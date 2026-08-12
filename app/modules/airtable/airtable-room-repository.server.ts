import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  decryptIntegrationCredentials,
  encryptIntegrationCredentials,
} from "~/modules/integrations/integration-credentials.server";
import {
  AirtableClient,
  AirtableProviderError,
  airtableEqualsFormula,
  type AirtableRecord,
  type AirtableTable,
} from "./airtable-client.server";
import {
  AIRTABLE_CACHE_TTL_SECONDS,
  AIRTABLE_EVENT_DATA_FIELDS,
  AIRTABLE_EVENT_DATA_TABLE_NAMES,
  AIRTABLE_ROOM_FIELDS,
  AIRTABLE_SCHEDULE_FIELDS,
  AIRTABLE_SCHEDULE_TABLE,
  AIRTABLE_SCHEMA_VERSION,
  AIRTABLE_SESSION_FIELDS,
  AIRTABLE_SESSIONS_TABLE,
  AIRTABLE_SPEAKER_FIELDS,
  AIRTABLE_SPEAKERS_TABLE,
  airtableConnectionConfigurationSchema,
  airtableConnectionInputSchema,
  airtableCredentialsSchema,
  airtableRoomSchema,
  type AirtableConnectionConfiguration,
  type AirtableConnectionInput,
  type AirtableCredentials,
  type AirtableEventDataTableKey,
  type AirtableRoom,
} from "./airtable-schema";

export const AIRTABLE_REPOSITORY_PROVIDER = "airtable_repository";

export class AirtableRepositoryConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableRepositoryConfigurationError";
  }
}

export class AirtableRepositorySchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableRepositorySchemaError";
  }
}

export class AirtableRepositoryReconciliationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableRepositoryReconciliationError";
  }
}

type ConnectionRow = {
  id: string;
  status: string;
  encryptedCredentials: string | null;
  configurationJson: string;
  revision: number;
};

export type AirtableRepositoryConnection = {
  id: string;
  status: "connected" | "needs_attention" | "failed" | "disconnected";
  configuration: AirtableConnectionConfiguration;
  credentials: AirtableCredentials;
  revision: number;
};

export type PreparedAirtableRepositoryConnection = {
  connectionId: string;
  encryptedCredentials: string;
  configuration: AirtableConnectionConfiguration;
};

export type AirtableRoomSnapshot = {
  rooms: AirtableRoom[];
  fetchedAt: number;
  cacheExpiresAt: number;
  cached: boolean;
};

type AirtableRoomRepositoryDependencies = {
  createClient?: (credentials: AirtableCredentials) => AirtableClientPort;
  now?: () => number;
};

type AirtableClientPort = Pick<
  AirtableClient,
  | "getBaseSchema"
  | "createTable"
  | "createField"
  | "listRecords"
  | "upsertRecords"
  | "deleteRecords"
>;

type CachedRooms = Omit<AirtableRoomSnapshot, "cached">;
const roomCache = new Map<string, CachedRooms>();

function assertAdministrator(viewer: Viewer) {
  if (!(["owner", "administrator"] as string[]).includes(viewer.role))
    throw new Response("Administrator access is required", { status: 403 });
}

function sortRooms<T extends Pick<AirtableRoom, "position" | "name" | "id">>(
  rooms: T[],
) {
  return rooms.sort(
    (left, right) =>
      left.position - right.position ||
      left.name.localeCompare(right.name) ||
      left.id.localeCompare(right.id),
  );
}

function fieldMap(table: AirtableTable) {
  const fields = new Map<string, AirtableTable["fields"][number]>();
  for (const field of table.fields) {
    if (fields.has(field.name))
      throw new AirtableRepositorySchemaError(
        `Airtable table “${table.name}” contains duplicate field name “${field.name}”.`,
      );
    fields.set(field.name, field);
  }
  return fields;
}

