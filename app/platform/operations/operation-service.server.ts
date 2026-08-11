import type { Viewer } from "~/platform/auth/authorize.server";
import {
  OperationReadService,
  parseJsonRecord,
  type ActivityTimelineItem,
  type OperationDetail,
  type OperationListItem,
} from "./operation-read-service.server";
export { activityAreas } from "./operation-read-service.server";
export type {
  ActivityArea,
  ActivityTimelineItem,
  OperationApiListItem,
  OperationAuditItem,
  OperationDetail,
  OperationDetailItem,
  OperationListItem,
} from "./operation-read-service.server";
import { CommunicationDeliveryService } from "~/modules/communications/communication-delivery-service.server";
import { integrationRunMessageSchema } from "~/modules/integrations/integration-service.server";
import { TaskBulkService } from "~/modules/tasks/task-bulk-service.server";

const STALE_QUEUED_OPERATION_SECONDS = 60;
const retryableOperationTypes = new Set([
  "communication.send",
  "calendar.sync",
  "decision.notification",
  "submission.notification",
  "schedule.calendar_fanout",
  "integration.accelevents.export",
  "webhook.deliver",
  "file.scan.dispatch",
]);

export class OperationQueueUnavailableError extends Error {
  constructor(readonly operationId: string) {
    super(
      `Operation ${operationId} was saved but could not be queued. Retry it from the operation centre.`,
    );
    this.name = "OperationQueueUnavailableError";
  }
}

export class OperationNotFoundError extends Error {
  constructor() {
    super("Operation not found.");
    this.name = "OperationNotFoundError";
  }
}

export class OperationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationStateError";
  }
}

function parseRetryQueueMessage(
  payloadJson: string,
  operation: { id: string; type: string },
  viewer: Pick<Viewer, "eventId" | "organisationId">,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new OperationStateError(
      "The saved operation payload is invalid and cannot be retried.",
    );
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    (parsed as Record<string, unknown>).type !== operation.type ||
    (parsed as Record<string, unknown>).operationId !== operation.id ||
    (parsed as Record<string, unknown>).eventId !== viewer.eventId ||
    (parsed as Record<string, unknown>).organisationId !== viewer.organisationId
  ) {
    throw new OperationStateError(
      "The saved operation payload does not match the operation tenant identity and cannot be retried.",
    );
  }
  return parsed as Record<string, unknown>;
}

