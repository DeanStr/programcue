import type { Viewer } from "~/platform/auth/authorize.server";

const STALE_QUEUED_OPERATION_SECONDS = 60;

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
  startedAt: number | null;
  requestedByName: string | null;
  correlationId: string;
  cancellable: boolean;
  scope: string | null;
  warning: string | null;
  retryable: boolean;
};

export type OperationApiListItem = {
  id: string;
  type: string;
  status: string;
  idempotencyKey: string;
  operationCorrelationId: string;
  progressTotal: number;
  progressCompleted: number;
  progressFailed: number;
  attemptCount: number;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
};

export type OperationDetailItem = {
  id: string;
  itemKey: string;
  entityType: string | null;
  entityId: string | null;
  status: string;
  attemptCount: number;
  errorCode: string | null;
  errorMessage: string | null;
  result: unknown;
  startedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
};

export type OperationAuditItem = {
  id: string;
  action: string;
  actorName: string;
  metadata: unknown;
  createdAt: number;
};

export type OperationDetail = {
  items: OperationDetailItem[];
  audit: OperationAuditItem[];
};

export const activityAreas = [
  "evaluation",
  "schedule",
  "integration",
  "permission",
  "communication",
  "session",
  "data",
  "other",
] as const;

export type ActivityArea = (typeof activityAreas)[number];

export type ActivityTimelineItem = {
  id: string;
  action: string;
  area: ActivityArea;
  actorName: string;
  actorPersonId: string | null;
  entityType: string;
  entityId: string | null;
  correlationId: string | null;
  metadata: unknown;
  createdAt: number;
};

