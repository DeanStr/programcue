import { z } from "zod";

import {
  errorDetails,
  QUEUE_CLAIM_LEASE_SECONDS,
  QueueClaimLeaseBusyError,
} from "./queue/claim-infrastructure";
import {
  COMMUNICATION_SEND_BATCH_SIZE,
  processCommunicationSend,
} from "./queue/communication-send";
import { processCalendarSync } from "./queue/calendar-sync-handler";
import {
  processDecisionNotification,
  processSubmissionNotification,
} from "./queue/notification-handlers";
import { processScheduleCalendarFanout } from "./queue/schedule-calendar-fanout-handler";
import { processAcceleventsExport } from "./queue/accelevents-export-handler";
import { processWebhookDelivery } from "./queue/webhook-delivery-handler";
import { processFileScanDispatch } from "../app/modules/files/file-scan-dispatch.server";
import { sourceRevisionForLog } from "../app/platform/observability/source-revision.server";

export {
  COMMUNICATION_SEND_BATCH_SIZE,
  processCalendarSync,
  processCommunicationSend,
  processDecisionNotification,
  processScheduleCalendarFanout,
  processSubmissionNotification,
  processAcceleventsExport,
  processWebhookDelivery,
  processFileScanDispatch,
  QUEUE_CLAIM_LEASE_SECONDS,
  QueueClaimLeaseBusyError,
};

const operationalIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);

// Wrangler allows the initial delivery plus three retries before the DLQ.
// Keep pre-claim infrastructure failures recoverable until that last attempt.
export const PROGRAM_CUE_QUEUE_MAX_ATTEMPTS = 4;

const queueFailureIdentitySchema = z
  .object({
    type: z.enum([
      "communication.send",
      "calendar.sync",
      "decision.notification",
      "submission.notification",
      "schedule.calendar_fanout",
      "integration.accelevents.export",
      "webhook.deliver",
      "file.scan.dispatch",
    ]),
    operationId: operationalIdentifierSchema,
    eventId: operationalIdentifierSchema,
    organisationId: operationalIdentifierSchema,
  })
  .passthrough();

function queueProvider(input: unknown, env: CloudflareEnvironment): string {
  if (!input || typeof input !== "object") return "unknown";
  const candidate = input as { provider?: unknown; type?: unknown };
  switch (candidate.type) {
    case "communication.send":
    case "decision.notification":
    case "submission.notification":
      return env.EMAIL_PROVIDER === "resend" || env.EMAIL_PROVIDER === "mailpit"
        ? env.EMAIL_PROVIDER
        : "email-unconfigured";
    case "calendar.sync":
      return candidate.provider === "email_ics" ||
        candidate.provider === "google" ||
        candidate.provider === "microsoft"
        ? candidate.provider
        : "calendar-unconfigured";
    case "schedule.calendar_fanout":
      return "calendar";
    case "integration.accelevents.export":
      return "accelevents";
    case "webhook.deliver":
      return "webhook";
    case "file.scan.dispatch":
      return "file-scanner";
    default:
      return "unknown";
  }
}

