import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AirtableClient,
  airtableEqualsFormula,
  type AirtableRecord,
} from "./airtable-client.server";
import {
  AIRTABLE_EVENT_TABLE_SPECS,
  type AirtableEventDataDomain,
  type AirtableEventTableSpec,
} from "./airtable-event-data-schema";
import {
  AirtableRepositoryReconciliationError,
  AirtableRoomRepository,
  type AirtableRepositoryConnection,
} from "./airtable-room-repository.server";
import {
  AIRTABLE_CACHE_TTL_SECONDS,
  AIRTABLE_EVENT_DATA_FIELDS,
  AIRTABLE_SCHEMA_VERSION,
  AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES,
  type AirtableCredentials,
  type AirtableEventDataTableKey,
} from "./airtable-schema";

const SNAPSHOT_MAPPING_TYPE = "airtable_event_snapshot";
export const COMMAND_EXECUTION_LEASE_SECONDS = 600;

type AirtableEventDataClient = Pick<
  AirtableClient,
  "listRecords" | "upsertRecords"
>;

type RepositoryDependencies = {
  rooms?: AirtableRoomRepository;
  createClient?: (credentials: AirtableCredentials) => AirtableEventDataClient;
  now?: () => number;
};

export type AirtableEventDataEntity = {
  tableKey: AirtableEventDataTableKey;
  domain: AirtableEventDataDomain;
  entityType: string;
  entityId: string;
  key: string;
  revision: number;
  payload: Record<string, unknown>;
  payloadJson: string;
};

export type AirtableEventDataSnapshot = {
  entities: AirtableEventDataEntity[];
  hash: string;
  freshness: {
    source: "d1_projection" | "airtable";
    fetchedAt: number;
    cacheExpiresAt: number | null;
    cached: boolean;
  };
};

export type AirtableEventDataPlanItem = {
  tableKey: AirtableEventDataTableKey;
  entityType: string;
  entityId: string;
  key: string;
  action: "create" | "update" | "noop";
  before: Record<string, unknown> | null;
  after: Record<string, unknown>;
};

export type AirtableProjectionCommandToken = {
  runId: string;
  connectionId: string;
  connectionRevision: number;
  organisationId: string;
  eventId: string;
  actorPersonId: string | null;
  operation: string;
  requestHash: string;
  beforeHash: string;
  replayed: boolean;
  commandResult?: AirtableProjectionCommandResult;
  executionLease?: string;
  executionLeaseExpiresAt?: number;
  recoveryLease?: string;
};

export type AirtableProjectionCompletion = AirtableProjectionCommandToken & {
  afterHash: string;
};

export type ProjectionRunSummary = {
  kind: "airtable_event_projection";
  phase:
    | "intent_recorded"
    | "d1_committed"
    | "external_committed"
    | "finalized"
    | "aborted";
  eventId: string;
  operation: string;
  requestHash: string;
  beforeHash: string;
  afterHash?: string;
  error?: string;
  commandResult?: AirtableProjectionCommandResult;
  executionLease?: string;
  executionLeaseExpiresAt?: number;
  recoveryLease?: string;
};

export type AirtableProjectionCommandResult =
  | { kind: "json"; valueJson: string }
  | { kind: "undefined" }
  | { kind: "unavailable"; reason: "not_recorded" | "sensitive" }
  | {
      kind: "committed_error";
      name: string;
      message: string;
      status?: number;
    };

const projectionCommandResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json"), valueJson: z.string() }),
  z.object({ kind: z.literal("undefined") }),
  z.object({
    kind: z.literal("unavailable"),
    reason: z.enum(["not_recorded", "sensitive"]),
  }),
  z.object({
    kind: z.literal("committed_error"),
    name: z.string().min(1),
    message: z.string(),
    status: z.number().int().optional(),
  }),
]);

export const projectionRunSummarySchema = z.object({
  kind: z.literal("airtable_event_projection"),
  phase: z.enum([
    "intent_recorded",
    "d1_committed",
    "external_committed",
    "finalized",
    "aborted",
  ]),
  eventId: z.string().min(1),
  operation: z.string().min(1),
  requestHash: z.string().min(1),
  beforeHash: z.string().min(1),
  afterHash: z.string().min(1).optional(),
  error: z.string().optional(),
  commandResult: projectionCommandResultSchema.optional(),
  executionLease: z.string().min(1).optional(),
  executionLeaseExpiresAt: z.number().int().optional(),
  recoveryLease: z.string().min(1).optional(),
});