export class OperationService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private readService() {
    return new OperationReadService(this.env);
  }

  eventTimezone(viewer: Viewer) {
    return this.readService().eventTimezone(viewer);
  }

  listApi(
    scope: { organisationId: string; eventId: string },
    options: { limit: number; cursor: { sort: number; id: string } | null },
  ) {
    return this.readService().listApi(scope, options);
  }

  list(viewer: Viewer, limit = 100): Promise<OperationListItem[]> {
    return this.readService().list(viewer, limit);
  }

  find(viewer: Viewer, operationId: string): Promise<OperationListItem | null> {
    return this.readService().find(viewer, operationId);
  }

  detail(viewer: Viewer, operationId: string): Promise<OperationDetail> {
    return this.readService().detail(viewer, operationId);
  }

  activity(
    viewer: Viewer,
    filters: { area?: string; actorPersonId?: string; query?: string } = {},
    limit = 200,
  ): Promise<ActivityTimelineItem[]> {
    return this.readService().activity(viewer, filters, limit);
  }

  async cancel(viewer: Viewer, operationId: string) {
    const operation = await this.env.DB.prepare(
      `
      SELECT o.id, o.type, o.payload_json AS payloadJson, o.cancellable,
             o.status
        FROM operation_jobs o
        JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
       WHERE o.id = ? AND o.event_id = ?
       LIMIT 1
    `,
    )
      .bind(viewer.organisationId, operationId, viewer.eventId)
      .first<{
        id: string;
        type: string;
        payloadJson: string;
        cancellable: number;
        status: string;
      }>();
    if (!operation) throw new OperationNotFoundError();
    if (operation.cancellable !== 1) {
      throw new OperationStateError(
        "This operation cannot be cancelled safely after durable intent was recorded.",
      );
    }
    if (operation.type === "task.bulk") {
      await new TaskBulkService(this.env).cancel(viewer, operationId);
      return;
    }
    if (operation.type === "data.import" || operation.type === "session.bulk") {
      const previewKind = operation.type === "data.import" ? "import" : "bulk";
      const auditAction =
        operation.type === "data.import"
          ? "data_import.cancelled"
          : "session_bulk.cancelled";
      const results = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE operation_jobs SET status = 'cancelled', completed_at = unixepoch(),
                  cancellable = 0, last_error = NULL, updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND organisation_id = ?
              AND type = ? AND status = 'received' AND cancellable = 1`,
        ).bind(
          operationId,
          viewer.eventId,
          viewer.organisationId,
          operation.type,
        ),
        this.env.DB.prepare(
          `UPDATE operation_items SET status = 'skipped',
                  error_code = ?, error_message = ?,
                  completed_at = unixepoch(), updated_at = unixepoch()
            WHERE operation_id = ? AND status = 'pending'
              AND EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'cancelled')`,
        ).bind(
          operation.type === "data.import"
            ? "IMPORT_CANCELLED"
            : "BULK_CANCELLED",
          `The ${previewKind} preview was cancelled before commitment.`,
          operationId,
          operationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, metadata_json, created_at
           ) SELECT ?, ?, ?, ?, ?, 'operation', ?, '{}', unixepoch()
              WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'cancelled')`,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          auditAction,
          operationId,
          operationId,
        ),
      ]);
      if ((results[0].meta.changes ?? 0) !== 1) {
        throw new OperationStateError(
          `Only an uncommitted ${previewKind} preview can be cancelled.`,
        );
      }
      return;
    }
    if (operation.type !== "communication.send") {
      throw new OperationStateError(
        `Cancellation is not implemented for operation type ${operation.type}.`,
      );
    }
    const payload = parseJsonRecord(
      operation.payloadJson,
      `Operation ${operation.id}`,
    );
    const communicationId =
      typeof payload === "object" &&
      payload !== null &&
      "communicationId" in payload &&
      typeof payload.communicationId === "string"
        ? payload.communicationId
        : null;
    if (!communicationId) {
      throw new Error(
        "The communication operation payload is missing its communication id.",
      );
    }
    await new CommunicationDeliveryService(this.env).cancel(
      viewer,
      communicationId,
    );
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
    if (!operation) throw new OperationNotFoundError();
    if (!retryableOperationTypes.has(operation.type)) {
      throw new OperationStateError(
        `Operation type ${operation.type} has no retryable Queue consumer. Start a new preview from its owning workflow instead.`,
      );
    }
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
      throw new OperationStateError(
        "Only failed operations, stale queued operations or operations with an expired processing lease can be retried.",
      );
    }
    if (!this.env.OPERATIONS_QUEUE)
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    const savedMessage = parseRetryQueueMessage(
      operation.payloadJson,
      operation,
      viewer,
    );
    let message = savedMessage;
    let communicationId: string | null = null;
    if (operation.type === "communication.send") {
      communicationId =
        typeof savedMessage.communicationId === "string" &&
        savedMessage.communicationId.length > 0
          ? savedMessage.communicationId
          : null;
      if (!communicationId) {
        throw new OperationStateError(
          "The saved communication operation is missing its communication identity and cannot be retried.",
        );
      }
      message = { ...savedMessage };
      delete message.includeFailed;
    }
    const restartCalendarFanout =
      operation.type === "schedule.calendar_fanout" &&
      ["failed", "partially_failed"].includes(operation.status) &&
      typeof message === "object" &&
      message !== null &&
      !Object.hasOwn(message, "afterTarget");
    const operationUpdate = this.env.DB.prepare(
      `
      UPDATE operation_jobs
         SET status = 'queued', last_error = NULL,
             claim_token = NULL, claim_expires_at = NULL,
             progress_total = CASE WHEN ? THEN 0 ELSE progress_total END,
             progress_completed = CASE WHEN ? OR ? THEN 0 ELSE progress_completed END,
             progress_failed = CASE WHEN ? OR ? THEN 0 ELSE progress_failed END,
             result_json = CASE WHEN ? OR ? THEN NULL ELSE result_json END,
             payload_json = CASE WHEN ? THEN ? ELSE payload_json END,
             completed_at = NULL,
             updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND organisation_id = ?
         AND payload_json = ?
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
    ).bind(
      restartCalendarFanout,
      restartCalendarFanout,
      operation.type === "communication.send",
      restartCalendarFanout,
      operation.type === "communication.send",
      restartCalendarFanout,
      operation.type === "communication.send",
      operation.type === "communication.send",
      JSON.stringify(message),
      operationId,
      viewer.eventId,
      viewer.organisationId,
      operation.payloadJson,
    );
    const update = communicationId
      ? (
          await this.env.DB.batch([
            this.env.DB.prepare(
              `UPDATE operation_items
                  SET status = 'pending', error_code = NULL, error_message = NULL,
                      started_at = NULL, completed_at = NULL, updated_at = unixepoch()
                WHERE operation_id = ? AND entity_type = 'communication_delivery'
                  AND status IN ('failed','running')
                  AND EXISTS (
                    SELECT 1 FROM operation_jobs operation
                     WHERE operation.id = operation_items.operation_id
                       AND operation.event_id = ? AND operation.organisation_id = ?
                       AND operation.type = 'communication.send'
                       AND operation.payload_json = ?
                       AND (
                         operation.status IN ('queue_failed','failed','partially_failed')
                         OR (operation.status = 'queued' AND operation.updated_at <= unixepoch() - ${STALE_QUEUED_OPERATION_SECONDS})
                         OR (operation.status = 'running' AND operation.claim_expires_at IS NOT NULL
                             AND operation.claim_expires_at <= unixepoch())
                       )
                  )`,
            ).bind(
              operationId,
              viewer.eventId,
              viewer.organisationId,
              operation.payloadJson,
            ),
            this.env.DB.prepare(
              `UPDATE communication_deliveries
                  SET status = 'queued', failure_code = NULL, failure_message = NULL,
                      next_attempt_at = NULL, updated_at = unixepoch()
                WHERE communication_id = ? AND event_id = ?
                  AND status IN ('failed','sending')
                  AND EXISTS (
                    SELECT 1 FROM operation_jobs operation
                     WHERE operation.id = ? AND operation.event_id = communication_deliveries.event_id
                       AND operation.organisation_id = ?
                       AND operation.type = 'communication.send'
                       AND operation.payload_json = ?
                       AND (
                         operation.status IN ('queue_failed','failed','partially_failed')
                         OR (operation.status = 'queued' AND operation.updated_at <= unixepoch() - ${STALE_QUEUED_OPERATION_SECONDS})
                         OR (operation.status = 'running' AND operation.claim_expires_at IS NOT NULL
                             AND operation.claim_expires_at <= unixepoch())
                       )
                  )`,
            ).bind(
              communicationId,
              viewer.eventId,
              operationId,
              viewer.organisationId,
              operation.payloadJson,
            ),
            this.env.DB.prepare(
              `UPDATE communications
                  SET status = 'queued', updated_at = unixepoch()
                WHERE id = ? AND event_id = ? AND operation_id = ?
                  AND status IN ('failed','partially_failed','sending')
                  AND EXISTS (
                    SELECT 1 FROM operation_jobs operation
                     WHERE operation.id = communications.operation_id
                       AND operation.event_id = communications.event_id
                       AND operation.organisation_id = ?
                       AND operation.type = 'communication.send'
                       AND operation.payload_json = ?
                       AND (
                         operation.status IN ('queue_failed','failed','partially_failed')
                         OR (operation.status = 'queued' AND operation.updated_at <= unixepoch() - ${STALE_QUEUED_OPERATION_SECONDS})
                         OR (operation.status = 'running' AND operation.claim_expires_at IS NOT NULL
                             AND operation.claim_expires_at <= unixepoch())
                       )
                  )`,
            ).bind(
              communicationId,
              viewer.eventId,
              operationId,
              viewer.organisationId,
              operation.payloadJson,
            ),
            operationUpdate,
          ])
        )[3]
      : await operationUpdate.run();
    if ((update.meta.changes ?? 0) !== 1)
      throw new OperationStateError(
        "The operation changed before it could be retried.",
      );
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

  async retryItem(
    viewer: Viewer,
    operationId: string,
    operationItemId: string,
  ) {
    const item = await this.acceleventsItem(
      viewer,
      operationId,
      operationItemId,
    );
    if (!this.env.OPERATIONS_QUEUE)
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    const savedMessage = parseRetryQueueMessage(
      item.payloadJson,
      { id: operationId, type: "integration.accelevents.export" },
      viewer,
    );
    const parsedMessage = integrationRunMessageSchema.safeParse({
      ...savedMessage,
      itemId: item.integrationItemId,
    });
    if (
      !parsedMessage.success ||
      parsedMessage.data.runId !== item.runId ||
      parsedMessage.data.connectionId !== item.connectionId
    ) {
      throw new OperationStateError(
        "The saved Accelevents payload does not match the failed run item and cannot be retried.",
      );
    }
    const message = parsedMessage.data;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'queued', last_error = NULL, completed_at = NULL,
                claim_token = NULL, claim_expires_at = NULL,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'integration.accelevents.export'
            AND status IN ('failed','partially_failed')
            AND claim_token IS NULL
            AND EXISTS (
              SELECT 1
                FROM operation_items operation_item
                JOIN integration_runs run ON run.operation_id = operation_jobs.id
                JOIN integration_run_items run_item
                  ON run_item.run_id = run.id
                 AND run_item.entity_type = operation_item.entity_type
                 AND run_item.entity_id = operation_item.entity_id
               WHERE operation_item.id = ?
                 AND operation_item.operation_id = operation_jobs.id
                 AND operation_item.status = 'failed'
                 AND run_item.id = ?
                 AND run_item.status IN ('pending','running','failed')
            )`,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        operationItemId,
        item.integrationItemId,
      ),
      this.env.DB.prepare(
        `UPDATE integration_runs
            SET status = 'queued', completed_at = NULL
          WHERE id = ? AND operation_id = ?
            AND status IN ('running','failed','partially_failed')
            AND EXISTS (SELECT 1 FROM operation_jobs
                         WHERE id = ? AND status = 'queued')`,
      ).bind(item.runId, operationId, operationId),
      this.env.DB.prepare(
        `UPDATE integration_run_items
            SET status = 'pending', error_code = NULL, error_message = NULL,
                updated_at = unixepoch()
          WHERE id = ? AND run_id = ?
            AND status IN ('pending','running','failed')
            AND EXISTS (SELECT 1 FROM operation_jobs
                         WHERE id = ? AND status = 'queued')`,
      ).bind(item.integrationItemId, item.runId, operationId),
      this.env.DB.prepare(
        `UPDATE operation_items
            SET status = 'pending', error_code = NULL, error_message = NULL,
                completed_at = NULL, updated_at = unixepoch()
          WHERE id = ? AND operation_id = ? AND status = 'failed'
            AND EXISTS (SELECT 1 FROM operation_jobs
                         WHERE id = ? AND status = 'queued')`,
      ).bind(operationItemId, operationId, operationId),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1 ||
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    ) {
      throw new OperationStateError(
        "The Accelevents item or processing lease changed before it could be retried.",
      );
    }
    try {
      await this.env.OPERATIONS_QUEUE.send(message);
    } catch (error) {
      await this.markAcceleventsItemQueueFailure(
        viewer,
        operationId,
        operationItemId,
        item.runId,
        item.integrationItemId,
        item.itemKey,
        error instanceof Error ? error.message : String(error),
      );
      throw new OperationQueueUnavailableError(operationId);
    }
    await this.env.DB.prepare(
      `INSERT INTO audit_events (
         id, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, 'integration.run.item_retried',
                 'integration_run_item', ?, ?, unixepoch())`,
    )
      .bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        item.integrationItemId,
        JSON.stringify({ operationId, itemKey: item.itemKey }),
      )
      .run();
  }

  async skipItem(
    viewer: Viewer,
    operationId: string,
    operationItemId: string,
    rawReason: string,
  ) {
    const reason = rawReason.trim();
    if (reason.length < 5 || reason.length > 500) {
      throw new OperationStateError(
        "Explain why this Accelevents record is being skipped (5–500 characters).",
      );
    }
    const item = await this.acceleventsItem(
      viewer,
      operationId,
      operationItemId,
    );
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE integration_run_items
            SET status = 'skipped', error_code = 'OPERATOR_SKIPPED',
                error_message = ?,
                diff_json = json_set(diff_json, '$.operatorSkipReason', ?),
                updated_at = unixepoch()
          WHERE id = ? AND run_id = ?
            AND status IN ('pending','running','failed')
            AND EXISTS (
              SELECT 1
                FROM integration_runs run
                JOIN operation_jobs operation ON operation.id = run.operation_id
                JOIN events event ON event.id = operation.event_id
               WHERE run.id = integration_run_items.run_id
                 AND operation.id = ? AND operation.event_id = ?
                 AND operation.organisation_id = ?
                 AND event.organisation_id = ?
                 AND operation.type = 'integration.accelevents.export'
                 AND operation.status IN ('failed','partially_failed')
                 AND operation.claim_token IS NULL
            )`,
      ).bind(
        reason,
        reason,
        item.integrationItemId,
        item.runId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE operation_items
            SET status = 'skipped', error_code = 'OPERATOR_SKIPPED',
                error_message = ?, completed_at = unixepoch(),
                result_json = json_set(COALESCE(result_json, '{}'),
                                       '$.operatorSkipReason', ?),
                updated_at = unixepoch()
          WHERE id = ? AND operation_id = ? AND status = 'failed'
            AND EXISTS (SELECT 1 FROM integration_run_items
                         WHERE id = ? AND status = 'skipped')`,
      ).bind(
        reason,
        reason,
        operationItemId,
        operationId,
        item.integrationItemId,
      ),
      this.env.DB.prepare(
        `UPDATE integration_runs
            SET status = CASE
                  WHEN EXISTS (SELECT 1 FROM integration_run_items
                               WHERE run_id = integration_runs.id AND status = 'failed')
                    THEN 'partially_failed'
                  ELSE 'succeeded'
                END,
                summary_json = json_set(
                  summary_json,
                  '$.completed', (SELECT COUNT(*) FROM integration_run_items
                                   WHERE run_id = integration_runs.id
                                     AND status IN ('succeeded','skipped')),
                  '$.failed', (SELECT COUNT(*) FROM integration_run_items
                                WHERE run_id = integration_runs.id
                                  AND status = 'failed'),
                  '$.skipped', (SELECT COUNT(*) FROM integration_run_items
                                 WHERE run_id = integration_runs.id
                                   AND status = 'skipped')
                ),
                completed_at = unixepoch()
          WHERE id = ? AND operation_id = ?
            AND EXISTS (SELECT 1 FROM integration_run_items
                         WHERE id = ? AND status = 'skipped')`,
      ).bind(item.runId, operationId, item.integrationItemId),
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM integration_runs run
                    JOIN integration_run_items run_item ON run_item.run_id = run.id
                    WHERE run.operation_id = operation_jobs.id
                      AND run_item.status = 'failed'
                  ) THEN 'partially_failed'
                  ELSE 'completed'
                END,
                progress_total = (SELECT COUNT(*) FROM operation_items
                                   WHERE operation_id = operation_jobs.id),
                progress_completed = (SELECT COUNT(*) FROM operation_items
                                       WHERE operation_id = operation_jobs.id
                                         AND status IN ('completed','skipped')),
                progress_failed = (SELECT COUNT(*) FROM operation_items
                                    WHERE operation_id = operation_jobs.id
                                      AND status = 'failed'),
                result_json = json_object(
                  'total', (SELECT COUNT(*) FROM operation_items
                            WHERE operation_id = operation_jobs.id),
                  'completed', (SELECT COUNT(*) FROM operation_items
                                WHERE operation_id = operation_jobs.id
                                  AND status IN ('completed','skipped')),
                  'failed', (SELECT COUNT(*) FROM operation_items
                             WHERE operation_id = operation_jobs.id
                               AND status = 'failed'),
                  'skipped', (SELECT COUNT(*) FROM operation_items
                              WHERE operation_id = operation_jobs.id
                                AND status = 'skipped')
                ),
                last_error = CASE
                  WHEN EXISTS (SELECT 1 FROM operation_items
                               WHERE operation_id = operation_jobs.id
                                 AND status = 'failed')
                    THEN (SELECT COUNT(*) || ' integration record(s) failed.'
                          FROM operation_items
                          WHERE operation_id = operation_jobs.id
                            AND status = 'failed')
                  ELSE NULL
                END,
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'integration.accelevents.export'
            AND status IN ('failed','partially_failed')
            AND claim_token IS NULL
            AND EXISTS (SELECT 1 FROM operation_items
                         WHERE id = ? AND status = 'skipped')`,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        operationItemId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'integration.run.item_skipped',
                  'integration_run_item', ?, ?, unixepoch()
            WHERE EXISTS (SELECT 1 FROM operation_items
                           WHERE id = ? AND status = 'skipped')`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        item.integrationItemId,
        JSON.stringify({ operationId, itemKey: item.itemKey, reason }),
        operationItemId,
      ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1 ||
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1 ||
      (results[4]?.meta.changes ?? 0) !== 1
    ) {
      throw new OperationStateError(
        "The Accelevents item or processing lease changed before it could be skipped.",
      );
    }
  }

  private async acceleventsItem(
    viewer: Viewer,
    operationId: string,
    operationItemId: string,
  ) {
    const item = await this.env.DB.prepare(
      `SELECT operation.payload_json AS payloadJson,
              operation_item.item_key AS itemKey,
              run.id AS runId,
              run.connection_id AS connectionId,
              run_item.id AS integrationItemId
         FROM operation_items operation_item
         JOIN operation_jobs operation ON operation.id = operation_item.operation_id
         JOIN events event ON event.id = operation.event_id
         JOIN integration_runs run ON run.operation_id = operation.id
         JOIN integration_run_items run_item
           ON run_item.run_id = run.id
          AND run_item.entity_type = operation_item.entity_type
          AND run_item.entity_id = operation_item.entity_id
        WHERE operation.id = ? AND operation_item.id = ?
          AND operation.event_id = ? AND operation.organisation_id = ?
          AND event.organisation_id = ?
          AND operation.type = 'integration.accelevents.export'
          AND operation.status IN ('failed','partially_failed')
          AND operation.claim_token IS NULL
          AND operation_item.status = 'failed'
          AND run.status IN ('running','failed','partially_failed')
          AND run_item.status IN ('pending','running','failed')
        LIMIT 1`,
    )
      .bind(
        operationId,
        operationItemId,
        viewer.eventId,
        viewer.organisationId,
        viewer.organisationId,
      )
      .first<{
        payloadJson: string;
        itemKey: string;
        runId: string;
        connectionId: string;
        integrationItemId: string;
      }>();
    if (!item) {
      throw new OperationStateError(
        "Only a failed Accelevents run item without an active processing lease can be changed.",
      );
    }
    return item;
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

  private async markAcceleventsItemQueueFailure(
    viewer: Viewer,
    operationId: string,
    operationItemId: string,
    runId: string,
    integrationItemId: string,
    itemKey: string,
    error: string,
  ) {
    const failure = error.slice(0, 2_000);
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE operation_items
            SET status = 'failed', error_code = 'QUEUE_UNAVAILABLE',
                error_message = ?, completed_at = unixepoch(),
                updated_at = unixepoch()
          WHERE id = ? AND operation_id = ? AND status = 'pending'
            AND EXISTS (
              SELECT 1 FROM operation_jobs operation
               WHERE operation.id = operation_items.operation_id
                 AND operation.event_id = ? AND operation.organisation_id = ?
                 AND operation.type = 'integration.accelevents.export'
                 AND operation.status = 'queued'
            )`,
      ).bind(
        failure,
        operationItemId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE integration_run_items
            SET status = 'failed', error_code = 'QUEUE_UNAVAILABLE',
                error_message = ?, updated_at = unixepoch()
          WHERE id = ? AND run_id = ? AND status = 'pending'
            AND EXISTS (
              SELECT 1
                FROM integration_runs run
                JOIN operation_jobs operation ON operation.id = run.operation_id
                JOIN operation_items item
                  ON item.operation_id = operation.id
                 AND item.id = ? AND item.status = 'failed'
               WHERE run.id = integration_run_items.run_id
                 AND operation.id = ? AND operation.event_id = ?
                 AND operation.organisation_id = ?
                 AND operation.status = 'queued'
            )`,
      ).bind(
        failure,
        integrationItemId,
        runId,
        operationItemId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE integration_runs
            SET status = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM integration_run_items item
                     WHERE item.run_id = integration_runs.id
                       AND item.status IN ('succeeded','skipped')
                  ) THEN 'partially_failed'
                  ELSE 'failed'
                END,
                summary_json = json_set(
                  summary_json,
                  '$.completed', (SELECT COUNT(*) FROM integration_run_items item
                                   WHERE item.run_id = integration_runs.id
                                     AND item.status IN ('succeeded','skipped')),
                  '$.failed', (SELECT COUNT(*) FROM integration_run_items item
                                WHERE item.run_id = integration_runs.id
                                  AND item.status = 'failed')
                ),
                completed_at = unixepoch()
          WHERE id = ? AND operation_id = ? AND status = 'queued'
            AND EXISTS (
              SELECT 1 FROM integration_run_items item
               WHERE item.id = ? AND item.run_id = integration_runs.id
                 AND item.status = 'failed'
            )`,
      ).bind(runId, operationId, integrationItemId),
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = CASE
                  WHEN EXISTS (
                    SELECT 1 FROM operation_items item
                     WHERE item.operation_id = operation_jobs.id
                       AND item.status IN ('completed','skipped')
                  ) THEN 'partially_failed'
                  ELSE 'failed'
                END,
                progress_total = (SELECT COUNT(*) FROM operation_items item
                                   WHERE item.operation_id = operation_jobs.id),
                progress_completed = (SELECT COUNT(*) FROM operation_items item
                                       WHERE item.operation_id = operation_jobs.id
                                         AND item.status IN ('completed','skipped')),
                progress_failed = (SELECT COUNT(*) FROM operation_items item
                                    WHERE item.operation_id = operation_jobs.id
                                      AND item.status = 'failed'),
                last_error = ?, completed_at = unixepoch(),
                claim_token = NULL, claim_expires_at = NULL,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'integration.accelevents.export' AND status = 'queued'
            AND EXISTS (
              SELECT 1 FROM operation_items item
               WHERE item.id = ? AND item.operation_id = operation_jobs.id
                 AND item.status = 'failed'
            )`,
      ).bind(
        `The selected Accelevents record could not be queued: ${failure}`.slice(
          0,
          2_000,
        ),
        operationId,
        viewer.eventId,
        viewer.organisationId,
        operationItemId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'integration.run.item_retry_queue_failed',
                  'integration_run_item', ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM operation_jobs
               WHERE id = ? AND event_id = ? AND organisation_id = ?
                 AND status IN ('failed','partially_failed')
            )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        integrationItemId,
        JSON.stringify({ operationId, itemKey }),
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1 ||
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    ) {
      throw new OperationStateError(
        "The Accelevents item changed while its Queue failure was being recorded.",
      );
    }
  }
}
