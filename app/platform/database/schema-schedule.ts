import { desc, sql } from "drizzle-orm";
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
import { submissions } from "./schema-submissions";

export const tracks = sqliteTable(
  "tracks",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    colourToken: text("colour_token"),
    position: integer("position").notNull().default(0),
    exclusive: integer("exclusive", { mode: "boolean" })
      .notNull()
      .default(false),
    isPublic: integer("is_public", { mode: "boolean" }).notNull().default(true),
  },
  (table) => [
    uniqueIndex("tracks_event_slug_unique").on(table.eventId, table.slug),
  ],
);

export const submissionTrackSelections = sqliteTable(
  "submission_track_selections",
  {
    submissionId: text("submission_id").notNull(),
    eventId: text("event_id").notNull(),
    trackId: text("track_id").notNull(),
    trackNameSnapshot: text("track_name_snapshot").notNull(),
    position: integer("position").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.submissionId, table.trackId] }),
    uniqueIndex("submission_track_selections_position_unique").on(
      table.submissionId,
      table.position,
    ),
    index("idx_submission_track_selections_event").on(
      table.eventId,
      table.trackId,
      table.submissionId,
    ),
    index("idx_submission_track_selections_event_name").on(
      table.eventId,
      table.trackNameSnapshot,
      table.submissionId,
    ),
    foreignKey({
      columns: [table.submissionId, table.eventId],
      foreignColumns: [submissions.id, submissions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.trackId, table.eventId],
      foreignColumns: [tracks.id, tracks.eventId],
    }),
  ],
);

