import { z } from "zod";

import {
  ACCELEVENTS_SESSION_SPEAKER_WRITE_UNSUPPORTED,
  ACCELEVENTS_TRACK_UPDATE_UNSUPPORTED,
  AcceleventsProvider,
  acceleventsCredentialsSchema,
  type AcceleventsSessionPayload,
  type AcceleventsSessionSpeakerAssociationPayload,
  type AcceleventsSpeakerPayload,
  type AcceleventsTrackPayload,
} from "./accelevents-provider.server";
import { encryptIntegrationCredentials } from "./integration-credentials.server";
import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";

export type IntegrationApiActor = {
  kind: "api_key";
  organisationId: string;
  eventId: string;
  personId: null;
  actorId: string;
};

type IntegrationAdminActor = Viewer | IntegrationApiActor;

export const integrationRunMessageSchema = z.object({
  type: z.literal("integration.accelevents.export"),
  operationId: z.string().min(1),
  runId: z.string().min(1),
  connectionId: z.string().min(1),
  connectionRevision: z.number().int().positive(),
  organisationId: z.string().min(1),
  eventId: z.string().min(1),
  itemId: z.string().min(1).optional(),
});

export const configureIntegrationConnectionSchema =
  acceleventsCredentialsSchema.extend({
    provider: z.literal("accelevents"),
  });

export const integrationMappingInputSchema = z
  .object({
    entityType: z.enum(["speaker", "track", "session", "session_speaker"]),
    entityId: z.string().trim().min(1).max(300),
    externalId: z.string().trim().min(1).max(300),
    sourceHash: z.string().regex(/^[a-f0-9]{64}$/),
    metadata: z.record(z.string().max(100), z.unknown()).default({}),
  })
  .strict();

const runIdentitySchema = {
  connectionId: z.string().min(1),
  idempotencyKey: z.string().trim().min(8).max(128),
};

const startRunSchema = z.discriminatedUnion("dryRun", [
  z
    .object({
      ...runIdentitySchema,
      dryRun: z.literal(true),
      previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    })
    .strict(),
  z
    .object({
      ...runIdentitySchema,
      dryRun: z.literal(false),
      previewFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    })
    .strict(),
]);

export type IntegrationPlanChange = {
  field: string;
  before: unknown;
  after: unknown;
};

export type IntegrationPlanItem = {
  entityType: "speaker" | "track" | "session" | "session_speaker";
  entityId: string;
  label: string;
  action: "create" | "update" | "noop";
  externalId: string | null;
  sourceHash: string;
  payload:
    | AcceleventsSpeakerPayload
    | AcceleventsTrackPayload
    | AcceleventsSessionPayload
    | AcceleventsSessionSpeakerAssociationPayload;
  changes: IntegrationPlanChange[];
  providerSupport: "supported" | "blocked";
  providerMessage: string | null;
};

export class IntegrationStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrationStateError";
  }
}

type IntegrationServiceDependencies = {
  airtable?: AirtableProviderBoundary;
  createAccelevents?: (
    credentials: z.infer<typeof acceleventsCredentialsSchema>,
  ) => Pick<AcceleventsProvider, "validateConnection">;
  enqueue?: (
    message: z.infer<typeof integrationRunMessageSchema>,
  ) => Promise<void>;
};

type ConnectionRow = {
  id: string;
  provider: string;
  status: string;
  direction: string;
  configurationJson: string;
  encryptedCredentials: string | null;
  updatedAt: number;
};

type LocalSpeakerRow = {
  id: string;
  displayName: string;
  email: string;
  biography: string | null;
  organisationName: string | null;
  jobTitle: string | null;
};

type LocalSessionRow = {
  id: string;
  title: string;
  description: string | null;
  format: string;
  visibility: string;
  startsAt: number;
  endsAt: number;
  room: string | null;
  timezone: string;
};

type LocalTrackRow = {
  id: string;
  name: string;
  slug: string;
  colour: string | null;
  position: number;
};

type LocalSessionSpeakerRow = {
  sessionId: string;
  sessionTitle: string;
  personId: string;
  displayName: string;
  position: number;
  roleLabel: string | null;
};

type MappingRow = {
  entityType: string;
  entityId: string;
  externalId: string;
  sourceHash: string;
  metadataJson: string;
};

type ExistingRun = {
  runId: string;
  operationId: string | null;
  operationStatus: string | null;
  dryRun: number;
  requestHash: string | null;
  previewFingerprint: string | null;
};

function splitName(displayName: string) {
  const parts = displayName.trim().split(/\s+/).filter(Boolean);
  if (parts.length < 2)
    throw new IntegrationStateError(
      `Speaker “${displayName}” needs both a first and last name for Accelevents. Update the speaker’s display name, then preview the export again.`,
    );
  return {
    firstName: parts.slice(0, -1).join(" "),
    lastName: parts.at(-1)!,
  };
}

function acceleventsSessionFormat(
  format: string,
): AcceleventsSessionPayload["format"] {
  if (format === "keynote") return "MAIN_STAGE";
  if (format === "workshop") return "WORKSHOP";
  if (format === "break") return "BREAK";
  if (format === "other") return "OTHER";
  return "BREAKOUT_SESSION";
}

