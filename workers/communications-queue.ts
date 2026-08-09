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

export {
  COMMUNICATION_SEND_BATCH_SIZE,
  processCalendarSync,
  processCommunicationSend,
  processDecisionNotification,
  processScheduleCalendarFanout,
  processSubmissionNotification,
  QUEUE_CLAIM_LEASE_SECONDS,
  QueueClaimLeaseBusyError,
};

const queueFailureIdentitySchema = z
  .object({
    type: z.enum([
      "communication.send",
      "calendar.sync",
      "decision.notification",
      "submission.notification",
      "schedule.calendar_fanout",
    ]),
    operationId: z.string().min(1),
    eventId: z.string().min(1),
    organisationId: z.string().min(1),
  })
  .passthrough();

async function finishUnclaimedQueueFailure(
  env: CloudflareEnvironment,
  input: unknown,
  queueMessageId: string,
  error: unknown,
) {
  const identity = queueFailureIdentitySchema.safeParse(input);
  if (!identity.success) return;
  const details = errorDetails(error);
  const failure = `${details.message} (Queue message ${queueMessageId})`.slice(
    0,
    2_000,
  );
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
    body?.type !== "schedule.calendar_fanout"
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
    else await processScheduleCalendarFanout(body, env);
    message.ack();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        subsystem: "communications-queue",
        type: body.type,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    if (error instanceof QueueClaimLeaseBusyError) {
      message.retry({ delaySeconds: error.retryAfterSeconds });
    } else {
      try {
        await finishUnclaimedQueueFailure(env, body, message.id, error);
      } catch (failureError) {
        console.error(
          JSON.stringify({
            level: "error",
            subsystem: "communications-queue",
            type: body.type,
            message: `Could not persist the Queue failure: ${failureError instanceof Error ? failureError.message : String(failureError)}`,
          }),
        );
      }
      message.retry();
    }
  }
  return true;
}