export const rooms = sqliteTable("rooms", {
  id: text("id").primaryKey(),
  eventId: text("event_id")
    .notNull()
    .references(() => events.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  building: text("building"),
  level: text("level"),
  capacity: integer("capacity").notNull(),
  resourcesJson: text("resources_json").notNull().default("[]"),
  position: integer("position").notNull().default(0),
  status: text("status")
    .notNull()
    .default("active")
    .$type<"active" | "retired">(),
});

export const schedulePolicies = sqliteTable("schedule_policies", {
  eventId: text("event_id")
    .primaryKey()
    .references(() => events.id, { onDelete: "cascade" }),
  roomOverlapAction: text("room_overlap_action")
    .notNull()
    .default("block")
    .$type<"allow" | "warn" | "block">(),
  speakerOverlapAction: text("speaker_overlap_action")
    .notNull()
    .default("block")
    .$type<"allow" | "warn" | "block">(),
  requiredResourceOverlapAction: text("required_resource_overlap_action")
    .notNull()
    .default("block")
    .$type<"allow" | "warn" | "block">(),
  exclusiveTrackOverlapAction: text("exclusive_track_overlap_action")
    .notNull()
    .default("warn")
    .$type<"allow" | "warn" | "block">(),
  eventBoundaryAction: text("event_boundary_action")
    .notNull()
    .default("block")
    .$type<"allow" | "warn" | "block">(),
  capacityAction: text("capacity_action")
    .notNull()
    .default("warn")
    .$type<"allow" | "warn" | "block">(),
  speakerUnavailableAction: text("speaker_unavailable_action")
    .notNull()
    .default("block")
    .$type<"warn" | "block">(),
  minimumTurnaroundMinutes: integer("minimum_turnaround_minutes")
    .notNull()
    .default(0),
  revision: integer("revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull().default(epochNow),
});

export const speakerBlackoutWindows = sqliteTable(
  "speaker_blackout_windows",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    note: text("note"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("speaker_blackout_windows_id_event_unique").on(
      table.id,
      table.eventId,
    ),
    index("idx_speaker_blackout_windows_person").on(
      table.eventId,
      table.personId,
      table.startsAt,
    ),
    index("idx_speaker_blackout_windows_event").on(
      table.eventId,
      table.startsAt,
      table.endsAt,
    ),
    check(
      "speaker_blackout_windows_range_check",
      sql`${table.endsAt} > ${table.startsAt}`,
    ),
    check(
      "speaker_blackout_windows_note_check",
      sql`${table.note} IS NULL OR (length(${table.note}) BETWEEN 1 AND 500 AND ${table.note} = trim(${table.note}))`,
    ),
  ],
);

export const programmeEmbeds = sqliteTable(
  "programme_embeds",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    organisationId: text("organisation_id").notNull(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "active" | "paused" | "revoked">(),
    configurationJson: text("configuration_json").notNull(),
    installationNote: text("installation_note"),
    revision: integer("revision").notNull().default(1),
    createdByPersonId: text("created_by_person_id")
      .notNull()
      .references(() => people.id),
    updatedByPersonId: text("updated_by_person_id")
      .notNull()
      .references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.eventId, table.organisationId],
      foreignColumns: [events.id, events.organisationId],
    }).onDelete("cascade"),
    uniqueIndex("programme_embeds_event_slug_unique").on(
      table.eventId,
      table.slug,
    ),
    index("idx_programme_embeds_event_status").on(
      table.eventId,
      table.status,
      table.updatedAt,
    ),
    check(
      "programme_embeds_status_check",
      sql`${table.status} IN ('draft','active','paused','revoked')`,
    ),
    check(
      "programme_embeds_name_length_check",
      sql`length(trim(${table.name})) BETWEEN 1 AND 120`,
    ),
    check(
      "programme_embeds_slug_check",
      sql`length(${table.slug}) BETWEEN 1 AND 80 AND ${table.slug} NOT GLOB '*[^a-z0-9-]*' AND ${table.slug} NOT LIKE '-%' AND ${table.slug} NOT LIKE '%-' AND ${table.slug} NOT LIKE '%--%'`,
    ),
    check(
      "programme_embeds_configuration_check",
      sql`json_valid(${table.configurationJson})`,
    ),
    check(
      "programme_embeds_installation_note_length_check",
      sql`${table.installationNote} IS NULL OR length(${table.installationNote}) BETWEEN 1 AND 500`,
    ),
    check("programme_embeds_revision_check", sql`${table.revision} >= 1`),
    check(
      "programme_embeds_revoked_at_check",
      sql`(${table.status} = 'revoked') = (${table.revokedAt} IS NOT NULL)`,
    ),
  ],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    sourceSubmissionId: text("source_submission_id").references(
      () => submissions.id,
    ),
    trackId: text("track_id").references(() => tracks.id),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    format: text("format").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    expectedAttendance: integer("expected_attendance"),
    requiredResourcesJson: text("required_resources_json")
      .notNull()
      .default("[]"),
    status: text("status")
      .notNull()
      .default("unscheduled")
      .$type<
        "unscheduled" | "scheduled" | "published" | "cancelled" | "archived"
      >(),
    visibility: text("visibility")
      .notNull()
      .default("public")
      .$type<"public" | "private" | "hidden">(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("sessions_event_slug_unique").on(table.eventId, table.slug),
    uniqueIndex("ux_sessions_source_submission")
      .on(table.sourceSubmissionId)
      .where(sql`${table.sourceSubmissionId} IS NOT NULL`),
    index("idx_sessions_event_status").on(
      table.eventId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const sessionSpeakers = sqliteTable(
  "session_speakers",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id),
    position: integer("position").notNull(),
    roleLabel: text("role_label"),
    participationStatus: text("participation_status")
      .notNull()
      .$type<"pending" | "confirmed" | "declined">(),
    participationRevision: integer("participation_revision")
      .notNull()
      .default(1),
    participationConfirmedAt: integer("participation_confirmed_at"),
    participationDeclinedAt: integer("participation_declined_at"),
    participationDeclineReason: text("participation_decline_reason"),
    visibility: text("visibility")
      .notNull()
      .default("public")
      .$type<"public" | "private" | "hidden">(),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.personId] }),
    uniqueIndex("session_speakers_position_unique").on(
      table.sessionId,
      table.position,
    ),
    index("idx_session_speakers_person").on(table.eventId, table.personId),
    check(
      "session_speakers_participation_confirmation_check",
      sql`(${table.participationStatus} = 'pending' AND ${table.participationConfirmedAt} IS NULL AND ${table.participationDeclinedAt} IS NULL AND ${table.participationDeclineReason} IS NULL) OR (${table.participationStatus} = 'confirmed' AND ${table.participationConfirmedAt} IS NOT NULL AND ${table.participationDeclinedAt} IS NULL AND ${table.participationDeclineReason} IS NULL) OR (${table.participationStatus} = 'declined' AND ${table.participationConfirmedAt} IS NULL AND ${table.participationDeclinedAt} IS NOT NULL AND (${table.participationDeclineReason} IS NULL OR (length(${table.participationDeclineReason}) BETWEEN 1 AND 500 AND ${table.participationDeclineReason} = trim(${table.participationDeclineReason}))))`,
    ),
    check(
      "session_speakers_participation_revision_check",
      sql`${table.participationRevision} > 0`,
    ),
  ],
);

