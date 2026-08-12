import { z } from "zod";

import type {
  PublishedSession,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AirtableClient,
  airtableAndFormula,
  airtableEqualsFormula,
  type AirtableRecord,
} from "./airtable-client.server";
import {
  AirtableRepositoryReconciliationError,
  AirtableRoomRepository,
} from "./airtable-room-repository.server";
import {
  AIRTABLE_CACHE_TTL_SECONDS,
  AIRTABLE_SCHEDULE_FIELDS,
  AIRTABLE_SESSION_FIELDS,
  AIRTABLE_SPEAKER_FIELDS,
  type AirtableCredentials,
} from "./airtable-schema";

type AirtableProgrammeClient = Pick<
  AirtableClient,
  "listRecords" | "upsertRecords"
>;

type AirtableProgrammeRepositoryDependencies = {
  rooms?: AirtableRoomRepository;
  createClient?: (credentials: AirtableCredentials) => AirtableProgrammeClient;
  now?: () => number;
};

type VersionRow = {
  id: string;
  versionNumber: number;
  revision: number;
  status: string;
};

type ProgrammeSource = {
  version: VersionRow;
  speakers: PublishedSpeaker[];
  sessions: Array<
    Omit<
      PublishedSession,
      "startsAt" | "endsAt" | "room" | "building" | "level"
    >
  >;
  entries: Array<{
    id: string;
    sessionId: string;
    roomId: string;
    startsAt: number;
    endsAt: number;
  }>;
};

type ProgrammeEntity = {
  entityType:
    "published_speaker" | "published_session" | "published_schedule_entry";
  entityId: string;
  key: string;
  label: string;
  tableId: string;
  fields: Record<string, unknown>;
};

export type AirtableProgrammePlanItem = ProgrammeEntity & {
  action: "create" | "update" | "noop";
  before: Record<string, unknown> | null;
};

export type AirtablePublishedSnapshot = {
  sessions: PublishedSession[];
  speakers: PublishedSpeaker[];
  freshness: {
    source: "airtable";
    fetchedAt: number;
    cacheExpiresAt: number;
    cached: boolean;
  };
};

export class AirtableProgrammeSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AirtableProgrammeSchemaError";
  }
}

const publishedSpeakerRecordSchema = z
  .object({
    personId: z.string().min(1),
    displayName: z.string().min(1),
    imageUrl: z.string().nullable(),
    biography: z.string().nullable(),
    pronunciation: z.string().nullable(),
    organisationName: z.string().nullable(),
    jobTitle: z.string().nullable(),
    sessionIds: z.array(z.string().min(1)),
  })
  .refine(
    (speaker) => new Set(speaker.sessionIds).size === speaker.sessionIds.length,
    { path: ["sessionIds"], message: "session IDs must be unique" },
  );

const publishedSessionRecordSchema = z
  .object({
    sessionId: z.string().min(1),
    slug: z.string().min(1),
    title: z.string().min(1),
    description: z.string(),
    format: z.string().min(1),
    track: z.string().nullable(),
    speakerIds: z.array(z.string().min(1)),
    speakerNames: z.array(z.string().min(1)),
  })
  .superRefine((session, context) => {
    if (session.speakerIds.length !== session.speakerNames.length) {
      context.addIssue({
        code: "custom",
        path: ["speakerNames"],
        message: "speaker IDs and names must have the same length",
      });
    }
    if (new Set(session.speakerIds).size !== session.speakerIds.length) {
      context.addIssue({
        code: "custom",
        path: ["speakerIds"],
        message: "speaker IDs must be unique",
      });
    }
  });

const scheduleEntryRecordSchema = z.object({
  entryId: z.string().min(1),
  sessionId: z.string().min(1),
  roomId: z.string().min(1),
  startsAt: z.number().int(),
  endsAt: z.number().int(),
});

type CachedSnapshot = Omit<AirtablePublishedSnapshot, "freshness"> & {
  fetchedAt: number;
  cacheExpiresAt: number;
};
const programmeCache = new Map<string, CachedSnapshot>();
const PUBLISHED_SNAPSHOT_MAPPING_TYPE = "airtable_published_snapshot";

function publishedFilter(eventId: string, versionId: string) {
  return airtableAndFormula(
    airtableEqualsFormula("Event ID", eventId),
    airtableEqualsFormula("Version ID", versionId),
  );
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.length ? value : null;
}

function jsonStringArray(value: unknown, field: string, recordId: string) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return z.array(z.string().min(1)).parse(parsed);
  } catch {
    throw new AirtableProgrammeSchemaError(
      `Airtable record ${recordId} field “${field}” must contain a JSON string array.`,
    );
  }
}

function matchingRecord(
  record: AirtableRecord,
  eventId: string,
  versionId: string,
) {
  return (
    record.fields["Event ID"] === eventId &&
    record.fields["Version ID"] === versionId &&
    record.fields.Status === "active"
  );
}

