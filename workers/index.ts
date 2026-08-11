import { createRequestHandler, RouterContextProvider } from "react-router";

import { runCommunicationAutomation } from "../app/modules/communications/communication-automation-service.server";
import { cloudflareContext } from "../app/platform/cloudflare-context";
import {
  apiCorsHeaders,
  apiPreflightResponse,
  isVersionedApiPath,
} from "../app/platform/http/api-cors";
import {
  applySecurityHeaders,
  SECURITY_HEADERS,
} from "../app/platform/http/security-headers";
import {
  rejectCrossOriginBrowserMutation,
  rejectUnsupportedRequestMethod,
} from "../app/platform/http/mutation-origin.server";
import { requestCorrelationId } from "../app/platform/observability/request-correlation";
import { WebhookService } from "../app/platform/operations/webhook-service.server";
import {
  requireSourceRevision,
  sourceRevisionForLog,
} from "../app/platform/observability/source-revision.server";
import { EventRealtimeService } from "../app/platform/realtime/event-realtime.server";
import {
  mayExposeInternalErrors,
  requireRuntimeMode,
} from "../app/platform/runtime-environment.server";
import { requireProductionRuntimeReadiness } from "../app/platform/runtime-readiness.server";
import { handleProgramCueQueueMessage } from "./communications-queue";
import { D1_BACKUP_CRON, scheduleDailyD1Backup } from "./d1-backup-workflow";

export { EventChannel } from "./event-channel";
export { D1BackupWorkflow } from "./d1-backup-workflow";
export { ProgramCueEventAgent } from "../app/modules/ai/program-cue-agent.server";

