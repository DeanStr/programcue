import {
  AUDIT_ACTIVITY_PAGE_SIZE,
  type AuditActorKind,
  type AuditOrigin,
  type AuditScope,
  auditDisplaySummary,
  auditOperationId,
  decodeAuditActivityCursor,
  encodeAuditActivityCursor,
} from "~/platform/audit/audit-contract";
import { AuditReader } from "~/platform/audit/audit-reader.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  canAcknowledgeOperationFailure,
  genericRetryableOperationTypesSql,
} from "./operation-service-support.server";

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
  alertAcknowledgedAt: number | null;
  alertAcknowledgedByName: string | null;
  canAcknowledgeFailure: boolean;
};

export type OperationFailurePage = {
  items: OperationListItem[];
  page: number;
  pageSize: number;
  total: number;
  from: number;
  to: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

type OperationListRow = Omit<
  OperationListItem,
  "retryable" | "cancellable" | "canAcknowledgeFailure"
> & {
  retryable: number;
  cancellable: number;
};

function normalizeOperationListItem(
  operation: OperationListRow,
): OperationListItem {
  const hasAcknowledgementActor =
    operation.alertAcknowledgedByName !== null &&
    operation.alertAcknowledgedByName.trim().length > 0;
  if ((operation.alertAcknowledgedAt === null) !== !hasAcknowledgementActor) {
    throw new Error(
      `Operation ${operation.id} has inconsistent failure acknowledgement attribution.`,
    );
  }
  const normalized = {
    ...operation,
    retryable: operation.retryable === 1,
    cancellable: operation.cancellable === 1,
  };
  return {
    ...normalized,
    canAcknowledgeFailure: canAcknowledgeOperationFailure(normalized),
  };
}

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
  summary: string | null;
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
  actorKey: string;
  actorKind: AuditActorKind;
  origin: AuditOrigin;
  eventId: string | null;
  eventName: string | null;
  entityType: string;
  entityId: string | null;
  correlationId: string | null;
  operationId: string | null;
  summary: string | null;
  createdAt: number;
};

export type ActivityPage = {
  items: ActivityTimelineItem[];
  nextCursor: string | null;
};

function activityScope(value: AuditScope | undefined): AuditScope {
  const scope = value ?? "event";
  if (scope !== "event" && scope !== "organisation") {
    throw new Response("Activity scope is invalid.", { status: 400 });
  }
  return scope;
}

function activityFilter(
  value: string | undefined,
  name: string,
  maximumLength: number,
) {
  const normalized = value?.trim() ?? "";
  if (normalized.length > maximumLength) {
    throw new Response(
      `${name} must be ${maximumLength} characters or fewer.`,
      { status: 400 },
    );
  }
  return normalized;
}

export type ActivityActor = {
  key: string;
  name: string;
  kind: AuditActorKind;
};

const activityAreaSql = `CASE
  WHEN a.action LIKE 'decision%' OR a.action LIKE 'review%'
    OR a.action LIKE 'evaluation%' OR a.action LIKE 'assignment%'
    OR a.action LIKE 'ai.reviewer_suggestion.%'
    OR a.entity_type IN ('evaluator_assignment','reviewer_ai_suggestion')
    THEN 'evaluation'
  WHEN a.action LIKE 'schedule%' OR a.action LIKE 'programme%'
    OR a.entity_type IN ('schedule_version','schedule_entry','schedule_conflict')
    THEN 'schedule'
  WHEN a.action LIKE 'integration%' OR a.action LIKE 'airtable%'
    OR a.action LIKE 'accelevents%' OR a.action LIKE 'calendar%'
    OR a.action LIKE 'webhook%'
    OR a.entity_type IN ('integration','integration_run','webhook_endpoint','webhook_delivery')
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
END`;

const activityActorKeySql = `CASE
  WHEN a.actor_kind = 'person' AND a.actor_person_id IS NOT NULL
    THEN 'person:' || a.actor_person_id
  WHEN a.actor_id IS NOT NULL THEN a.actor_kind || ':' || a.actor_id
  ELSE 'kind:' || a.actor_kind
END`;