function activeScopedRecords(
  records: AirtableRecord[],
  eventId: string,
  versionId: string,
  tableLabel: string,
) {
  return records.filter((record) => {
    if (
      record.fields["Event ID"] !== eventId ||
      record.fields["Version ID"] !== versionId
    )
      return false;
    if (!(["active", "retired"] as unknown[]).includes(record.fields.Status))
      throw new AirtableProgrammeSchemaError(
        `Airtable ${tableLabel} record ${record.id} must have active or retired status.`,
      );
    return matchingRecord(record, eventId, versionId);
  });
}

function requireUnique<T>(
  values: T[],
  key: (value: T) => string,
  label: string,
) {
  const seen = new Set<string>();
  for (const value of values) {
    const id = key(value);
    if (seen.has(id))
      throw new AirtableProgrammeSchemaError(
        `Airtable contains duplicate ${label} “${id}” in this published version.`,
      );
    seen.add(id);
  }
}

function parseSpeaker(record: AirtableRecord) {
  try {
    return publishedSpeakerRecordSchema.parse({
      personId: record.fields["Person ID"],
      displayName: record.fields["Display Name"],
      imageUrl: nullableString(record.fields["Image URL"]),
      biography: nullableString(record.fields.Biography),
      pronunciation: nullableString(record.fields.Pronunciation),
      organisationName: nullableString(record.fields.Organisation),
      jobTitle: nullableString(record.fields["Job Title"]),
      sessionIds: jsonStringArray(
        record.fields["Session IDs JSON"],
        "Session IDs JSON",
        record.id,
      ),
    });
  } catch (error) {
    if (error instanceof AirtableProgrammeSchemaError) throw error;
    if (error instanceof z.ZodError)
      throw new AirtableProgrammeSchemaError(
        `Airtable published-speaker record ${record.id} is invalid: ${error.issues[0]?.message ?? "schema mismatch"}.`,
      );
    throw error;
  }
}

function parseSession(record: AirtableRecord) {
  try {
    return publishedSessionRecordSchema.parse({
      sessionId: record.fields["Session ID"],
      slug: record.fields.Slug,
      title: record.fields.Title,
      description:
        typeof record.fields.Description === "string"
          ? record.fields.Description
          : "",
      format: record.fields.Format,
      track: nullableString(record.fields.Track),
      speakerIds: jsonStringArray(
        record.fields["Speaker IDs JSON"],
        "Speaker IDs JSON",
        record.id,
      ),
      speakerNames: jsonStringArray(
        record.fields["Speaker Names JSON"],
        "Speaker Names JSON",
        record.id,
      ),
    });
  } catch (error) {
    if (error instanceof AirtableProgrammeSchemaError) throw error;
    if (error instanceof z.ZodError)
      throw new AirtableProgrammeSchemaError(
        `Airtable published-session record ${record.id} is invalid: ${error.issues[0]?.message ?? "schema mismatch"}.`,
      );
    throw error;
  }
}

function parseEntry(record: AirtableRecord) {
  try {
    const parsed = scheduleEntryRecordSchema.parse({
      entryId: record.fields["Entry ID"],
      sessionId: record.fields["Session ID"],
      roomId: record.fields["Room ID"],
      startsAt: record.fields["Starts At"],
      endsAt: record.fields["Ends At"],
    });
    if (parsed.endsAt <= parsed.startsAt)
      throw new AirtableProgrammeSchemaError(
        `Airtable schedule record ${record.id} must end after it starts.`,
      );
    return parsed;
  } catch (error) {
    if (error instanceof AirtableProgrammeSchemaError) throw error;
    if (error instanceof z.ZodError)
      throw new AirtableProgrammeSchemaError(
        `Airtable schedule record ${record.id} is invalid: ${error.issues[0]?.message ?? "schema mismatch"}.`,
      );
    throw error;
  }
}