function validateFieldType(
  table: AirtableTable,
  name: string,
  expectedType: string,
) {
  const field = fieldMap(table).get(name);
  if (!field) return false;
  if (field.type !== expectedType) {
    throw new AirtableRepositorySchemaError(
      `Airtable table “${table.name}” field “${name}” must use type ${expectedType}; found ${field.type}.`,
    );
  }
  return true;
}

function parseRoomRecord(record: AirtableRecord, eventId: string) {
  const fields = record.fields;
  if (fields["Event ID"] !== eventId) return null;
  try {
    return airtableRoomSchema.parse({
      id: fields["Program Cue ID"],
      eventId: fields["Event ID"],
      name: fields.Name,
      capacity: fields.Capacity,
      position: fields.Position,
      status: fields.Status,
      revision: fields.Revision,
      building:
        typeof fields.Building === "string" && fields.Building
          ? fields.Building
          : null,
      level:
        typeof fields.Level === "string" && fields.Level ? fields.Level : null,
      resources: (() => {
        try {
          return JSON.parse(String(fields["Resources JSON"] ?? "[]"));
        } catch {
          throw new AirtableRepositorySchemaError(
            `Airtable room record ${record.id} Resources JSON must contain a JSON string array.`,
          );
        }
      })(),
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      throw new AirtableRepositorySchemaError(
        `Airtable room record ${record.id} does not match the managed Program Cue schema: ${error.issues[0]?.message ?? "invalid record"}.`,
      );
    }
    throw error;
  }
}

function toAirtableFields(room: AirtableRoom) {
  return {
    "Program Cue ID": room.id,
    "Event ID": room.eventId,
    Name: room.name,
    Capacity: room.capacity,
    Position: room.position,
    Status: room.status,
    Revision: room.revision,
    Building: room.building ?? "",
    Level: room.level ?? "",
    "Resources JSON": JSON.stringify(room.resources),
  };
}

function sameRooms(left: AirtableRoom[], right: AirtableRoom[]) {
  if (left.length !== right.length) return false;
  return left.every((room, index) => {
    const candidate = right[index];
    return (
      candidate?.id === room.id &&
      candidate.eventId === room.eventId &&
      candidate.name === room.name &&
      candidate.capacity === room.capacity &&
      candidate.position === room.position &&
      candidate.status === room.status &&
      candidate.revision === room.revision &&
      candidate.building === room.building &&
      candidate.level === room.level &&
      JSON.stringify(candidate.resources) === JSON.stringify(room.resources)
    );
  });
}

function sameActiveRoomProjection(left: AirtableRoom[], right: AirtableRoom[]) {
  if (left.length !== right.length) return false;
  return left.every((room, index) => {
    const candidate = right[index];
    return (
      candidate?.id === room.id &&
      candidate.eventId === room.eventId &&
      candidate.name === room.name &&
      candidate.capacity === room.capacity &&
      candidate.position === room.position &&
      candidate.status === room.status &&
      JSON.stringify(candidate.resources) === JSON.stringify(room.resources)
    );
  });
}

export class AirtableRoomRepository {
  private readonly now;

  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: AirtableRoomRepositoryDependencies = {},
  ) {
    this.now = dependencies.now ?? Date.now;
  }

  private client(credentials: AirtableCredentials) {
    return (
      this.dependencies.createClient?.(credentials) ??
      new AirtableClient(credentials)
    );
  }

  private cacheKey(connectionId: string, eventId: string) {
    return `${connectionId}:${eventId}`;
  }

  invalidate(connectionId: string, eventId: string) {
    roomCache.delete(this.cacheKey(connectionId, eventId));
  }

  async provisionAndValidateSchema(
    client: AirtableClientPort,
    tableName: string,
    fields = AIRTABLE_ROOM_FIELDS,
    primaryFieldName = "Program Cue ID",
    expectedTableId?: string,
    knownTables?: AirtableTable[],
  ) {
    const tables = knownTables ?? (await client.getBaseSchema());
    const namedTables = tables.filter(
      (candidate) => candidate.name === tableName,
    );
    if (!expectedTableId && namedTables.length > 1)
      throw new AirtableRepositorySchemaError(
        `Airtable base contains multiple tables named “${tableName}”. Rename them so the managed table is unambiguous.`,
      );
    let table = expectedTableId
      ? tables.find((candidate) => candidate.id === expectedTableId)
      : namedTables[0];
    if (expectedTableId && !table)
      throw new AirtableRepositorySchemaError(
        `The configured Airtable table “${tableName}” (${expectedTableId}) no longer exists. Restore it or migrate authority back to D1 before changing repositories.`,
      );
    if (!table) {
      table = await client.createTable(tableName, fields);
      // The real metadata client returns a new object without mutating the
      // schema snapshot. Test/provider ports are allowed to keep a live
      // snapshot, so do not add a second reference when they already did.
      if (!tables.some((candidate) => candidate.id === table?.id))
        tables.push(table);
    }

    const primaryField = table.fields.find(
      (field) => field.id === table?.primaryFieldId,
    );
    if (
      primaryField?.name !== primaryFieldName ||
      primaryField.type !== "singleLineText"
    ) {
      throw new AirtableRepositorySchemaError(
        `Airtable table “${table.name}” must use “${primaryFieldName}” as its single-line-text primary field.`,
      );
    }

    for (const field of fields) {
      if (validateFieldType(table, field.name, field.type)) continue;
      if (field.name === primaryFieldName) {
        throw new AirtableRepositorySchemaError(
          `Airtable table “${table.name}” is missing its managed primary field.`,
        );
      }
      const created = await client.createField(table.id, field);
      table.fields.push(created);
    }
    return table;
  }

  private async provisionConnection(
    eventId: string,
    input: AirtableConnectionInput,
    options: {
      connectionId?: string;
      authoritativeConfiguration?: AirtableConnectionConfiguration | null;
    } = {},
  ): Promise<PreparedAirtableRepositoryConnection> {
    const credentials = airtableCredentialsSchema.parse(input);
    const authoritativeConfiguration =
      options.authoritativeConfiguration ?? null;
    const client = this.client(credentials);
    const knownTables = await client.getBaseSchema();
    const roomTable = await this.provisionAndValidateSchema(
      client,
      input.tableName,
      AIRTABLE_ROOM_FIELDS,
      "Program Cue ID",
      authoritativeConfiguration?.tables.rooms.id,
      knownTables,
    );
    const validationId = crypto.randomUUID();
    const validationKey = `connection-validation-${validationId}`;
    const validationEventId = `connection-validation:${eventId}:${validationId}`;
    const validationWrite = await client.upsertRecords(roomTable.id, [
      {
        fields: {
          "Program Cue ID": validationKey,
          "Event ID": validationEventId,
          Name: "Program Cue connection validation",
          Capacity: 1,
          Position: 0,
          Status: "retired",
          Revision: 1,
          Building: "",
          Level: "",
          "Resources JSON": "[]",
        },
      },
    ]);
    const validationRecord = validationWrite.records.find(
      (record) => record.fields["Program Cue ID"] === validationKey,
    );
    if (!validationRecord)
      throw new AirtableRepositoryConfigurationError(
        "Airtable did not return the connection-validation record after writing it.",
      );
    const validationRead = await client.listRecords(roomTable.id, {
      filterByFormula: airtableEqualsFormula("Program Cue ID", validationKey),
      fields: ["Program Cue ID", "Event ID"],
    });
    const observedValidationRecord = validationRead.find(
      (record) =>
        record.id === validationRecord.id &&
        record.fields["Program Cue ID"] === validationKey &&
        record.fields["Event ID"] === validationEventId,
    );
    if (!observedValidationRecord)
      throw new AirtableRepositoryConfigurationError(
        "Airtable did not return the connection-validation record when it was read back.",
      );
    await client.deleteRecords(roomTable.id, [observedValidationRecord.id]);
    const speakerTable = await this.provisionAndValidateSchema(
      client,
      AIRTABLE_SPEAKERS_TABLE,
      AIRTABLE_SPEAKER_FIELDS,
      "Program Cue Key",
      authoritativeConfiguration?.tables.speakers.id,
      knownTables,
    );
    const sessionTable = await this.provisionAndValidateSchema(
      client,
      AIRTABLE_SESSIONS_TABLE,
      AIRTABLE_SESSION_FIELDS,
      "Program Cue Key",
      authoritativeConfiguration?.tables.sessions.id,
      knownTables,
    );
    const scheduleTable = await this.provisionAndValidateSchema(
      client,
      AIRTABLE_SCHEDULE_TABLE,
      AIRTABLE_SCHEDULE_FIELDS,
      "Program Cue Key",
      authoritativeConfiguration?.tables.schedule.id,
      knownTables,
    );
    const eventDataTables = {} as Record<
      AirtableEventDataTableKey,
      { id: string; name: string }
    >;
    for (const [key, tableName] of Object.entries(
      AIRTABLE_EVENT_DATA_TABLE_NAMES,
    ) as Array<[AirtableEventDataTableKey, string]>) {
      const table = await this.provisionAndValidateSchema(
        client,
        tableName,
        AIRTABLE_EVENT_DATA_FIELDS,
        "Program Cue Key",
        authoritativeConfiguration?.tables[key].id,
        knownTables,
      );
      eventDataTables[key] = { id: table.id, name: table.name };
    }
    const connectionId = options.connectionId ?? crypto.randomUUID();
    const encryptedCredentials = await encryptIntegrationCredentials(
      credentials,
      this.env.INTEGRATION_CREDENTIALS_KEY,
      connectionId,
    );
    return {
      connectionId,
      encryptedCredentials,
      configuration: {
        baseId: credentials.baseId,
        schemaVersion: AIRTABLE_SCHEMA_VERSION,
        tables: {
          rooms: { id: roomTable.id, name: roomTable.name },
          speakers: { id: speakerTable.id, name: speakerTable.name },
          sessions: { id: sessionTable.id, name: sessionTable.name },
          schedule: { id: scheduleTable.id, name: scheduleTable.name },
          ...eventDataTables,
        },
        authoritativeEntities: [
          "rooms",
          "event_configuration",
          "forms",
          "submissions",
          "evaluations",
          "sessions",
          "tasks",
          "published_programme",
        ],
      },
    };
  }

  async provisionForEvent(
    viewer: Viewer,
    eventId: string,
    raw: unknown,
  ): Promise<PreparedAirtableRepositoryConnection> {
    assertAdministrator(viewer);
    const authorised = await this.env.DB.prepare(
      `SELECT 1
         FROM events event
         JOIN memberships membership
           ON membership.organisation_id = event.organisation_id
          AND membership.event_id IS NULL
          AND membership.person_id = ?
          AND membership.role IN ('owner','administrator')
          AND membership.accepted_at IS NOT NULL
          AND membership.revoked_at IS NULL
        WHERE event.id = ? AND event.organisation_id = ?
        LIMIT 1`,
    )
      .bind(viewer.personId, eventId, viewer.organisationId)
      .first();
    if (!authorised)
      throw new Response(
        "Organisation owner or administrator access is required to provision an event repository.",
        { status: 403 },
      );
    const input = airtableConnectionInputSchema.parse(raw);
    return this.provisionConnection(eventId, input);
  }

  async configure(viewer: Viewer, raw: unknown) {
    assertAdministrator(viewer);
    const input = airtableConnectionInputSchema.parse(raw);
    const credentials = airtableCredentialsSchema.parse(input);
    const [event, existing] = await Promise.all([
      this.env.DB.prepare(
        `SELECT repository_provider AS repositoryProvider
           FROM events WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{ repositoryProvider: "d1" | "airtable" }>(),
      this.env.DB.prepare(
        `SELECT id, revision, configuration_json AS configurationJson
           FROM integration_connections
          WHERE organisation_id = ? AND event_id = ? AND provider = ?`,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          AIRTABLE_REPOSITORY_PROVIDER,
        )
        .first<{ id: string; revision: number; configurationJson: string }>(),
    ]);
    if (!event)
      throw new AirtableRepositoryConfigurationError("Event not found.");
    let authoritativeConfiguration: AirtableConnectionConfiguration | null =
      null;
    if (event.repositoryProvider === "airtable") {
      try {
        authoritativeConfiguration =
          airtableConnectionConfigurationSchema.parse(
            JSON.parse(existing?.configurationJson ?? ""),
          );
      } catch {
        throw new AirtableRepositoryConfigurationError(
          "The authoritative Airtable repository configuration is invalid. Migrate or repair it before reconfiguring credentials.",
        );
      }
      if (
        credentials.baseId !== authoritativeConfiguration.baseId ||
        input.tableName !== authoritativeConfiguration.tables.rooms.name
      )
        throw new AirtableRepositoryConfigurationError(
          "An authoritative Airtable repository cannot be switched to another base or room table through reconfiguration. Migrate authority to D1 first.",
        );
    }
    const prepared = await this.provisionConnection(viewer.eventId, input, {
      connectionId: existing?.id,
      authoritativeConfiguration,
    });
    const { connectionId, encryptedCredentials, configuration } = prepared;
    const operationId = crypto.randomUUID();
    const connectionStatement = existing
      ? this.env.DB.prepare(
          `UPDATE integration_connections
              SET status = 'connected', direction = 'bidirectional',
                  conflict_policy = 'single_authority_no_dual_write',
                  encrypted_credentials = ?, configuration_json = ?,
                  revision = revision + 1, last_operation_id = ?,
                  updated_at = unixepoch()
            WHERE id = ? AND organisation_id = ? AND event_id = ?
              AND provider = ? AND revision = ?
              AND EXISTS (
                SELECT 1 FROM events
                 WHERE id = ? AND organisation_id = ?
                   AND repository_provider = ?
              )`,
        ).bind(
          encryptedCredentials,
          JSON.stringify(configuration),
          operationId,
          connectionId,
          viewer.organisationId,
          viewer.eventId,
          AIRTABLE_REPOSITORY_PROVIDER,
          existing.revision,
          viewer.eventId,
          viewer.organisationId,
          event.repositoryProvider,
        )
      : this.env.DB.prepare(
          `INSERT INTO integration_connections (
             id, organisation_id, event_id, provider, status, direction,
             conflict_policy, encrypted_credentials, configuration_json,
             revision, last_operation_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'connected', 'bidirectional',
                     'single_authority_no_dual_write', ?, ?, 1, ?,
                     unixepoch(), unixepoch())`,
        ).bind(
          connectionId,
          viewer.organisationId,
          viewer.eventId,
          AIRTABLE_REPOSITORY_PROVIDER,
          encryptedCredentials,
          JSON.stringify(configuration),
          operationId,
        );
    const [connectionResult, auditResult] = await this.env.DB.batch([
      connectionStatement,
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'airtable.repository.configured',
                  'integration_connection', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM integration_connections
               WHERE id = ? AND organisation_id = ? AND event_id = ?
                 AND provider = ? AND last_operation_id = ?
            )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        connectionId,
        operationId,
        JSON.stringify({
          baseId: credentials.baseId,
          tables: configuration.tables,
          schemaVersion: AIRTABLE_SCHEMA_VERSION,
          authoritativeEntities: configuration.authoritativeEntities,
        }),
        connectionId,
        viewer.organisationId,
        viewer.eventId,
        AIRTABLE_REPOSITORY_PROVIDER,
        operationId,
      ),
    ]);
    if (
      (connectionResult.meta.changes ?? 0) !== 1 ||
      (auditResult.meta.changes ?? 0) !== 1
    ) {
      throw new AirtableRepositoryConfigurationError(
        "The Airtable repository connection changed before it could be saved.",
      );
    }
    this.invalidate(connectionId, viewer.eventId);
    return { connectionId, configuration };
  }

  async getConnection(
    organisationId: string,
    eventId: string,
    options: {
      requireConnected?: boolean;
      allowNeedsAttention?: boolean;
    } = {},
  ): Promise<AirtableRepositoryConnection | null> {
    const row = await this.env.DB.prepare(
      `SELECT id, status, encrypted_credentials AS encryptedCredentials,
              configuration_json AS configurationJson, revision
         FROM integration_connections
        WHERE organisation_id = ? AND event_id = ? AND provider = ?`,
    )
      .bind(organisationId, eventId, AIRTABLE_REPOSITORY_PROVIDER)
      .first<ConnectionRow>();
    if (!row) {
      if (options.requireConnected)
        throw new AirtableRepositoryConfigurationError(
          "Configure and validate an Airtable repository connection before selecting Airtable.",
        );
      return null;
    }
    let status: AirtableRepositoryConnection["status"];
    try {
      status = z
        .enum(["connected", "needs_attention", "failed", "disconnected"])
        .parse(row.status);
    } catch {
      throw new AirtableRepositoryConfigurationError(
        "The saved Airtable repository connection status is invalid.",
      );
    }
    if (
      status !== "connected" &&
      !(options.allowNeedsAttention && status === "needs_attention")
    ) {
      if (options.requireConnected)
        throw new AirtableRepositoryConfigurationError(
          `The Airtable repository connection is ${status.replaceAll("_", " ")}; reconnect it before reading or writing event data.`,
        );
      return null;
    }
    if (!row.encryptedCredentials)
      throw new AirtableRepositoryConfigurationError(
        "The Airtable repository connection has no credentials.",
      );
    let configuration: AirtableConnectionConfiguration;
    let credentials: AirtableCredentials;
    try {
      configuration = airtableConnectionConfigurationSchema.parse(
        JSON.parse(row.configurationJson),
      );
      credentials = airtableCredentialsSchema.parse(
        await decryptIntegrationCredentials(
          row.encryptedCredentials,
          this.env.INTEGRATION_CREDENTIALS_KEY,
          row.id,
        ),
      );
    } catch {
      throw new AirtableRepositoryConfigurationError(
        "The saved Airtable repository configuration or credentials are invalid.",
      );
    }
    if (credentials.baseId !== configuration.baseId) {
      throw new AirtableRepositoryConfigurationError(
        "The Airtable credential base does not match the saved repository configuration.",
      );
    }
    return {
      id: row.id,
      status,
      configuration,
      credentials,
      revision: row.revision,
    };
  }

  async getConnectionSummary(organisationId: string, eventId: string) {
    const row = await this.env.DB.prepare(
      `SELECT id, status, configuration_json AS configurationJson,
              encrypted_credentials IS NOT NULL AS hasCredentials,
              updated_at AS updatedAt
         FROM integration_connections
        WHERE organisation_id = ? AND event_id = ? AND provider = ?`,
    )
      .bind(organisationId, eventId, AIRTABLE_REPOSITORY_PROVIDER)
      .first<{
        id: string;
        status: string;
        configurationJson: string;
        hasCredentials: number;
        updatedAt: number;
      }>();
    if (!row) return null;
    let configuration: AirtableConnectionConfiguration;
    try {
      configuration = airtableConnectionConfigurationSchema.parse(
        JSON.parse(row.configurationJson),
      );
    } catch {
      throw new AirtableRepositoryConfigurationError(
        "The saved Airtable repository configuration is invalid.",
      );
    }
    return {
      id: row.id,
      status: row.status,
      baseId: configuration.baseId,
      tableId: configuration.tables.rooms.id,
      tableName: configuration.tables.rooms.name,
      hasCredentials: Boolean(row.hasCredentials),
      updatedAt: row.updatedAt,
      authoritativeEntities: configuration.authoritativeEntities,
    };
  }

  async readRooms(
    organisationId: string,
    eventId: string,
    options: {
      bypassCache?: boolean;
      allowNeedsAttention?: boolean;
    } = {},
  ): Promise<AirtableRoomSnapshot> {
    const connection = await this.getConnection(organisationId, eventId, {
      requireConnected: true,
      allowNeedsAttention: options.allowNeedsAttention,
    });
    if (!connection)
      throw new AirtableRepositoryConfigurationError(
        "Airtable repository connection not found.",
      );
    const key = this.cacheKey(connection.id, eventId);
    const now = this.now();
    const cached = roomCache.get(key);
    if (!options.bypassCache && cached && cached.cacheExpiresAt * 1_000 > now)
      return {
        ...cached,
        rooms: cached.rooms.map((room) => ({ ...room })),
        cached: true,
      };

    const records = await this.client(connection.credentials).listRecords(
      connection.configuration.tables.rooms.id,
      {
        filterByFormula: airtableEqualsFormula("Event ID", eventId),
        fields: AIRTABLE_ROOM_FIELDS.map((field) => field.name),
      },
    );
    const rooms = records
      .map((record) => parseRoomRecord(record, eventId))
      .filter((room): room is AirtableRoom => room !== null);
    const ids = new Set<string>();
    for (const room of rooms) {
      if (ids.has(room.id))
        throw new AirtableRepositorySchemaError(
          `Airtable contains duplicate Program Cue room ID “${room.id}” for this event.`,
        );
      ids.add(room.id);
    }
    const fetchedAt = Math.floor(now / 1_000);
    const snapshot: CachedRooms = {
      rooms: sortRooms(rooms),
      fetchedAt,
      cacheExpiresAt: fetchedAt + AIRTABLE_CACHE_TTL_SECONDS,
    };
    roomCache.set(key, snapshot);
    return {
      ...snapshot,
      rooms: snapshot.rooms.map((room) => ({ ...room })),
      cached: false,
    };
  }

  /**
   * Verifies the D1 room rows used by scheduling are a faithful projection of
   * the active Airtable room records. Building and level remain Airtable-only
   * annotations because Program Cue does not consume them in its room model.
   * Event Setup intentionally does not call this guard: it is the explicit UI
   * that reads the authoritative records and writes the reviewed projection.
   */
  async assertActiveProjectionSynchronized(
    organisationId: string,
    eventId: string,
    options: { bypassCache?: boolean } = {},
  ) {
    const [snapshot, d1Rows] = await Promise.all([
      this.readRooms(organisationId, eventId, options),
      this.env.DB.prepare(
        `SELECT room.id, room.event_id AS eventId, room.name, room.capacity,
                room.resources_json AS resourcesJson, room.position,
                room.status
           FROM rooms room
          WHERE room.event_id = ? AND room.status = 'active'
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = room.event_id AND event.organisation_id = ?
            )
          ORDER BY room.position, room.name, room.id`,
      )
        .bind(eventId, organisationId)
        .all<{
          id: string;
          eventId: string;
          name: string;
          capacity: number;
          resourcesJson: string;
          position: number;
          status: "active";
        }>(),
    ]);
    const d1Rooms = d1Rows.results.map((row) => {
      let resources: unknown;
      try {
        resources = JSON.parse(row.resourcesJson);
      } catch {
        throw new AirtableRepositorySchemaError(
          `D1 room ${row.id} has invalid resource inventory JSON.`,
        );
      }
      try {
        return airtableRoomSchema.parse({
          ...row,
          resources,
          revision: 1,
          building: null,
          level: null,
        });
      } catch (error) {
        const detail =
          error instanceof z.ZodError
            ? error.issues[0]?.message
            : error instanceof Error
              ? error.message
              : String(error);
        throw new AirtableRepositorySchemaError(
          `D1 room ${row.id} does not match the managed Airtable room projection: ${detail ?? "invalid row"}.`,
        );
      }
    });
    const authoritativeRooms = sortRooms(
      snapshot.rooms.filter((room) => room.status === "active"),
    );
    if (!sameActiveRoomProjection(sortRooms(d1Rooms), authoritativeRooms))
      throw new AirtableRepositoryReconciliationError(
        "The authoritative Airtable rooms and D1 scheduling projection diverged. Review the Airtable rooms in Event Setup and save them before continuing.",
      );
    return snapshot;
  }

  async replaceRooms(
    organisationId: string,
    eventId: string,
    desiredActiveRooms: Array<
      Pick<
        AirtableRoom,
        "id" | "name" | "capacity" | "resources" | "position"
      > &
        Partial<Pick<AirtableRoom, "building" | "level">>
    >,
    revision: number,
    options: { allowNeedsAttention?: boolean } = {},
  ) {
    const connection = await this.getConnection(organisationId, eventId, {
      requireConnected: true,
      allowNeedsAttention: options.allowNeedsAttention,
    });
    if (!connection)
      throw new AirtableRepositoryConfigurationError(
        "Airtable repository connection not found.",
      );
    const current = await this.readRooms(organisationId, eventId, {
      bypassCache: true,
      allowNeedsAttention: options.allowNeedsAttention,
    });
    const currentById = new Map(current.rooms.map((room) => [room.id, room]));
    const parsedDesired = desiredActiveRooms.map((room) =>
      airtableRoomSchema.parse({
        ...room,
        eventId,
        status: "active",
        revision,
        building: room.building ?? currentById.get(room.id)?.building ?? null,
        level: room.level ?? currentById.get(room.id)?.level ?? null,
        resources: room.resources,
      }),
    );
    const desiredIds = new Set(parsedDesired.map((room) => room.id));
    const retired = current.rooms
      .filter((room) => room.status === "active" && !desiredIds.has(room.id))
      .map((room) => ({ ...room, status: "retired" as const, revision }));
    const records = [...parsedDesired, ...retired].map((room) => ({
      fields: toAirtableFields(room),
    }));
    const client = this.client(connection.credentials);
    for (let index = 0; index < records.length; index += 10) {
      await client.upsertRecords(
        connection.configuration.tables.rooms.id,
        records.slice(index, index + 10),
      );
    }
    this.invalidate(connection.id, eventId);
    const reconciled = await this.readRooms(organisationId, eventId, {
      bypassCache: true,
      allowNeedsAttention: options.allowNeedsAttention,
    });
    const actualActive = sortRooms(
      reconciled.rooms.filter((room) => room.status === "active"),
    );
    if (!sameRooms(sortRooms(parsedDesired), actualActive)) {
      throw new AirtableRepositoryReconciliationError(
        "Airtable accepted the room write but the follow-up reconciliation did not match. The connection requires attention.",
      );
    }
    return reconciled;
  }

  async markNeedsAttention(
    organisationId: string,
    eventId: string,
    reason: string,
  ) {
    const result = await this.env.DB.prepare(
      `UPDATE integration_connections
          SET status = 'needs_attention', updated_at = unixepoch()
        WHERE organisation_id = ? AND event_id = ? AND provider = ?
          AND status = 'connected'`,
    )
      .bind(organisationId, eventId, AIRTABLE_REPOSITORY_PROVIDER)
      .run();
    if ((result.meta.changes ?? 0) === 1) {
      await this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, action, entity_type, entity_id,
           metadata_json, created_at
         ) SELECT ?, organisation_id, event_id,
                  'airtable.repository.needs_attention',
                  'integration_connection', id, ?, unixepoch()
             FROM integration_connections
            WHERE organisation_id = ? AND event_id = ? AND provider = ?`,
      )
        .bind(
          crypto.randomUUID(),
          JSON.stringify({ reason }),
          organisationId,
          eventId,
          AIRTABLE_REPOSITORY_PROVIDER,
        )
        .run();
    }
  }
}

export function isAirtableRepositoryError(error: unknown) {
  return (
    error instanceof AirtableProviderError ||
    error instanceof AirtableRepositoryConfigurationError ||
    error instanceof AirtableRepositorySchemaError ||
    error instanceof AirtableRepositoryReconciliationError
  );
}

export type { AirtableConnectionInput };