export const tags = sqliteTable(
  "tags",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    colourToken: text("colour_token"),
    createdByPersonId: text("created_by_person_id")
      .notNull()
      .references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("ux_tags_event_name").on(
      table.eventId,
      sql`lower(${table.name})`,
    ),
  ],
);

export const sessionTags = sqliteTable(
  "session_tags",
  {
    eventId: text("event_id").notNull(),
    sessionId: text("session_id").notNull(),
    tagId: text("tag_id").notNull(),
    createdByPersonId: text("created_by_person_id")
      .notNull()
      .references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    primaryKey({ columns: [table.sessionId, table.tagId] }),
    foreignKey({
      columns: [table.sessionId, table.eventId],
      foreignColumns: [sessions.id, sessions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.tagId, table.eventId],
      foreignColumns: [tags.id, tags.eventId],
    }).onDelete("cascade"),
    index("idx_session_tags_tag").on(
      table.eventId,
      table.tagId,
      table.sessionId,
    ),
  ],
);

export const scheduleVersions = sqliteTable(
  "schedule_versions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    name: text("name"),
    notes: text("notes").notNull().default(""),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "publishing" | "published" | "archived" | "failed">(),
    revision: integer("revision").notNull().default(1),
    publicationOperationId: text("publication_operation_id"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    publishedAt: integer("published_at"),
  },
  (table) => [
    uniqueIndex("schedule_versions_number_unique").on(
      table.eventId,
      table.versionNumber,
    ),
    uniqueIndex("ux_schedule_versions_one_published")
      .on(table.eventId)
      .where(sql`${table.status} = 'published'`),
    uniqueIndex("ux_schedule_versions_one_draft")
      .on(table.eventId)
      .where(sql`${table.status} = 'draft'`),
  ],
);

