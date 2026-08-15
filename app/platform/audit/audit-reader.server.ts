import {
  auditDisplaySummary,
  auditOperationId,
  type AuditActorKind,
  type AuditOrigin,
} from "./audit-contract";

export type AuditHistoryItem = {
  id: string;
  action: string;
  actorName: string;
  actorKind: AuditActorKind;
  origin: AuditOrigin;
  entityType: string;
  entityId: string | null;
  correlationId: string | null;
  operationId: string | null;
  summary: string | null;
  createdAt: number;
};

const relatedMetadataKeys = [
  "operationId",
  "submissionId",
  "personId",
] as const;
type RelatedMetadataKey = (typeof relatedMetadataKeys)[number];

function requiredAuditReaderValue(value: string, name: string) {
  const normalized = value.trim();
  if (!normalized || normalized.length > 200) {
    throw new Error(`${name} must contain between 1 and 200 characters.`);
  }
  return normalized;
}

export class AuditReader {
  constructor(private readonly env: CloudflareEnvironment) {}

  async eventEntityHistory(
    scope: { organisationId: string; eventId: string },
    input: {
      entityType: string;
      entityId: string;
      relatedMetadataKey?: RelatedMetadataKey;
      actionPrefix?: string;
      actions?: readonly string[];
      limit?: number;
    },
  ): Promise<AuditHistoryItem[]> {
    const limit = input.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new Error("Audit history limit must be an integer from 1 to 100.");
    }
    const entityType = requiredAuditReaderValue(
      input.entityType,
      "Entity type",
    );
    const entityId = requiredAuditReaderValue(input.entityId, "Entity ID");
    const organisationId = requiredAuditReaderValue(
      scope.organisationId,
      "Organisation ID",
    );
    const eventId = requiredAuditReaderValue(scope.eventId, "Event ID");
    if (
      input.relatedMetadataKey !== undefined &&
      !relatedMetadataKeys.includes(input.relatedMetadataKey)
    ) {
      throw new Error("Related audit metadata key is invalid.");
    }
    if (input.actions !== undefined && input.actionPrefix !== undefined) {
      throw new Error(
        "Use either audit actions or an action prefix, not both.",
      );
    }
    if ((input.actions?.length ?? 0) > 30) {
      throw new Error("Audit history accepts at most 30 actions.");
    }
    const actions = (input.actions ?? []).map((action) =>
      requiredAuditReaderValue(action, "Audit action"),
    );
    if (new Set(actions).size !== actions.length) {
      throw new Error("Audit history actions must be unique.");
    }
    const actionPrefix = input.actionPrefix?.trim() ?? "";
    if (actionPrefix.length > 200) {
      throw new Error("Audit action prefix must be 200 characters or fewer.");
    }
    const relatedPredicate = input.relatedMetadataKey
      ? `OR json_extract(a.metadata_json, '$.${input.relatedMetadataKey}') = ?`
      : "";
    const actionPredicate = actions.length
      ? `AND a.action IN (${actions.map(() => "?").join(",")})`
      : `AND (? = '' OR a.action LIKE ? || '%')`;
    const rows = await this.env.DB.prepare(
      `SELECT a.id, a.action, a.actor_kind AS actorKind, a.origin,
              CASE a.actor_kind
                WHEN 'person' THEN COALESCE(person.display_name, 'Former participant')
                WHEN 'api_key' THEN 'API key'
                WHEN 'agent' THEN 'Agent'
                WHEN 'provider' THEN 'Provider'
                WHEN 'historical' THEN COALESCE(a.actor_id, 'Historical actor')
                ELSE 'System'
              END AS actorName,
              a.entity_type AS entityType, a.entity_id AS entityId,
              a.correlation_id AS correlationId,
              a.metadata_version AS metadataVersion,
              a.metadata_json AS metadataJson, a.created_at AS createdAt
         FROM audit_events a
         LEFT JOIN people person ON person.id = a.actor_person_id
        WHERE a.organisation_id = ? AND a.event_id = ?
          AND ((a.entity_type = ? AND a.entity_id = ?) ${relatedPredicate})
          ${actionPredicate}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ?`,
    )
      .bind(
        organisationId,
        eventId,
        entityType,
        entityId,
        ...(input.relatedMetadataKey ? [entityId] : []),
        ...(actions.length ? actions : [actionPrefix, actionPrefix]),
        limit,
      )
      .all<{
        id: string;
        action: string;
        actorKind: AuditActorKind;
        origin: AuditOrigin;
        actorName: string;
        entityType: string;
        entityId: string | null;
        correlationId: string | null;
        metadataJson: string;
        metadataVersion: number;
        createdAt: number;
      }>();
    return rows.results.map(({ metadataJson, metadataVersion, ...row }) => {
      let metadata: unknown;
      try {
        metadata = JSON.parse(metadataJson);
      } catch {
        throw new Error(`Audit event ${row.id} contains invalid JSON.`);
      }
      return {
        ...row,
        operationId: auditOperationId(row.action, metadataVersion, metadata),
        summary: auditDisplaySummary(row.action, metadataVersion, metadata),
      };
    });
  }
}