export function parseJsonRecord(value: string | null, context: string) {
  if (value === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${context} contains invalid JSON.`);
  }
  return parsed;
}

export class OperationReadService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async eventTimezone(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      `SELECT timezone FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ timezone: string }>();
    if (!event) throw new Response("This event could not be found.", { status: 404 });
    if (!event.timezone.trim()) {
      throw new Error("The event timezone is missing.");
    }
    return event.timezone;
  }

  async listApi(
    scope: { organisationId: string; eventId: string },
    options: {
      limit: number;
      cursor: { sort: number; id: string } | null;
    },
  ) {
    const limit = Math.max(1, Math.min(200, Math.trunc(options.limit)));
    const rows = await this.env.DB.prepare(
      `SELECT operation.id, operation.type, operation.status,
              operation.idempotency_key AS idempotencyKey,
              operation.correlation_id AS operationCorrelationId,
              operation.progress_total AS progressTotal,
              operation.progress_completed AS progressCompleted,
              operation.progress_failed AS progressFailed,
              operation.attempt_count AS attemptCount,
              operation.last_error AS lastError,
              operation.created_at AS createdAt,
              operation.updated_at AS updatedAt,
              operation.completed_at AS completedAt
         FROM operation_jobs operation
         JOIN events event ON event.id = operation.event_id
                          AND event.organisation_id = ?
        WHERE operation.event_id = ?
          ${options.cursor ? "AND (operation.created_at < ? OR (operation.created_at = ? AND operation.id < ?))" : ""}
        ORDER BY operation.created_at DESC, operation.id DESC
        LIMIT ?`,
    )
      .bind(
        scope.organisationId,
        scope.eventId,
        ...(options.cursor
          ? [options.cursor.sort, options.cursor.sort, options.cursor.id]
          : []),
        limit + 1,
      )
      .all<OperationApiListItem>();
    return {
      items: rows.results.slice(0, limit),
      hasMore: rows.results.length > limit,
    };
  }

  async list(viewer: Viewer, limit = 100): Promise<OperationListItem[]> {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const result = await this.env.DB.prepare(
      `
      SELECT o.id, o.type, o.status, o.attempt_count AS attemptCount,
             COALESCE(o.progress_completed, 0) AS progressCurrent,
             o.progress_total AS progressTotal, o.last_error AS lastError,
             o.created_at AS createdAt, o.updated_at AS updatedAt,
             o.started_at AS startedAt, o.completed_at AS completedAt,
             p.display_name AS requestedByName, o.correlation_id AS correlationId,
             o.cancellable,
             COALESCE(
               json_extract(o.payload_json, '$.communicationId'),
               json_extract(o.payload_json, '$.scheduleVersionId'),
               json_extract(o.payload_json, '$.invitationId'),
               json_extract(o.payload_json, '$.submissionId'),
               json_extract(o.payload_json, '$.runId'),
               json_extract(o.payload_json, '$.deliveryId')
             ) AS scope,
             json_extract(o.result_json, '$.realtimeWarning') AS warning,
             CASE
               WHEN o.type NOT IN (
                 'communication.send', 'calendar.sync', 'decision.notification',
                 'submission.notification', 'schedule.calendar_fanout',
                 'integration.accelevents.export', 'webhook.deliver',
                 'file.scan.dispatch'
               ) THEN 0
               WHEN o.type = 'communication.send' AND EXISTS (
                 SELECT 1 FROM communications communication
                 JOIN communication_deliveries delivery
                   ON delivery.communication_id = communication.id
                  AND delivery.event_id = communication.event_id
                 JOIN submission_speakers speaker
                   ON speaker.id = delivery.source_id
                  AND speaker.event_id = delivery.event_id
                WHERE communication.operation_id = o.id
                  AND communication.event_id = o.event_id
                  AND json_extract(communication.audience_json, '$.type') =
                      'co_speaker_invitation'
                  AND json_extract(communication.audience_json, '$.speakerId') =
                      speaker.id
               ) THEN 0
               WHEN o.status IN ('queue_failed','failed','partially_failed') THEN 1
               WHEN o.status = 'queued'
                    AND o.updated_at <= unixepoch() - ${STALE_QUEUED_OPERATION_SECONDS} THEN 1
               WHEN o.status = 'running' AND o.claim_expires_at IS NOT NULL
                    AND o.claim_expires_at <= unixepoch() THEN 1
               ELSE 0
             END AS retryable
        FROM operation_jobs o
        JOIN events e ON e.id = o.event_id
        LEFT JOIN people p ON p.id = o.requested_by_person_id
       WHERE o.event_id = ? AND e.organisation_id = ?
       ORDER BY o.created_at DESC
       LIMIT ?
    `,
    )
      .bind(viewer.eventId, viewer.organisationId, safeLimit)
      .all<
        Omit<OperationListItem, "retryable" | "cancellable"> & {
          retryable: number;
          cancellable: number;
        }
      >();
    return result.results.map((operation) => ({
      ...operation,
      retryable: operation.retryable === 1,
      cancellable: operation.cancellable === 1,
    }));
  }

  async find(
    viewer: Viewer,
    operationId: string,
  ): Promise<OperationListItem | null> {
    const operation = await this.env.DB.prepare(
      `SELECT o.id, o.type, o.status, o.attempt_count AS attemptCount,
              COALESCE(o.progress_completed, 0) AS progressCurrent,
              o.progress_total AS progressTotal, o.last_error AS lastError,
              o.created_at AS createdAt, o.updated_at AS updatedAt,
              o.started_at AS startedAt, o.completed_at AS completedAt,
              p.display_name AS requestedByName, o.correlation_id AS correlationId,
              o.cancellable,
              COALESCE(
                json_extract(o.payload_json, '$.communicationId'),
                json_extract(o.payload_json, '$.scheduleVersionId'),
                json_extract(o.payload_json, '$.invitationId'),
                json_extract(o.payload_json, '$.submissionId'),
                json_extract(o.payload_json, '$.runId'),
                json_extract(o.payload_json, '$.deliveryId')
              ) AS scope,
              json_extract(o.result_json, '$.realtimeWarning') AS warning,
              CASE
                WHEN o.type NOT IN (
                  'communication.send', 'calendar.sync', 'decision.notification',
                  'submission.notification', 'schedule.calendar_fanout',
                  'integration.accelevents.export', 'webhook.deliver',
                  'file.scan.dispatch'
                ) THEN 0
                WHEN o.type = 'communication.send' AND EXISTS (
                  SELECT 1 FROM communications communication
                  JOIN communication_deliveries delivery
                    ON delivery.communication_id = communication.id
                   AND delivery.event_id = communication.event_id
                  JOIN submission_speakers speaker
                    ON speaker.id = delivery.source_id
                   AND speaker.event_id = delivery.event_id
                 WHERE communication.operation_id = o.id
                   AND communication.event_id = o.event_id
                   AND json_extract(communication.audience_json, '$.type') =
                       'co_speaker_invitation'
                   AND json_extract(communication.audience_json, '$.speakerId') =
                       speaker.id
                ) THEN 0
                WHEN o.status IN ('queue_failed','failed','partially_failed') THEN 1
                WHEN o.status = 'queued'
                     AND o.updated_at <= unixepoch() - ${STALE_QUEUED_OPERATION_SECONDS} THEN 1
                WHEN o.status = 'running' AND o.claim_expires_at IS NOT NULL
                     AND o.claim_expires_at <= unixepoch() THEN 1
                ELSE 0
              END AS retryable
         FROM operation_jobs o
         JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
         LEFT JOIN people p ON p.id = o.requested_by_person_id
        WHERE o.id = ? AND o.event_id = ?
        LIMIT 1`,
    )
      .bind(viewer.organisationId, operationId, viewer.eventId)
      .first<
        Omit<OperationListItem, "retryable" | "cancellable"> & {
          retryable: number;
          cancellable: number;
        }
      >();
    return operation
      ? {
          ...operation,
          retryable: operation.retryable === 1,
          cancellable: operation.cancellable === 1,
        }
      : null;
  }

  async detail(viewer: Viewer, operationId: string): Promise<OperationDetail> {
    const exists = await this.env.DB.prepare(
      `
      SELECT 1
        FROM operation_jobs o
        JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
       WHERE o.id = ? AND o.event_id = ?
       LIMIT 1
    `,
    )
      .bind(viewer.organisationId, operationId, viewer.eventId)
      .first();
    if (!exists) throw new Response("Operation not found", { status: 404 });

    const [items, audit] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT oi.id, oi.item_key AS itemKey, oi.entity_type AS entityType,
               oi.entity_id AS entityId, oi.status,
               oi.attempt_count AS attemptCount, oi.error_code AS errorCode,
               oi.error_message AS errorMessage, oi.result_json AS resultJson,
               oi.started_at AS startedAt, oi.completed_at AS completedAt,
               oi.updated_at AS updatedAt
          FROM operation_items oi
         WHERE oi.operation_id = ?
         ORDER BY CASE oi.status
                    WHEN 'failed' THEN 0 WHEN 'running' THEN 1
                    WHEN 'pending' THEN 2 ELSE 3 END,
                  oi.updated_at DESC, oi.id
      `,
      )
        .bind(operationId)
        .all<{
          id: string;
          itemKey: string;
          entityType: string | null;
          entityId: string | null;
          status: string;
          attemptCount: number;
          errorCode: string | null;
          errorMessage: string | null;
          resultJson: string | null;
          startedAt: number | null;
          completedAt: number | null;
          updatedAt: number;
        }>(),
      this.env.DB.prepare(
        `
        SELECT a.id, a.action, COALESCE(p.display_name, a.actor_id, 'System') AS actorName,
               a.metadata_json AS metadataJson, a.created_at AS createdAt
          FROM audit_events a
          LEFT JOIN people p ON p.id = a.actor_person_id
         WHERE a.event_id = ?
           AND (
             (a.entity_type = 'operation' AND a.entity_id = ?)
             OR json_extract(a.metadata_json, '$.operationId') = ?
           )
         ORDER BY a.created_at DESC, a.id DESC
         LIMIT 50
      `,
      )
        .bind(viewer.eventId, operationId, operationId)
        .all<{
          id: string;
          action: string;
          actorName: string;
          metadataJson: string;
          createdAt: number;
        }>(),
    ]);

    return {
      items: items.results.map(({ resultJson, ...item }) => ({
        ...item,
        result: parseJsonRecord(resultJson, `Operation item ${item.id}`),
      })),
      audit: audit.results.map(({ metadataJson, ...item }) => ({
        ...item,
        metadata: parseJsonRecord(metadataJson, `Audit event ${item.id}`),
      })),
    };
  }

  async activity(
    viewer: Viewer,
    filters: { area?: string; actorPersonId?: string; query?: string } = {},
    limit = 200,
  ): Promise<ActivityTimelineItem[]> {
    const area = activityAreas.includes(filters.area as ActivityArea)
      ? (filters.area as ActivityArea)
      : null;
    const actorPersonId = filters.actorPersonId?.trim() || null;
    const query = filters.query?.trim().slice(0, 120) || null;
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = await this.env.DB.prepare(
      `WITH scoped AS (
         SELECT a.id, a.action, a.actor_person_id AS actorPersonId,
                COALESCE(p.display_name, a.actor_id, 'System') AS actorName,
                a.entity_type AS entityType, a.entity_id AS entityId,
                a.correlation_id AS correlationId,
                a.metadata_json AS metadataJson, a.created_at AS createdAt,
                CASE
                  WHEN a.action LIKE 'decision%' OR a.action LIKE 'review%'
                    OR a.action LIKE 'evaluation%' OR a.action LIKE 'assignment%'
                    THEN 'evaluation'
                  WHEN a.action LIKE 'schedule%' OR a.action LIKE 'programme%'
                    OR a.entity_type IN ('schedule_version','schedule_entry','schedule_conflict')
                    THEN 'schedule'
                  WHEN a.action LIKE 'integration%' OR a.action LIKE 'airtable%'
                    OR a.action LIKE 'accelevents%' OR a.action LIKE 'calendar%'
                    OR a.action LIKE 'webhook%' OR a.entity_type IN ('integration','integration_run','webhook_endpoint','webhook_delivery')
                    THEN 'integration'
                  WHEN a.action LIKE 'membership%' OR a.action LIKE 'permission%'
                    OR a.action LIKE 'api_key%' OR a.entity_type IN ('membership','api_key')
                    THEN 'permission'
                  WHEN a.action LIKE 'communication%' OR a.action LIKE 'email%'
                    OR a.entity_type IN ('communication','communication_delivery','communication_template')
                    THEN 'communication'
                  WHEN a.action LIKE 'session%' OR a.entity_type IN ('session','session_tag')
                    THEN 'session'
                  WHEN a.action LIKE 'data_%' OR a.action LIKE 'event_clone%'
                    OR a.entity_type IN ('import_row','export','event')
                    THEN 'data'
                  ELSE 'other'
                END AS area
           FROM audit_events a
           JOIN events e ON e.id = a.event_id AND e.organisation_id = ?
           LEFT JOIN people p ON p.id = a.actor_person_id
          WHERE a.event_id = ?
       )
       SELECT id, action, actorPersonId, actorName, entityType, entityId,
              correlationId, metadataJson, createdAt, area
         FROM scoped
        WHERE (? IS NULL OR area = ?)
          AND (? IS NULL OR actorPersonId = ?)
          AND (
            ? IS NULL OR lower(action) LIKE '%' || lower(?) || '%'
            OR lower(COALESCE(entityId, '')) LIKE '%' || lower(?) || '%'
            OR lower(actorName) LIKE '%' || lower(?) || '%'
          )
        ORDER BY createdAt DESC, id DESC
        LIMIT ?`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        area,
        area,
        actorPersonId,
        actorPersonId,
        query,
        query,
        query,
        query,
        safeLimit,
      )
      .all<{
        id: string;
        action: string;
        actorPersonId: string | null;
        actorName: string;
        entityType: string;
        entityId: string | null;
        correlationId: string | null;
        metadataJson: string;
        createdAt: number;
        area: ActivityArea;
      }>();
    return rows.results.map(({ metadataJson, ...row }) => ({
      ...row,
      metadata: parseJsonRecord(metadataJson, `Audit event ${row.id}`),
    }));
  }
}
