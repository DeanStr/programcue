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

import { epochNow } from "./schema-helpers";

export const organisations = sqliteTable(
  "organisations",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [uniqueIndex("organisations_slug_unique").on(table.slug)],
);

export const people = sqliteTable(
  "people",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    name: text("display_name").notNull(),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    image: text("image_url"),
    biography: text("biography"),
    pronunciation: text("pronunciation"),
    organisationName: text("organisation_name"),
    jobTitle: text("job_title"),
    linkedinUrl: text("linkedin_url"),
    xHandle: text("x_handle"),
    profileStatus: text("profile_status")
      .notNull()
      .default("draft")
      .$type<"draft" | "published" | "archived">(),
    profileRevision: integer("profile_revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [uniqueIndex("people_email_unique").on(table.email)],
);

export const organisationAiSettings = sqliteTable(
  "organisation_ai_settings",
  {
    organisationId: text("organisation_id")
      .primaryKey()
      .references(() => organisations.id, { onDelete: "cascade" }),
    provider: text("provider")
      .notNull()
      .$type<"workers_ai" | "openai" | "anthropic">(),
    model: text("model").notNull(),
    revision: integer("revision").notNull().default(1),
    lastUpdatedByPersonId: text("last_updated_by_person_id").references(
      () => people.id,
    ),
    lastOperationId: text("last_operation_id"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("organisation_ai_settings_operation_unique").on(
      table.lastOperationId,
    ),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    timezone: text("timezone").notNull(),
    startsAt: integer("starts_at").notNull(),
    endsAt: integer("ends_at").notNull(),
    venueName: text("venue_name"),
    city: text("city"),
    description: text("description"),
    brandAccent: text("brand_accent").notNull().default("#4f46e5"),
    participantLogoUrl: text("participant_logo_url"),
    participantWelcomeText: text("participant_welcome_text"),
    participantSupportUrl: text("participant_support_url"),
    sessionFormatsJson: text("session_formats_json")
      .notNull()
      .default(
        '[{"key":"keynote","label":"Keynote","defaultDurationMinutes":60,"position":0},{"key":"presentation","label":"Presentation","defaultDurationMinutes":45,"position":1},{"key":"panel","label":"Panel","defaultDurationMinutes":60,"position":2},{"key":"workshop","label":"Workshop","defaultDurationMinutes":90,"position":3},{"key":"breakout","label":"Breakout","defaultDurationMinutes":45,"position":4},{"key":"break","label":"Break","defaultDurationMinutes":30,"position":5},{"key":"other","label":"Other","defaultDurationMinutes":30,"position":6}]',
      ),
    repositoryProvider: text("repository_provider")
      .notNull()
      .default("d1")
      .$type<"d1" | "airtable">(),
    activationStatus: text("activation_status")
      .notNull()
      .$type<"provisioning" | "active" | "provisioning_failed" | "discarded">(),
    repositoryLockedAt: integer("repository_locked_at"),
    retentionMonths: integer("retention_months")
      .notNull()
      .default(24)
      .$type<12 | 24 | 36>(),
    fileRetentionHoldAt: integer("file_retention_hold_at"),
    participantRetentionCompletedAt: integer(
      "participant_retention_completed_at",
    ),
    submissionAccessMode: text("submission_access_mode")
      .notNull()
      .default("email_verified")
      .$type<"email_verified" | "account_required" | "password_protected">(),
    allowAnonymousDrafts: integer("allow_anonymous_drafts", { mode: "boolean" })
      .notNull()
      .default(true),
    duplicatePersonWarnings: integer("duplicate_person_warnings", {
      mode: "boolean",
    })
      .notNull()
      .default(true),
    filePolicyJson: text("file_policy_json").notNull(),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    lastUpdatedByPersonId: text("last_updated_by_person_id").references(
      () => people.id,
    ),
    programmePublishedAt: integer("programme_published_at"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("events_slug_unique").on(table.slug),
    uniqueIndex("events_id_organisation_unique").on(
      table.id,
      table.organisationId,
    ),
    index("idx_events_org").on(table.organisationId),
  ],
);

export const eventParticipantProfiles = sqliteTable(
  "event_participant_profiles",
  {
    eventId: text("event_id").notNull(),
    organisationId: text("organisation_id").notNull(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    travelPreferences: text("travel_preferences"),
    lastOperationId: text("last_operation_id").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.personId] }),
    index("idx_event_participant_profiles_person").on(
      table.personId,
      table.eventId,
    ),
    foreignKey({
      columns: [table.eventId, table.organisationId],
      foreignColumns: [events.id, events.organisationId],
    }).onDelete("cascade"),
    check(
      "event_participant_profiles_travel_preferences_length",
      sql`${table.travelPreferences} IS NULL OR length(trim(${table.travelPreferences})) BETWEEN 1 AND 2000`,
    ),
  ],
);

export const memberships = sqliteTable(
  "memberships",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "cascade",
    }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    role: text("role")
      .notNull()
      .$type<
        | "owner"
        | "administrator"
        | "committee_chair"
        | "evaluator"
        | "submitter"
        | "speaker"
      >(),
    invitedAt: integer("invited_at"),
    invitationExpiresAt: integer("invitation_expires_at"),
    acceptedAt: integer("accepted_at"),
    revokedAt: integer("revoked_at"),
    lastOperationId: text("last_operation_id"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_memberships_person_event").on(
      table.personId,
      table.eventId,
      table.acceptedAt,
      table.revokedAt,
    ),
    index("idx_memberships_event_role_status").on(
      table.eventId,
      table.role,
      table.acceptedAt,
      table.revokedAt,
      table.personId,
    ),
    uniqueIndex("ux_memberships_org_role")
      .on(table.organisationId, table.personId, table.role)
      .where(sql`${table.eventId} IS NULL`),
    uniqueIndex("ux_memberships_event_role")
      .on(table.eventId, table.personId, table.role)
      .where(sql`${table.eventId} IS NOT NULL`),
  ],
);

