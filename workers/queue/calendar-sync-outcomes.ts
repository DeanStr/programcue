import type { CalendarQueueMessage } from "../../app/modules/calendars/calendar-schema";
import {
  loadOperationClaim,
  notifyRealtimeAfterCommit,
  QueueClaimLeaseBusyError,
  QueueClaimLeaseLostError,
  returnedChangeSequence,
} from "./claim-infrastructure";
import { loadCalendarAttempt } from "./calendar-sync-state";

export async function finishSupersededCalendarAttempt(
  env: CloudflareEnvironment,
  message: CalendarQueueMessage,
  reason: string,
  providerEventId: string | null = null,
  claimToken?: string,
) {
  const claimGuard = claimToken
    ? `AND EXISTS (
    SELECT 1 FROM operation_jobs claimed_operation
     WHERE claimed_operation.id = ? AND claimed_operation.event_id = ?
       AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
  )`
    : "";
  const claimBindings = claimToken
    ? [message.operationId, message.eventId, claimToken]
    : [];
  const resultJson = JSON.stringify({
    invitationId: message.invitationId,
    attemptId: message.attemptId,
    sequence: message.payload.sequence,
    provider: message.provider,
    outcome: "superseded",
    providerApplied: providerEventId !== null,
    ...(providerEventId ? { providerEventId } : {}),
    reason,
  });
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE calendar_sync_attempts
      SET status = 'superseded', provider_event_id = COALESCE(?, provider_event_id),
          error_code = 'SUPERSEDED', error_message = ?, completed_at = unixepoch()
      WHERE id = ? AND invitation_id = ? AND sequence_number = ? AND method = ? AND provider = ?
        AND status IN ('queued','running','failed') ${claimGuard}`,
    ).bind(
      providerEventId,
      reason.slice(0, 2_000),
      message.attemptId,
      message.invitationId,
      message.payload.sequence,
      message.payload.method,
      message.provider,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communication_deliveries
      SET status = 'cancelled', failure_code = 'SUPERSEDED', failure_message = ?, updated_at = unixepoch()
      WHERE communication_id IN (SELECT id FROM communications WHERE operation_id = ? AND event_id = ?)
        AND status IN ('queued','sending','failed') ${claimGuard}`,
    ).bind(
      reason.slice(0, 2_000),
      message.operationId,
      message.eventId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communications
      SET status = 'cancelled', cancelled_at = unixepoch(), updated_at = unixepoch()
      WHERE operation_id = ? AND event_id = ? AND status IN ('queued','sending','failed','partially_failed')
        ${claimGuard}`,
    ).bind(message.operationId, message.eventId, ...claimBindings),
    env.DB.prepare(
      `UPDATE operation_items
      SET status = 'skipped', result_json = ?, error_code = 'SUPERSEDED', error_message = ?,
          completed_at = unixepoch(), updated_at = unixepoch()
      WHERE operation_id = ? AND status IN ('pending','running','failed') ${claimGuard}`,
    ).bind(
      resultJson,
      reason.slice(0, 2_000),
      message.operationId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
      SET status = 'cancelled', progress_total = 1, progress_completed = 1, progress_failed = 0,
          result_json = ?, last_error = NULL, completed_at = unixepoch(),
          claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND status NOT IN ('completed','cancelled')
        ${claimToken ? "AND status = 'running' AND claim_token = ?" : ""}`,
    ).bind(
      resultJson,
      message.operationId,
      message.eventId,
      ...(claimToken ? [claimToken] : []),
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
      id, actor_kind, origin, metadata_version, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
    ) SELECT ?, 'system', 'queue', 1, ?, ?, 'calendar.lifecycle.superseded', 'calendar_invitation', ?, ?, unixepoch()
       WHERE changes() = 1
         AND EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND event_id = ? AND status = 'cancelled')`,
    ).bind(
      crypto.randomUUID(),
      message.organisationId,
      message.eventId,
      message.invitationId,
      resultJson,
      message.operationId,
      message.eventId,
    ),
    env.DB.prepare(
      `INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
      SELECT event_id, 'calendar_invitation', ?, 'progress', correlation_id, unixepoch()
        FROM operation_jobs WHERE id = ? AND event_id = ? AND status = 'cancelled' AND changes() = 1
      RETURNING sequence`,
    ).bind(message.invitationId, message.operationId, message.eventId),
  ]);
  const operationFinished = (results[4]?.meta.changes ?? 0) === 1;
  if (!operationFinished) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (current?.status === "completed" || current?.status === "cancelled")
      return;
    if (current?.status === "running") {
      if (claimToken && current.claimToken !== claimToken)
        throw new QueueClaimLeaseLostError();
      throw new QueueClaimLeaseBusyError();
    }
  }
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(results.at(-1)),
    message.operationId,
  );
}

export async function finishCalendarAttemptFailure(
  env: CloudflareEnvironment,
  message: CalendarQueueMessage,
  payloadHash: string,
  failure: { code: string; message: string },
  claimToken?: string,
) {
  const claimGuard = claimToken
    ? `AND EXISTS (
    SELECT 1 FROM operation_jobs claimed_operation
     WHERE claimed_operation.id = ? AND claimed_operation.event_id = ?
       AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
  )`
    : "";
  const claimBindings = claimToken
    ? [message.operationId, message.eventId, claimToken]
    : [];
  const failureResults = await env.DB.batch([
    env.DB.prepare(
      `UPDATE calendar_sync_attempts
      SET status = 'failed', error_code = ?, error_message = ?, completed_at = unixepoch()
      WHERE id = ? AND invitation_id = ? AND sequence_number = ? AND method = ? AND provider = ?
        AND status IN ('queued','running','failed') ${claimGuard}`,
    ).bind(
      failure.code,
      failure.message,
      message.attemptId,
      message.invitationId,
      message.payload.sequence,
      message.payload.method,
      message.provider,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE calendar_invitations SET status = 'failed', updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND current_attempt_id = ? AND sequence_number = ?
        AND method = ? AND last_payload_hash = ? ${claimGuard}`,
    ).bind(
      message.invitationId,
      message.eventId,
      message.attemptId,
      message.payload.sequence,
      message.payload.method,
      payloadHash,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE operation_items
      SET status = 'failed', error_code = ?, error_message = ?, completed_at = unixepoch(), updated_at = unixepoch()
      WHERE operation_id = ? AND status <> 'completed' ${claimGuard}`,
    ).bind(
      failure.code,
      failure.message,
      message.operationId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communication_deliveries
      SET status = 'failed', failure_code = ?, failure_message = ?, next_attempt_at = unixepoch() + 60,
          updated_at = unixepoch()
      WHERE communication_id IN (SELECT id FROM communications WHERE operation_id = ? AND event_id = ?)
        AND status IN ('queued','sending','failed') ${claimGuard}`,
    ).bind(
      failure.code,
      failure.message,
      message.operationId,
      message.eventId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communications SET status = 'failed', updated_at = unixepoch()
      WHERE operation_id = ? AND event_id = ? AND status NOT IN ('sent','cancelled') ${claimGuard}`,
    ).bind(message.operationId, message.eventId, ...claimBindings),
    env.DB.prepare(
      `UPDATE operation_jobs
      SET status = 'failed', progress_total = 1, progress_completed = 1, progress_failed = 1,
          last_error = ?, completed_at = unixepoch(), claim_token = NULL,
          claim_expires_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND status NOT IN ('completed','cancelled')
        ${claimToken ? "AND status = 'running' AND claim_token = ?" : ""}`,
    ).bind(
      failure.message,
      message.operationId,
      message.eventId,
      ...(claimToken ? [claimToken] : []),
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
      id, actor_kind, origin, metadata_version, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
    ) SELECT ?, 'system', 'queue', 1, ?, ?, 'calendar.lifecycle.failed', 'calendar_invitation', ?, ?, unixepoch()
       WHERE changes() = 1`,
    ).bind(
      crypto.randomUUID(),
      message.organisationId,
      message.eventId,
      message.invitationId,
      JSON.stringify({
        attemptId: message.attemptId,
        provider: message.provider,
        method: message.payload.method,
        sequence: message.payload.sequence,
        errorCode: failure.code,
        errorMessage: failure.message,
      }),
    ),
    env.DB.prepare(
      `INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
      SELECT event_id, 'calendar_invitation', ?, 'progress', correlation_id, unixepoch()
        FROM operation_jobs WHERE id = ? AND event_id = ? AND status = 'failed' AND changes() = 1
      RETURNING sequence`,
    ).bind(message.invitationId, message.operationId, message.eventId),
  ]);
  const operationFinished = (failureResults[5]?.meta.changes ?? 0) === 1;
  if (!operationFinished) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (current?.status === "completed" || current?.status === "cancelled")
      return;
    if (current?.status === "running") {
      if (claimToken && current.claimToken !== claimToken)
        throw new QueueClaimLeaseLostError();
      throw new QueueClaimLeaseBusyError();
    }
  }
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(failureResults.at(-1)),
    message.operationId,
  );
}