declare global {
  interface CloudflareEnvironment extends Env {
    EMAIL_PROVIDER?: "resend" | "mailpit";
    BETTER_AUTH_SECRET?: string;
    RESEND_API_KEY?: string;
    RESEND_WEBHOOK_SECRET?: string;
    MAILPIT_SEND_API_URL?: string;
    MAILPIT_SEND_API_USERNAME?: string;
    MAILPIT_SEND_API_PASSWORD?: string;
    CALENDAR_CREDENTIALS_KEY?: string;
    GOOGLE_CALENDAR_CLIENT_ID?: string;
    GOOGLE_CALENDAR_CLIENT_SECRET?: string;
    MICROSOFT_CALENDAR_CLIENT_ID?: string;
    MICROSOFT_CALENDAR_CLIENT_SECRET?: string;
    GOOGLE_AUTH_CLIENT_ID?: string;
    GOOGLE_AUTH_CLIENT_SECRET?: string;
    MICROSOFT_AUTH_CLIENT_ID?: string;
    MICROSOFT_AUTH_CLIENT_SECRET?: string;
    INTEGRATION_CREDENTIALS_KEY?: string;
    WEBHOOK_CREDENTIALS_KEY?: string;
    TURNSTILE_SITE_KEY?: string;
    TURNSTILE_SECRET_KEY?: string;
    FILE_SCANNER_WEBHOOK_SECRET?: string;
    FILE_SCANNER_API_URL?: string;
    FILE_SCANNER_API_TOKEN?: string;
    R2_ACCOUNT_ID?: string;
    R2_BUCKET_NAME?: string;
    R2_ACCESS_KEY_ID?: string;
    R2_SECRET_ACCESS_KEY?: string;
    D1_REST_API_TOKEN?: string;
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

function secure(
  response: Response,
  request: Request,
  env: CloudflareEnvironment,
  appEnvironment: unknown = env.APP_ENV,
) {
  const headers = new Headers(response.headers);
  applySecurityHeaders(
    headers,
    typeof appEnvironment === "string" ? appEnvironment : undefined,
  );
  for (const [name, value] of apiCorsHeaders(request, env))
    headers.set(name, value);

  if (new URL(request.url).pathname.startsWith("/embed/")) {
    const ancestors = env.EMBED_FRAME_ANCESTORS;
    if (!ancestors)
      return new Response("EMBED_FRAME_ANCESTORS is required", {
        status: 503,
        headers,
      });
    if (/[\r\n;]/.test(ancestors))
      return new Response("Invalid EMBED_FRAME_ANCESTORS configuration", {
        status: 500,
        headers,
      });
    headers.set(
      "content-security-policy",
      SECURITY_HEADERS["content-security-policy"].replace(
        "frame-ancestors 'self'",
        `frame-ancestors ${ancestors}`,
      ),
    );
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
    webSocket: response.webSocket,
  });
}

function invalidRuntimeConfiguration(
  request: Request,
  env: CloudflareEnvironment,
  correlationId: string,
  error: unknown,
) {
  console.error(
    JSON.stringify({
      level: "error",
      correlationId,
      sourceRevision: sourceRevisionForLog(env),
      subsystem: "runtime-configuration",
      event: "validation-failed",
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: "Worker runtime configuration validation failed.",
    }),
  );
  const pathname = new URL(request.url).pathname;
  const response = isVersionedApiPath(pathname)
    ? Response.json(
        {
          error: {
            code: "RUNTIME_CONFIGURATION_INVALID",
            message: "The service runtime configuration is invalid.",
          },
          correlationId,
        },
        { status: 503 },
      )
    : new Response("The service runtime configuration is invalid.", {
        status: 503,
      });
  return secure(response, request, env, "production");
}

export async function rejectUnsupportedQueueMessage(
  message: Message,
  env: CloudflareEnvironment,
) {
  const body = message.body as {
    operationId?: unknown;
    eventId?: unknown;
    organisationId?: unknown;
    idempotencyKey?: unknown;
    type?: unknown;
  } | null;
  const operationalIdentifier = (value: unknown) =>
    typeof value === "string" &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)
      ? value
      : null;
  const operationId = operationalIdentifier(body?.operationId);
  const eventId = operationalIdentifier(body?.eventId);
  const organisationId = operationalIdentifier(body?.organisationId);
  const idempotencyKey = operationalIdentifier(body?.idempotencyKey);
  const operationType = operationalIdentifier(body?.type);
  const reportedType = operationType ?? "invalid";
  const failure = `No queue consumer is registered for operation type ${reportedType}.`;

  if (
    operationId &&
    eventId &&
    organisationId &&
    operationType &&
    idempotencyKey
  ) {
    const [update, audit] = await env.DB.batch([
      env.DB.prepare(
        `
      UPDATE operation_jobs
         SET status = 'failed', progress_total = MAX(progress_total, 1),
             progress_failed = MAX(progress_failed, 1),
             last_error = ?, completed_at = unixepoch(), updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND organisation_id = ?
         AND type = ? AND idempotency_key = ?
         AND status IN ('queued','queue_failed','received','retrying','partially_failed')
         AND claim_token IS NULL
    `,
      ).bind(
        failure,
        operationId,
        eventId,
        organisationId,
        operationType,
        idempotencyKey,
      ),
      env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, action, entity_type, entity_id,
          metadata_json, created_at
        )
        SELECT ?, ?, ?, 'operation.unsupported', 'operation', ?, ?, unixepoch()
         WHERE changes() = 1
      `,
      ).bind(
        crypto.randomUUID(),
        organisationId,
        eventId,
        operationId,
        JSON.stringify({ type: operationType, failure }),
      ),
    ]);
    if ((update.meta.changes ?? 0) > 0) {
      if ((audit.meta.changes ?? 0) !== 1) {
        throw new Error(
          "The unsupported operation failure was not recorded in the audit log.",
        );
      }
      try {
        await new EventRealtimeService(env).recordChange(
          { organisationId, eventId },
          {
            entityType: "operation",
            entityId: operationId,
            changeType: "progress",
          },
        );
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            sourceRevision: sourceRevisionForLog(env),
            subsystem: "queue-realtime",
            operationId,
            eventId,
            committed: true,
            errorName: error instanceof Error ? error.name : "UnknownError",
            message:
              "The unsupported operation was persisted, but its realtime invalidation failed.",
          }),
        );
      }
    } else {
      console.warn(
        JSON.stringify({
          level: "warning",
          sourceRevision: sourceRevisionForLog(env),
          subsystem: "queue",
          event: "unsupported-operation-unmatched",
          operationId,
          eventId,
          message:
            "Discarded unsupported operation message that did not match an eligible durable operation.",
        }),
      );
    }
  } else {
    console.error(
      JSON.stringify({
        level: "error",
        sourceRevision: sourceRevisionForLog(env),
        subsystem: "queue",
        event: "malformed-message",
        message:
          "Discarded malformed operation message without complete durable identity fields.",
      }),
    );
  }
  message.ack();
}

export default {
  async fetch(request, env, ctx) {
    const correlationId = requestCorrelationId(request);
    let sourceRevision: string;
    try {
      requireRuntimeMode(env);
      sourceRevision = requireSourceRevision(env);
      requireProductionRuntimeReadiness(env);
    } catch (error) {
      return invalidRuntimeConfiguration(request, env, correlationId, error);
    }
    const rejectedMethod = rejectUnsupportedRequestMethod(request);
    if (rejectedMethod) return secure(rejectedMethod, request, env);
    const preflight = apiPreflightResponse(request, env, correlationId);
    if (preflight) return secure(preflight, request, env);
    const rejectedMutation = rejectCrossOriginBrowserMutation(request);
    if (rejectedMutation) return secure(rejectedMutation, request, env);

    try {
      const routerContext = new RouterContextProvider();
      routerContext.set(cloudflareContext, { env, ctx });
      const response = await requestHandler(request, routerContext);
      if (response.status >= 500) {
        console.error(
          JSON.stringify({
            level: "error",
            subsystem: "request",
            event: "error-response",
            correlationId,
            sourceRevision,
            method: request.method,
            status: response.status,
            message: "The request completed with a server error response.",
          }),
        );
      }
      return secure(response, request, env);
    } catch (error) {
      const pathname = new URL(request.url).pathname;
      console.error(
        JSON.stringify({
          level: "error",
          subsystem: "request",
          event: "unhandled-exception",
          correlationId,
          sourceRevision,
          method: request.method,
          errorName: error instanceof Error ? error.name : "UnknownError",
          message: "The request failed with an unhandled exception.",
        }),
      );
      const message = mayExposeInternalErrors(env.APP_ENV)
        ? String(error)
        : "Unexpected server error";
      const response = isVersionedApiPath(pathname)
        ? Response.json(
            { error: { code: "INTERNAL_ERROR", message }, correlationId },
            { status: 500 },
          )
        : new Response(message, { status: 500 });
      return secure(response, request, env);
    }
  },

  async queue(batch, env) {
    try {
      requireRuntimeMode(env);
      requireSourceRevision(env);
      requireProductionRuntimeReadiness(env);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          sourceRevision: sourceRevisionForLog(env),
          subsystem: "runtime-configuration",
          event: "queue-validation-failed",
          errorName: error instanceof Error ? error.name : "UnknownError",
          message: "Queue runtime configuration validation failed.",
        }),
      );
      throw error;
    }
    for (const message of batch.messages) {
      if (!(await handleProgramCueQueueMessage(message, env))) {
        await rejectUnsupportedQueueMessage(message, env);
      }
    }
  },

  scheduled(controller, env, ctx) {
    let sourceRevision: string;
    try {
      requireRuntimeMode(env);
      sourceRevision = requireSourceRevision(env);
      requireProductionRuntimeReadiness(env);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          sourceRevision: sourceRevisionForLog(env),
          subsystem: "runtime-configuration",
          event: "scheduled-validation-failed",
          trigger: controller.cron,
          errorName: error instanceof Error ? error.name : "UnknownError",
          message: "Scheduled runtime configuration validation failed.",
        }),
      );
      throw error;
    }
    const observe = <T>(subsystem: string, task: Promise<T>) =>
      task.catch((error) => {
        console.error(
          JSON.stringify({
            level: "error",
            sourceRevision,
            subsystem,
            event: "scheduled-task-failed",
            trigger: controller.cron,
            errorName: error instanceof Error ? error.name : "UnknownError",
            message: "The scheduled task failed.",
          }),
        );
        throw error;
      });
    if (controller.cron === "* * * * *") {
      ctx.waitUntil(
        observe(
          "outbound-webhook-dispatch",
          new WebhookService(env).dispatchPendingEvents(),
        ),
      );
      ctx.waitUntil(
        observe("communication-automation", runCommunicationAutomation(env)),
      );
      return;
    }
    if (controller.cron === D1_BACKUP_CRON) {
      ctx.waitUntil(
        observe(
          "d1-backup-scheduler",
          scheduleDailyD1Backup(env, controller.scheduledTime),
        ),
      );
      return;
    }
    console.error(
      JSON.stringify({
        level: "error",
        sourceRevision,
        subsystem: "scheduler",
        event: "unsupported-trigger",
        trigger: controller.cron,
        message: "The Worker received an unsupported scheduled trigger.",
      }),
    );
    throw new Error(`Unsupported scheduled trigger: ${controller.cron}`);
  },
} satisfies ExportedHandler<CloudflareEnvironment>;
