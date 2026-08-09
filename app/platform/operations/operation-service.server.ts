import type { Viewer } from "~/platform/auth/authorize.server";

const STALE_QUEUED_OPERATION_SECONDS = 60;

export class OperationQueueUnavailableError extends Error {
  constructor(readonly operationId: string) {
    super(
      `Operation ${operationId} was saved but could not be queued. Retry it from the operation centre.`,
    );
    this.name = "OperationQueueUnavailableError";
  }
}

export type OperationListItem = {
  id: string;
  type: string;
  status: string;
  attemptCount: number;
  progressCurrent: number;
  progressTotal: number | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  retryable: boolean;
};

export class OperationService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async list(viewer: Viewer, limit = 100): Promise<OperationListItem[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const result = await this.env.DB.prepare(
      `
      SELECT o.id, o.type, o.status, o.attempt_count AS attemptCount,
             COALESCE(o.progress_completed, 0) AS progressCurrent,
             o.progress_total AS progressTotal, o.last_error AS lastError,
             o.created_at AS createdAt, o.updated_at AS updatedAt, o.completed_at AS completedAt,
             CASE
               WHEN o.status IN ('queue_failed','failed','partially_failed') THEN 1
               WHEN o.status = 'queued'
                    AND o.updated_at <= unixepoch() - ${STALE_QUEUED_OPERATION_SECONDS} THEN 1
               WHEN o.status = 'running' AND o.claim_expires_at IS NOT NULL
                    AND o.claim_expires_at <= unixepoch() THEN 1
               ELSE 0
             END AS retryable
        FROM operation_jobs o
        JOIN events e ON e.id = o.event_id
       WHERE o.event_id = ? AND e.organisation_id = ?
       ORDER BY o.created_at DESC
       LIMIT ?
    `,
    )
      .bind(viewer.eventId, viewer.organisationId, safeLimit)
      .all<Omit<OperationListItem, "retryable"> & { retryable: number }>();
    return result.results.map((operation) => ({
      ...operation,
      retryable: operation.retryable === 1,
    }));
  }

  async retry(viewer: Viewer, operationId: string) {
    const operation = await this.env.DB.prepare(
      `
      SELECT o.id, o.type, o.payload_json AS payloadJson, o.status,
             o.claim_expires_at AS claimExpiresAt, o.updated_at AS updatedAt
        FROM operation_jobs o
        JOIN events e ON e.id = o.event_id
       WHERE o.id = ? AND o.event_id = ? AND e.organisation_id = ?
       LIMIT 1
    `,
    )
      .bind(operationId, viewer.eventId, viewer.organisationId)
      .first<{
        id: string;
        type: string;
        payloadJson: string;
        status: string;
        claimExpiresAt: number | null;
        updatedAt: number;
      }>();
    if (!operation) throw new Error("Operation not found.");
    const expiredRunningClaim =
      operation.status === "running" &&
      operation.claimExpiresAt !== null &&
      operation.claimExpiresAt <= Math.floor(Date.now() / 1_000);
    const staleQueued =
      operation.status === "queued" &&
      operation.updatedAt <=
        Math.floor(Date.now() / 1_000) - STALE_QUEUED_OPERATION_SECONDS;
    if (
      !["queue_failed", "failed", "partially_failed"].includes(
        operation.status,
      ) &&
      !expiredRunningClaim &&
      !staleQueued
    ) {
      throw new Error(
        "Only failed operations, stale queued operations or operations with an expired processing lease can be retried.",
      );
    }
    if (!this.env.OPERATIONS_QUEUE)
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    let message: unknown;
    try {
      message = JSON.parse(operation.payloadJson);
    } catch {
      throw new Error(
        "The saved operation payload is invalid and cannot be retried.",
      );
    }
    const restartCalendarFanout =
      operation.type === "schedule.calendar_fanout" &&
      ["failed", "partially_failed"].includes(operation.status) &&
      typeof message === "object" &&
      message !== null &&
      !Object.hasOwn(message, "afterTarget");
    const update = await this.env.DB.prepare(
      `
      UPDATE operation_jobs
         SET status = 'queued', last_error = NULL,
             claim_token = NULL, claim_expires_at = NULL,
             progress_total = CASE WHEN ? THEN 0 ELSE progress_total END,
             progress_completed = CASE WHEN ? THEN 0 ELSE progress_completed END,
             progress_failed = CASE WHEN ? THEN 0 ELSE progress_failed END,
             result_json = CASE WHEN ? THEN NULL ELSE result_json END,
             completed_at = NULL,
             updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND organisation_id = ?
         AND (
           status IN ('queue_failed','failed','partially_failed')
           OR (
             status = 'queued'
             AND updated_at <= unixepoch() - ${STALE_QUEUED_OPERATION_SECONDS}
           )
           OR (
             status = 'running' AND claim_expires_at IS NOT NULL
             AND claim_expires_at <= unixepoch()
           )
         )
    `,
    )
      .bind(
        restartCalendarFanout,
        restartCalendarFanout,
        restartCalendarFanout,
        restartCalendarFanout,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      )
      .run();
    if ((update.meta.changes ?? 0) !== 1)
      throw new Error("The operation changed before it could be retried.");
    try {
      await this.env.OPERATIONS_QUEUE.send(message);
    } catch (error) {
      await this.markQueueFailure(
        operationId,
        error instanceof Error ? error.message : String(error),
      );
      throw new OperationQueueUnavailableError(operationId);
    }
    await this.env.DB.prepare(
      `
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, 'operation.retried', 'operation', ?, '{}', unixepoch())
    `,
    )
      .bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
      )
      .run();
  }

  private async markQueueFailure(operationId: string, error: string) {
    await this.env.DB.prepare(
      `
      UPDATE operation_jobs
         SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
       WHERE id = ? AND status = 'queued'
    `,
    )
      .bind(error.slice(0, 2_000), operationId)
      .run();
  }
}