export const eventSpeakerWorkflows = sqliteTable(
  "event_speaker_workflows",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    status: text("status")
      .notNull()
      .$type<"prospect" | "invited" | "confirmed" | "declined" | "withdrawn">(),
    source: text("source")
      .notNull()
      .$type<
        | "application"
        | "import"
        | "manual"
        | "session"
        | "membership"
        | "backfill"
      >(),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id").notNull().unique(),
    updatedByPersonId: text("updated_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    primaryKey({ columns: [table.eventId, table.personId] }),
    index("idx_event_speaker_workflows_status").on(
      table.eventId,
      table.status,
      table.personId,
    ),
    check(
      "event_speaker_workflows_attribution",
      sql`${table.updatedByPersonId} IS NOT NULL OR ${table.source} IN ('session','membership','backfill')`,
    ),
  ],
);

export const organisationContacts = sqliteTable(
  "organisation_contacts",
  {
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    source: text("source").notNull().$type<"event" | "import" | "manual">(),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"active" | "merged">(),
    mergedIntoPersonId: text("merged_into_person_id").references(
      () => people.id,
    ),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    primaryKey({ columns: [table.organisationId, table.personId] }),
    index("idx_organisation_contacts_status").on(
      table.organisationId,
      table.status,
      desc(table.updatedAt),
    ),
  ],
);

export const organisationContactProfiles = sqliteTable(
  "organisation_contact_profiles",
  {
    organisationId: text("organisation_id").notNull(),
    personId: text("person_id").notNull(),
    displayName: text("display_name").notNull(),
    biography: text("biography"),
    organisationName: text("organisation_name"),
    jobTitle: text("job_title"),
    source: text("source").notNull().$type<"import" | "manual">(),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    updatedByPersonId: text("updated_by_person_id").references(() => people.id),
    lastOperationId: text("last_operation_id"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    primaryKey({ columns: [table.organisationId, table.personId] }),
    foreignKey({
      columns: [table.organisationId, table.personId],
      foreignColumns: [
        organisationContacts.organisationId,
        organisationContacts.personId,
      ],
    }).onDelete("cascade"),
  ],
);

export const organisationContactTags = sqliteTable(
  "organisation_contact_tags",
  {
    organisationId: text("organisation_id").notNull(),
    personId: text("person_id").notNull(),
    tag: text("tag").notNull(),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    primaryKey({ columns: [table.organisationId, table.personId, table.tag] }),
    foreignKey({
      columns: [table.organisationId, table.personId],
      foreignColumns: [
        organisationContacts.organisationId,
        organisationContacts.personId,
      ],
    }).onDelete("cascade"),
    index("idx_organisation_contact_tags_tag").on(
      table.organisationId,
      table.tag,
      table.personId,
    ),
  ],
);

export const organisationContactNotes = sqliteTable(
  "organisation_contact_notes",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull(),
    personId: text("person_id").notNull(),
    authorPersonId: text("author_person_id")
      .notNull()
      .references(() => people.id),
    body: text("body").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.organisationId, table.personId],
      foreignColumns: [
        organisationContacts.organisationId,
        organisationContacts.personId,
      ],
    }).onDelete("cascade"),
    index("idx_organisation_contact_notes_person").on(
      table.organisationId,
      table.personId,
      desc(table.createdAt),
    ),
  ],
);

export const crmSegments = sqliteTable(
  "crm_segments",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    ownerPersonId: text("owner_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    filtersJson: text("filters_json").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("crm_segments_name_unique").on(
      table.organisationId,
      table.ownerPersonId,
      table.name,
    ),
    index("idx_crm_segments_owner").on(
      table.organisationId,
      table.ownerPersonId,
      desc(table.updatedAt),
    ),
  ],
);

export const crmPipelineEntries = sqliteTable(
  "crm_pipeline_entries",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull(),
    personId: text("person_id").notNull(),
    stage: text("stage")
      .notNull()
      .$type<
        "identified" | "contacted" | "interested" | "confirmed" | "declined"
      >(),
    score: integer("score"),
    rationale: text("rationale"),
    revision: integer("revision").notNull().default(1),
    createdByPersonId: text("created_by_person_id")
      .notNull()
      .references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("crm_pipeline_person_unique").on(
      table.organisationId,
      table.personId,
    ),
    uniqueIndex("crm_pipeline_id_org_unique").on(
      table.id,
      table.organisationId,
    ),
    foreignKey({
      columns: [table.organisationId, table.personId],
      foreignColumns: [
        organisationContacts.organisationId,
        organisationContacts.personId,
      ],
    }).onDelete("cascade"),
    index("idx_crm_pipeline_stage").on(
      table.organisationId,
      table.stage,
      desc(table.updatedAt),
    ),
  ],
);

export const crmPipelineActivity = sqliteTable(
  "crm_pipeline_activity",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").notNull(),
    pipelineEntryId: text("pipeline_entry_id").notNull(),
    actorPersonId: text("actor_person_id")
      .notNull()
      .references(() => people.id),
    kind: text("kind").notNull().$type<"note" | "stage_changed">(),
    body: text("body"),
    fromStage: text("from_stage"),
    toStage: text("to_stage"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.pipelineEntryId, table.organisationId],
      foreignColumns: [
        crmPipelineEntries.id,
        crmPipelineEntries.organisationId,
      ],
    }).onDelete("cascade"),
    index("idx_crm_pipeline_activity_entry").on(
      table.organisationId,
      table.pipelineEntryId,
      desc(table.createdAt),
    ),
  ],
);