type CachedExternalSnapshot = Omit<AirtableEventDataSnapshot, "freshness"> & {
  fetchedAt: number;
  cacheExpiresAt: number;
};

const externalCache = new Map<string, CachedExternalSnapshot>();

export class AirtableEventDataSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableEventDataSchemaError";
  }
}

export class AirtableEventDataUnsynchronizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableEventDataUnsynchronizedError";
  }
}

export class AirtableEventProjectionCommitError extends Error {
  readonly committed = true;

  constructor(
    readonly runId: string,
    cause: unknown,
  ) {
    super(
      `The D1 projection command committed, but Airtable did not reconcile: ${cause instanceof Error ? cause.message : String(cause)}. Run ${runId} must be retried before this event can be read or changed.`,
    );
    this.name = "AirtableEventProjectionCommitError";
  }
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  return value;
}

export function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

export function activeLeaseSummary(token: AirtableProjectionCommandToken) {
  return {
    ...(token.executionLease
      ? {
          executionLease: token.executionLease,
          executionLeaseExpiresAt: token.executionLeaseExpiresAt,
        }
      : {}),
    ...(token.recoveryLease ? { recoveryLease: token.recoveryLease } : {}),
  };
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function entitySort(
  left: AirtableEventDataEntity,
  right: AirtableEventDataEntity,
) {
  return (
    left.tableKey.localeCompare(right.tableKey) ||
    left.entityId.localeCompare(right.entityId)
  );
}

async function snapshotHash(entities: AirtableEventDataEntity[]) {
  return sha256(
    stableJson(
      [...entities].sort(entitySort).map((entity) => ({
        tableKey: entity.tableKey,
        entityId: entity.entityId,
        revision: entity.revision,
        payload: entity.payload,
      })),
    ),
  );
}

function cloneEntities(entities: AirtableEventDataEntity[]) {
  return entities.map((entity) => ({
    ...entity,
    payload: structuredClone(entity.payload),
  }));
}

function recordFields(entity: AirtableEventDataEntity) {
  return {
    "Program Cue Key": entity.key,
    "Event ID": String(entity.payload.event_id),
    "Entity ID": entity.entityId,
    "Payload JSON": entity.payloadJson,
    Revision: entity.revision,
    Status: "active",
  };
}

function scopedKey(tableKey: AirtableEventDataTableKey, entityId: string) {
  return `${tableKey}:${entityId}`;
}

export class AirtableEventDataProjectionRepository {
  protected readonly rooms;
  protected readonly now;

  constructor(
    protected readonly env: CloudflareEnvironment,
    private readonly dependencies: RepositoryDependencies = {},
  ) {
    this.rooms = dependencies.rooms ?? new AirtableRoomRepository(env);
    this.now = dependencies.now ?? Date.now;
  }

  private client(credentials: AirtableCredentials) {
    return (
      this.dependencies.createClient?.(credentials) ??
      new AirtableClient(credentials)
    );
  }

  private cacheKey(
    connectionId: string,
    connectionRevision: number,
    eventId: string,
  ) {
    return `${connectionId}:${connectionRevision}:${eventId}`;
  }

  private async d1Entities(eventId: string) {
    const groups = await Promise.all(
      AIRTABLE_EVENT_TABLE_SPECS.map(async (spec) => {
        const rows = await this.env.DB.prepare(spec.query)
          .bind(eventId)
          .all<Record<string, unknown>>();
        return rows.results.map((raw) => {
          let payload: Record<string, unknown>;
          try {
            payload = spec.schema.parse(raw);
          } catch (error) {
            const detail =
              error instanceof z.ZodError
                ? error.issues[0]?.message
                : error instanceof Error
                  ? error.message
                  : String(error);
            throw new AirtableEventDataSchemaError(
              `D1 ${spec.entityType} projection does not match the managed Airtable schema: ${detail ?? "invalid row"}.`,
            );
          }
          const entityId = spec.entityId(payload);
          return {
            tableKey: spec.key,
            domain: spec.domain,
            entityType: spec.entityType,
            entityId,
            key: `${eventId}:${spec.key}:${entityId}`,
            revision: spec.revision(payload),
            payload,
            payloadJson: stableJson(payload),
          } satisfies AirtableEventDataEntity;
        });
      }),
    );
    return groups.flat().sort(entitySort);
  }

  async readD1Projection(eventId: string): Promise<AirtableEventDataSnapshot> {
    const entities = await this.d1Entities(eventId);
    return {
      entities,
      hash: await snapshotHash(entities),
      freshness: {
        source: "d1_projection",
        fetchedAt: Math.floor(this.now() / 1_000),
        cacheExpiresAt: null,
        cached: false,
      },
    };
  }

  assertRoomProjectionSynchronized(
    organisationId: string,
    eventId: string,
    options: { bypassCache?: boolean } = {},
  ) {
    return this.rooms.assertActiveProjectionSynchronized(
      organisationId,
      eventId,
      options,
    );
  }

  private parseExternalRecord(
    spec: AirtableEventTableSpec,
    record: AirtableRecord,
    eventId: string,
  ) {
    const status = record.fields.Status;
    if (status !== "active" && status !== "retired")
      throw new AirtableEventDataSchemaError(
        `Airtable ${spec.entityType} record ${record.id} must have active or retired status.`,
      );
    if (status === "retired") return null;
    const payloadJson = record.fields["Payload JSON"];
    if (typeof payloadJson !== "string")
      throw new AirtableEventDataSchemaError(
        `Airtable ${spec.entityType} record ${record.id} has no Payload JSON.`,
      );
    let payload: Record<string, unknown>;
    try {
      payload = spec.schema.parse(JSON.parse(payloadJson));
    } catch (error) {
      const detail =
        error instanceof z.ZodError
          ? error.issues[0]?.message
          : error instanceof Error
            ? error.message
            : String(error);
      throw new AirtableEventDataSchemaError(
        `Airtable ${spec.entityType} record ${record.id} has invalid payload JSON: ${detail ?? "schema mismatch"}.`,
      );
    }
    if (payload.event_id !== eventId)
      throw new AirtableEventDataSchemaError(
        `Airtable ${spec.entityType} record ${record.id} payload belongs to another event.`,
      );
    const entityId = spec.entityId(payload);
    const key = `${eventId}:${spec.key}:${entityId}`;
    if (
      record.fields["Event ID"] !== eventId ||
      record.fields["Entity ID"] !== entityId ||
      record.fields["Program Cue Key"] !== key ||
      record.fields.Revision !== spec.revision(payload)
    )
      throw new AirtableEventDataSchemaError(
        `Airtable ${spec.entityType} record ${record.id} identity or revision fields do not match its payload.`,
      );
    return {
      tableKey: spec.key,
      domain: spec.domain,
      entityType: spec.entityType,
      entityId,
      key,
      revision: spec.revision(payload),
      payload,
      payloadJson: stableJson(payload),
    } satisfies AirtableEventDataEntity;
  }

  private async externalEntities(
    connection: AirtableRepositoryConnection,
    eventId: string,
  ) {
    const client = this.client(connection.credentials);
    const entities: AirtableEventDataEntity[] = [];
    for (const spec of AIRTABLE_EVENT_TABLE_SPECS) {
      const records = await client.listRecords(
        connection.configuration.tables[spec.key].id,
        {
          filterByFormula: airtableEqualsFormula("Event ID", eventId),
          fields: AIRTABLE_EVENT_DATA_FIELDS.map((field) => field.name),
        },
      );
      const ids = new Set<string>();
      const keys = new Set<string>();
      for (const record of records) {
        if (record.fields["Event ID"] !== eventId) continue;
        const recordKey = record.fields["Program Cue Key"];
        if (
          typeof recordKey !== "string" ||
          !recordKey.startsWith(`${eventId}:${spec.key}:`)
        )
          throw new AirtableEventDataSchemaError(
            `Airtable ${spec.entityType} record ${record.id} has an invalid Program Cue Key.`,
          );
        if (keys.has(recordKey))
          throw new AirtableEventDataSchemaError(
            `Airtable contains duplicate managed key “${recordKey}”.`,
          );
        keys.add(recordKey);
        const entity = this.parseExternalRecord(spec, record, eventId);
        if (!entity) continue;
        if (ids.has(entity.entityId))
          throw new AirtableEventDataSchemaError(
            `Airtable contains duplicate ${spec.entityType} ID “${entity.entityId}”.`,
          );
        ids.add(entity.entityId);
        entities.push(entity);
      }
    }
    return entities.sort(entitySort);
  }

  async readAuthoritative(
    organisationId: string,
    eventId: string,
    options: { bypassCache?: boolean; allowNeedsAttention?: boolean } = {},
  ): Promise<AirtableEventDataSnapshot> {
    const connection = await this.rooms.getConnection(organisationId, eventId, {
      requireConnected: true,
      allowNeedsAttention: options.allowNeedsAttention,
    });
    if (!connection)
      throw new AirtableRepositoryReconciliationError(
        "Airtable event repository connection not found.",
      );
    const cacheKey = this.cacheKey(connection.id, connection.revision, eventId);
    const now = this.now();
    const cached = externalCache.get(cacheKey);
    if (!options.bypassCache && cached && cached.cacheExpiresAt * 1_000 > now)
      return {
        entities: cloneEntities(cached.entities),
        hash: cached.hash,
        freshness: {
          source: "airtable",
          fetchedAt: cached.fetchedAt,
          cacheExpiresAt: cached.cacheExpiresAt,
          cached: true,
        },
      };
    const entities = await this.externalEntities(connection, eventId);
    const hash = await snapshotHash(entities);
    const fetchedAt = Math.floor(now / 1_000);
    const snapshot = {
      entities,
      hash,
      fetchedAt,
      cacheExpiresAt: fetchedAt + AIRTABLE_CACHE_TTL_SECONDS,
    };
    externalCache.set(cacheKey, snapshot);
    return {
      entities: cloneEntities(entities),
      hash,
      freshness: {
        source: "airtable",
        fetchedAt,
        cacheExpiresAt: snapshot.cacheExpiresAt,
        cached: false,
      },
    };
  }

  protected plan(
    desired: AirtableEventDataSnapshot,
    current: AirtableEventDataSnapshot,
  ) {
    const currentByKey = new Map(
      current.entities.map((entity) => [
        scopedKey(entity.tableKey, entity.entityId),
        entity,
      ]),
    );
    const desiredKeys = new Set<string>();
    const items: AirtableEventDataPlanItem[] = desired.entities.map(
      (entity) => {
        const key = scopedKey(entity.tableKey, entity.entityId);
        desiredKeys.add(key);
        const before = currentByKey.get(key);
        const after = recordFields(entity);
        return {
          tableKey: entity.tableKey,
          entityType: entity.entityType,
          entityId: entity.entityId,
          key: entity.key,
          action: !before
            ? "create"
            : before.payloadJson === entity.payloadJson &&
                before.revision === entity.revision
              ? "noop"
              : "update",
          before: before ? recordFields(before) : null,
          after,
        };
      },
    );
    for (const entity of current.entities) {
      if (desiredKeys.has(scopedKey(entity.tableKey, entity.entityId)))
        continue;
      items.push({
        tableKey: entity.tableKey,
        entityType: entity.entityType,
        entityId: entity.entityId,
        key: entity.key,
        action: "update",
        before: recordFields(entity),
        after: { "Program Cue Key": entity.key, Status: "retired" },
      });
    }
    return items;
  }

  async previewFromD1(organisationId: string, eventId: string) {
    const [desired, current] = await Promise.all([
      this.readD1Projection(eventId),
      this.readAuthoritative(organisationId, eventId, { bypassCache: true }),
    ]);
    return { desired, current, items: this.plan(desired, current) };
  }

  protected async writePlan(
    connection: AirtableRepositoryConnection,
    organisationId: string,
    eventId: string,
    desired: AirtableEventDataSnapshot,
    current: AirtableEventDataSnapshot,
  ) {
    const plan = this.plan(desired, current);
    const client = this.client(connection.credentials);
    for (const spec of AIRTABLE_EVENT_TABLE_SPECS) {
      const writes = plan
        .filter((item) => item.tableKey === spec.key && item.action !== "noop")
        .map((item) => ({ fields: item.after }));
      for (let index = 0; index < writes.length; index += 10)
        await client.upsertRecords(
          connection.configuration.tables[spec.key].id,
          writes.slice(index, index + 10),
          "Program Cue Key",
        );
    }
    externalCache.delete(
      this.cacheKey(connection.id, connection.revision, eventId),
    );
    const reconciled = await this.readAuthoritative(organisationId, eventId, {
      bypassCache: true,
      allowNeedsAttention: true,
    });
    if (reconciled.hash !== desired.hash)
      throw new AirtableRepositoryReconciliationError(
        "Airtable accepted event-data writes but did not reconcile to the requested projection hash.",
      );
    return { plan, reconciled };
  }

  private async mapping(connectionId: string, eventId: string) {
    return this.env.DB.prepare(
      `SELECT source_hash AS sourceHash
         FROM integration_entity_mappings
        WHERE connection_id = ? AND entity_type = ? AND entity_id = ?`,
    )
      .bind(connectionId, SNAPSHOT_MAPPING_TYPE, eventId)
      .first<{ sourceHash: string }>();
  }

  protected mappingStatement(
    connectionId: string,
    eventId: string,
    hash: string,
  ) {
    return this.env.DB.prepare(
      `INSERT INTO integration_entity_mappings (
         id, connection_id, entity_type, entity_id, external_id, source_hash,
         metadata_json, last_synced_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(), unixepoch())
       ON CONFLICT(connection_id, entity_type, entity_id) DO UPDATE SET
         external_id = excluded.external_id,
         source_hash = excluded.source_hash,
         metadata_json = excluded.metadata_json,
         last_synced_at = unixepoch(), updated_at = unixepoch()`,
    ).bind(
      crypto.randomUUID(),
      connectionId,
      SNAPSHOT_MAPPING_TYPE,
      eventId,
      eventId,
      hash,
      JSON.stringify({
        schema: AIRTABLE_SCHEMA_VERSION,
        domains: AIRTABLE_EVENT_TABLE_SPECS.length,
      }),
    );
  }

  private async pendingRun(connectionId: string, eventId: string) {
    return this.env.DB.prepare(
      `SELECT id, status, summary_json AS summaryJson
         FROM integration_runs
        WHERE connection_id = ?
          AND json_extract(summary_json, '$.kind') = 'airtable_event_projection'
          AND json_extract(summary_json, '$.eventId') = ?
          AND (
            status = 'running'
            OR (
              status IN ('failed','partially_failed')
              AND json_extract(summary_json, '$.phase') IN (
                'd1_committed','external_committed'
              )
            )
          )
        ORDER BY created_at LIMIT 1`,
    )
      .bind(connectionId, eventId)
      .first<{ id: string; status: string; summaryJson: string }>();
  }

  async assertSynchronized(
    organisationId: string,
    eventId: string,
    options: { bypassCache?: boolean } = {},
  ) {
    const connection = await this.rooms.getConnection(organisationId, eventId, {
      requireConnected: true,
    });
    if (!connection)
      throw new AirtableEventDataUnsynchronizedError(
        "Airtable event repository connection not found.",
      );
    const pending = await this.pendingRun(connection.id, eventId);
    if (pending)
      throw new AirtableEventDataUnsynchronizedError(
        `Airtable projection run ${pending.id} is ${pending.status}. Retry or reconcile it before reading or changing this event.`,
      );
    const [mapping, d1, airtable] = await Promise.all([
      this.mapping(connection.id, eventId),
      this.readD1Projection(eventId),
      this.readAuthoritative(organisationId, eventId, {
        bypassCache: options.bypassCache,
      }),
    ]);
    if (!mapping)
      throw new AirtableEventDataUnsynchronizedError(
        "The Airtable event-data snapshot has not completed its initial migration.",
      );
    if (
      mapping.sourceHash !== d1.hash ||
      mapping.sourceHash !== airtable.hash
    ) {
      const reason =
        "The Airtable canonical snapshot and D1 projection diverged. Reconcile the connection before continuing.";
      await this.rooms.markNeedsAttention(organisationId, eventId, reason);
      throw new AirtableEventDataUnsynchronizedError(reason);
    }
    return { connection, d1, airtable };
  }

  async synchronizeFromD1(
    scope: Pick<Viewer, "organisationId" | "eventId"> & {
      personId: string | null;
    },
    options: { idempotencyKey: string; reason: string },
  ) {
    const connection = await this.rooms.getConnection(
      scope.organisationId,
      scope.eventId,
      { requireConnected: true },
    );
    if (!connection)
      throw new AirtableRepositoryReconciliationError(
        "Airtable event repository connection not found.",
      );
    const existing = await this.env.DB.prepare(
      `SELECT id, status FROM integration_runs
        WHERE connection_id = ? AND idempotency_key = ?`,
    )
      .bind(connection.id, options.idempotencyKey)
      .first<{ id: string; status: string }>();
    if (existing?.status === "succeeded")
      return { runId: existing.id, idempotent: true };
    if (existing)
      throw new AirtableEventDataUnsynchronizedError(
        `Airtable event-data sync ${existing.id} is ${existing.status}; reconcile that run instead of creating another.`,
      );
    const [desired, current] = await Promise.all([
      this.readD1Projection(scope.eventId),
      this.readAuthoritative(scope.organisationId, scope.eventId, {
        bypassCache: true,
      }),
    ]);
    const plan = this.plan(desired, current);
    const changedPlan = plan.filter((item) => item.action !== "noop");
    if (changedPlan.length > AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES)
      throw new AirtableEventDataUnsynchronizedError(
        `The initial Airtable synchronization would change ${changedPlan.length} managed records, above the ${AIRTABLE_SYNCHRONOUS_MIGRATION_MAX_CHANGES}-record synchronous limit. Keep this event on D1.`,
      );
    const runId = crypto.randomUUID();
    const summary = {
      kind: "airtable_event_initial_sync",
      reason: options.reason,
      eventId: scope.eventId,
      desiredHash: desired.hash,
      total: plan.length,
    };
    const intentResults = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO integration_runs (
           id, connection_id, idempotency_key, status, direction, dry_run,
           summary_json, started_at, created_at
         ) VALUES (?, ?, ?, 'running', 'outbound', 0, ?, unixepoch(), unixepoch())`,
      ).bind(
        runId,
        connection.id,
        options.idempotencyKey,
        JSON.stringify(summary),
      ),
      ...changedPlan.map((item) =>
        this.env.DB.prepare(
          `INSERT INTO integration_run_items (
             id, run_id, entity_type, entity_id, action, status, diff_json,
             attempt_count, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, unixepoch())`,
        ).bind(
          crypto.randomUUID(),
          runId,
          item.entityType,
          item.entityId,
          item.action,
          item.action === "noop" ? "skipped" : "running",
          JSON.stringify({ before: item.before, after: item.after }),
        ),
      ),
    ]);
    if (intentResults.some((result) => (result.meta.changes ?? 0) !== 1))
      throw new AirtableRepositoryReconciliationError(
        "The Airtable event-data sync intent could not be recorded completely.",
      );
    try {
      await this.writePlan(
        connection,
        scope.organisationId,
        scope.eventId,
        desired,
        current,
      );
      const completed = await this.env.DB.batch([
        this.mappingStatement(connection.id, scope.eventId, desired.hash),
        this.env.DB.prepare(
          `UPDATE integration_run_items
              SET status = CASE WHEN action = 'noop' THEN 'skipped' ELSE 'succeeded' END,
                  attempt_count = 1,
                  updated_at = unixepoch()
            WHERE run_id = ?`,
        ).bind(runId),
        this.env.DB.prepare(
          `UPDATE integration_runs SET status = 'succeeded', completed_at = unixepoch()
            WHERE id = ? AND status = 'running'`,
        ).bind(runId),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, 'airtable.event_data.synchronized',
                     'event', ?, ?, ?, unixepoch())`,
        ).bind(
          crypto.randomUUID(),
          scope.organisationId,
          scope.eventId,
          scope.personId,
          scope.eventId,
          runId,
          JSON.stringify({ hash: desired.hash, reason: options.reason }),
        ),
      ]);
      if (
        (completed[0]?.meta.changes ?? 0) !== 1 ||
        (completed[1]?.meta.changes ?? 0) !== changedPlan.length ||
        (completed[2]?.meta.changes ?? 0) !== 1 ||
        (completed[3]?.meta.changes ?? 0) !== 1
      )
        throw new AirtableRepositoryReconciliationError(
          "Airtable synchronized, but its D1 mapping and audit did not finalize completely.",
        );
      return { runId, idempotent: false };
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE integration_runs SET status = 'failed', completed_at = unixepoch(),
                summary_json = json_set(summary_json, '$.error', ?)
          WHERE id = ? AND status = 'running'`,
      )
        .bind(error instanceof Error ? error.message : String(error), runId)
        .run();
      throw error;
    }
  }
}