function eventLocalDateTime(epoch: number, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(epoch * 1_000));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value;
  const values = {
    year: get("year"),
    month: get("month"),
    day: get("day"),
    hour: get("hour"),
    minute: get("minute"),
  };
  if (Object.values(values).some((value) => !value))
    throw new IntegrationStateError(
      "The event timezone could not be formatted for Accelevents.",
    );
  return `${values.year}/${values.month}/${values.day} ${values.hour}:${values.minute}`;
}

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonicalValue(item)]),
  );
}

function stableJson(value: unknown) {
  return JSON.stringify(canonicalValue(value));
}

async function sourceHash(payload: unknown) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(stableJson(payload)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function mappingPayload(mapping: MappingRow | undefined) {
  if (!mapping) return null;
  let metadata: unknown;
  try {
    metadata = JSON.parse(mapping.metadataJson);
  } catch {
    throw new IntegrationStateError(
      `The saved ${mapping.entityType} mapping contains invalid metadata.`,
    );
  }
  if (!metadata || typeof metadata !== "object" || !("payload" in metadata))
    return null;
  return (metadata as { payload: unknown }).payload;
}

function payloadChanges(before: unknown, after: unknown) {
  const beforeRecord =
    before && typeof before === "object" && !Array.isArray(before)
      ? (before as Record<string, unknown>)
      : {};
  const afterRecord =
    after && typeof after === "object" && !Array.isArray(after)
      ? (after as Record<string, unknown>)
      : {};
  return [
    ...new Set([...Object.keys(beforeRecord), ...Object.keys(afterRecord)]),
  ]
    .sort()
    .filter(
      (field) =>
        stableJson(beforeRecord[field] ?? null) !==
        stableJson(afterRecord[field] ?? null),
    )
    .map((field) => ({
      field,
      before: beforeRecord[field] ?? null,
      after: afterRecord[field] ?? null,
    }));
}

async function planItem(
  input: Omit<IntegrationPlanItem, "action" | "sourceHash" | "changes"> & {
    mapping?: MappingRow;
  },
): Promise<IntegrationPlanItem> {
  const hash = await sourceHash(input.payload);
  const before = mappingPayload(input.mapping);
  const { mapping, ...item } = input;
  return {
    ...item,
    action: !mapping
      ? "create"
      : mapping.sourceHash === hash
        ? "noop"
        : "update",
    externalId: mapping?.externalId ?? item.externalId,
    sourceHash: hash,
    changes: payloadChanges(before, input.payload),
  };
}

function summary(items: IntegrationPlanItem[]) {
  return {
    total: items.length,
    create: items.filter((item) => item.action === "create").length,
    update: items.filter((item) => item.action === "update").length,
    noop: items.filter((item) => item.action === "noop").length,
    blocked: items.filter(
      (item) => item.action !== "noop" && item.providerSupport === "blocked",
    ).length,
  };
}

export class IntegrationService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: IntegrationServiceDependencies = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  private assertAdministrator(viewer: IntegrationAdminActor) {
    if ("kind" in viewer) {
      if (
        viewer.kind !== "api_key" ||
        viewer.personId !== null ||
        !viewer.actorId.startsWith("api_key:")
      ) {
        throw new Response("Invalid integration API actor", { status: 403 });
      }
      return;
    }
    if (!(["owner", "administrator"] as const).includes(viewer.role as never))
      throw new Response("Administrator access is required", { status: 403 });
  }

  private auditActor(viewer: IntegrationAdminActor) {
    return "kind" in viewer
      ? { personId: null, actorId: viewer.actorId }
      : { personId: viewer.personId, actorId: null };
  }

  private accelevents(
    credentials: z.infer<typeof acceleventsCredentialsSchema>,
  ) {
    return (
      this.dependencies.createAccelevents?.(credentials) ??
      new AcceleventsProvider(credentials)
    );
  }

  private async enqueue(message: z.infer<typeof integrationRunMessageSchema>) {
    if (this.dependencies.enqueue) return this.dependencies.enqueue(message);
    if (!this.env.OPERATIONS_QUEUE)
      throw new IntegrationStateError(
        "The operations Queue binding is required for integration exports.",
      );
    await this.env.OPERATIONS_QUEUE.send(message);
  }

  private async existingRun(
    viewer: IntegrationAdminActor,
    connectionId: string,
    idempotencyKey: string,
  ) {
    return this.env.DB.prepare(
      `SELECT run.id AS runId, run.operation_id AS operationId,
              operation.status AS operationStatus, run.dry_run AS dryRun,
              json_extract(run.summary_json, '$.requestHash') AS requestHash,
              json_extract(run.summary_json, '$.previewFingerprint') AS previewFingerprint
         FROM integration_runs run
         JOIN integration_connections connection ON connection.id = run.connection_id
         LEFT JOIN operation_jobs operation ON operation.id = run.operation_id
        WHERE run.connection_id = ? AND run.idempotency_key = ?
          AND connection.event_id = ? AND connection.organisation_id = ?`,
    )
      .bind(connectionId, idempotencyKey, viewer.eventId, viewer.organisationId)
      .first<ExistingRun>();
  }

  private replayRun(
    existing: ExistingRun,
    dryRun: boolean,
    requestHash: string,
  ) {
    if (
      Boolean(existing.dryRun) !== dryRun ||
      existing.requestHash !== requestHash
    ) {
      throw new IntegrationStateError(
        "This idempotency key was already used with a different export request.",
      );
    }
    return {
      runId: existing.runId,
      operationId: existing.operationId,
      queued: existing.operationStatus === "queued",
      replayed: true,
      previewFingerprint: existing.previewFingerprint,
    };
  }

  async getWorkspace(viewer: Viewer) {
    this.assertAdministrator(viewer);
    const [connections, runs] = await Promise.all([
      this.env.DB.prepare(
        `SELECT id, provider, status, direction, configuration_json AS configurationJson,
                encrypted_credentials AS encryptedCredentials, updated_at AS updatedAt
           FROM integration_connections
          WHERE event_id = ? AND organisation_id = ? AND provider = 'accelevents'
          ORDER BY updated_at DESC`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .all<ConnectionRow>(),
      this.env.DB.prepare(
        `SELECT run.id, run.connection_id AS connectionId, run.operation_id AS operationId,
                connection.provider,
                run.status, run.direction, run.dry_run AS dryRun,
                run.summary_json AS summaryJson, run.created_at AS createdAt,
                run.completed_at AS completedAt
           FROM integration_runs run
           JOIN integration_connections connection ON connection.id = run.connection_id
          WHERE connection.event_id = ? AND connection.organisation_id = ?
            AND connection.provider = 'accelevents'
          ORDER BY run.created_at DESC LIMIT 25`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .all<{
          id: string;
          connectionId: string;
          operationId: string;
          provider: string;
          status: string;
          direction: string;
          dryRun: number;
          summaryJson: string;
          createdAt: number;
          completedAt: number | null;
        }>(),
    ]);
    return {
      connections: connections.results.map((connection) => {
        const configuration = JSON.parse(
          connection.configurationJson,
        ) as unknown;
        const demoNoWriteFixture = Boolean(
          configuration &&
          typeof configuration === "object" &&
          "demoNoWriteFixture" in configuration &&
          configuration.demoNoWriteFixture === true,
        );
        return {
          ...connection,
          configuration,
          demoNoWriteFixture,
          hasCredentials: Boolean(connection.encryptedCredentials),
          encryptedCredentials: undefined,
        };
      }),
      runs: runs.results.map((run) => ({
        ...run,
        dryRun: Boolean(run.dryRun),
        summary: JSON.parse(run.summaryJson) as unknown,
      })),
    };
  }

  async configureAccelevents(
    viewer: Viewer,
    raw: unknown,
    command?: { operationId: string; connectionId: string },
  ) {
    this.assertAdministrator(viewer);
    const input = configureIntegrationConnectionSchema.parse(raw);
    const credentials = acceleventsCredentialsSchema.parse(input);
    const existing = await this.env.DB.prepare(
      `SELECT id, revision FROM integration_connections
        WHERE event_id = ? AND organisation_id = ? AND provider = 'accelevents'
        ORDER BY created_at LIMIT 1`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ id: string; revision: number }>();
    const connectionId =
      existing?.id ?? command?.connectionId ?? crypto.randomUUID();
    const operationId = command?.operationId ?? crypto.randomUUID();
    if (command) {
      const recovered = await this.env.DB.prepare(
        `SELECT id FROM integration_connections
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND provider = 'accelevents' AND status = 'connected'
            AND last_operation_id = ?`,
      )
        .bind(connectionId, viewer.eventId, viewer.organisationId, operationId)
        .first();
      if (recovered) return { connectionId };
    }
    const encrypted = await encryptIntegrationCredentials(
      credentials,
      this.env.INTEGRATION_CREDENTIALS_KEY,
      connectionId,
    );
    await this.accelevents(credentials).validateConnection();
    const configuration = JSON.stringify({
      eventUrl: credentials.eventUrl,
      externalEventId: credentials.externalEventId,
      sessionTypeFormat: credentials.sessionTypeFormat,
    });
    const statements: D1PreparedStatement[] = existing
      ? [
          this.env.DB.prepare(
            `UPDATE integration_connections
                SET status = 'connected', direction = 'outbound',
                    encrypted_credentials = ?, configuration_json = ?,
                    revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
              WHERE id = ? AND event_id = ? AND organisation_id = ? AND revision = ?`,
          ).bind(
            encrypted,
            configuration,
            operationId,
            connectionId,
            viewer.eventId,
            viewer.organisationId,
            existing.revision,
          ),
        ]
      : [
          this.env.DB.prepare(
            `INSERT INTO integration_connections (
               id, organisation_id, event_id, provider, status, direction,
               conflict_policy, encrypted_credentials, configuration_json,
               revision, last_operation_id, created_at, updated_at
             ) VALUES (?, ?, ?, 'accelevents', 'connected', 'outbound',
                       'program_cue_wins', ?, ?, 1, ?, unixepoch(), unixepoch())`,
          ).bind(
            connectionId,
            viewer.organisationId,
            viewer.eventId,
            encrypted,
            configuration,
            operationId,
          ),
        ];
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'integration.connection.saved',
                'integration_connection', ?, ?, ?, unixepoch()
          FROM integration_connections
         WHERE id = ? AND event_id = ? AND organisation_id = ?
           AND last_operation_id = ?`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        connectionId,
        operationId,
        JSON.stringify({
          provider: "accelevents",
          eventUrl: credentials.eventUrl,
        }),
        connectionId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    );
    const results = await this.env.DB.batch(statements);
    if ((results[0]?.meta.changes ?? 0) !== 1)
      throw new IntegrationStateError(
        "The integration connection changed before it could be saved.",
      );
    return { connectionId };
  }

  async disconnect(
    viewer: Viewer,
    connectionId: string,
    suppliedOperationId?: string,
  ) {
    this.assertAdministrator(viewer);
    const current = await this.env.DB.prepare(
      `SELECT connection.revision, connection.provider,
              event.repository_provider AS repositoryProvider
         FROM integration_connections connection
         JOIN events event
           ON event.id = connection.event_id
          AND event.organisation_id = connection.organisation_id
        WHERE connection.id = ? AND connection.event_id = ?
          AND connection.organisation_id = ?
          AND connection.status <> 'disconnected'`,
    )
      .bind(connectionId, viewer.eventId, viewer.organisationId)
      .first<{
        revision: number;
        provider: string;
        repositoryProvider: string;
      }>();
    if (!current) {
      if (suppliedOperationId) {
        const recovered = await this.env.DB.prepare(
          `SELECT 1 FROM integration_connections
            WHERE id = ? AND event_id = ? AND organisation_id = ?
              AND status = 'disconnected' AND last_operation_id = ?`,
        )
          .bind(
            connectionId,
            viewer.eventId,
            viewer.organisationId,
            suppliedOperationId,
          )
          .first();
        if (recovered) return { connectionId };
      }
      throw new IntegrationStateError(
        "The active integration connection was not found.",
      );
    }
    if (
      current.provider === "airtable_repository" &&
      current.repositoryProvider === "airtable"
    )
      throw new IntegrationStateError(
        "Migrate event-data authority back to D1 before disconnecting Airtable.",
      );
    const operationId = suppliedOperationId ?? crypto.randomUUID();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE integration_connections
            SET status = 'disconnected', encrypted_credentials = NULL,
                revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ? AND revision = ?
            AND status <> 'disconnected'
            AND NOT (
              provider = 'airtable_repository'
              AND EXISTS (
                SELECT 1 FROM events event
                 WHERE event.id = integration_connections.event_id
                   AND event.organisation_id = integration_connections.organisation_id
                   AND event.repository_provider = 'airtable'
              )
            )`,
      ).bind(
        operationId,
        connectionId,
        viewer.eventId,
        viewer.organisationId,
        current.revision,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'integration.connection.disconnected',
                'integration_connection', ?, ?, '{}', unixepoch()
          FROM integration_connections
         WHERE id = ? AND event_id = ? AND organisation_id = ?
           AND last_operation_id = ?`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        connectionId,
        operationId,
        connectionId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1)
      throw new IntegrationStateError(
        "The integration connection changed before it could be disconnected.",
      );
    return { connectionId };
  }

  private async assertMappingEntity(
    viewer: Viewer,
    input: z.infer<typeof integrationMappingInputSchema>,
  ) {
    const queries = {
      speaker:
        "SELECT 1 FROM people person WHERE person.id = ? AND EXISTS (SELECT 1 FROM session_speakers speaker WHERE speaker.event_id = ? AND speaker.person_id = person.id)",
      track: "SELECT 1 FROM tracks WHERE id = ? AND event_id = ?",
      session: "SELECT 1 FROM sessions WHERE id = ? AND event_id = ?",
      session_speaker:
        "SELECT 1 FROM session_speakers WHERE event_id = ? AND session_id || ':' || person_id = ?",
    } satisfies Record<typeof input.entityType, string>;
    const entity = await this.env.DB.prepare(queries[input.entityType])
      .bind(
        ...(input.entityType === "session_speaker"
          ? [viewer.eventId, input.entityId]
          : [input.entityId, viewer.eventId]),
      )
      .first();
    if (!entity) {
      throw new IntegrationStateError(
        "The mapping target does not exist in this event.",
      );
    }
  }

  async saveMapping(
    viewer: Viewer,
    connectionId: string,
    raw: unknown,
    operationId: string = crypto.randomUUID(),
  ) {
    this.assertAdministrator(viewer);
    const input = integrationMappingInputSchema.parse(raw);
    const connection = await this.env.DB.prepare(
      `SELECT id FROM integration_connections
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND status = 'connected'`,
    )
      .bind(connectionId, viewer.eventId, viewer.organisationId)
      .first();
    if (!connection) {
      throw new IntegrationStateError(
        "Connect this integration before saving mappings.",
      );
    }
    const recovered = await this.env.DB.prepare(
      `SELECT id FROM integration_entity_mappings
        WHERE connection_id = ? AND entity_type = ? AND entity_id = ?
          AND external_id = ? AND source_hash = ? AND last_operation_id = ?`,
    )
      .bind(
        connectionId,
        input.entityType,
        input.entityId,
        input.externalId,
        input.sourceHash,
        operationId,
      )
      .first<{ id: string }>();
    if (recovered) return { mappingId: recovered.id };
    await this.assertMappingEntity(viewer, input);
    const current = await this.env.DB.prepare(
      `SELECT id FROM integration_entity_mappings
        WHERE connection_id = ? AND entity_type = ? AND entity_id = ?`,
    )
      .bind(connectionId, input.entityType, input.entityId)
      .first<{ id: string }>();
    const mappingId = current?.id ?? operationId;
    try {
      const [saved] = await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO integration_entity_mappings (
             id, connection_id, entity_type, entity_id, external_id,
             source_hash, metadata_json, last_operation_id,
             last_synced_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(), unixepoch())
           ON CONFLICT(connection_id, entity_type, entity_id) DO UPDATE SET
             external_id = excluded.external_id,
             source_hash = excluded.source_hash,
             metadata_json = excluded.metadata_json,
             last_operation_id = excluded.last_operation_id,
             last_synced_at = unixepoch(), updated_at = unixepoch()`,
        ).bind(
          mappingId,
          connectionId,
          input.entityType,
          input.entityId,
          input.externalId,
          input.sourceHash,
          JSON.stringify(input.metadata),
          operationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           ) SELECT ?, ?, ?, ?, 'integration.mapping.saved',
                    'integration_mapping', id, ?, ?, unixepoch()
               FROM integration_entity_mappings
              WHERE connection_id = ? AND entity_type = ? AND entity_id = ?
                AND last_operation_id = ?`,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          operationId,
          JSON.stringify({
            connectionId,
            entityType: input.entityType,
            entityId: input.entityId,
            externalId: input.externalId,
          }),
          connectionId,
          input.entityType,
          input.entityId,
          operationId,
        ),
      ]);
      if ((saved.meta.changes ?? 0) !== 1) {
        throw new IntegrationStateError("The mapping could not be saved.");
      }
    } catch (error) {
      if (
        error instanceof Error &&
        /integration_entity_mappings\.connection_id.*external_id/i.test(
          error.message,
        )
      ) {
        throw new IntegrationStateError(
          "That external identifier is already mapped in this connection.",
        );
      }
      throw error;
    }
    return { mappingId };
  }

  async deleteMapping(
    viewer: Viewer,
    connectionId: string,
    entityType: z.infer<typeof integrationMappingInputSchema>["entityType"],
    entityId: string,
    operationId: string = crypto.randomUUID(),
  ) {
    this.assertAdministrator(viewer);
    const prior = await this.env.DB.prepare(
      `SELECT mapping.id
         FROM integration_entity_mappings mapping
         JOIN integration_connections connection
           ON connection.id = mapping.connection_id
        WHERE mapping.connection_id = ? AND mapping.entity_type = ?
          AND mapping.entity_id = ? AND connection.event_id = ?
          AND connection.organisation_id = ?`,
    )
      .bind(
        connectionId,
        entityType,
        entityId,
        viewer.eventId,
        viewer.organisationId,
      )
      .first<{ id: string }>();
    if (!prior) {
      const recovered = await this.env.DB.prepare(
        `SELECT entity_id AS mappingId FROM audit_events
          WHERE organisation_id = ? AND event_id = ?
            AND action = 'integration.mapping.deleted'
            AND correlation_id = ? LIMIT 1`,
      )
        .bind(viewer.organisationId, viewer.eventId, operationId)
        .first<{ mappingId: string }>();
      if (recovered) return recovered;
      throw new IntegrationStateError("The integration mapping was not found.");
    }
    const [deleted] = await this.env.DB.batch([
      this.env.DB.prepare(
        `DELETE FROM integration_entity_mappings
          WHERE id = ? AND connection_id = ? AND entity_type = ? AND entity_id = ?
            AND EXISTS (
              SELECT 1 FROM integration_connections connection
               WHERE connection.id = integration_entity_mappings.connection_id
                 AND connection.event_id = ? AND connection.organisation_id = ?
            )`,
      ).bind(
        prior.id,
        connectionId,
        entityType,
        entityId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'integration.mapping.deleted',
                  'integration_mapping', ?, ?, ?, unixepoch()
             WHERE changes() = 1`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        prior.id,
        operationId,
        JSON.stringify({ connectionId, entityType, entityId }),
      ),
    ]);
    if ((deleted.meta.changes ?? 0) !== 1) {
      throw new IntegrationStateError(
        "The mapping changed before it could be deleted.",
      );
    }
    return { mappingId: prior.id };
  }

  async preview(viewer: IntegrationAdminActor, connectionId: string) {
    this.assertAdministrator(viewer);
    await this.airtable.assertReadable(viewer);
    const connection = await this.env.DB.prepare(
      `SELECT id, provider, status, revision,
              configuration_json AS configurationJson
         FROM integration_connections
        WHERE id = ? AND event_id = ? AND organisation_id = ?`,
    )
      .bind(connectionId, viewer.eventId, viewer.organisationId)
      .first<{
        id: string;
        provider: string;
        status: string;
        revision: number;
        configurationJson: string;
      }>();
    if (!connection)
      throw new IntegrationStateError("Integration connection not found.");
    if (connection.provider !== "accelevents")
      throw new IntegrationStateError(
        "This integration provider is not supported by this export.",
      );
    if (connection.status !== "connected")
      throw new IntegrationStateError(
        "Reconnect Accelevents before previewing an export.",
      );
    let connectionConfiguration: unknown;
    try {
      connectionConfiguration = JSON.parse(connection.configurationJson);
    } catch {
      throw new IntegrationStateError(
        "The Accelevents connection configuration is invalid. Reconnect before exporting.",
      );
    }
    const parsedConfiguration = z
      .object({
        sessionTypeFormat: z.enum(["VIRTUAL", "IN_PERSON", "HYBRID"]),
        demoNoWriteFixture: z.boolean().optional(),
      })
      .safeParse(connectionConfiguration);
    if (!parsedConfiguration.success) {
      throw new IntegrationStateError(
        "The Accelevents connection is missing its event delivery format. Reconnect before exporting.",
      );
    }
    const { sessionTypeFormat } = parsedConfiguration.data;
    const demoNoWriteFixture =
      parsedConfiguration.data.demoNoWriteFixture === true;
    if (demoNoWriteFixture && String(this.env.DEMO_MODE) !== "true") {
      throw new IntegrationStateError(
        "A demo-only Accelevents fixture cannot be used outside demo mode.",
      );
    }

    const [speakers, tracks, sessions, sessionSpeakers, mappings] =
      await Promise.all([
        this.env.DB.prepare(
          `SELECT DISTINCT person.id, person.display_name AS displayName, person.email,
                person.biography, person.organisation_name AS organisationName,
                person.job_title AS jobTitle
           FROM schedule_versions version
           JOIN schedule_entries entry ON entry.schedule_version_id = version.id
           JOIN sessions session ON session.id = entry.session_id AND session.event_id = version.event_id
           JOIN session_speakers relationship ON relationship.session_id = session.id
                AND relationship.event_id = session.event_id
           JOIN people person ON person.id = relationship.person_id
          WHERE version.event_id = ? AND version.status = 'published'
            AND session.status = 'published' AND relationship.visibility <> 'hidden'
          ORDER BY person.display_name, person.id`,
        )
          .bind(viewer.eventId)
          .all<LocalSpeakerRow>(),
        this.env.DB.prepare(
          `SELECT DISTINCT track.id, track.name, track.slug,
                track.colour_token AS colour, track.position
           FROM schedule_versions version
           JOIN schedule_entries entry ON entry.schedule_version_id = version.id
                AND entry.event_id = version.event_id
           JOIN sessions session ON session.id = entry.session_id
                AND session.event_id = version.event_id
           JOIN tracks track ON track.id = session.track_id
                AND track.event_id = session.event_id
          WHERE version.event_id = ? AND version.status = 'published'
            AND session.status = 'published'
          ORDER BY track.position, track.name, track.id`,
        )
          .bind(viewer.eventId)
          .all<LocalTrackRow>(),
        this.env.DB.prepare(
          `SELECT session.id, session.title, session.description, session.format,
                session.visibility, entry.starts_at AS startsAt, entry.ends_at AS endsAt,
                room.name AS room, event.timezone
           FROM schedule_versions version
           JOIN schedule_entries entry ON entry.schedule_version_id = version.id
           JOIN sessions session ON session.id = entry.session_id AND session.event_id = version.event_id
           JOIN events event ON event.id = version.event_id AND event.organisation_id = ?
           LEFT JOIN rooms room ON room.id = entry.room_id AND room.event_id = version.event_id
          WHERE version.event_id = ? AND version.status = 'published'
            AND session.status = 'published'
          ORDER BY entry.starts_at, session.id`,
        )
          .bind(viewer.organisationId, viewer.eventId)
          .all<LocalSessionRow>(),
        this.env.DB.prepare(
          `SELECT relationship.session_id AS sessionId,
                session.title AS sessionTitle,
                relationship.person_id AS personId,
                person.display_name AS displayName,
                relationship.position,
                relationship.role_label AS roleLabel
           FROM schedule_versions version
           JOIN schedule_entries entry ON entry.schedule_version_id = version.id
                AND entry.event_id = version.event_id
           JOIN sessions session ON session.id = entry.session_id
                AND session.event_id = version.event_id
           JOIN session_speakers relationship
                ON relationship.session_id = session.id
               AND relationship.event_id = session.event_id
           JOIN people person ON person.id = relationship.person_id
          WHERE version.event_id = ? AND version.status = 'published'
            AND session.status = 'published'
            AND relationship.visibility <> 'hidden'
          ORDER BY session.id, relationship.position, relationship.person_id`,
        )
          .bind(viewer.eventId)
          .all<LocalSessionSpeakerRow>(),
        this.env.DB.prepare(
          `SELECT entity_type AS entityType, entity_id AS entityId,
                external_id AS externalId, source_hash AS sourceHash,
                metadata_json AS metadataJson
           FROM integration_entity_mappings WHERE connection_id = ?`,
        )
          .bind(connectionId)
          .all<MappingRow>(),
      ]);
    const mappingByEntity = new Map(
      mappings.results.map((mapping) => [
        `${mapping.entityType}:${mapping.entityId}`,
        mapping,
      ]),
    );
    const items: IntegrationPlanItem[] = [];
    for (const speaker of speakers.results) {
      const name = splitName(speaker.displayName);
      const payload: AcceleventsSpeakerPayload = {
        ...name,
        email: speaker.email,
        ...(speaker.biography ? { bio: speaker.biography } : {}),
        ...(speaker.organisationName
          ? { company: speaker.organisationName }
          : {}),
        ...(speaker.jobTitle ? { title: speaker.jobTitle } : {}),
        allowAttendeeAccess: true,
        allowOverrideDetails: true,
      };
      const mapping = mappingByEntity.get(`speaker:${speaker.id}`);
      items.push(
        await planItem({
          entityType: "speaker",
          entityId: speaker.id,
          label: speaker.displayName,
          externalId: mapping?.externalId ?? null,
          payload,
          mapping,
          providerSupport: "supported",
          providerMessage: null,
        }),
      );
    }
    for (const track of tracks.results) {
      const payload: AcceleventsTrackPayload = {
        type: "TRACK",
        name: track.name,
        ...(track.colour ? { color: track.colour } : {}),
        description: `Program Cue track: ${track.slug}`,
        position: track.position,
      };
      const mapping = mappingByEntity.get(`track:${track.id}`);
      const item = await planItem({
        entityType: "track",
        entityId: track.id,
        label: track.name,
        externalId: mapping?.externalId ?? null,
        payload,
        mapping,
        providerSupport: mapping ? "blocked" : "supported",
        providerMessage: mapping ? ACCELEVENTS_TRACK_UPDATE_UNSUPPORTED : null,
      });
      if (item.action === "noop") {
        item.providerSupport = "supported";
        item.providerMessage = null;
      }
      items.push(item);
    }
    for (const session of sessions.results) {
      const payload: AcceleventsSessionPayload = {
        title: session.title,
        ...(session.description ? { description: session.description } : {}),
        startTime: eventLocalDateTime(session.startsAt, session.timezone),
        endTime: eventLocalDateTime(session.endsAt, session.timezone),
        format: acceleventsSessionFormat(session.format),
        status: session.visibility === "hidden" ? "HIDDEN" : "VISIBLE",
        sessionVisibilityType:
          session.visibility === "private" ? "PRIVATE" : "PUBLIC",
        sessionTypeFormat,
        ...(session.room ? { location: session.room } : {}),
      };
      const mapping = mappingByEntity.get(`session:${session.id}`);
      items.push(
        await planItem({
          entityType: "session",
          entityId: session.id,
          label: session.title,
          externalId: mapping?.externalId ?? null,
          payload,
          mapping,
          providerSupport: "supported",
          providerMessage: null,
        }),
      );
    }
    for (const association of sessionSpeakers.results) {
      const entityId = `${association.sessionId}:${association.personId}`;
      const payload: AcceleventsSessionSpeakerAssociationPayload = {
        sessionId: association.sessionId,
        speakerId: association.personId,
        position: association.position,
        roleLabel: association.roleLabel,
      };
      const mapping = mappingByEntity.get(`session_speaker:${entityId}`);
      items.push(
        await planItem({
          entityType: "session_speaker",
          entityId,
          label: `${association.displayName} → ${association.sessionTitle}`,
          externalId: mapping?.externalId ?? null,
          payload,
          mapping,
          providerSupport: "blocked",
          providerMessage: ACCELEVENTS_SESSION_SPEAKER_WRITE_UNSUPPORTED,
        }),
      );
    }
    const previewFingerprint = await sourceHash({
      connectionId: connection.id,
      connectionRevision: connection.revision,
      items,
    });
    return {
      connection: { ...connection, demoNoWriteFixture },
      items,
      summary: summary(items),
      previewFingerprint,
    };
  }

  async startRun(viewer: IntegrationAdminActor, raw: unknown) {
    this.assertAdministrator(viewer);
    const auditActor = this.auditActor(viewer);
    const input = startRunSchema.parse(raw);
    const requestHash = await sourceHash({
      connectionId: input.connectionId,
      dryRun: input.dryRun,
      previewFingerprint: input.previewFingerprint ?? null,
    });
    const duplicate = await this.existingRun(
      viewer,
      input.connectionId,
      input.idempotencyKey,
    );
    if (duplicate)
      return this.replayRun(duplicate, input.dryRun, requestHash);

    const preview = await this.preview(viewer, input.connectionId);
    if (
      input.previewFingerprint &&
      input.previewFingerprint !== preview.previewFingerprint
    ) {
      throw new IntegrationStateError(
        "The Accelevents export changed after it was previewed. Review the refreshed mapping before confirming it.",
      );
    }
    if (preview.connection.demoNoWriteFixture && !input.dryRun) {
      throw new IntegrationStateError(
        "The demo-only Accelevents fixture supports no-write dry runs only. Configure verified provider credentials before starting a live export.",
      );
    }
    const runId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const runSummary = {
      ...summary(preview.items),
      requestHash,
      previewFingerprint: preview.previewFingerprint,
    };
    const noProviderWork = preview.items.every(
      (item) => item.action === "noop",
    );
    const completeImmediately = input.dryRun || noProviderWork;
    const message = integrationRunMessageSchema.parse({
      type: "integration.accelevents.export",
      operationId,
      runId,
      connectionId: input.connectionId,
      connectionRevision: preview.connection.revision,
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
    });
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, result_json,
           progress_total, progress_completed, progress_failed, cancellable,
           completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'integration.accelevents.export', ?, ?, ?, ?, ?,
                   ?, ?, 0, 0, ?, unixepoch(), unixepoch())`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        input.idempotencyKey,
        correlationId,
        completeImmediately ? "completed" : "queued",
        JSON.stringify(message),
        completeImmediately ? JSON.stringify(runSummary) : null,
        preview.items.length,
        completeImmediately ? preview.items.length : runSummary.noop,
        completeImmediately ? Math.floor(Date.now() / 1_000) : null,
      ),
      this.env.DB.prepare(
        `INSERT INTO integration_runs (
           id, connection_id, operation_id, idempotency_key, status, direction,
           dry_run, summary_json, started_at, completed_at, created_at
         ) VALUES (?, ?, ?, ?, ?, 'outbound', ?, ?, ?, ?, unixepoch())`,
      ).bind(
        runId,
        input.connectionId,
        operationId,
        input.idempotencyKey,
        completeImmediately ? "succeeded" : "queued",
        input.dryRun ? 1 : 0,
        JSON.stringify(runSummary),
        completeImmediately ? Math.floor(Date.now() / 1_000) : null,
        completeImmediately ? Math.floor(Date.now() / 1_000) : null,
      ),
      ...preview.items.flatMap((item) => {
        const itemId = crypto.randomUUID();
        const itemKey = `${item.entityType}:${item.entityId}`;
        const itemStatus =
          input.dryRun || item.action === "noop" ? "skipped" : "pending";
        const diff = JSON.stringify({
          label: item.label,
          payload: item.payload,
          sourceHash: item.sourceHash,
          previousExternalId: item.externalId,
          changes: item.changes,
          providerSupport: item.providerSupport,
          providerMessage: item.providerMessage,
        });
        return [
          this.env.DB.prepare(
            `INSERT INTO integration_run_items (
               id, run_id, entity_type, entity_id, external_id, action, status,
               diff_json, attempt_count, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, unixepoch())`,
          ).bind(
            itemId,
            runId,
            item.entityType,
            item.entityId,
            item.externalId,
            item.action,
            itemStatus,
            diff,
          ),
          this.env.DB.prepare(
            `INSERT INTO operation_items (
               id, operation_id, item_key, entity_type, entity_id, status,
               result_json, updated_at, completed_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch(), ?)`,
          ).bind(
            crypto.randomUUID(),
            operationId,
            itemKey,
            item.entityType,
            item.entityId,
            itemStatus,
            diff,
            itemStatus === "skipped" ? Math.floor(Date.now() / 1_000) : null,
          ),
        ];
      }),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, actor_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (?, ?, ?, ?, ?, 'integration.run.created', 'integration_run', ?, ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        runId,
        correlationId,
        JSON.stringify({ dryRun: input.dryRun, ...runSummary }),
      ),
    ];
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      // A concurrent request can win the unique (connection, key) claim after
      // our initial lookup. Return its durable result instead of surfacing the
      // storage constraint as a spurious 500. Other storage failures still fail.
      const winner = await this.existingRun(
        viewer,
        input.connectionId,
        input.idempotencyKey,
      );
      if (!winner) throw error;
      return this.replayRun(winner, input.dryRun, requestHash);
    }
    if (!completeImmediately) {
      try {
        await this.enqueue(message);
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
              WHERE id = ? AND status = 'queued'`,
          ).bind(failure.slice(0, 2_000), operationId),
          this.env.DB.prepare(
            `UPDATE integration_runs SET status = 'failed', summary_json = json_set(summary_json, '$.queueError', ?), completed_at = unixepoch()
              WHERE id = ? AND status = 'queued'`,
          ).bind(failure.slice(0, 2_000), runId),
        ]);
        throw new IntegrationStateError(
          `The export was saved as ${operationId}, but Queue delivery failed. Retry it from Operations.`,
        );
      }
    }
    return {
      runId,
      operationId,
      queued: !completeImmediately,
      replayed: false,
      previewFingerprint: preview.previewFingerprint,
    };
  }
}