export const scheduleSessionContents = sqliteTable(
  "schedule_session_contents",
  {
    scheduleVersionId: text("schedule_version_id").notNull(),
    eventId: text("event_id").notNull(),
    sessionId: text("session_id").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    trackId: text("track_id"),
    format: text("format").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    requiredResourcesJson: text("required_resources_json")
      .notNull()
      .default("[]"),
    visibility: text("visibility")
      .notNull()
      .$type<"public" | "private" | "hidden">(),
    contentStatus: text("content_status")
      .notNull()
      .default("draft")
      .$type<"draft" | "in_review" | "approved" | "changes_requested">(),
    contentRevision: integer("content_revision").notNull().default(1),
    lastEditedByPersonId: text("last_edited_by_person_id").references(
      () => people.id,
    ),
    approvedByPersonId: text("approved_by_person_id").references(
      () => people.id,
    ),
    approvedAt: integer("approved_at"),
    approvalSource: text("approval_source").$type<
      "editorial" | "legacy_publication"
    >(),
    lastOperationId: text("last_operation_id"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    primaryKey({ columns: [table.scheduleVersionId, table.sessionId] }),
    foreignKey({
      columns: [table.scheduleVersionId, table.eventId],
      foreignColumns: [scheduleVersions.id, scheduleVersions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId, table.eventId],
      foreignColumns: [sessions.id, sessions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.trackId, table.eventId],
      foreignColumns: [tracks.id, tracks.eventId],
    }),
    index("idx_schedule_session_contents_event").on(
      table.eventId,
      table.sessionId,
      table.scheduleVersionId,
    ),
  ],
);

export const sessionContentRevisions = sqliteTable(
  "session_content_revisions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    scheduleVersionId: text("schedule_version_id").notNull(),
    sessionId: text("session_id").notNull(),
    revisionNumber: integer("revision_number").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    description: text("description"),
    trackId: text("track_id"),
    format: text("format").notNull(),
    durationMinutes: integer("duration_minutes").notNull(),
    requiredResourcesJson: text("required_resources_json").notNull(),
    visibility: text("visibility")
      .notNull()
      .$type<"public" | "private" | "hidden">(),
    contentStatus: text("content_status")
      .notNull()
      .$type<"draft" | "in_review" | "approved" | "changes_requested">(),
    changeKind: text("change_kind")
      .notNull()
      .$type<"baseline" | "edit" | "status" | "restore">(),
    restoredFromRevisionId: text("restored_from_revision_id"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("session_content_revisions_number_unique").on(
      table.scheduleVersionId,
      table.sessionId,
      table.revisionNumber,
    ),
    index("idx_session_content_revisions_history").on(
      table.eventId,
      table.sessionId,
      table.scheduleVersionId,
      desc(table.revisionNumber),
    ),
    foreignKey({
      columns: [table.scheduleVersionId, table.sessionId, table.eventId],
      foreignColumns: [
        scheduleSessionContents.scheduleVersionId,
        scheduleSessionContents.sessionId,
        scheduleSessionContents.eventId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.trackId, table.eventId],
      foreignColumns: [tracks.id, tracks.eventId],
    }),
  ],
);

export const scheduleEntries = sqliteTable(
  "schedule_entries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    scheduleVersionId: text("schedule_version_id")
      .notNull()
      .references(() => scheduleVersions.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    roomId: text("room_id")
      .notNull()
      .references(() => rooms.id),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("schedule_entries_session_unique").on(
      table.scheduleVersionId,
      table.sessionId,
    ),
    index("idx_schedule_entries_version_time").on(
      table.scheduleVersionId,
      table.startsAt,
    ),
    index("idx_schedule_entries_room_time").on(
      table.scheduleVersionId,
      table.roomId,
      table.startsAt,
      table.endsAt,
    ),
  ],
);

export const scheduleReviewLinks = sqliteTable(
  "schedule_review_links",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull(),
    eventId: text("event_id").notNull(),
    scheduleVersionId: text("schedule_version_id").notNull(),
    scheduleRevision: integer("schedule_revision").notNull(),
    projectionJson: text("projection_json").notNull(),
    tokenHash: text("token_hash").notNull(),
    expiresAt: integer("expires_at").notNull(),
    createdByPersonId: text("created_by_person_id")
      .notNull()
      .references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    purpose: text("purpose").notNull(),
    revokedAt: integer("revoked_at"),
    revokedByPersonId: text("revoked_by_person_id").references(() => people.id),
    revocationReason: text("revocation_reason").$type<"manual" | "published">(),
  },
  (table) => [
    uniqueIndex("schedule_review_links_token_hash_unique").on(table.tokenHash),
    uniqueIndex("schedule_review_links_id_event_unique").on(
      table.id,
      table.eventId,
    ),
    uniqueIndex("schedule_review_links_id_org_event_unique").on(
      table.id,
      table.organisationId,
      table.eventId,
    ),
    index("idx_schedule_review_links_event").on(
      table.organisationId,
      table.eventId,
      desc(table.createdAt),
      desc(table.id),
    ),
    foreignKey({
      columns: [table.eventId, table.organisationId],
      foreignColumns: [events.id, events.organisationId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.scheduleVersionId, table.eventId],
      foreignColumns: [scheduleVersions.id, scheduleVersions.eventId],
    }).onDelete("cascade"),
    check(
      "schedule_review_links_revision_check",
      sql`${table.scheduleRevision} > 0`,
    ),
    check(
      "schedule_review_links_projection_json_check",
      sql`json_valid(${table.projectionJson}) AND json_type(${table.projectionJson}) = 'object' AND length(${table.projectionJson}) <= 1048576`,
    ),
    check(
      "schedule_review_links_token_hash_check",
      sql`length(${table.tokenHash}) = 64 AND ${table.tokenHash} NOT GLOB '*[^0-9a-f]*'`,
    ),
    check(
      "schedule_review_links_expiry_check",
      sql`${table.expiresAt} > ${table.createdAt} AND ${table.expiresAt} <= ${table.createdAt} + 2592000`,
    ),
    check(
      "schedule_review_links_purpose_check",
      sql`length(trim(${table.purpose})) BETWEEN 1 AND 80 AND ${table.purpose} = trim(${table.purpose}) AND instr(${table.purpose}, char(10)) = 0 AND instr(${table.purpose}, char(13)) = 0`,
    ),
    check(
      "schedule_review_links_revocation_check",
      sql`(${table.revokedAt} IS NULL AND ${table.revokedByPersonId} IS NULL AND ${table.revocationReason} IS NULL) OR (${table.revokedAt} IS NOT NULL AND ${table.revocationReason} IS NOT NULL AND ${table.revocationReason} IN ('manual', 'published') AND (${table.revocationReason} <> 'manual' OR (${table.revokedByPersonId} IS NOT NULL AND trim(${table.revokedByPersonId}) <> '')))`,
    ),
  ],
);