async function finishUnclaimedQueueFailure(
  env: CloudflareEnvironment,
  input: unknown,
  queueMessageId: string,
  error: unknown,
  terminal: boolean,
) {
  const identity = queueFailureIdentitySchema.safeParse(input);
  if (!identity.success) return;
  const details = errorDetails(error);
  const failure = `${details.message} (Queue message ${queueMessageId})`.slice(
    0,
    2_000,
  );
  if (!terminal) {
    await env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'retrying', attempt_count = attempt_count + 1,
              last_error = ?, completed_at = NULL, claim_token = NULL,
              claim_expires_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND organisation_id = ? AND type = ?
          AND status IN ('queued','queue_failed','received','retrying')
          AND claim_token IS NULL`,
    )
      .bind(
        failure,
        identity.data.operationId,
        identity.data.eventId,
        identity.data.organisationId,
        identity.data.type,
      )
      .run();
    return;
  }
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE operation_jobs
      SET status = 'failed', progress_completed = progress_total,
          progress_failed = progress_total, attempt_count = attempt_count + 1,
          last_error = ?, completed_at = unixepoch(), claim_token = NULL,
          claim_expires_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ? AND type = ?
        AND status IN ('queued','queue_failed','received','retrying')
        AND claim_token IS NULL`,
    ).bind(
      failure,
      identity.data.operationId,
      identity.data.eventId,
      identity.data.organisationId,
      identity.data.type,
    ),
    env.DB.prepare(
      `UPDATE communication_deliveries
      SET status = 'failed', failure_code = ?, failure_message = ?, next_attempt_at = NULL,
          updated_at = unixepoch()
      WHERE event_id = ? AND status IN ('queued','sending','failed')
        AND EXISTS (
          SELECT 1 FROM communications c
          JOIN operation_jobs failed_operation ON failed_operation.id = c.operation_id
           WHERE c.id = communication_deliveries.communication_id
             AND c.operation_id = ? AND c.event_id = ?
             AND failed_operation.organisation_id = ?
             AND failed_operation.type = ? AND failed_operation.status = 'failed'
             AND failed_operation.last_error = ?
        )`,
    ).bind(
      details.code,
      details.message,
      identity.data.eventId,
      identity.data.operationId,
      identity.data.eventId,
      identity.data.organisationId,
      identity.data.type,
      failure,
    ),
    env.DB.prepare(
      `UPDATE communications
      SET status = 'failed', updated_at = unixepoch()
      WHERE operation_id = ? AND event_id = ? AND status IN ('queued','sending','failed')
        AND EXISTS (
          SELECT 1 FROM operation_jobs failed_operation
           WHERE failed_operation.id = communications.operation_id
             AND failed_operation.organisation_id = ?
             AND failed_operation.type = ? AND failed_operation.status = 'failed'
             AND failed_operation.last_error = ?
        )`,
    ).bind(
      identity.data.operationId,
      identity.data.eventId,
      identity.data.organisationId,
      identity.data.type,
      failure,
    ),
    env.DB.prepare(
      `UPDATE operation_items
      SET status = 'failed', error_code = ?, error_message = ?, completed_at = unixepoch(),
          updated_at = unixepoch()
      WHERE operation_id = ? AND status IN ('pending','running','failed')
        AND EXISTS (
          SELECT 1 FROM operation_jobs failed_operation
           WHERE failed_operation.id = operation_items.operation_id
             AND failed_operation.event_id = ? AND failed_operation.organisation_id = ?
             AND failed_operation.type = ? AND failed_operation.status = 'failed'
             AND failed_operation.last_error = ?
        )`,
    ).bind(
      details.code,
      details.message,
      identity.data.operationId,
      identity.data.eventId,
      identity.data.organisationId,
      identity.data.type,
      failure,
    ),
  ]);
}
export async function handleProgramCueQueueMessage(
  message: Message,
  env: CloudflareEnvironment,
) {
  const body = message.body as { type?: unknown } | null;
  if (
    body?.type !== "communication.send" &&
    body?.type !== "calendar.sync" &&
    body?.type !== "decision.notification" &&
    body?.type !== "submission.notification" &&
    body?.type !== "schedule.calendar_fanout" &&
    body?.type !== "integration.accelevents.export" &&
    body?.type !== "webhook.deliver" &&
    body?.type !== "file.scan.dispatch"
  )
    return false;
  try {
    if (body.type === "communication.send")
      await processCommunicationSend(body, env);
    else if (body.type === "calendar.sync")
      await processCalendarSync(body, env);
    else if (body.type === "decision.notification")
      await processDecisionNotification(body, env);
    else if (body.type === "submission.notification")
      await processSubmissionNotification(body, env);
    else if (body.type === "schedule.calendar_fanout")
      await processScheduleCalendarFanout(body, env);
    else if (body.type === "integration.accelevents.export")
      await processAcceleventsExport(body, env);
    else if (body.type === "webhook.deliver")
      await processWebhookDelivery(body, env);
    else await processFileScanDispatch(body, env);
    message.ack();
  } catch (error) {
    const identity = queueFailureIdentitySchema.safeParse(body);
    const leaseBusy = error instanceof QueueClaimLeaseBusyError;
    const failureLog = JSON.stringify({
      level: leaseBusy ? "warning" : "error",
      sourceRevision: sourceRevisionForLog(env),
      subsystem: "operations-queue",
      event: leaseBusy ? "claim-busy" : "handler-failed",
      type: body.type,
      ...(identity.success
        ? {
            operationId: identity.data.operationId,
            eventId: identity.data.eventId,
          }
        : {}),
      provider: queueProvider(body, env),
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: leaseBusy
        ? "The Queue operation is already held by an active claim and will retry."
        : "The Queue operation handler failed.",
    });
    if (leaseBusy) console.warn(failureLog);
    else console.error(failureLog);
    if (leaseBusy) {
      message.retry({ delaySeconds: error.retryAfterSeconds });
    } else {
      try {
        await finishUnclaimedQueueFailure(
          env,
          body,
          message.id,
          error,
          message.attempts >= PROGRAM_CUE_QUEUE_MAX_ATTEMPTS,
        );
      } catch (failureError) {
        console.error(
          JSON.stringify({
            level: "error",
            sourceRevision: sourceRevisionForLog(env),
            subsystem: "operations-queue",
            event: "failure-persistence-failed",
            type: body.type,
            ...(identity.success
              ? {
                  operationId: identity.data.operationId,
                  eventId: identity.data.eventId,
                }
              : {}),
            provider: queueProvider(body, env),
            errorName:
              failureError instanceof Error
                ? failureError.name
                : "UnknownError",
            message: "The Queue failure could not be persisted.",
          }),
        );
      }
      message.retry();
    }
  }
  return true;
}