const activityActorNameSql = `CASE a.actor_kind
  WHEN 'person' THEN COALESCE(p.display_name, 'Former participant')
  WHEN 'api_key' THEN 'API key · ' || substr(a.actor_id, 1, 80)
  WHEN 'agent' THEN 'Agent · ' || substr(a.actor_id, 1, 80)
  WHEN 'provider' THEN 'Provider · ' || substr(a.actor_id, 1, 80)
  WHEN 'historical' THEN COALESCE(a.actor_id, 'Historical actor')
  ELSE CASE WHEN a.actor_id IS NULL THEN 'System'
            ELSE 'System · ' || substr(a.actor_id, 1, 80) END
END`;

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

  private async assertActivityScope(viewer: Viewer, scope: AuditScope) {
    if (scope === "event") return;
    const authorised = await this.env.DB.prepare(
      `SELECT 1
         FROM memberships
        WHERE organisation_id = ? AND event_id IS NULL AND person_id = ?
          AND role IN ('owner','administrator')
          AND accepted_at IS NOT NULL AND revoked_at IS NULL
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.personId)
      .first();
    if (!authorised) {
      throw new Response(
        "Organisation-wide owner or administrator access is required for organisation activity.",
        { status: 403, statusText: "Forbidden" },
      );
    }
  }

  async eventTimezone(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      `SELECT timezone FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ timezone: string }>();
    if (!event)
      throw new Response("This event could not be found.", { status: 404 });
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

  private async listRows(
    viewer: Viewer,
    options: {
      limit: number;
      offset: number;
      failureOnly: boolean;
      type: string;
    },
  ): Promise<OperationListItem[]> {
    if (
      !Number.isInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > 200
    ) {
      throw new Error("Operation list limit must be between 1 and 200.");
    }
    if (!Number.isSafeInteger(options.offset) || options.offset < 0) {
      throw new Error("Operation list offset must be a non-negative integer.");
    }
    const result = await this.env.DB.prepare(
      `
      SELECT o.id, o.type, o.status, o.attempt_count AS attemptCount,
             COALESCE(o.progress_completed, 0) AS progressCurrent,
             o.progress_total AS progressTotal, o.last_error AS lastError,
             o.created_at AS createdAt, o.updated_at AS updatedAt,
             o.started_at AS startedAt, o.completed_at AS completedAt,
             p.display_name AS requestedByName, o.correlation_id AS correlationId,
             o.cancellable,
             o.alert_acknowledged_at AS alertAcknowledgedAt,
             acknowledgement_person.display_name AS alertAcknowledgedByName,
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
               WHEN o.type NOT IN (${genericRetryableOperationTypesSql}) THEN 0
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
        LEFT JOIN people acknowledgement_person
          ON acknowledgement_person.id = o.alert_acknowledged_by_person_id
       WHERE o.event_id = ? AND e.organisation_id = ?
         AND (? = 0 OR o.status IN ('queue_failed','failed','partially_failed'))
         AND (? = '' OR o.type = ?)
       ORDER BY CASE
                  WHEN ? = 1 AND o.alert_acknowledged_at IS NULL THEN 0
                  ELSE 1
                END,
                o.created_at DESC,
                o.id DESC
       LIMIT ? OFFSET ?
    `,
    )
      .bind(
        viewer.eventId,
        viewer.organisationId,
        options.failureOnly ? 1 : 0,
        options.type,
        options.type,
        options.failureOnly ? 1 : 0,
        options.limit,
        options.offset,
      )
      .all<OperationListRow>();
    return result.results.map(normalizeOperationListItem);
  }

  list(viewer: Viewer, limit = 100): Promise<OperationListItem[]> {
    return this.listRows(viewer, {
      limit,
      offset: 0,
      failureOnly: false,
      type: "",
    });
  }

  async listFailurePage(
    viewer: Viewer,
    options: { page: number; pageSize: number; type: string },
  ): Promise<OperationFailurePage> {
    if (!Number.isSafeInteger(options.page) || options.page < 1) {
      throw new Response("Failure page must be a positive integer.", {
        status: 400,
      });
    }
    if (
      !Number.isInteger(options.pageSize) ||
      options.pageSize < 1 ||
      options.pageSize > 200
    ) {
      throw new Error("Failure page size must be between 1 and 200.");
    }
    const offset = (options.page - 1) * options.pageSize;
    if (!Number.isSafeInteger(offset)) {
      throw new Response("Failure page is too large.", { status: 400 });
    }
    const [items, count] = await Promise.all([
      this.listRows(viewer, {
        limit: options.pageSize,
        offset,
        failureOnly: true,
        type: options.type,
      }),
      this.env.DB.prepare(
        `SELECT COUNT(*) AS total
           FROM operation_jobs operation
           JOIN events event
             ON event.id = operation.event_id
            AND event.organisation_id = ?
          WHERE operation.event_id = ?
            AND operation.status IN ('queue_failed','failed','partially_failed')
            AND (? = '' OR operation.type = ?)`,
      )
        .bind(viewer.organisationId, viewer.eventId, options.type, options.type)
        .first<{ total: number }>(),
    ]);
    if (!count || !Number.isSafeInteger(count.total) || count.total < 0) {
      throw new Error("The failed operation count is invalid.");
    }
    const total = count.total;
    const pageCount = Math.max(1, Math.ceil(total / options.pageSize));
    if (options.page > pageCount) {
      throw new Response("This failed operation page does not exist.", {
        status: 404,
      });
    }
    return {
      items,
      page: options.page,
      pageSize: options.pageSize,
      total,
      from: total === 0 ? 0 : offset + 1,
      to: offset + items.length,
      hasPrevious: options.page > 1,
      hasNext: options.page < pageCount,
    };
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
              o.alert_acknowledged_at AS alertAcknowledgedAt,
              acknowledgement_person.display_name AS alertAcknowledgedByName,
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
                WHEN o.type NOT IN (${genericRetryableOperationTypesSql}) THEN 0
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
         LEFT JOIN people acknowledgement_person
           ON acknowledgement_person.id = o.alert_acknowledged_by_person_id
        WHERE o.id = ? AND o.event_id = ?
        LIMIT 1`,
    )
      .bind(viewer.organisationId, operationId, viewer.eventId)
      .first<OperationListRow>();
    if (!operation) return null;
    return normalizeOperationListItem(operation);
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
      new AuditReader(this.env).eventEntityHistory(
        {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
        },
        {
          entityType: "operation",
          entityId: operationId,
          relatedMetadataKey: "operationId",
          limit: 50,
        },
      ),
    ]);

    return {
      items: items.results.map(({ resultJson, ...item }) => ({
        ...item,
        result: parseJsonRecord(resultJson, `Operation item ${item.id}`),
      })),
      audit: audit.map(({ id, action, actorName, summary, createdAt }) => ({
        id,
        action,
        actorName,
        summary,
        createdAt,
      })),
    };
  }

  async activity(
    viewer: Viewer,
    options: {
      scope?: AuditScope;
      area?: string;
      actorKey?: string;
      query?: string;
      cursor?: string;
    } = {},
  ): Promise<ActivityPage> {
    const scope = activityScope(options.scope);
    await this.assertActivityScope(viewer, scope);
    const requestedArea = options.area?.trim() ?? "";
    if (
      requestedArea &&
      !activityAreas.includes(requestedArea as ActivityArea)
    ) {
      throw new Response("Activity area is invalid.", { status: 400 });
    }
    const area = requestedArea ? (requestedArea as ActivityArea) : null;
    const actorKey = activityFilter(options.actorKey, "Actor key", 420);
    const query = activityFilter(options.query, "Activity search", 120);
    const binding = {
      scope,
      organisationId: viewer.organisationId,
      eventId: scope === "event" ? viewer.eventId : null,
      area: area ?? "",
      actorKey,
      query,
    };
    const cursor = decodeAuditActivityCursor(options.cursor, binding);
    const eventPredicate = scope === "event" ? "AND a.event_id = ?" : "";
    const rows = await this.env.DB.prepare(
      `WITH scoped AS (
         SELECT a.id, a.action, a.actor_kind AS actorKind,
                a.origin, ${activityActorKeySql} AS actorKey,
                ${activityActorNameSql} AS actorName,
                a.event_id AS eventId, e.name AS eventName,
                a.entity_type AS entityType, a.entity_id AS entityId,
                a.correlation_id AS correlationId,
                a.metadata_version AS metadataVersion,
                a.metadata_json AS metadataJson, a.created_at AS createdAt,
                ${activityAreaSql} AS area
           FROM audit_events a
           LEFT JOIN events e ON e.id = a.event_id
                             AND e.organisation_id = a.organisation_id
           LEFT JOIN people p ON p.id = a.actor_person_id
          WHERE a.organisation_id = ? ${eventPredicate}
       )
       SELECT id, action, actorKind, origin, actorKey, actorName, eventId,
              eventName, entityType, entityId, correlationId, metadataVersion,
              metadataJson, createdAt, area
         FROM scoped
        WHERE (? IS NULL OR area = ?)
          AND (? = '' OR actorKey = ?)
          AND (
            ? = '' OR lower(action) LIKE '%' || lower(?) || '%'
            OR lower(COALESCE(entityId, '')) LIKE '%' || lower(?) || '%'
            OR lower(actorName) LIKE '%' || lower(?) || '%'
          )
          AND (
            ? IS NULL OR createdAt < ?
            OR (createdAt = ? AND id < ?)
          )
        ORDER BY createdAt DESC, id DESC
        LIMIT ?`,
    )
      .bind(
        viewer.organisationId,
        ...(scope === "event" ? [viewer.eventId] : []),
        area,
        area,
        actorKey,
        actorKey,
        query,
        query,
        query,
        query,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.createdAt ?? null,
        cursor?.id ?? null,
        AUDIT_ACTIVITY_PAGE_SIZE + 1,
      )
      .all<{
        id: string;
        action: string;
        actorKind: AuditActorKind;
        origin: AuditOrigin;
        actorKey: string;
        actorName: string;
        eventId: string | null;
        eventName: string | null;
        entityType: string;
        entityId: string | null;
        correlationId: string | null;
        metadataJson: string;
        metadataVersion: number;
        createdAt: number;
        area: ActivityArea;
      }>();
    const page = rows.results.slice(0, AUDIT_ACTIVITY_PAGE_SIZE);
    const items = page.map(({ metadataJson, metadataVersion, ...row }) => {
      const metadata = parseJsonRecord(metadataJson, `Audit event ${row.id}`);
      return {
        ...row,
        operationId: auditOperationId(row.action, metadataVersion, metadata),
        summary: auditDisplaySummary(row.action, metadataVersion, metadata),
      };
    });
    const oldest = items.at(-1);
    return {
      items,
      nextCursor:
        rows.results.length > AUDIT_ACTIVITY_PAGE_SIZE && oldest
          ? encodeAuditActivityCursor(binding, {
              createdAt: oldest.createdAt,
              id: oldest.id,
            })
          : null,
    };
  }

  async activityActors(
    viewer: Viewer,
    options: {
      scope?: AuditScope;
      search?: string;
      selectedKey?: string;
    } = {},
  ): Promise<ActivityActor[]> {
    const scope = activityScope(options.scope);
    await this.assertActivityScope(viewer, scope);
    const search = activityFilter(options.search, "Actor search", 80);
    const selectedKey = activityFilter(
      options.selectedKey,
      "Selected actor key",
      420,
    );
    const eventPredicate = scope === "event" ? "AND a.event_id = ?" : "";
    const actors = await this.env.DB.prepare(
      `WITH scoped AS (
         SELECT ${activityActorKeySql} AS actorKey,
                ${activityActorNameSql} AS actorName,
                a.actor_kind AS actorKind,
                MAX(a.created_at) AS lastSeenAt
           FROM audit_events a
           LEFT JOIN people p ON p.id = a.actor_person_id
          WHERE a.organisation_id = ? ${eventPredicate}
          GROUP BY actorKey, actorName, actorKind
       )
       SELECT actorKey, actorName, actorKind
         FROM scoped
        WHERE ? = '' OR lower(actorName) LIKE '%' || lower(?) || '%'
           OR actorKey = ?
        ORDER BY CASE WHEN actorKey = ? THEN 0 ELSE 1 END,
                 actorName, lastSeenAt DESC
        LIMIT 100`,
    )
      .bind(
        viewer.organisationId,
        ...(scope === "event" ? [viewer.eventId] : []),
        search,
        search,
        selectedKey,
        selectedKey,
      )
      .all<{
        actorKey: string;
        actorName: string;
        actorKind: AuditActorKind;
      }>();
    return actors.results.map((actor) => ({
      key: actor.actorKey,
      name: actor.actorName,
      kind: actor.actorKind,
    }));
  }
}