function sameFields(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return Object.entries(right).every(([field, expected]) => {
    const actual = left[field];
    if (expected === "" && actual === undefined) return true;
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
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

async function entityHash(
  entities: Array<Pick<ProgrammeEntity, "tableId" | "key" | "fields">>,
) {
  const source = entities
    .map((entity) => ({
      tableId: entity.tableId,
      key: entity.key,
      fields: stableValue(entity.fields),
    }))
    .sort(
      (left, right) =>
        left.tableId.localeCompare(right.tableId) ||
        left.key.localeCompare(right.key),
    );
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(source)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function publishedRecordsHash(
  eventId: string,
  versionId: string,
  groups: ReadonlyArray<{
    tableId: string;
    fields: readonly string[];
    records: AirtableRecord[];
  }>,
) {
  const entities: Array<{
    tableId: string;
    key: string;
    fields: Record<string, unknown>;
  }> = [];
  for (const group of groups) {
    for (const record of group.records) {
      if (
        record.fields["Event ID"] !== eventId ||
        record.fields["Version ID"] !== versionId
      )
        continue;
      if (record.fields.Status === "retired") continue;
      if (record.fields.Status !== "active")
        throw new AirtableProgrammeSchemaError(
          `Airtable managed record ${record.id} must have active or retired status.`,
        );
      const key = record.fields["Program Cue Key"];
      if (typeof key !== "string" || !key)
        throw new AirtableProgrammeSchemaError(
          `Airtable managed record ${record.id} has no Program Cue Key.`,
        );
      entities.push({
        tableId: group.tableId,
        key,
        fields: Object.fromEntries(
          group.fields.map((field) => [field, record.fields[field] ?? ""]),
        ),
      });
    }
  }
  return entityHash(entities);
}

export class AirtableProgrammeRepository {
  private readonly rooms;
  private readonly now;

  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: AirtableProgrammeRepositoryDependencies = {},
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

  private cloneSessions(sessions: PublishedSession[]) {
    return sessions.map((session) => ({
      ...session,
      speakerIds: [...session.speakerIds],
      speakerNames: [...session.speakerNames],
    }));
  }

  private cloneSpeakers(speakers: PublishedSpeaker[]) {
    return speakers.map((speaker) => ({
      ...speaker,
      sessionIds: [...speaker.sessionIds],
    }));
  }

  async readPublishedSpeakerPreview(
    organisationId: string,
    eventId: string,
    versionId: string,
    limit: number,
  ) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 8) {
      throw new RangeError(
        "Published speaker preview limit must be between 1 and 8.",
      );
    }
    const connection = await this.rooms.getConnection(organisationId, eventId, {
      requireConnected: true,
    });
    if (!connection)
      throw new AirtableRepositoryReconciliationError(
        "Airtable repository connection not found.",
      );
    const key = `${connection.id}:${connection.revision}:${eventId}:${versionId}`;
    const cached = programmeCache.get(key);
    if (cached && cached.cacheExpiresAt * 1_000 > this.now()) {
      return this.cloneSpeakers(cached.speakers.slice(0, limit));
    }

    // A cache miss must validate the complete provider projection before any
    // part of it is shown. This preserves the fail-closed Airtable drift
    // boundary; subsequent landing requests clone only the bounded preview.
    const snapshot = await this.readPublished(
      organisationId,
      eventId,
      versionId,
    );
    return this.cloneSpeakers(snapshot.speakers.slice(0, limit));
  }

  private publishedMappingStatement(
    connectionId: string,
    versionId: string,
    sourceHash: string,
    versionRevision: number,
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
      PUBLISHED_SNAPSHOT_MAPPING_TYPE,
      versionId,
      versionId,
      sourceHash,
      JSON.stringify({ versionRevision }),
    );
  }

  private async publishedMapping(connectionId: string, versionId: string) {
    return this.env.DB.prepare(
      `SELECT source_hash AS sourceHash
         FROM integration_entity_mappings
        WHERE connection_id = ? AND entity_type = ? AND entity_id = ?`,
    )
      .bind(connectionId, PUBLISHED_SNAPSHOT_MAPPING_TYPE, versionId)
      .first<{ sourceHash: string }>();
  }

  private async source(
    eventId: string,
    versionId: string,
  ): Promise<ProgrammeSource> {
    const version = await this.env.DB.prepare(
      `SELECT id, version_number AS versionNumber, revision, status
         FROM schedule_versions
        WHERE id = ? AND event_id = ?
          AND status IN ('draft','publishing','published')`,
    )
      .bind(versionId, eventId)
      .first<VersionRow>();
    if (!version)
      throw new AirtableRepositoryReconciliationError(
        "The schedule version cannot be staged for Airtable publication.",
      );
    const [sessionRows, speakerRows] = await Promise.all([
      this.env.DB.prepare(
        `SELECT entry.id AS entryId, entry.session_id AS sessionId,
                entry.room_id AS roomId, entry.starts_at AS startsAt,
                entry.ends_at AS endsAt, content.slug, content.title,
                COALESCE(content.description, '') AS description,
                content.format, track.name AS track,
                (
                  SELECT GROUP_CONCAT(ordered.personId, '||') FROM (
                    SELECT relation.person_id AS personId
                      FROM session_speakers relation
                      JOIN people person ON person.id = relation.person_id
                     WHERE relation.event_id = content.event_id
                       AND relation.session_id = content.session_id
                       AND relation.visibility = 'public'
                       AND person.profile_status = 'published'
                     ORDER BY relation.position, relation.person_id
                  ) ordered
                ) AS speakerIds,
                (
                  SELECT GROUP_CONCAT(ordered.displayName, '||') FROM (
                    SELECT person.display_name AS displayName
                      FROM session_speakers relation
                      JOIN people person ON person.id = relation.person_id
                     WHERE relation.event_id = content.event_id
                       AND relation.session_id = content.session_id
                       AND relation.visibility = 'public'
                       AND person.profile_status = 'published'
                     ORDER BY relation.position, relation.person_id
                  ) ordered
                ) AS speakerNames
           FROM schedule_entries entry
           JOIN schedule_session_contents content
             ON content.schedule_version_id = entry.schedule_version_id
            AND content.session_id = entry.session_id
            AND content.event_id = entry.event_id
           JOIN sessions session
             ON session.id = entry.session_id AND session.event_id = entry.event_id
           LEFT JOIN tracks track
             ON track.id = content.track_id AND track.event_id = content.event_id
            AND track.is_public = 1
          WHERE entry.event_id = ? AND entry.schedule_version_id = ?
            AND content.visibility = 'public'
            AND session.status IN ('scheduled','published')
            AND session.visibility = 'public'
          ORDER BY entry.starts_at, entry.id`,
      )
        .bind(eventId, versionId)
        .all<{
          entryId: string;
          sessionId: string;
          roomId: string;
          startsAt: number;
          endsAt: number;
          slug: string;
          title: string;
          description: string;
          format: string;
          track: string | null;
          speakerIds: string | null;
          speakerNames: string | null;
        }>(),
      this.env.DB.prepare(
        `SELECT person.id, person.display_name AS displayName,
                person.image_url AS imageUrl, person.biography,
                person.pronunciation,
                person.organisation_name AS organisationName,
                person.job_title AS jobTitle,
                GROUP_CONCAT(relation.session_id, '||') AS sessionIds
           FROM people person
           JOIN session_speakers relation ON relation.person_id = person.id
           JOIN schedule_entries entry
             ON entry.session_id = relation.session_id
            AND entry.event_id = relation.event_id
           JOIN schedule_session_contents content
             ON content.schedule_version_id = entry.schedule_version_id
            AND content.session_id = entry.session_id
            AND content.event_id = entry.event_id
           JOIN sessions session
             ON session.id = relation.session_id AND session.event_id = relation.event_id
          WHERE content.event_id = ? AND entry.schedule_version_id = ?
            AND content.visibility = 'public'
            AND session.status IN ('scheduled','published')
            AND session.visibility = 'public'
            AND relation.visibility = 'public'
            AND person.profile_status = 'published'
          GROUP BY person.id
          ORDER BY person.display_name COLLATE NOCASE, person.id`,
      )
        .bind(eventId, versionId)
        .all<Omit<PublishedSpeaker, "sessionIds"> & { sessionIds: string }>(),
    ]);
    return {
      version,
      entries: sessionRows.results.map((row) => ({
        id: row.entryId,
        sessionId: row.sessionId,
        roomId: row.roomId,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
      })),
      sessions: sessionRows.results.map((row) => ({
        id: row.sessionId,
        slug: row.slug,
        title: row.title,
        description: row.description,
        format: row.format,
        track: row.track,
        speakerIds: row.speakerIds?.split("||") ?? [],
        speakerNames: row.speakerNames?.split("||") ?? [],
      })),
      speakers: speakerRows.results.map((row) => ({
        ...row,
        sessionIds: row.sessionIds.split("||"),
      })),
    };
  }

  private entities(
    eventId: string,
    source: ProgrammeSource,
    tables: {
      speakers: { id: string };
      sessions: { id: string };
      schedule: { id: string };
    },
  ) {
    const versionId = source.version.id;
    const speakers: ProgrammeEntity[] = source.speakers.map((speaker) => ({
      entityType: "published_speaker",
      entityId: speaker.id,
      key: `${versionId}:${speaker.id}`,
      label: speaker.displayName,
      tableId: tables.speakers.id,
      fields: {
        "Program Cue Key": `${versionId}:${speaker.id}`,
        "Event ID": eventId,
        "Version ID": versionId,
        "Person ID": speaker.id,
        "Display Name": speaker.displayName,
        "Image URL": speaker.imageUrl ?? "",
        Biography: speaker.biography ?? "",
        Pronunciation: speaker.pronunciation ?? "",
        Organisation: speaker.organisationName ?? "",
        "Job Title": speaker.jobTitle ?? "",
        "Session IDs JSON": JSON.stringify(speaker.sessionIds),
        Status: "active",
      },
    }));
    const sessions: ProgrammeEntity[] = source.sessions.map((session) => ({
      entityType: "published_session",
      entityId: session.id,
      key: `${versionId}:${session.id}`,
      label: session.title,
      tableId: tables.sessions.id,
      fields: {
        "Program Cue Key": `${versionId}:${session.id}`,
        "Event ID": eventId,
        "Version ID": versionId,
        "Session ID": session.id,
        Slug: session.slug,
        Title: session.title,
        Description: session.description,
        Format: session.format,
        Track: session.track ?? "",
        "Speaker IDs JSON": JSON.stringify(session.speakerIds),
        "Speaker Names JSON": JSON.stringify(session.speakerNames),
        Status: "active",
      },
    }));
    const entries: ProgrammeEntity[] = source.entries.map((entry) => ({
      entityType: "published_schedule_entry",
      entityId: entry.id,
      key: `${versionId}:${entry.id}`,
      label:
        source.sessions.find((session) => session.id === entry.sessionId)
          ?.title ?? entry.sessionId,
      tableId: tables.schedule.id,
      fields: {
        "Program Cue Key": `${versionId}:${entry.id}`,
        "Event ID": eventId,
        "Version ID": versionId,
        "Entry ID": entry.id,
        "Session ID": entry.sessionId,
        "Room ID": entry.roomId,
        "Starts At": entry.startsAt,
        "Ends At": entry.endsAt,
        Status: "active",
      },
    }));
    return [...speakers, ...sessions, ...entries];
  }

  private async plan(
    eventId: string,
    source: ProgrammeSource,
    connection: Awaited<ReturnType<AirtableRoomRepository["getConnection"]>>,
  ) {
    if (!connection)
      throw new AirtableRepositoryReconciliationError(
        "Airtable repository connection not found.",
      );
    const entities = this.entities(
      eventId,
      source,
      connection.configuration.tables,
    );
    const existingByTable = new Map<string, AirtableRecord[]>();
    const client = this.client(connection.credentials);
    for (const [tableId, fields] of [
      [
        connection.configuration.tables.speakers.id,
        AIRTABLE_SPEAKER_FIELDS.map((field) => field.name),
      ],
      [
        connection.configuration.tables.sessions.id,
        AIRTABLE_SESSION_FIELDS.map((field) => field.name),
      ],
      [
        connection.configuration.tables.schedule.id,
        AIRTABLE_SCHEDULE_FIELDS.map((field) => field.name),
      ],
    ] as const) {
      existingByTable.set(
        tableId,
        await client.listRecords(tableId, {
          filterByFormula: publishedFilter(eventId, source.version.id),
          fields,
        }),
      );
    }
    for (const [tableId, records] of existingByTable) {
      const keys = new Set<string>();
      for (const record of records) {
        if (
          record.fields["Event ID"] !== eventId ||
          record.fields["Version ID"] !== source.version.id
        )
          continue;
        if (!("Status" in record.fields))
          throw new AirtableProgrammeSchemaError(
            `Airtable managed record ${record.id} has no status.`,
          );
        if (!(
          record.fields.Status === "active" ||
          record.fields.Status === "retired"
        ))
          throw new AirtableProgrammeSchemaError(
            `Airtable managed record ${record.id} must have active or retired status.`,
          );
        const key = record.fields["Program Cue Key"];
        if (typeof key !== "string" || !key)
          throw new AirtableProgrammeSchemaError(
            `Airtable managed record ${record.id} has no Program Cue Key.`,
          );
        const scopedKey = `${tableId}:${key}`;
        if (keys.has(scopedKey))
          throw new AirtableProgrammeSchemaError(
            `Airtable contains duplicate Program Cue key “${key}” in this published version.`,
          );
        keys.add(scopedKey);
      }
    }
    const items: AirtableProgrammePlanItem[] = entities.map((entity) => {
      const record = existingByTable
        .get(entity.tableId)
        ?.find(
          (candidate) => candidate.fields["Program Cue Key"] === entity.key,
        );
      return {
        ...entity,
        action: !record
          ? "create"
          : sameFields(record.fields, entity.fields)
            ? "noop"
            : "update",
        before: record?.fields ?? null,
      };
    });
    const desiredKeys = new Set(
      entities.map((entity) => `${entity.tableId}:${entity.key}`),
    );
    for (const entityType of [
      ["published_speaker", connection.configuration.tables.speakers.id],
      ["published_session", connection.configuration.tables.sessions.id],
      ["published_schedule_entry", connection.configuration.tables.schedule.id],
    ] as const) {
      for (const record of existingByTable.get(entityType[1]) ?? []) {
        if (
          record.fields["Event ID"] !== eventId ||
          record.fields["Version ID"] !== source.version.id ||
          record.fields.Status !== "active"
        )
          continue;
        const key = String(record.fields["Program Cue Key"] ?? "");
        if (!key || desiredKeys.has(`${entityType[1]}:${key}`)) continue;
        items.push({
          entityType: entityType[0],
          entityId: key.split(":").at(-1) ?? key,
          key,
          label: String(
            record.fields["Display Name"] ??
              record.fields.Title ??
              record.fields["Entry ID"] ??
              key,
          ),
          tableId: entityType[1],
          action: "update",
          before: record.fields,
          fields: { "Program Cue Key": key, Status: "retired" },
        });
      }
    }
    return items;
  }

  async previewPublication(eventId: string, versionId: string) {
    const source = await this.source(eventId, versionId);
    const event = await this.env.DB.prepare(
      "SELECT organisation_id AS organisationId FROM events WHERE id = ?",
    )
      .bind(eventId)
      .first<{ organisationId: string }>();
    if (!event)
      throw new AirtableRepositoryReconciliationError("Event not found.");
    const connection = await this.rooms.getConnection(
      event.organisationId,
      eventId,
      { requireConnected: true },
    );
    return this.plan(eventId, source, connection);
  }

  async stagePublication(
    scope: Pick<Viewer, "organisationId" | "eventId"> & {
      personId: string | null;
    },
    versionId: string,
  ) {
    const source = await this.source(scope.eventId, versionId);
    const connection = await this.rooms.getConnection(
      scope.organisationId,
      scope.eventId,
      { requireConnected: true },
    );
    if (!connection)
      throw new AirtableRepositoryReconciliationError(
        "Airtable repository connection not found.",
      );
    const items = await this.plan(scope.eventId, source, connection);
    const changedItems = items.filter((item) => item.action !== "noop");
    const sourceHash = await entityHash(
      this.entities(scope.eventId, source, connection.configuration.tables),
    );
    const idempotencyKey = `airtable-programme-stage:${versionId}:${sourceHash}`;
    const existing = await this.env.DB.prepare(
      `SELECT id, status FROM integration_runs
        WHERE connection_id = ? AND idempotency_key = ?`,
    )
      .bind(connection.id, idempotencyKey)
      .first<{ id: string; status: string }>();
    if (existing?.status === "succeeded") {
      const mapping = await this.publishedMapping(connection.id, versionId);
      if (
        changedItems.length > 0 ||
        !mapping ||
        mapping.sourceHash !== sourceHash
      ) {
        const reason =
          "The previously staged Airtable published-programme projection no longer matches its immutable Program Cue snapshot. Publish a new schedule version before continuing.";
        await this.rooms.markNeedsAttention(
          scope.organisationId,
          scope.eventId,
          reason,
        );
        throw new AirtableRepositoryReconciliationError(reason);
      }
      return { runId: existing.id, idempotent: true };
    }
    if (existing && !["failed", "partially_failed"].includes(existing.status))
      throw new AirtableRepositoryReconciliationError(
        `Airtable publication staging is already ${existing.status.replaceAll("_", " ")} for this schedule revision.`,
      );

    const runId = existing?.id ?? crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      ...(existing
        ? [
            this.env.DB.prepare(
              `DELETE FROM integration_runs
                WHERE id = ? AND connection_id = ?
                  AND status IN ('failed','partially_failed')`,
            ).bind(runId, connection.id),
          ]
        : []),
      this.env.DB.prepare(
        `INSERT INTO integration_runs (
           id, connection_id, idempotency_key, status, direction, dry_run,
           summary_json, started_at, created_at
         ) VALUES (?, ?, ?, 'running', 'outbound', 0, ?, unixepoch(), unixepoch())`,
      ).bind(
        runId,
        connection.id,
        idempotencyKey,
        JSON.stringify({
          kind: "airtable_programme_stage",
          versionId,
          versionRevision: source.version.revision,
          sourceHash,
          total: items.length,
          create: items.filter((item) => item.action === "create").length,
          update: items.filter((item) => item.action === "update").length,
          noop: items.filter((item) => item.action === "noop").length,
        }),
      ),
      ...changedItems.map((item) =>
        this.env.DB.prepare(
          `INSERT INTO integration_run_items (
             id, run_id, entity_type, entity_id, action, status,
             diff_json, attempt_count, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, unixepoch())`,
        ).bind(
          crypto.randomUUID(),
          runId,
          item.entityType,
          item.entityId,
          item.action,
          item.action === "noop" ? "skipped" : "running",
          JSON.stringify({ before: item.before, after: item.fields }),
        ),
      ),
    ];
    const intentResults = await this.env.DB.batch(statements);
    if (intentResults.some((result) => (result.meta.changes ?? 0) !== 1))
      throw new AirtableRepositoryReconciliationError(
        "Airtable publication intent could not be recorded completely.",
      );

    try {
      const client = this.client(connection.credentials);
      for (const tableId of [
        connection.configuration.tables.speakers.id,
        connection.configuration.tables.sessions.id,
        connection.configuration.tables.schedule.id,
      ]) {
        const writes = items
          .filter((item) => item.tableId === tableId && item.action !== "noop")
          .map((item) => ({ fields: item.fields }));
        for (let index = 0; index < writes.length; index += 10) {
          await client.upsertRecords(
            tableId,
            writes.slice(index, index + 10),
            "Program Cue Key",
          );
        }
      }
      const latestSource = await this.source(scope.eventId, versionId);
      if (latestSource.version.revision !== source.version.revision)
        throw new AirtableRepositoryReconciliationError(
          "The schedule version changed while Airtable publication was being staged. Retry against the latest revision.",
        );
      const after = await this.plan(scope.eventId, latestSource, connection);
      if (after.some((item) => item.action !== "noop"))
        throw new AirtableRepositoryReconciliationError(
          "Airtable programme staging did not reconcile to the requested version snapshot.",
        );
      const completionResults = await this.env.DB.batch([
        this.publishedMappingStatement(
          connection.id,
          versionId,
          sourceHash,
          source.version.revision,
        ),
        this.env.DB.prepare(
          `UPDATE integration_runs
              SET status = 'succeeded', completed_at = unixepoch()
            WHERE id = ? AND status = 'running'`,
        ).bind(runId),
        this.env.DB.prepare(
          `UPDATE integration_run_items
              SET status = CASE WHEN action = 'noop' THEN 'skipped' ELSE 'succeeded' END,
                  attempt_count = 1,
                  updated_at = unixepoch()
            WHERE run_id = ?`,
        ).bind(runId),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, 'airtable.programme.staged',
                     'schedule_version', ?, ?, ?, unixepoch())`,
        ).bind(
          crypto.randomUUID(),
          scope.organisationId,
          scope.eventId,
          scope.personId,
          versionId,
          runId,
          JSON.stringify({ versionRevision: source.version.revision }),
        ),
      ]);
      if (
        (completionResults[0]?.meta.changes ?? 0) !== 1 ||
        (completionResults[1]?.meta.changes ?? 0) !== 1 ||
        (completionResults[2]?.meta.changes ?? 0) !== changedItems.length ||
        (completionResults[3]?.meta.changes ?? 0) !== 1
      )
        throw new AirtableRepositoryReconciliationError(
          "Airtable publication reconciled, but its D1 run and audit result could not be recorded completely.",
        );
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE integration_runs
            SET status = 'failed', completed_at = unixepoch(),
                summary_json = json_set(summary_json, '$.error', ?)
          WHERE id = ? AND status = 'running'`,
      )
        .bind(error instanceof Error ? error.message : String(error), runId)
        .run();
      throw error;
    }
    programmeCache.delete(
      `${connection.id}:${connection.revision}:${scope.eventId}:${versionId}`,
    );
    return { runId, idempotent: false };
  }

  async readPublished(
    organisationId: string,
    eventId: string,
    versionId: string,
    options: { bypassCache?: boolean } = {},
  ): Promise<AirtablePublishedSnapshot> {
    const connection = await this.rooms.getConnection(organisationId, eventId, {
      requireConnected: true,
    });
    if (!connection)
      throw new AirtableRepositoryReconciliationError(
        "Airtable repository connection not found.",
      );
    const key = `${connection.id}:${connection.revision}:${eventId}:${versionId}`;
    const now = this.now();
    const cached = programmeCache.get(key);
    if (!options.bypassCache && cached && cached.cacheExpiresAt * 1_000 > now) {
      return {
        sessions: this.cloneSessions(cached.sessions),
        speakers: this.cloneSpeakers(cached.speakers),
        freshness: {
          source: "airtable",
          fetchedAt: cached.fetchedAt,
          cacheExpiresAt: cached.cacheExpiresAt,
          cached: true,
        },
      };
    }
    const client = this.client(connection.credentials);
    const speakerRecords = await client.listRecords(
      connection.configuration.tables.speakers.id,
      {
        filterByFormula: publishedFilter(eventId, versionId),
        fields: AIRTABLE_SPEAKER_FIELDS.map((field) => field.name),
      },
    );
    const sessionRecords = await client.listRecords(
      connection.configuration.tables.sessions.id,
      {
        filterByFormula: publishedFilter(eventId, versionId),
        fields: AIRTABLE_SESSION_FIELDS.map((field) => field.name),
      },
    );
    const entryRecords = await client.listRecords(
      connection.configuration.tables.schedule.id,
      {
        filterByFormula: publishedFilter(eventId, versionId),
        fields: AIRTABLE_SCHEDULE_FIELDS.map((field) => field.name),
      },
    );
    const [mapping, actualHash] = await Promise.all([
      this.publishedMapping(connection.id, versionId),
      publishedRecordsHash(eventId, versionId, [
        {
          tableId: connection.configuration.tables.speakers.id,
          fields: AIRTABLE_SPEAKER_FIELDS.map((field) => field.name),
          records: speakerRecords,
        },
        {
          tableId: connection.configuration.tables.sessions.id,
          fields: AIRTABLE_SESSION_FIELDS.map((field) => field.name),
          records: sessionRecords,
        },
        {
          tableId: connection.configuration.tables.schedule.id,
          fields: AIRTABLE_SCHEDULE_FIELDS.map((field) => field.name),
          records: entryRecords,
        },
      ]),
    ]);
    if (!mapping || mapping.sourceHash !== actualHash) {
      const reason =
        "The Airtable published-programme projection changed outside the Program Cue publication boundary. Publish a new schedule version before serving it.";
      await this.rooms.markNeedsAttention(organisationId, eventId, reason);
      throw new AirtableRepositoryReconciliationError(reason);
    }
    const roomSnapshot = await this.rooms.readRooms(organisationId, eventId, {
      bypassCache: options.bypassCache,
    });
    const speakers = activeScopedRecords(
      speakerRecords,
      eventId,
      versionId,
      "published-speaker",
    )
      .map(parseSpeaker)
      .map((speaker) => ({
        id: speaker.personId,
        displayName: speaker.displayName,
        imageUrl: speaker.imageUrl,
        biography: speaker.biography,
        pronunciation: speaker.pronunciation,
        organisationName: speaker.organisationName,
        jobTitle: speaker.jobTitle,
        sessionIds: speaker.sessionIds,
      }));
    const sessions = activeScopedRecords(
      sessionRecords,
      eventId,
      versionId,
      "published-session",
    ).map(parseSession);
    const entries = activeScopedRecords(
      entryRecords,
      eventId,
      versionId,
      "schedule",
    ).map(parseEntry);
    requireUnique(speakers, (speaker) => speaker.id, "speaker ID");
    requireUnique(sessions, (session) => session.sessionId, "session ID");
    requireUnique(entries, (entry) => entry.entryId, "schedule entry ID");
    requireUnique(entries, (entry) => entry.sessionId, "scheduled session ID");
    const speakerById = new Map(
      speakers.map((speaker) => [speaker.id, speaker]),
    );
    const speakerIds = new Set(speakerById.keys());
    const sessionById = new Map(
      sessions.map((session) => [session.sessionId, session]),
    );
    const roomById = new Map(
      roomSnapshot.rooms
        .filter((room) => room.status === "active")
        .map((room) => [room.id, room]),
    );
    const publishedSessions = entries.map((entry) => {
      const session = sessionById.get(entry.sessionId);
      const room = roomById.get(entry.roomId);
      if (!session)
        throw new AirtableProgrammeSchemaError(
          `Airtable schedule entry ${entry.entryId} references missing session ${entry.sessionId}.`,
        );
      if (!room)
        throw new AirtableProgrammeSchemaError(
          `Airtable schedule entry ${entry.entryId} references missing active room ${entry.roomId}.`,
        );
      const missingSpeaker = session.speakerIds.find(
        (id) => !speakerIds.has(id),
      );
      if (missingSpeaker)
        throw new AirtableProgrammeSchemaError(
          `Airtable session ${session.sessionId} references missing published speaker ${missingSpeaker}.`,
        );
      const mismatchedSpeakerIndex = session.speakerIds.findIndex(
        (id, index) =>
          speakerById.get(id)?.displayName !== session.speakerNames[index],
      );
      if (mismatchedSpeakerIndex >= 0)
        throw new AirtableProgrammeSchemaError(
          `Airtable session ${session.sessionId} has a speaker name that does not match published speaker ${session.speakerIds[mismatchedSpeakerIndex]}.`,
        );
      return {
        id: session.sessionId,
        slug: session.slug,
        title: session.title,
        description: session.description,
        format: session.format,
        startsAt: entry.startsAt,
        endsAt: entry.endsAt,
        room: room.name,
        building: room.building,
        level: room.level,
        track: session.track,
        speakerIds: session.speakerIds,
        speakerNames: session.speakerNames,
      } satisfies PublishedSession;
    });
    if (publishedSessions.length !== sessions.length) {
      const scheduled = new Set(entries.map((entry) => entry.sessionId));
      const orphan = sessions.find(
        (session) => !scheduled.has(session.sessionId),
      );
      throw new AirtableProgrammeSchemaError(
        `Airtable published session ${orphan?.sessionId ?? "unknown"} has no active schedule entry in this version.`,
      );
    }
    const sessionIds = new Set(publishedSessions.map((session) => session.id));
    for (const speaker of speakers) {
      if (!speaker.sessionIds.length)
        throw new AirtableProgrammeSchemaError(
          `Airtable published speaker ${speaker.id} has no published session in this version.`,
        );
      const missing = speaker.sessionIds.find((id) => !sessionIds.has(id));
      if (missing)
        throw new AirtableProgrammeSchemaError(
          `Airtable speaker ${speaker.id} references missing published session ${missing}.`,
        );
      const missingReverseReference = publishedSessions.find(
        (session) =>
          session.speakerIds.includes(speaker.id) &&
          !speaker.sessionIds.includes(session.id),
      );
      const extraReverseReference = speaker.sessionIds.find(
        (sessionId) =>
          !publishedSessions
            .find((session) => session.id === sessionId)
            ?.speakerIds.includes(speaker.id),
      );
      if (missingReverseReference || extraReverseReference)
        throw new AirtableProgrammeSchemaError(
          `Airtable speaker ${speaker.id} and the published-session speaker lists do not agree.`,
        );
    }
    const fetchedAt = Math.min(Math.floor(now / 1_000), roomSnapshot.fetchedAt);
    const snapshot: CachedSnapshot = {
      sessions: publishedSessions.sort(
        (left, right) =>
          left.startsAt - right.startsAt ||
          left.title.localeCompare(right.title) ||
          left.id.localeCompare(right.id),
      ),
      speakers: speakers.sort((left, right) =>
        left.displayName.localeCompare(right.displayName),
      ),
      fetchedAt,
      cacheExpiresAt: Math.min(
        fetchedAt + AIRTABLE_CACHE_TTL_SECONDS,
        roomSnapshot.cacheExpiresAt,
      ),
    };
    programmeCache.set(key, snapshot);
    return {
      sessions: this.cloneSessions(snapshot.sessions),
      speakers: this.cloneSpeakers(snapshot.speakers),
      freshness: {
        source: "airtable",
        fetchedAt,
        cacheExpiresAt: snapshot.cacheExpiresAt,
        cached: false,
      },
    };
  }
}
