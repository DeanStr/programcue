import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { events, people } from "./schema-core";
import { epochNow } from "./schema-helpers";
import { sessions } from "./schema-schedule";

export const eventPublicSites = sqliteTable(
  "event_public_sites",
  {
    eventId: text("event_id").primaryKey(),
    organisationId: text("organisation_id").notNull(),
    draftJson: text("draft_json").notNull(),
    draftRevision: integer("draft_revision").notNull().default(1),
    publishedJson: text("published_json"),
    publishedRevision: integer("published_revision"),
    publishedAt: integer("published_at"),
    lastUpdatedByPersonId: text("last_updated_by_person_id")
      .notNull()
      .references(() => people.id),
    lastOperationId: text("last_operation_id").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.eventId, table.organisationId],
      foreignColumns: [events.id, events.organisationId],
    }).onDelete("cascade"),
    uniqueIndex("event_public_sites_operation_unique").on(
      table.lastOperationId,
    ),
    check("event_public_sites_draft_json", sql`json_valid(${table.draftJson})`),
    check("event_public_sites_draft_revision", sql`${table.draftRevision} > 0`),
    check(
      "event_public_sites_published_json",
      sql`${table.publishedJson} IS NULL OR json_valid(${table.publishedJson})`,
    ),
    check(
      "event_public_sites_publication_tuple",
      sql`(${table.publishedJson} IS NULL AND ${table.publishedRevision} IS NULL AND ${table.publishedAt} IS NULL) OR (${table.publishedJson} IS NOT NULL AND ${table.publishedRevision} > 0 AND ${table.publishedAt} IS NOT NULL)`,
    ),
  ],
);

export const eventPublicSiteReferences = sqliteTable(
  "event_public_site_references",
  {
    eventId: text("event_id").notNull(),
    organisationId: text("organisation_id").notNull(),
    kind: text("kind").notNull().$type<"session" | "speaker">(),
    recordId: text("record_id").notNull(),
    siteRevision: integer("site_revision").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.kind, table.recordId] }),
    foreignKey({
      columns: [table.eventId, table.organisationId],
      foreignColumns: [events.id, events.organisationId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.eventId],
      foreignColumns: [eventPublicSites.eventId],
    }).onDelete("cascade"),
    check(
      "event_public_site_references_kind",
      sql`${table.kind} IN ('session', 'speaker')`,
    ),
    check(
      "event_public_site_references_revision",
      sql`${table.siteRevision} > 0`,
    ),
  ],
);

export const eventSiteSponsors = sqliteTable(
  "event_site_sponsors",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull(),
    eventId: text("event_id").notNull(),
    name: text("name").notNull(),
    tier: text("tier").notNull(),
    websiteUrl: text("website_url"),
    logoUrl: text("logo_url"),
    description: text("description"),
    position: integer("position").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    lastUpdatedByPersonId: text("last_updated_by_person_id")
      .notNull()
      .references(() => people.id),
    lastOperationId: text("last_operation_id").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("event_site_sponsors_event_id_unique").on(
      table.id,
      table.eventId,
    ),
    uniqueIndex("event_site_sponsors_operation_unique").on(
      table.lastOperationId,
    ),
    foreignKey({
      columns: [table.eventId, table.organisationId],
      foreignColumns: [events.id, events.organisationId],
    }).onDelete("cascade"),
    index("idx_event_site_sponsors_order").on(
      table.eventId,
      table.tier,
      table.position,
      table.name,
      table.id,
    ),
    check("event_site_sponsors_revision", sql`${table.revision} > 0`),
    check("event_site_sponsors_position", sql`${table.position} >= 0`),
  ],
);

export const eventSessionRecordings = sqliteTable(
  "event_session_recordings",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull(),
    eventId: text("event_id").notNull(),
    sessionId: text("session_id").notNull(),
    draftTitle: text("draft_title").notNull(),
    draftRecordingUrl: text("draft_recording_url").notNull(),
    draftCaptionsUrl: text("draft_captions_url"),
    draftTranscriptUrl: text("draft_transcript_url"),
    draftRevision: integer("draft_revision").notNull().default(1),
    publishedTitle: text("published_title"),
    publishedRecordingUrl: text("published_recording_url"),
    publishedCaptionsUrl: text("published_captions_url"),
    publishedTranscriptUrl: text("published_transcript_url"),
    publishedRevision: integer("published_revision"),
    publishedAt: integer("published_at"),
    lastUpdatedByPersonId: text("last_updated_by_person_id")
      .notNull()
      .references(() => people.id),
    lastOperationId: text("last_operation_id").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("event_session_recordings_event_session_unique").on(
      table.eventId,
      table.sessionId,
    ),
    uniqueIndex("event_session_recordings_operation_unique").on(
      table.lastOperationId,
    ),
    foreignKey({
      columns: [table.eventId, table.organisationId],
      foreignColumns: [events.id, events.organisationId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId, table.eventId],
      foreignColumns: [sessions.id, sessions.eventId],
    }).onDelete("cascade"),
    index("idx_event_session_recordings_public")
      .on(table.eventId, table.publishedAt, table.sessionId)
      .where(sql`${table.publishedAt} IS NOT NULL`),
    check(
      "event_session_recordings_draft_revision",
      sql`${table.draftRevision} > 0`,
    ),
    check(
      "event_session_recordings_publication_tuple",
      sql`(${table.publishedTitle} IS NULL AND ${table.publishedRecordingUrl} IS NULL AND ${table.publishedCaptionsUrl} IS NULL AND ${table.publishedTranscriptUrl} IS NULL AND ${table.publishedRevision} IS NULL AND ${table.publishedAt} IS NULL) OR (${table.publishedTitle} IS NOT NULL AND ${table.publishedRecordingUrl} IS NOT NULL AND ${table.publishedRevision} > 0 AND ${table.publishedAt} IS NOT NULL)`,
    ),
  ],
);
