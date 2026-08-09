import {
  loadOperationClaim,
  notifyRealtimeAfterCommit,
  QueueClaimLeaseBusyError,
  returnedChangeSequence,
} from "./claim-infrastructure";

export async function markTriggerFailure(
  env: CloudflareEnvironment,
  message: { operationId: string; eventId: string; organisationId: string },
  reason: string,
  entityId: string | null = null,
) {
  const failure = reason.slice(0, 2_000);
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `
      UPDATE operation_jobs SET status = 'failed', progress_total = 1, progress_completed = 1,
        progress_failed = 1, last_error = ?, completed_at = unixepoch(),
        claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND organisation_id = ?
         AND (
           (
             status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
             AND claim_token IS NULL
           )
           OR (
             status IN ('running','received')
             AND COALESCE(claim_expires_at, 0) <= unixepoch()
           )
         )
    `,
    ).bind(
      failure,
      message.operationId,
      message.eventId,
      message.organisationId,
    ),
  ];
  if (entityId) {
    statements.push(
      env.DB.prepare(
        `UPDATE communications
      SET status = 'failed', updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND operation_id = ? AND status IN ('queued','failed')
        AND changes() = 1
        AND EXISTS (
          SELECT 1 FROM operation_jobs failed_operation
           WHERE failed_operation.id = communications.operation_id
             AND failed_operation.event_id = communications.event_id
             AND failed_operation.organisation_id = ?
             AND failed_operation.status = 'failed' AND failed_operation.last_error = ?
             AND failed_operation.claim_token IS NULL
        )`,
      ).bind(
        entityId,
        message.eventId,
        message.operationId,
        message.organisationId,
        failure,
      ),
    );
  }
  const results = await env.DB.batch(statements);
  if ((results[0]?.meta.changes ?? 0) !== 1) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (current?.status === "completed" || current?.status === "cancelled")
      return;
    if (
      (current?.status === "running" || current?.status === "received") &&
      current.claimToken &&
      (current.claimExpiresAt ?? 0) > Math.floor(Date.now() / 1_000)
    ) {
      throw new QueueClaimLeaseBusyError();
    }
    throw new Error(
      "The notification trigger failure could not claim the operation.",
    );
  }
  const change = await env.DB.prepare(
    `INSERT INTO event_changes (
    event_id, entity_type, entity_id, change_type, correlation_id, created_at
  ) SELECT event_id, 'communication', ?, 'progress', correlation_id, unixepoch()
      FROM operation_jobs WHERE id = ? AND event_id = ?
    RETURNING sequence`,
  )
    .bind(entityId, message.operationId, message.eventId)
    .run();
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(change),
    message.operationId,
  );
}