export const scheduleConflicts = sqliteTable(
  "schedule_conflicts",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    scheduleVersionId: text("schedule_version_id")
      .notNull()
      .references(() => scheduleVersions.id, { onDelete: "cascade" }),
    conflictType: text("conflict_type")
      .notNull()
      .$type<
        | "room"
        | "speaker"
        | "track"
        | "event_boundary"
        | "capacity"
        | "required_resource"
        | "resource_configuration"
        | "room_resource"
        | "turnaround"
        | "speaker_unavailable"
      >(),
    severity: text("severity").notNull().$type<"warning" | "blocking">(),
    fingerprint: text("fingerprint").notNull(),
    primaryEntryId: text("primary_entry_id"),
    conflictingEntryId: text("conflicting_entry_id"),
    detailsJson: text("details_json").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
    resolvedByPersonId: text("resolved_by_person_id").references(
      () => people.id,
    ),
    resolvedAt: integer("resolved_at"),
    resolutionJson: text("resolution_json"),
  },
  (table) => [
    uniqueIndex("schedule_conflicts_fingerprint_unique").on(
      table.scheduleVersionId,
      table.fingerprint,
    ),
    index("idx_schedule_conflicts_open").on(
      table.eventId,
      table.scheduleVersionId,
      table.resolvedAt,
      table.severity,
    ),
  ],
);

export const publicItineraries = sqliteTable(
  "public_itineraries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    personId: text("person_id").references(() => people.id, {
      onDelete: "cascade",
    }),
    visitorKeyHash: text("visitor_key_hash"),
    shareTokenHash: text("share_token_hash"),
    expiresAt: integer("expires_at"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("public_itineraries_person_unique").on(
      table.eventId,
      table.personId,
    ),
    uniqueIndex("public_itineraries_visitor_unique").on(
      table.eventId,
      table.visitorKeyHash,
    ),
    uniqueIndex("public_itineraries_share_unique").on(table.shareTokenHash),
    index("idx_itinerary_person").on(table.eventId, table.personId),
    index("idx_itinerary_expiry").on(table.expiresAt, table.id),
  ],
);

export const publicItineraryItems = sqliteTable(
  "public_itinerary_items",
  {
    itineraryId: text("itinerary_id")
      .notNull()
      .references(() => publicItineraries.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [primaryKey({ columns: [table.itineraryId, table.sessionId] })],
);
