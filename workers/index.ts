import { createRequestHandler, RouterContextProvider } from "react-router";

import { cloudflareContext } from "../app/platform/cloudflare-context";
import { apiCorsHeaders, apiPreflightResponse, isVersionedApiPath } from "../app/platform/http/api-cors";
import { applySecurityHeaders, SECURITY_HEADERS } from "../app/platform/http/security-headers";
import { rejectCrossOriginBrowserMutation } from "../app/platform/http/mutation-origin.server";
import { EventRealtimeService } from "../app/platform/realtime/event-realtime.server";
import {
  mayExposeInternalErrors,
  requireRuntimeMode,
} from "../app/platform/runtime-environment.server";
import { handleProgramCueQueueMessage } from "./communications-queue";

export { EventChannel } from "./event-channel";

declare global {
  interface CloudflareEnvironment extends Env {
    BETTER_AUTH_SECRET?: string;
    RESEND_API_KEY?: string;
    RESEND_WEBHOOK_SECRET?: string;
    CALENDAR_CREDENTIALS_KEY?: string;
  }
}

const requestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build"),
  import.meta.env.MODE,
);

function requestCorrelationId(request: Request) {
  return request.headers.get("cf-ray")
    ?? request.headers.get("x-correlation-id")
    ?? crypto.randomUUID();
}

function secure(
  response: Response,
  request: Request,
  env: CloudflareEnvironment,
  appEnvironment: unknown = env.APP_ENV,
) {
  const headers = new Headers(response.headers);
  applySecurityHeaders(headers, typeof appEnvironment === "string" ? appEnvironment : undefined);
  for (const [name, value] of apiCorsHeaders(request, env)) headers.set(name, value);

  if (new URL(request.url).pathname.startsWith("/embed/")) {
    const ancestors = env.EMBED_FRAME_ANCESTORS;
    if (!ancestors) return new Response("EMBED_FRAME_ANCESTORS is required", { status: 503, headers });
    if (/[\r\n;]/.test(ancestors)) return new Response("Invalid EMBED_FRAME_ANCESTORS configuration", { status: 500, headers });
    headers.set("content-security-policy", SECURITY_HEADERS["content-security-policy"].replace("frame-ancestors 'self'", `frame-ancestors ${ancestors}`));
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
  console.error(JSON.stringify({
    level: "error",
    correlationId,
    subsystem: "runtime-configuration",
    message: error instanceof Error ? error.message : String(error),
  }));
  const pathname = new URL(request.url).pathname;
  const response = isVersionedApiPath(pathname)
    ? Response.json({
        error: {
          code: "RUNTIME_CONFIGURATION_INVALID",
          message: "The service runtime configuration is invalid.",
        },
        correlationId,
      }, { status: 503 })
    : new Response("The service runtime configuration is invalid.", { status: 503 });
  return secure(response, request, env, "production");
}

export async function rejectUnsupportedQueueMessage(message: Message, env: CloudflareEnvironment) {
  const body = message.body as {
    operationId?: unknown;
    eventId?: unknown;
    organisationId?: unknown;
    idempotencyKey?: unknown;
    type?: unknown;
  } | null;
  const operationId = typeof body?.operationId === "string" ? body.operationId : null;
  const eventId = typeof body?.eventId === "string" ? body.eventId : null;
  const organisationId = typeof body?.organisationId === "string" ? body.organisationId : null;
  const idempotencyKey = typeof body?.idempotencyKey === "string" ? body.idempotencyKey : null;
  const operationType = typeof body?.type === "string" ? body.type : null;
  const reportedType = operationType ?? "invalid";
  const failure = `No queue consumer is registered for operation type ${reportedType}.`;

  if (operationId && eventId && organisationId && operationType && idempotencyKey) {
    const update = await env.DB.prepare(`
      UPDATE operation_jobs
         SET status = 'failed', progress_total = MAX(progress_total, 1),
             progress_failed = MAX(progress_failed, 1),
             last_error = ?, completed_at = unixepoch(), updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND organisation_id = ?
         AND type = ? AND idempotency_key = ?
         AND status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
         AND claim_token IS NULL
    `).bind(
      failure,
      operationId,
      eventId,
      organisationId,
      operationType,
      idempotencyKey,
    ).run();
    if ((update.meta.changes ?? 0) > 0) {
      await env.DB.prepare(`
        INSERT INTO audit_events (
          id, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
        ) VALUES (?, ?, ?, 'operation.unsupported', 'operation', ?, ?, unixepoch())
      `).bind(
        crypto.randomUUID(),
        organisationId,
        eventId,
        operationId,
        JSON.stringify({ type: operationType, failure }),
      ).run();
      try {
        await new EventRealtimeService(env).recordChange(
          { organisationId, eventId },
          { entityType: "operation", entityId: operationId, changeType: "progress" },
        );
      } catch (error) {
        console.error(JSON.stringify({
          level: "error",
          subsystem: "queue-realtime",
          operationId,
          committed: true,
          message: error instanceof Error ? error.message : String(error),
        }));
      }
    } else {
      console.warn(JSON.stringify({
        level: "warning",
        subsystem: "queue",
        operationId,
        eventId,
        message: "Discarded unsupported operation message that did not match an eligible durable operation.",
      }));
    }
  } else {
    console.error(JSON.stringify({
      level: "error",
      subsystem: "queue",
      message: "Discarded malformed operation message without complete durable identity fields.",
    }));
  }
  message.ack();
}

export default {
  async fetch(request, env, ctx) {
    const correlationId = requestCorrelationId(request);
    try {
      requireRuntimeMode(env);
    } catch (error) {
      return invalidRuntimeConfiguration(request, env, correlationId, error);
    }
    const preflight = apiPreflightResponse(request, env, correlationId);
    if (preflight) return secure(preflight, request, env);
    const rejectedMutation = rejectCrossOriginBrowserMutation(request);
    if (rejectedMutation) return secure(rejectedMutation, request, env);

    try {
      const routerContext = new RouterContextProvider();
      routerContext.set(cloudflareContext, { env, ctx });
      return secure(await requestHandler(request, routerContext), request, env);
    } catch (error) {
      const pathname = new URL(request.url).pathname;
      console.error(JSON.stringify({
        level: "error",
        correlationId,
        method: request.method,
        path: pathname,
        message: error instanceof Error ? error.message : String(error),
      }));
      const message = mayExposeInternalErrors(env.APP_ENV) ? String(error) : "Unexpected server error";
      const response = isVersionedApiPath(pathname)
        ? Response.json({ error: { code: "INTERNAL_ERROR", message }, correlationId }, { status: 500 })
        : new Response(message, { status: 500 });
      return secure(response, request, env);
    }
  },

  async queue(batch, env) {
    requireRuntimeMode(env);
    for (const message of batch.messages) {
      if (!await handleProgramCueQueueMessage(message, env)) {
        await rejectUnsupportedQueueMessage(message, env);
      }
    }
  },
} satisfies ExportedHandler<CloudflareEnvironment>;
