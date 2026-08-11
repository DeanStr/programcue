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
const COMMAND_EXECUTION_LEASE_SECONDS = 600;

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

type ProjectionRunSummary = {
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

const projectionRunSummarySchema = z.object({
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

function stableJson(value: unknown) {
  return JSON.stringify(stableValue(value));
}

function activeLeaseSummary(token: AirtableProjectionCommandToken) {
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

async function sha256(value: string) {
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

export class AirtableEventDataRepository {
  private readonly rooms;
  private readonly now;

  constructor(
    private readonly env: CloudflareEnvironment,
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

  private plan(
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

  private async writePlan(
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

  private mappingStatement(
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

  async beginCommand(
    scope: Pick<Viewer, "organisationId" | "eventId"> & {
      personId: string | null;
    },
    input: {
      idempotencyKey: string;
      operation: string;
      requestHash?: string;
    },
  ): Promise<AirtableProjectionCommandToken> {
    const requestHash =
      input.requestHash ??
      (await sha256(
        stableJson({
          idempotencyKey: input.idempotencyKey,
          operation: input.operation,
        }),
      ));
    const state = await this.assertSynchronized(
      scope.organisationId,
      scope.eventId,
      { bypassCache: true },
    );
    const existing = await this.env.DB.prepare(
      `SELECT id, status, summary_json AS summaryJson FROM integration_runs
        WHERE connection_id = ? AND idempotency_key = ?`,
    )
      .bind(state.connection.id, input.idempotencyKey)
      .first<{ id: string; status: string; summaryJson: string }>();
    if (existing) {
      const summary = projectionRunSummarySchema.parse(
        JSON.parse(existing.summaryJson),
      );
      if (
        summary.eventId !== scope.eventId ||
        summary.operation !== input.operation ||
        summary.requestHash !== requestHash
      )
        throw new AirtableEventDataUnsynchronizedError(
          `Airtable command run ${existing.id} does not match this event operation and request payload.`,
        );
      if (existing.status === "cancelled" && summary.phase === "aborted") {
        const executionLease = crypto.randomUUID();
        const executionLeaseExpiresAt =
          Math.floor(this.now() / 1_000) + COMMAND_EXECUTION_LEASE_SECONDS;
        const restartedSummary: ProjectionRunSummary = {
          kind: "airtable_event_projection",
          phase: "intent_recorded",
          eventId: scope.eventId,
          operation: input.operation,
          requestHash,
          beforeHash: state.d1.hash,
          executionLease,
          executionLeaseExpiresAt,
        };
        const restarted = await this.env.DB.prepare(
          `UPDATE integration_runs
              SET status = 'running', summary_json = ?, completed_at = NULL,
                  started_at = unixepoch()
            WHERE id = ? AND connection_id = ? AND status = 'cancelled'
              AND NOT EXISTS (
                SELECT 1 FROM integration_runs pending
                 WHERE pending.connection_id = ? AND pending.id <> ?
                   AND json_extract(pending.summary_json, '$.kind') = 'airtable_event_projection'
                   AND (
                     pending.status = 'running'
                     OR (
                       pending.status IN ('failed','partially_failed')
                       AND json_extract(pending.summary_json, '$.phase') IN (
                         'd1_committed','external_committed'
                       )
                     )
                   )
              )`,
        )
          .bind(
            JSON.stringify(restartedSummary),
            existing.id,
            state.connection.id,
            state.connection.id,
            existing.id,
          )
          .run();
        if ((restarted.meta.changes ?? 0) !== 1)
          throw new AirtableEventDataUnsynchronizedError(
            `Airtable command run ${existing.id} could not restart safely.`,
          );
        return {
          runId: existing.id,
          connectionId: state.connection.id,
          connectionRevision: state.connection.revision,
          organisationId: scope.organisationId,
          eventId: scope.eventId,
          actorPersonId: scope.personId,
          operation: input.operation,
          requestHash,
          beforeHash: state.d1.hash,
          replayed: false,
          executionLease,
          executionLeaseExpiresAt,
        };
      }
      if (existing.status !== "succeeded")
        throw new AirtableEventDataUnsynchronizedError(
          `Airtable command run ${existing.id} is ${existing.status}; recover it before replaying the command.`,
        );
      return {
        runId: existing.id,
        connectionId: state.connection.id,
        connectionRevision: state.connection.revision,
        organisationId: scope.organisationId,
        eventId: scope.eventId,
        actorPersonId: scope.personId,
        operation: summary.operation,
        requestHash: summary.requestHash,
        beforeHash: summary.beforeHash,
        replayed: true,
        commandResult: summary.commandResult ?? {
          kind: "unavailable",
          reason: "not_recorded",
        },
      };
    }
    const runId = crypto.randomUUID();
    const executionLease = crypto.randomUUID();
    const executionLeaseExpiresAt =
      Math.floor(this.now() / 1_000) + COMMAND_EXECUTION_LEASE_SECONDS;
    const summary: ProjectionRunSummary = {
      kind: "airtable_event_projection",
      phase: "intent_recorded",
      eventId: scope.eventId,
      operation: input.operation,
      requestHash,
      beforeHash: state.d1.hash,
      executionLease,
      executionLeaseExpiresAt,
    };
    const result = await this.env.DB.prepare(
      `INSERT INTO integration_runs (
         id, connection_id, operation_id, idempotency_key, status, direction,
         dry_run, summary_json, started_at, created_at
       )
       SELECT ?, ?, ?, ?, 'running', 'bidirectional', 0, ?, unixepoch(), unixepoch()
        WHERE NOT EXISTS (
          SELECT 1 FROM integration_runs pending
           WHERE pending.connection_id = ?
             AND json_extract(pending.summary_json, '$.kind') = 'airtable_event_projection'
             AND (
               pending.status = 'running'
               OR (
                 pending.status IN ('failed','partially_failed')
                 AND json_extract(pending.summary_json, '$.phase') IN (
                   'd1_committed','external_committed'
                 )
               )
             )
        )`,
    )
      .bind(
        runId,
        state.connection.id,
        input.idempotencyKey,
        input.idempotencyKey,
        JSON.stringify(summary),
        state.connection.id,
      )
      .run();
    if ((result.meta.changes ?? 0) !== 1)
      throw new AirtableEventDataUnsynchronizedError(
        "This Airtable event already has an active or recoverable projection command. Complete or recover it before starting another change.",
      );
    return {
      runId,
      connectionId: state.connection.id,
      connectionRevision: state.connection.revision,
      organisationId: scope.organisationId,
      eventId: scope.eventId,
      actorPersonId: scope.personId,
      operation: input.operation,
      requestHash,
      beforeHash: state.d1.hash,
      replayed: false,
      executionLease,
      executionLeaseExpiresAt,
    };
  }

  private async recordCommittedProjection(
    token: AirtableProjectionCommandToken,
    desired: AirtableEventDataSnapshot,
    current: AirtableEventDataSnapshot,
  ) {
    const plan = this.plan(desired, current);
    const summary: ProjectionRunSummary = {
      kind: "airtable_event_projection",
      phase: "d1_committed",
      eventId: token.eventId,
      operation: token.operation,
      requestHash: token.requestHash,
      beforeHash: token.beforeHash,
      afterHash: desired.hash,
      commandResult: token.commandResult ?? {
        kind: "unavailable",
        reason: "not_recorded",
      },
      ...activeLeaseSummary(token),
    };
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE integration_runs SET summary_json = ?
          WHERE id = ? AND connection_id = ? AND status = 'running'`,
      ).bind(JSON.stringify(summary), token.runId, token.connectionId),
      ...plan
        .filter((item) => item.action !== "noop")
        .map((item) =>
          this.env.DB.prepare(
            `INSERT INTO integration_run_items (
               id, run_id, entity_type, entity_id, action, status, diff_json,
               attempt_count, updated_at
             ) VALUES (?, ?, ?, ?, ?, 'running', ?, 0, unixepoch())
             ON CONFLICT(run_id, entity_type, entity_id) DO UPDATE SET
               action = excluded.action, status = 'running',
               diff_json = excluded.diff_json, error_code = NULL,
               error_message = NULL, updated_at = unixepoch()`,
          ).bind(
            crypto.randomUUID(),
            token.runId,
            item.entityType,
            item.entityId,
            item.action,
            JSON.stringify(
              token.operation === "participant.retention.anonymise"
                ? {
                    redacted: true,
                    reason: "participant_retention",
                    beforeHash: token.beforeHash,
                    afterHash: desired.hash,
                  }
                : { before: item.before, after: item.after },
            ),
          ),
        ),
    ]);
    if (results.some((result) => (result.meta.changes ?? 0) !== 1))
      throw new AirtableEventProjectionCommitError(
        token.runId,
        "The committed D1 projection could not be recorded as a durable Airtable run.",
      );
    return plan;
  }

  async prepareCommandCompletion(
    token: AirtableProjectionCommandToken,
    options: { recovery?: boolean } = {},
  ): Promise<AirtableProjectionCompletion> {
    if (token.replayed)
      throw new AirtableEventDataUnsynchronizedError(
        `Airtable command run ${token.runId} already succeeded; replay the domain command through its idempotency key instead of applying it again.`,
      );
    try {
      const connection = await this.rooms.getConnection(
        token.organisationId,
        token.eventId,
        {
          requireConnected: true,
          allowNeedsAttention: options.recovery,
        },
      );
      if (
        !connection ||
        connection.id !== token.connectionId ||
        connection.revision !== token.connectionRevision
      )
        throw new AirtableEventDataUnsynchronizedError(
          "The Airtable connection changed after the command intent was persisted.",
        );
      const [desired, current] = await Promise.all([
        this.readD1Projection(token.eventId),
        this.readAuthoritative(token.organisationId, token.eventId, {
          bypassCache: true,
          allowNeedsAttention: options.recovery,
        }),
      ]);
      if (current.hash !== token.beforeHash)
        throw new AirtableEventDataUnsynchronizedError(
          "Airtable changed while the D1 projection command was running.",
        );
      await this.recordCommittedProjection(token, desired, current);
      await this.writePlan(
        connection,
        token.organisationId,
        token.eventId,
        desired,
        current,
      );
      const summary: ProjectionRunSummary = {
        kind: "airtable_event_projection",
        phase: "external_committed",
        eventId: token.eventId,
        operation: token.operation,
        requestHash: token.requestHash,
        beforeHash: token.beforeHash,
        afterHash: desired.hash,
        commandResult: token.commandResult ?? {
          kind: "unavailable",
          reason: "not_recorded",
        },
        ...activeLeaseSummary(token),
      };
      const result = await this.env.DB.prepare(
        `UPDATE integration_runs SET summary_json = ?
          WHERE id = ? AND connection_id = ? AND status = 'running'`,
      )
        .bind(JSON.stringify(summary), token.runId, token.connectionId)
        .run();
      if ((result.meta.changes ?? 0) !== 1)
        throw new AirtableRepositoryReconciliationError(
          "Airtable committed, but the projection run checkpoint was not recorded.",
        );
      return { ...token, afterHash: desired.hash };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await Promise.all([
        this.env.DB.prepare(
          `UPDATE integration_runs
              SET status = 'partially_failed', completed_at = unixepoch(),
                  summary_json = json_remove(
                    json_set(summary_json, '$.error', ?),
                    '$.executionLease', '$.executionLeaseExpiresAt',
                    '$.recoveryLease'
                  )
            WHERE id = ? AND status = 'running'`,
        )
          .bind(reason, token.runId)
          .run(),
        this.rooms.markNeedsAttention(
          token.organisationId,
          token.eventId,
          reason,
        ),
      ]);
      throw new AirtableEventProjectionCommitError(token.runId, error);
    }
  }

  async finalizeCommand(completion: AirtableProjectionCompletion) {
    const connection = await this.rooms.getConnection(
      completion.organisationId,
      completion.eventId,
      { requireConnected: true, allowNeedsAttention: true },
    );
    if (!connection || connection.id !== completion.connectionId)
      throw new AirtableEventDataUnsynchronizedError(
        "The Airtable connection for this projection run is no longer available.",
      );
    const d1 = await this.readD1Projection(completion.eventId);
    if (d1.hash !== completion.afterHash)
      throw new AirtableEventDataUnsynchronizedError(
        "The D1 projection changed before the Airtable command could finalize.",
      );
    // prepareCommandCompletion has already read the provider back and matched
    // its complete snapshot hash. A later external edit is detected at the next
    // read boundary; repeating all managed table reads here only narrows that
    // race and materially increases Airtable request amplification.
    const summary: ProjectionRunSummary = {
      kind: "airtable_event_projection",
      phase: "finalized",
      eventId: completion.eventId,
      operation: completion.operation,
      requestHash: completion.requestHash,
      beforeHash: completion.beforeHash,
      afterHash: completion.afterHash,
      commandResult: completion.commandResult ?? {
        kind: "unavailable",
        reason: "not_recorded",
      },
    };
    const results = await this.env.DB.batch([
      this.mappingStatement(
        completion.connectionId,
        completion.eventId,
        completion.afterHash,
      ),
      this.env.DB.prepare(
        `UPDATE integration_run_items
            SET status = 'succeeded', attempt_count = 1,
                updated_at = unixepoch()
          WHERE run_id = ? AND status = 'running'`,
      ).bind(completion.runId),
      this.env.DB.prepare(
        `UPDATE integration_runs
            SET status = 'succeeded', summary_json = ?, completed_at = unixepoch()
          WHERE id = ? AND connection_id = ?
            AND status IN ('running','partially_failed')`,
      ).bind(
        JSON.stringify(summary),
        completion.runId,
        completion.connectionId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, 'airtable.event_data.command_reconciled',
                   'event', ?, ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        completion.organisationId,
        completion.eventId,
        completion.actorPersonId,
        completion.eventId,
        completion.runId,
        JSON.stringify({
          operation: completion.operation,
          beforeHash: completion.beforeHash,
          afterHash: completion.afterHash,
        }),
      ),
      this.env.DB.prepare(
        `UPDATE integration_connections
            SET status = 'connected', updated_at = unixepoch()
          WHERE id = ? AND status = 'needs_attention'`,
      ).bind(completion.connectionId),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    )
      throw new AirtableEventDataUnsynchronizedError(
        "The Airtable command reconciled but its mapping, run, or audit did not finalize.",
      );
    return { runId: completion.runId, hash: completion.afterHash };
  }

  async completeCommand(
    token: AirtableProjectionCommandToken,
    commandResult: AirtableProjectionCommandResult = {
      kind: "unavailable",
      reason: "not_recorded",
    },
  ) {
    const completion = await this.prepareCommandCompletion({
      ...token,
      commandResult,
    });
    return this.finalizeCommand(completion);
  }

  async failCommandResult(
    token: AirtableProjectionCommandToken,
    cause: unknown,
  ): Promise<never> {
    const desired = await this.readD1Projection(token.eventId);
    const reason = cause instanceof Error ? cause.message : String(cause);
    const summary: ProjectionRunSummary = {
      kind: "airtable_event_projection",
      phase: "d1_committed",
      eventId: token.eventId,
      operation: token.operation,
      requestHash: token.requestHash,
      beforeHash: token.beforeHash,
      afterHash: desired.hash,
      commandResult: { kind: "unavailable", reason: "not_recorded" },
      error: reason,
    };
    const [recorded] = await Promise.all([
      this.env.DB.prepare(
        `UPDATE integration_runs
            SET status = 'partially_failed', completed_at = unixepoch(),
                summary_json = ?
          WHERE id = ? AND connection_id = ? AND status = 'running'`,
      )
        .bind(JSON.stringify(summary), token.runId, token.connectionId)
        .run(),
      this.rooms.markNeedsAttention(
        token.organisationId,
        token.eventId,
        reason,
      ),
    ]);
    if ((recorded.meta.changes ?? 0) !== 1)
      throw new AirtableEventProjectionCommitError(
        token.runId,
        "The committed D1 projection could not be checkpointed for Airtable recovery.",
      );
    throw new AirtableEventProjectionCommitError(token.runId, cause);
  }

  async abortCommand(token: AirtableProjectionCommandToken, cause: unknown) {
    const d1 = await this.readD1Projection(token.eventId);
    if (d1.hash !== token.beforeHash) {
      return this.failCommandResult(
        token,
        cause instanceof Error
          ? cause
          : new Error(
              "The domain command reported failure after changing the D1 projection.",
            ),
      );
    }
    const summary: ProjectionRunSummary = {
      kind: "airtable_event_projection",
      phase: "aborted",
      eventId: token.eventId,
      operation: token.operation,
      requestHash: token.requestHash,
      beforeHash: token.beforeHash,
      error: cause instanceof Error ? cause.message : String(cause),
    };
    await this.env.DB.prepare(
      `UPDATE integration_runs
          SET status = 'cancelled', summary_json = ?, completed_at = unixepoch()
        WHERE id = ? AND status = 'running'`,
    )
      .bind(JSON.stringify(summary), token.runId)
      .run();
  }

  async recoverCommand(
    scope: Pick<Viewer, "organisationId" | "eventId"> & {
      personId: string | null;
    },
    runId: string,
  ) {
    const connection = await this.rooms.getConnection(
      scope.organisationId,
      scope.eventId,
      { requireConnected: true, allowNeedsAttention: true },
    );
    if (!connection)
      throw new AirtableEventDataUnsynchronizedError(
        "Airtable event repository connection not found.",
      );
    const row = await this.env.DB.prepare(
      `SELECT status, summary_json AS summaryJson FROM integration_runs
        WHERE id = ? AND connection_id = ?`,
    )
      .bind(runId, connection.id)
      .first<{ status: string; summaryJson: string }>();
    if (!row)
      throw new AirtableEventDataUnsynchronizedError(
        "Airtable projection run not found.",
      );
    if (row.status === "succeeded") return { runId, idempotent: true };
    const summary = projectionRunSummarySchema.parse(
      JSON.parse(row.summaryJson),
    );
    if (summary.operation === "event_setup.save") {
      const [event, roomRows] = await Promise.all([
        this.env.DB.prepare(
          `SELECT revision FROM events
            WHERE id = ? AND organisation_id = ?`,
        )
          .bind(scope.eventId, scope.organisationId)
          .first<{ revision: number }>(),
        this.env.DB.prepare(
          `SELECT id, name, capacity, resources_json AS resourcesJson, position
             FROM rooms
            WHERE event_id = ? AND status = 'active'
            ORDER BY position, name, id`,
        )
          .bind(scope.eventId)
          .all<{
            id: string;
            name: string;
            capacity: number;
            resourcesJson: string;
            position: number;
          }>(),
      ]);
      if (!event)
        throw new AirtableEventDataUnsynchronizedError(
          "The event for this Airtable projection no longer exists.",
        );
      await this.rooms.replaceRooms(
        scope.organisationId,
        scope.eventId,
        roomRows.results.map((room) => ({
          id: room.id,
          name: room.name,
          capacity: room.capacity,
          resources: z.array(z.string()).parse(JSON.parse(room.resourcesJson)),
          position: room.position,
        })),
        event.revision,
        { allowNeedsAttention: true },
      );
    }
    const [d1, airtable] = await Promise.all([
      this.readD1Projection(scope.eventId),
      this.readAuthoritative(scope.organisationId, scope.eventId, {
        bypassCache: true,
        allowNeedsAttention: true,
      }),
    ]);
    if (
      d1.hash === summary.beforeHash &&
      airtable.hash === summary.beforeHash &&
      summary.phase === "intent_recorded"
    ) {
      await this.env.DB.prepare(
        `UPDATE integration_runs SET status = 'cancelled', completed_at = unixepoch(),
                summary_json = json_set(summary_json, '$.phase', 'aborted')
          WHERE id = ? AND status IN ('running','failed','partially_failed')`,
      )
        .bind(runId)
        .run();
      return { runId, idempotent: false, aborted: true };
    }
    const afterHash = summary.afterHash ?? d1.hash;
    if (d1.hash !== afterHash)
      throw new AirtableEventDataUnsynchronizedError(
        "The D1 projection changed again after the interrupted Airtable command.",
      );
    const token: AirtableProjectionCommandToken = {
      runId,
      connectionId: connection.id,
      connectionRevision: connection.revision,
      organisationId: scope.organisationId,
      eventId: scope.eventId,
      actorPersonId: scope.personId,
      operation: summary.operation,
      requestHash: summary.requestHash,
      beforeHash: summary.beforeHash,
      replayed: false,
      commandResult: summary.commandResult ?? {
        kind: "unavailable",
        reason: "not_recorded",
      },
      recoveryLease: summary.recoveryLease,
    };
    if (airtable.hash !== afterHash) {
      if (airtable.hash !== summary.beforeHash)
        throw new AirtableEventDataUnsynchronizedError(
          "Airtable diverged from both the before and committed projection hashes.",
        );
      await this.env.DB.prepare(
        `UPDATE integration_runs SET status = 'running', completed_at = NULL
          WHERE id = ? AND status IN ('failed','partially_failed')`,
      )
        .bind(runId)
        .run();
      const completion = await this.prepareCommandCompletion(token, {
        recovery: true,
      });
      return this.finalizeCommand(completion);
    }
    const completion: AirtableProjectionCompletion = { ...token, afterHash };
    return this.finalizeCommand(completion);
  }
}
