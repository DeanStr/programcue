import { z } from "zod";

import {
  type AirtableRecord,
  airtableAndFormula,
  airtableEqualsFormula,
} from "./airtable-client.server";

export type ProgrammeEntity = {
  entityType:
    | "published_speaker"
    | "published_session"
    | "published_schedule_entry";
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

export function publishedFilter(eventId: string, versionId: string) {
  return airtableAndFormula(
    airtableEqualsFormula("Event ID", eventId),
    airtableEqualsFormula("Version ID", versionId),
  );
}

export function nullableString(value: unknown) {
  return typeof value === "string" && value.length ? value : null;
}

export function jsonStringArray(
  value: unknown,
  field: string,
  recordId: string,
) {
  try {
    const parsed = JSON.parse(String(value ?? "[]"));
    return z.array(z.string().min(1)).parse(parsed);
  } catch {
    throw new AirtableProgrammeSchemaError(
      `Airtable record ${recordId} field “${field}” must contain a JSON string array.`,
    );
  }
}

export function matchingRecord(
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

export function activeScopedRecords(
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

export function requireUnique<T>(
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

export function parseSpeaker(record: AirtableRecord) {
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

export function parseSession(record: AirtableRecord) {
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

export function parseEntry(record: AirtableRecord) {
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

export function sameFields(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
) {
  return Object.entries(right).every(([field, expected]) => {
    const actual = left[field];
    if (expected === "" && actual === undefined) return true;
    return JSON.stringify(actual) === JSON.stringify(expected);
  });
}

export function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableValue(entry)]),
    );
  return value;
}

export async function entityHash(
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

export async function publishedRecordsHash(
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
