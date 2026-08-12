import { desc, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

const epochNow = sql`(unixepoch())`;

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
    index("idx_events_org").on(table.organisationId),
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

export const formDefinitions = sqliteTable(
  "form_definitions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    kind: text("kind").notNull().$type<"submission" | "direct_session">(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "published" | "closed" | "archived">(),
    publicSlug: text("public_slug").notNull(),
    closesAt: integer("closes_at"),
    submissionLimit: integer("submission_limit"),
    minSpeakers: integer("min_speakers").notNull().default(1),
    maxSpeakers: integer("max_speakers"),
    accessMode: text("access_mode")
      .notNull()
      .default("email_verified")
      .$type<"email_verified" | "account_required" | "password_protected">(),
    accessPasswordHash: text("access_password_hash"),
    confirmationTemplateId: text("confirmation_template_id"),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("form_definitions_public_slug_unique").on(table.publicSlug),
    index("idx_form_public_status").on(table.publicSlug, table.status),
  ],
);

export const formVersions = sqliteTable(
  "form_versions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    formId: text("form_id")
      .notNull()
      .references(() => formDefinitions.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    schemaJson: text("schema_json").notNull(),
    routingJson: text("routing_json").notNull().default("{}"),
    settingsSnapshotJson: text("settings_snapshot_json")
      .notNull()
      .default("{}"),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "published" | "retired">(),
    revision: integer("revision").notNull().default(1),
    publishedAt: integer("published_at"),
    retiredAt: integer("retired_at"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("form_versions_number_unique").on(
      table.formId,
      table.versionNumber,
    ),
    uniqueIndex("ux_form_versions_one_published")
      .on(table.formId)
      .where(sql`${table.status} = 'published'`),
    index("idx_form_versions_lookup").on(
      table.eventId,
      table.formId,
      table.versionNumber,
    ),
  ],
);

export const submissions = sqliteTable(
  "submissions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    formVersionId: text("form_version_id"),
    submitterPersonId: text("submitter_person_id").references(() => people.id),
    submitterEmail: text("submitter_email"),
    publicReference: text("public_reference").notNull(),
    title: text("title").notNull().default(""),
    category: text("category"),
    format: text("format"),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<
        | "draft"
        | "submitted"
        | "assigned"
        | "in_review"
        | "decision_ready"
        | "accepted"
        | "waitlisted"
        | "rejected"
        | "withdrawn"
      >(),
    answersJson: text("answers_json").notNull().default("{}"),
    submittedSnapshotJson: text("submitted_snapshot_json"),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    submittedAt: integer("submitted_at"),
    withdrawnAt: integer("withdrawn_at"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    check(
      "submissions_snapshot_state_check",
      sql`
    (${table.status} = 'draft' AND ${table.submittedAt} IS NULL AND ${table.submittedSnapshotJson} IS NULL)
    OR
    (${table.status} <> 'draft' AND ${table.submittedAt} IS NOT NULL AND ${table.submittedSnapshotJson} IS NOT NULL)
  `,
    ),
    uniqueIndex("submissions_reference_unique").on(
      table.eventId,
      table.publicReference,
    ),
    foreignKey({
      columns: [table.formVersionId, table.eventId],
      foreignColumns: [formVersions.id, formVersions.eventId],
    }),
    index("idx_submissions_event_status").on(
      table.eventId,
      table.status,
      table.updatedAt,
    ),
    index("idx_submissions_event_category_status").on(
      table.eventId,
      table.category,
      table.status,
      desc(table.updatedAt),
    ),
    index("idx_submissions_submitter").on(
      table.eventId,
      table.submitterPersonId,
      table.updatedAt,
    ),
    index("idx_submissions_email").on(
      table.eventId,
      table.submitterEmail,
      table.updatedAt,
    ),
  ],
);

export const submissionRevisions = sqliteTable(
  "submission_revisions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    formVersionId: text("form_version_id")
      .notNull()
      .references(() => formVersions.id),
    revisionNumber: integer("revision_number").notNull(),
    answersJson: text("answers_json").notNull(),
    speakerSnapshotJson: text("speaker_snapshot_json").notNull().default("[]"),
    saveKind: text("save_kind")
      .notNull()
      .default("autosave")
      .$type<"autosave" | "manual" | "submitted" | "withdrawn">(),
    savedByPersonId: text("saved_by_person_id").references(() => people.id),
    idempotencyKey: text("idempotency_key"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("submission_revisions_number_unique").on(
      table.submissionId,
      table.revisionNumber,
    ),
    uniqueIndex("submission_revisions_idempotency_unique").on(
      table.submissionId,
      table.idempotencyKey,
    ),
    index("idx_submission_revisions_submission").on(
      table.submissionId,
      table.revisionNumber,
    ),
  ],
);

export const submissionEmailVerifications = sqliteTable(
  "submission_email_verifications",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    formId: text("form_id")
      .notNull()
      .references(() => formDefinitions.id, { onDelete: "cascade" }),
    submissionId: text("submission_id").references(() => submissions.id, {
      onDelete: "cascade",
    }),
    email: text("email").notNull(),
    tokenHash: text("token_hash").notNull(),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "verified" | "consumed" | "expired" | "revoked">(),
    attemptCount: integer("attempt_count").notNull().default(0),
    expiresAt: integer("expires_at").notNull(),
    verifiedAt: integer("verified_at"),
    consumedAt: integer("consumed_at"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("submission_verification_token_unique").on(table.tokenHash),
    index("idx_submission_verifications_form_email").on(
      table.eventId,
      table.formId,
      table.email,
      table.status,
      table.expiresAt,
    ),
  ],
);

export const submissionSpeakers = sqliteTable(
  "submission_speakers",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    personId: text("person_id").references(() => people.id),
    email: text("email").notNull(),
    displayName: text("display_name").notNull(),
    roleLabel: text("role_label"),
    position: integer("position").notNull(),
    invitationStatus: text("invitation_status")
      .notNull()
      .default("pending")
      .$type<
        "pending" | "sent" | "claimed" | "declined" | "expired" | "revoked"
      >(),
    isPrimary: integer("is_primary", { mode: "boolean" })
      .notNull()
      .default(false),
    claimTokenHash: text("claim_token_hash"),
    invitationExpiresAt: integer("invitation_expires_at"),
    invitedAt: integer("invited_at"),
    claimedAt: integer("claimed_at"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("submission_speakers_position_unique").on(
      table.submissionId,
      table.position,
    ),
    uniqueIndex("submission_speakers_email_unique").on(
      table.submissionId,
      table.email,
    ),
    uniqueIndex("submission_speakers_claim_token_unique").on(
      table.claimTokenHash,
    ),
    index("idx_submission_speakers_person").on(table.eventId, table.personId),
  ],
);

export const evaluationPlans = sqliteTable(
  "evaluation_plans",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "active" | "closed" | "archived">(),
    blindedReviewing: integer("blinded_reviewing", { mode: "boolean" })
      .notNull()
      .default(false),
    decisionRole: text("decision_role")
      .notNull()
      .default("administrator")
      .$type<"administrator" | "committee_chair">(),
    revision: integer("revision").notNull().default(1),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_evaluation_plans_event").on(table.eventId, table.status),
  ],
);

export const evaluationTeams = sqliteTable(
  "evaluation_teams",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    chairPersonId: text("chair_person_id").references(() => people.id),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"active" | "archived">(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("evaluation_teams_event_name_unique").on(
      table.eventId,
      table.name,
    ),
  ],
);

export const evaluationTeamMembers = sqliteTable(
  "evaluation_team_members",
  {
    teamId: text("team_id")
      .notNull()
      .references(() => evaluationTeams.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    role: text("role")
      .notNull()
      .default("evaluator")
      .$type<"chair" | "evaluator">(),
    joinedAt: integer("joined_at").notNull().default(epochNow),
    removedAt: integer("removed_at"),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.personId] }),
    index("idx_team_members_person").on(
      table.eventId,
      table.personId,
      table.removedAt,
    ),
  ],
);

export const evaluationRounds = sqliteTable(
  "evaluation_rounds",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    planId: text("plan_id")
      .notNull()
      .references(() => evaluationPlans.id, { onDelete: "cascade" }),
    roundNumber: integer("round_number").notNull(),
    name: text("name").notNull(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "active" | "closed" | "archived">(),
    opensAt: integer("opens_at"),
    closesAt: integer("closes_at"),
    advancementRuleJson: text("advancement_rule_json").notNull().default("{}"),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("evaluation_rounds_number_unique").on(
      table.planId,
      table.roundNumber,
    ),
    index("idx_evaluation_rounds_active").on(
      table.eventId,
      table.status,
      table.roundNumber,
    ),
  ],
);

export const evaluationCriteria = sqliteTable(
  "evaluation_criteria",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roundId: text("round_id")
      .notNull()
      .references(() => evaluationRounds.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    inputType: text("input_type")
      .notNull()
      .default("scale_5")
      .$type<"scale_5" | "scale_10" | "yes_no" | "free_text">(),
    weightPercent: integer("weight_percent").notNull().default(0),
    required: integer("required", { mode: "boolean" }).notNull().default(true),
    position: integer("position").notNull(),
  },
  (table) => [
    uniqueIndex("evaluation_criteria_position_unique").on(
      table.roundId,
      table.position,
    ),
  ],
);

export const evaluatorConflicts = sqliteTable(
  "evaluator_conflicts",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roundId: text("round_id")
      .notNull()
      .references(() => evaluationRounds.id, { onDelete: "cascade" }),
    submissionId: text("submission_id"),
    sessionId: text("session_id"),
    evaluatorPersonId: text("evaluator_person_id")
      .notNull()
      .references(() => people.id),
    relationship: text("relationship"),
    notes: text("notes"),
    status: text("status")
      .notNull()
      .default("declared")
      .$type<"declared" | "recused" | "waived" | "dismissed">(),
    declaredAt: integer("declared_at").notNull().default(epochNow),
    resolvedByPersonId: text("resolved_by_person_id").references(
      () => people.id,
    ),
    resolvedAt: integer("resolved_at"),
  },
  (table) => [
    check(
      "evaluator_conflicts_exact_target_check",
      sql`(${table.submissionId} IS NOT NULL) <> (${table.sessionId} IS NOT NULL)`,
    ),
    foreignKey({
      columns: [table.submissionId, table.eventId],
      foreignColumns: [submissions.id, submissions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId, table.eventId],
      foreignColumns: [sessions.id, sessions.eventId],
    }).onDelete("cascade"),
    uniqueIndex("ux_evaluator_conflicts_submission")
      .on(table.roundId, table.submissionId, table.evaluatorPersonId)
      .where(sql`${table.submissionId} IS NOT NULL`),
    uniqueIndex("ux_evaluator_conflicts_session")
      .on(table.roundId, table.sessionId, table.evaluatorPersonId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    index("idx_evaluator_conflicts_open").on(
      table.eventId,
      table.evaluatorPersonId,
      table.status,
    ),
  ],
);

export const evaluatorAssignments = sqliteTable(
  "evaluator_assignments",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roundId: text("round_id")
      .notNull()
      .references(() => evaluationRounds.id, { onDelete: "cascade" }),
    submissionId: text("submission_id"),
    sessionId: text("session_id"),
    sessionSnapshotJson: text("session_snapshot_json"),
    evaluatorPersonId: text("evaluator_person_id")
      .notNull()
      .references(() => people.id),
    teamId: text("team_id").references(() => evaluationTeams.id),
    status: text("status")
      .notNull()
      .default("assigned")
      .$type<
        | "assigned"
        | "in_progress"
        | "submitted"
        | "recused"
        | "reopened"
        | "cancelled"
      >(),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    dueAt: integer("due_at"),
    conflictDeclaredAt: integer("conflict_declared_at"),
    assignedAt: integer("assigned_at").notNull().default(epochNow),
    submittedAt: integer("submitted_at"),
  },
  (table) => [
    check(
      "evaluator_assignments_exact_target_check",
      sql`(
        (${table.submissionId} IS NOT NULL AND ${table.sessionId} IS NULL AND ${table.sessionSnapshotJson} IS NULL)
        OR
        (${table.submissionId} IS NULL AND ${table.sessionId} IS NOT NULL AND ${table.sessionSnapshotJson} IS NOT NULL AND json_valid(${table.sessionSnapshotJson}))
      )`,
    ),
    foreignKey({
      columns: [table.submissionId, table.eventId],
      foreignColumns: [submissions.id, submissions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.sessionId, table.eventId],
      foreignColumns: [sessions.id, sessions.eventId],
    }).onDelete("cascade"),
    uniqueIndex("ux_evaluator_assignments_submission")
      .on(table.roundId, table.submissionId, table.evaluatorPersonId)
      .where(sql`${table.submissionId} IS NOT NULL`),
    uniqueIndex("ux_evaluator_assignments_session")
      .on(table.roundId, table.sessionId, table.evaluatorPersonId)
      .where(sql`${table.sessionId} IS NOT NULL`),
    index("idx_assignments_evaluator_status").on(
      table.eventId,
      table.evaluatorPersonId,
      table.status,
      table.dueAt,
    ),
    index("idx_assignments_submission").on(
      table.eventId,
      table.submissionId,
      table.roundId,
    ),
    index("idx_assignments_session").on(
      table.eventId,
      table.sessionId,
      table.roundId,
    ),
  ],
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    assignmentId: text("assignment_id")
      .notNull()
      .references(() => evaluatorAssignments.id, { onDelete: "cascade" }),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "submitted" | "locked" | "reopened">(),
    scoresJson: text("scores_json").notNull().default("{}"),
    weightedScore: real("weighted_score"),
    recommendation: text("recommendation").$type<
      "accept" | "minor_changes" | "conditional_accept" | "waitlist" | "reject"
    >(),
    confidence: integer("confidence"),
    submitterFeedback: text("submitter_feedback"),
    privateNotes: text("private_notes"),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
    submittedAt: integer("submitted_at"),
    lockedAt: integer("locked_at"),
  },
  (table) => [
    uniqueIndex("reviews_assignment_unique").on(table.assignmentId),
    index("idx_reviews_status").on(
      table.eventId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const reviewRevisions = sqliteTable(
  "review_revisions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    reviewId: text("review_id")
      .notNull()
      .references(() => reviews.id, { onDelete: "cascade" }),
    revisionNumber: integer("revision_number").notNull(),
    scoresJson: text("scores_json").notNull(),
    contentJson: text("content_json").notNull().default("{}"),
    saveKind: text("save_kind")
      .notNull()
      .default("autosave")
      .$type<"autosave" | "manual" | "submitted" | "reopened">(),
    savedByPersonId: text("saved_by_person_id")
      .notNull()
      .references(() => people.id),
    idempotencyKey: text("idempotency_key"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("review_revisions_number_unique").on(
      table.reviewId,
      table.revisionNumber,
    ),
    uniqueIndex("review_revisions_idempotency_unique").on(
      table.reviewId,
      table.idempotencyKey,
    ),
  ],
);

export const reviewModerations = sqliteTable(
  "review_moderations",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    roundId: text("round_id")
      .notNull()
      .references(() => evaluationRounds.id, { onDelete: "cascade" }),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    moderatorPersonId: text("moderator_person_id")
      .notNull()
      .references(() => people.id),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "confirmed" | "superseded">(),
    recommendation: text("recommendation").$type<
      "accept" | "waitlist" | "reject" | "advance"
    >(),
    moderatedScore: real("moderated_score"),
    notes: text("notes"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
    confirmedAt: integer("confirmed_at"),
  },
  (table) => [
    uniqueIndex("ux_review_moderations_current")
      .on(table.roundId, table.submissionId)
      .where(sql`${table.status} IN ('draft','confirmed')`),
  ],
);

export const submissionDecisions = sqliteTable(
  "submission_decisions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    submissionId: text("submission_id")
      .notNull()
      .references(() => submissions.id, { onDelete: "cascade" }),
    roundId: text("round_id").references(() => evaluationRounds.id),
    revisionNumber: integer("revision_number").notNull().default(1),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "published" | "superseded" | "revoked">(),
    decision: text("decision")
      .notNull()
      .$type<"accepted" | "rejected" | "waitlisted">(),
    decidedByPersonId: text("decided_by_person_id")
      .notNull()
      .references(() => people.id),
    rationale: text("rationale"),
    notificationFeedbackJson: text("notification_feedback_json").notNull(),
    effectPreviewJson: text("effect_preview_json").notNull().default("{}"),
    idempotencyKey: text("idempotency_key"),
    decidedAt: integer("decided_at").notNull().default(epochNow),
    publishedAt: integer("published_at"),
  },
  (table) => [
    uniqueIndex("submission_decisions_revision_unique").on(
      table.submissionId,
      table.revisionNumber,
    ),
    uniqueIndex("submission_decisions_idempotency_unique").on(
      table.eventId,
      table.idempotencyKey,
    ),
    uniqueIndex("ux_decisions_one_published")
      .on(table.submissionId)
      .where(sql`${table.status} = 'published'`),
  ],
);

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

export const submissionRoutingTeams = sqliteTable(
  "submission_routing_teams",
  {
    submissionId: text("submission_id").notNull(),
    eventId: text("event_id").notNull(),
    teamId: text("team_id").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.submissionId, table.teamId] }),
    index("idx_submission_routing_teams_event").on(
      table.eventId,
      table.teamId,
      table.submissionId,
    ),
    foreignKey({
      columns: [table.submissionId, table.eventId],
      foreignColumns: [submissions.id, submissions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.teamId, table.eventId],
      foreignColumns: [evaluationTeams.id, evaluationTeams.eventId],
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
  minimumTurnaroundMinutes: integer("minimum_turnaround_minutes")
    .notNull()
    .default(0),
  revision: integer("revision").notNull().default(1),
  updatedAt: integer("updated_at").notNull().default(epochNow),
});

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

export const sessionArchives = sqliteTable(
  "session_archives",
  {
    sessionId: text("session_id").primaryKey(),
    eventId: text("event_id").notNull(),
    previousStatus: text("previous_status")
      .notNull()
      .$type<"unscheduled" | "cancelled">(),
    archivedByPersonId: text("archived_by_person_id")
      .notNull()
      .references(() => people.id),
    archiveOperationId: text("archive_operation_id").notNull(),
    archivedAt: integer("archived_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.sessionId, table.eventId],
      foreignColumns: [sessions.id, sessions.eventId],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.archiveOperationId, table.eventId],
      foreignColumns: [operationJobs.id, operationJobs.eventId],
    }),
    index("idx_session_archives_event").on(
      table.eventId,
      desc(table.archivedAt),
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

export const taskTemplates = sqliteTable(
  "task_templates",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    description: text("description"),
    targetType: text("target_type")
      .notNull()
      .$type<"speaker" | "session" | "event">(),
    taskType: text("task_type")
      .notNull()
      .default("checklist")
      .$type<
        | "checklist"
        | "acknowledgement"
        | "short_form"
        | "file_upload"
        | "link_visit"
        | "administrator_only"
      >(),
    impact: text("impact")
      .notNull()
      .$type<"critical" | "high" | "medium" | "low">(),
    evidenceMode: text("evidence_mode")
      .notNull()
      .default("none")
      .$type<
        "none" | "checkbox" | "file" | "text" | "link" | "admin_approval"
      >(),
    dueAnchor: text("due_anchor")
      .notNull()
      .default("none")
      .$type<"none" | "acceptance" | "session_start" | "fixed">(),
    dueOffsetMinutes: integer("due_offset_minutes"),
    fixedDueAt: integer("fixed_due_at"),
    autoAssignOnAcceptance: integer("auto_assign_on_acceptance", {
      mode: "boolean",
    }).notNull(),
    configurationJson: text("configuration_json").notNull().default("{}"),
    status: text("status")
      .notNull()
      .default("active")
      .$type<"active" | "archived">(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    check(
      "task_templates_fixed_due_check",
      sql`${table.dueAnchor} <> 'fixed' OR ${table.fixedDueAt} IS NOT NULL`,
    ),
    check(
      "task_templates_relative_due_check",
      sql`${table.dueAnchor} NOT IN ('acceptance','session_start') OR ${table.dueOffsetMinutes} IS NOT NULL`,
    ),
    check(
      "task_templates_auto_assign_check",
      sql`${table.autoAssignOnAcceptance} = 0 OR ${table.dueAnchor} <> 'session_start'`,
    ),
  ],
);

export const taskTemplateDependencies = sqliteTable(
  "task_template_dependencies",
  {
    templateId: text("template_id")
      .notNull()
      .references(() => taskTemplates.id, { onDelete: "cascade" }),
    dependsOnTemplateId: text("depends_on_template_id")
      .notNull()
      .references(() => taskTemplates.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    primaryKey({ columns: [table.templateId, table.dependsOnTemplateId] }),
  ],
);

export const taskInstances = sqliteTable(
  "task_instances",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    templateId: text("template_id").references(() => taskTemplates.id),
    targetType: text("target_type")
      .notNull()
      .$type<"speaker" | "session" | "event">(),
    targetId: text("target_id").notNull(),
    ownerPersonId: text("owner_person_id").references(() => people.id),
    title: text("title").notNull(),
    description: text("description"),
    taskType: text("task_type")
      .notNull()
      .default("checklist")
      .$type<
        | "checklist"
        | "acknowledgement"
        | "short_form"
        | "file_upload"
        | "link_visit"
        | "administrator_only"
      >(),
    impact: text("impact")
      .notNull()
      .$type<"critical" | "high" | "medium" | "low">(),
    status: text("status")
      .notNull()
      .default("not_started")
      .$type<
        | "not_started"
        | "in_progress"
        | "blocked"
        | "submitted"
        | "completed"
        | "waived"
        | "overdue"
      >(),
    readinessState: text("readiness_state")
      .notNull()
      .default("on_track")
      .$type<"on_track" | "at_risk" | "overdue" | "blocked">(),
    readinessPercent: integer("readiness_percent").notNull().default(0),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    idempotencyKey: text("idempotency_key"),
    dueAt: integer("due_at"),
    evidenceJson: text("evidence_json"),
    waiverJson: text("waiver_json"),
    submittedAt: integer("submitted_at"),
    completedAt: integer("completed_at"),
    completedByPersonId: text("completed_by_person_id").references(
      () => people.id,
    ),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_tasks_event_status_due").on(
      table.eventId,
      table.status,
      table.dueAt,
    ),
    index("idx_tasks_target").on(
      table.eventId,
      table.targetType,
      table.targetId,
      table.status,
    ),
    index("idx_tasks_owner_status").on(
      table.eventId,
      table.ownerPersonId,
      table.status,
    ),
    uniqueIndex("ux_task_instances_template_target")
      .on(table.eventId, table.templateId, table.targetType, table.targetId)
      .where(sql`${table.templateId} IS NOT NULL`),
    uniqueIndex("idx_task_idempotency")
      .on(table.eventId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} IS NOT NULL`),
  ],
);

export const taskInstanceDependencies = sqliteTable(
  "task_instance_dependencies",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => taskInstances.id, { onDelete: "cascade" }),
    dependsOnTaskId: text("depends_on_task_id")
      .notNull()
      .references(() => taskInstances.id, { onDelete: "cascade" }),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [primaryKey({ columns: [table.taskId, table.dependsOnTaskId] })],
);

export const taskComments = sqliteTable(
  "task_comments",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => taskInstances.id, { onDelete: "cascade" }),
    authorPersonId: text("author_person_id")
      .notNull()
      .references(() => people.id),
    body: text("body").notNull(),
    visibility: text("visibility")
      .notNull()
      .default("participant")
      .$type<"participant" | "administrator">(),
    createdAt: integer("created_at").notNull().default(epochNow),
    editedAt: integer("edited_at"),
  },
  (table) => [
    index("idx_task_comments_task").on(table.taskId, table.createdAt),
  ],
);

export const fileAssets = sqliteTable(
  "file_assets",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    ownerPersonId: text("owner_person_id").references(() => people.id),
    targetType: text("target_type")
      .notNull()
      .$type<"person" | "submission" | "session" | "task" | "resource">(),
    targetId: text("target_id").notNull(),
    assetKind: text("asset_kind")
      .notNull()
      .$type<
        | "headshot"
        | "slides"
        | "video"
        | "supporting_document"
        | "resource_attachment"
        | "task_evidence"
        | "other"
      >(),
    currentVersionId: text("current_version_id"),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "active" | "rejected" | "deleted">(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_files_target").on(
      table.eventId,
      table.targetType,
      table.targetId,
      table.status,
    ),
    index("idx_files_owner_status").on(
      table.eventId,
      table.ownerPersonId,
      table.status,
    ),
    uniqueIndex("ux_file_assets_logical_active")
      .on(
        table.eventId,
        table.ownerPersonId,
        table.targetType,
        table.targetId,
        table.assetKind,
      )
      .where(
        sql`${table.status} <> 'deleted' AND ${table.targetType} NOT IN ('task','resource')`,
      ),
    uniqueIndex("ux_file_assets_current_version")
      .on(table.currentVersionId)
      .where(sql`${table.currentVersionId} IS NOT NULL`),
  ],
);

export const fileVersions = sqliteTable(
  "file_versions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").notNull(),
    assetId: text("asset_id").notNull(),
    versionNumber: integer("version_number").notNull(),
    objectKey: text("object_key").notNull(),
    multipartUploadId: text("multipart_upload_id"),
    originalFilename: text("original_filename").notNull(),
    declaredContentType: text("declared_content_type").notNull(),
    detectedContentType: text("detected_content_type"),
    sizeBytes: integer("size_bytes").notNull(),
    checksumSha256: text("checksum_sha256"),
    objectEtag: text("object_etag"),
    uploadStatus: text("upload_status")
      .notNull()
      .default("requested")
      .$type<"requested" | "uploading" | "uploaded" | "failed" | "aborted">(),
    signatureStatus: text("signature_status")
      .notNull()
      .default("pending")
      .$type<"pending" | "valid" | "invalid" | "failed">(),
    scanStatus: text("scan_status")
      .notNull()
      .default("pending")
      .$type<"pending" | "clean" | "infected" | "failed">(),
    scanProvider: text("scan_provider"),
    scanResultJson: text("scan_result_json"),
    scanError: text("scan_error"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    uploadedAt: integer("uploaded_at"),
    scannedAt: integer("scanned_at"),
    releasedAt: integer("released_at"),
    replacedAt: integer("replaced_at"),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    foreignKey({
      columns: [table.assetId, table.eventId],
      foreignColumns: [fileAssets.id, fileAssets.eventId],
    }).onDelete("cascade"),
    uniqueIndex("file_versions_asset_version_unique").on(
      table.assetId,
      table.versionNumber,
    ),
    uniqueIndex("file_versions_id_event_asset_unique").on(
      table.id,
      table.eventId,
      table.assetId,
    ),
    uniqueIndex("file_versions_object_key_unique").on(table.objectKey),
    index("idx_file_versions_release").on(
      table.assetId,
      table.scanStatus,
      table.releasedAt,
      table.versionNumber,
    ),
  ],
);

export const fileMultipartUploads = sqliteTable(
  "file_multipart_uploads",
  {
    versionId: text("version_id").primaryKey(),
    eventId: text("event_id").notNull(),
    assetId: text("asset_id").notNull(),
    uploadId: text("upload_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status")
      .notNull()
      .default("requested")
      .$type<
        | "requested"
        | "initiated"
        | "completing"
        | "completed"
        | "aborted"
        | "failed"
      >(),
    partSizeBytes: integer("part_size_bytes").notNull(),
    manifestJson: text("manifest_json"),
    manifestHash: text("manifest_hash"),
    expiresAt: integer("expires_at").notNull(),
    lastError: text("last_error"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.versionId, table.eventId, table.assetId],
      foreignColumns: [
        fileVersions.id,
        fileVersions.eventId,
        fileVersions.assetId,
      ],
    }).onDelete("cascade"),
    foreignKey({
      columns: [table.assetId, table.eventId],
      foreignColumns: [fileAssets.id, fileAssets.eventId],
    }).onDelete("cascade"),
    uniqueIndex("ux_file_multipart_upload_id").on(table.uploadId),
    uniqueIndex("ux_file_multipart_idempotency").on(
      table.eventId,
      table.idempotencyKey,
    ),
    index("idx_file_multipart_status_expiry").on(table.status, table.expiresAt),
  ],
);

export const taskEvidence = sqliteTable(
  "task_evidence",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    taskId: text("task_id")
      .notNull()
      .references(() => taskInstances.id, { onDelete: "cascade" }),
    submittedByPersonId: text("submitted_by_person_id")
      .notNull()
      .references(() => people.id),
    fileAssetId: text("file_asset_id").references(() => fileAssets.id),
    evidenceJson: text("evidence_json").notNull().default("{}"),
    status: text("status")
      .notNull()
      .default("submitted")
      .$type<"submitted" | "approved" | "rejected" | "superseded">(),
    reviewedByPersonId: text("reviewed_by_person_id").references(
      () => people.id,
    ),
    createdAt: integer("created_at").notNull().default(epochNow),
    reviewedAt: integer("reviewed_at"),
  },
  (table) => [
    index("idx_task_evidence_task").on(
      table.taskId,
      table.status,
      table.createdAt,
    ),
  ],
);

export const resourcePages = sqliteTable(
  "resource_pages",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    category: text("category"),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "published" | "archived">(),
    audienceScope: text("audience_scope")
      .notNull()
      .default("all_speakers")
      .$type<"all_speakers" | "accepted_speakers" | "custom">(),
    acknowledgementRequired: integer("acknowledgement_required", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
    archivedAt: integer("archived_at"),
  },
  (table) => [
    uniqueIndex("resource_pages_event_slug_unique").on(
      table.eventId,
      table.slug,
    ),
    index("idx_resource_pages_audience").on(
      table.eventId,
      table.status,
      table.audienceScope,
    ),
  ],
);

export const resourcePageVersions = sqliteTable(
  "resource_page_versions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    resourcePageId: text("resource_page_id")
      .notNull()
      .references(() => resourcePages.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    title: text("title").notNull(),
    slug: text("slug").notNull(),
    category: text("category"),
    audienceScope: text("audience_scope")
      .notNull()
      .default("all_speakers")
      .$type<"all_speakers" | "accepted_speakers" | "custom">(),
    acknowledgementRequired: integer("acknowledgement_required", {
      mode: "boolean",
    })
      .notNull()
      .default(false),
    documentJson: text("document_json").notNull(),
    renderedHtml: text("rendered_html").notNull(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "published" | "retired">(),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    publishedAt: integer("published_at"),
  },
  (table) => [
    uniqueIndex("resource_page_versions_number_unique").on(
      table.resourcePageId,
      table.versionNumber,
    ),
    uniqueIndex("ux_resource_versions_one_published")
      .on(table.resourcePageId)
      .where(sql`${table.status} = 'published'`),
  ],
);

export const resourceAudiences = sqliteTable(
  "resource_audiences",
  {
    resourcePageVersionId: text("resource_page_version_id")
      .notNull()
      .references(() => resourcePageVersions.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    targetType: text("target_type")
      .notNull()
      .$type<"role" | "team" | "person" | "session" | "track">(),
    targetId: text("target_id").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    primaryKey({
      columns: [table.resourcePageVersionId, table.targetType, table.targetId],
    }),
  ],
);

export const resourceAttachments = sqliteTable(
  "resource_attachments",
  {
    resourcePageVersionId: text("resource_page_version_id")
      .notNull()
      .references(() => resourcePageVersions.id, { onDelete: "cascade" }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    fileAssetId: text("file_asset_id")
      .notNull()
      .references(() => fileAssets.id),
    position: integer("position").notNull().default(0),
    label: text("label"),
  },
  (table) => [
    primaryKey({ columns: [table.resourcePageVersionId, table.fileAssetId] }),
  ],
);

export const resourceAcknowledgements = sqliteTable(
  "resource_acknowledgements",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    resourcePageId: text("resource_page_id")
      .notNull()
      .references(() => resourcePages.id, { onDelete: "cascade" }),
    resourcePageVersionId: text("resource_page_version_id")
      .notNull()
      .references(() => resourcePageVersions.id),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    acknowledgedAt: integer("acknowledged_at").notNull().default(epochNow),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("resource_acknowledgements_person_unique").on(
      table.resourcePageVersionId,
      table.personId,
    ),
    index("idx_resource_ack_person").on(
      table.eventId,
      table.personId,
      table.acknowledgedAt,
    ),
  ],
);

export const senderProfiles = sqliteTable(
  "sender_profiles",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    fromName: text("from_name").notNull(),
    fromEmail: text("from_email").notNull(),
    replyToEmail: text("reply_to_email"),
    provider: text("provider").notNull().$type<"resend" | "mailpit">(),
    providerSenderId: text("provider_sender_id"),
    status: text("status")
      .notNull()
      .default("unverified")
      .$type<"unverified" | "verified" | "disabled">(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("sender_profiles_event_name_unique").on(
      table.eventId,
      table.name,
    ),
  ],
);

export const communicationTemplates = sqliteTable(
  "communication_templates",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    category: text("category")
      .notNull()
      .$type<
        | "submission_confirmation"
        | "decision"
        | "task_reminder"
        | "schedule"
        | "calendar"
        | "ad_hoc"
      >(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "active" | "archived">(),
    lastOperationId: text("last_operation_id"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_templates_event_status").on(
      table.eventId,
      table.status,
      table.category,
    ),
  ],
);

export const communicationTemplateVersions = sqliteTable(
  "communication_template_versions",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    templateId: text("template_id")
      .notNull()
      .references(() => communicationTemplates.id, { onDelete: "cascade" }),
    versionNumber: integer("version_number").notNull(),
    name: text("name").notNull(),
    category: text("category")
      .notNull()
      .$type<
        | "submission_confirmation"
        | "decision"
        | "task_reminder"
        | "schedule"
        | "calendar"
        | "ad_hoc"
      >(),
    channel: text("channel")
      .notNull()
      .$type<"email" | "sms" | "push" | "calendar">(),
    subjectTemplate: text("subject_template"),
    contentJson: text("content_json").notNull(),
    renderedPreviewHtml: text("rendered_preview_html"),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<"draft" | "published" | "retired">(),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    publishedAt: integer("published_at"),
  },
  (table) => [
    check(
      "communication_template_versions_email_subject_check",
      sql`${table.channel} <> 'email' OR (${table.subjectTemplate} IS NOT NULL AND ${table.subjectTemplate} = trim(${table.subjectTemplate}) AND length(${table.subjectTemplate}) BETWEEN 1 AND 200)`,
    ),
    uniqueIndex("communication_template_versions_number_unique").on(
      table.templateId,
      table.versionNumber,
      table.channel,
    ),
    uniqueIndex("ux_template_channel_one_published")
      .on(table.templateId, table.channel)
      .where(sql`${table.status} = 'published'`),
  ],
);

export const communicationTriggers = sqliteTable(
  "communication_triggers",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    templateId: text("template_id")
      .notNull()
      .references(() => communicationTemplates.id, { onDelete: "cascade" }),
    triggerType: text("trigger_type")
      .notNull()
      .$type<
        | "submission_confirmed"
        | "decision_published"
        | "task_due"
        | "task_overdue"
        | "schedule_published"
        | "manual"
      >(),
    configurationJson: text("configuration_json").notNull().default("{}"),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("communication_triggers_unique").on(
      table.eventId,
      table.triggerType,
      table.templateId,
    ),
  ],
);

export const communications = sqliteTable(
  "communications",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    templateVersionId: text("template_version_id").references(
      () => communicationTemplateVersions.id,
    ),
    senderProfileId: text("sender_profile_id").references(
      () => senderProfiles.id,
    ),
    operationId: text("operation_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    kind: text("kind")
      .notNull()
      .default("transactional")
      .$type<"transactional" | "optional">(),
    channel: text("channel")
      .notNull()
      .default("email")
      .$type<"email" | "sms" | "push" | "calendar">(),
    status: text("status")
      .notNull()
      .default("draft")
      .$type<
        | "draft"
        | "scheduled"
        | "queued"
        | "sending"
        | "sent"
        | "partially_failed"
        | "failed"
        | "cancelled"
      >(),
    revision: integer("revision").notNull().default(1),
    audienceJson: text("audience_json").notNull(),
    contentSnapshotJson: text("content_snapshot_json").notNull(),
    recipientCount: integer("recipient_count").notNull().default(0),
    scheduledAt: integer("scheduled_at"),
    queuedAt: integer("queued_at"),
    sentAt: integer("sent_at"),
    cancelledAt: integer("cancelled_at"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("communications_idempotency_unique").on(
      table.eventId,
      table.idempotencyKey,
    ),
    index("idx_communications_status_schedule").on(
      table.eventId,
      table.status,
      table.scheduledAt,
    ),
  ],
);

export const communicationDeliveries = sqliteTable(
  "communication_deliveries",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    communicationId: text("communication_id")
      .notNull()
      .references(() => communications.id, { onDelete: "cascade" }),
    personId: text("person_id").references(() => people.id),
    recipientAddress: text("recipient_address").notNull(),
    recipientName: text("recipient_name"),
    sourceId: text("source_id"),
    sourceValuesJson: text("source_values_json").notNull().default("{}"),
    channel: text("channel")
      .notNull()
      .$type<"email" | "sms" | "push" | "calendar">(),
    provider: text("provider"),
    providerMessageId: text("provider_message_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status")
      .notNull()
      .default("queued")
      .$type<
        | "queued"
        | "sending"
        | "sent"
        | "delivered"
        | "opened"
        | "clicked"
        | "bounced"
        | "suppressed"
        | "failed"
        | "cancelled"
      >(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    failureCode: text("failure_code"),
    failureMessage: text("failure_message"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("communication_deliveries_idempotency_unique").on(
      table.communicationId,
      table.idempotencyKey,
    ),
    index("idx_deliveries_communication_status").on(
      table.communicationId,
      table.status,
      table.nextAttemptAt,
    ),
    index("idx_deliveries_provider_message").on(
      table.provider,
      table.providerMessageId,
    ),
  ],
);

export const communicationDeliveryEvents = sqliteTable(
  "communication_delivery_events",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => communicationDeliveries.id, { onDelete: "cascade" }),
    providerEventId: text("provider_event_id"),
    eventType: text("event_type").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    occurredAt: integer("occurred_at").notNull(),
    receivedAt: integer("received_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("communication_delivery_events_provider_unique").on(
      table.deliveryId,
      table.providerEventId,
    ),
  ],
);

export const communicationUnsubscribes = sqliteTable(
  "communication_unsubscribes",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    personId: text("person_id").references(() => people.id),
    address: text("address").notNull(),
    category: text("category").notNull(),
    reason: text("reason"),
    createdAt: integer("created_at").notNull().default(epochNow),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("communication_unsubscribes_unique").on(
      table.eventId,
      table.address,
      table.category,
    ),
  ],
);

export const calendarConnections = sqliteTable(
  "calendar_connections",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    eventId: text("event_id"),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    provider: text("provider").notNull().$type<"google" | "microsoft">(),
    accountReference: text("account_reference").notNull(),
    encryptedCredentials: text("encrypted_credentials"),
    scopesJson: text("scopes_json").notNull(),
    status: text("status")
      .notNull()
      .default("connected")
      .$type<"connected" | "needs_attention" | "revoked" | "disconnected">(),
    expiresAt: integer("expires_at"),
    lastSyncedAt: integer("last_synced_at"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    check(
      "calendar_connections_connected_credentials_check",
      sql`${table.status} <> 'connected' OR (${table.encryptedCredentials} IS NOT NULL AND ${table.expiresAt} IS NOT NULL)`,
    ),
    foreignKey({
      columns: [table.eventId, table.organisationId],
      foreignColumns: [events.id, events.organisationId],
    }).onDelete("cascade"),
    uniqueIndex("calendar_connections_account_unique").on(
      table.personId,
      table.provider,
      table.accountReference,
    ),
  ],
);

export const calendarInvitations = sqliteTable(
  "calendar_invitations",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    connectionId: text("connection_id").references(
      () => calendarConnections.id,
    ),
    deliveryId: text("delivery_id").references(
      () => communicationDeliveries.id,
    ),
    icalUid: text("ical_uid").notNull(),
    sequenceNumber: integer("sequence_number").notNull().default(0),
    method: text("method")
      .notNull()
      .default("REQUEST")
      .$type<"REQUEST" | "CANCEL">(),
    providerEventId: text("provider_event_id"),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<
        "pending" | "queued" | "sent" | "confirmed" | "cancelled" | "failed"
      >(),
    lastPayloadHash: text("last_payload_hash"),
    currentAttemptId: text("current_attempt_id"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("calendar_invitations_uid_unique").on(
      table.eventId,
      table.icalUid,
    ),
    uniqueIndex("calendar_invitations_session_person_unique").on(
      table.sessionId,
      table.personId,
    ),
    index("idx_calendar_invitation_status").on(
      table.eventId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const calendarSyncAttempts = sqliteTable(
  "calendar_sync_attempts",
  {
    id: text("id").primaryKey(),
    invitationId: text("invitation_id")
      .notNull()
      .references(() => calendarInvitations.id, { onDelete: "cascade" }),
    sequenceNumber: integer("sequence_number").notNull(),
    method: text("method").notNull().$type<"REQUEST" | "CANCEL">(),
    provider: text("provider")
      .notNull()
      .$type<"email_ics" | "google" | "microsoft">(),
    status: text("status")
      .notNull()
      .$type<"queued" | "running" | "succeeded" | "failed" | "superseded">(),
    providerEventId: text("provider_event_id"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("calendar_sync_attempts_sequence_unique").on(
      table.invitationId,
      table.sequenceNumber,
      table.provider,
    ),
    index("idx_calendar_attempt_status").on(table.status, table.createdAt),
  ],
);

export const integrationConnections = sqliteTable(
  "integration_connections",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    eventId: text("event_id"),
    provider: text("provider").notNull(),
    status: text("status")
      .notNull()
      .$type<"connected" | "needs_attention" | "failed" | "disconnected">(),
    direction: text("direction")
      .notNull()
      .$type<"outbound" | "inbound" | "bidirectional">(),
    conflictPolicy: text("conflict_policy"),
    encryptedCredentials: text("encrypted_credentials"),
    configurationJson: text("configuration_json").notNull().default("{}"),
    revision: integer("revision").notNull().default(1),
    lastOperationId: text("last_operation_id"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    foreignKey({
      columns: [table.eventId, table.organisationId],
      foreignColumns: [events.id, events.organisationId],
    }).onDelete("cascade"),
    uniqueIndex("ux_integration_connections_event_provider")
      .on(table.eventId, table.provider)
      .where(sql`${table.eventId} IS NOT NULL`),
  ],
);

export const integrationRuns = sqliteTable(
  "integration_runs",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    operationId: text("operation_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    status: text("status")
      .notNull()
      .$type<
        | "queued"
        | "running"
        | "succeeded"
        | "partially_failed"
        | "failed"
        | "cancelled"
      >(),
    direction: text("direction")
      .notNull()
      .$type<"outbound" | "inbound" | "bidirectional">(),
    dryRun: integer("dry_run", { mode: "boolean" }).notNull().default(false),
    summaryJson: text("summary_json").notNull().default("{}"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("integration_runs_idempotency_unique").on(
      table.connectionId,
      table.idempotencyKey,
    ),
    index("idx_integration_runs_connection").on(
      table.connectionId,
      table.createdAt,
    ),
  ],
);

export const integrationRunItems = sqliteTable(
  "integration_run_items",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => integrationRuns.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    externalId: text("external_id"),
    action: text("action")
      .notNull()
      .$type<"create" | "update" | "delete" | "skip" | "noop">(),
    status: text("status")
      .notNull()
      .$type<"pending" | "running" | "succeeded" | "failed" | "skipped">(),
    diffJson: text("diff_json").notNull().default("{}"),
    attemptCount: integer("attempt_count").notNull().default(0),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("integration_run_items_entity_unique").on(
      table.runId,
      table.entityType,
      table.entityId,
    ),
    index("idx_integration_items_status").on(table.runId, table.status),
  ],
);

export const integrationEntityMappings = sqliteTable(
  "integration_entity_mappings",
  {
    id: text("id").primaryKey(),
    connectionId: text("connection_id")
      .notNull()
      .references(() => integrationConnections.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    externalId: text("external_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    lastOperationId: text("last_operation_id"),
    lastSyncedAt: integer("last_synced_at").notNull().default(epochNow),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("integration_mappings_entity_unique").on(
      table.connectionId,
      table.entityType,
      table.entityId,
    ),
    uniqueIndex("integration_mappings_external_unique").on(
      table.connectionId,
      table.entityType,
      table.externalId,
    ),
  ],
);

export const operationJobs = sqliteTable(
  "operation_jobs",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").references(() => organisations.id, {
      onDelete: "cascade",
    }),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "cascade",
    }),
    requestedByPersonId: text("requested_by_person_id").references(
      () => people.id,
    ),
    type: text("type").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    correlationId: text("correlation_id").notNull(),
    status: text("status")
      .notNull()
      .$type<
        | "queued"
        | "queue_failed"
        | "received"
        | "running"
        | "retrying"
        | "completed"
        | "partially_failed"
        | "failed"
        | "cancelled"
      >(),
    payloadJson: text("payload_json").notNull(),
    resultJson: text("result_json"),
    progressTotal: integer("progress_total").notNull().default(0),
    progressCompleted: integer("progress_completed").notNull().default(0),
    progressFailed: integer("progress_failed").notNull().default(0),
    attemptCount: integer("attempt_count").notNull().default(0),
    lastError: text("last_error"),
    cancellable: integer("cancellable", { mode: "boolean" })
      .notNull()
      .default(false),
    claimToken: text("claim_token"),
    claimExpiresAt: integer("claim_expires_at"),
    dispatchedAt: integer("dispatched_at"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("operation_jobs_idempotency_unique").on(
      table.eventId,
      table.idempotencyKey,
    ),
    uniqueIndex("operation_jobs_correlation_unique").on(table.correlationId),
    uniqueIndex("operation_jobs_id_event_unique").on(table.id, table.eventId),
    index("idx_operation_jobs_event_status").on(
      table.eventId,
      table.status,
      table.createdAt,
    ),
    index("idx_operation_jobs_undispatched").on(
      table.type,
      table.status,
      table.dispatchedAt,
      table.createdAt,
    ),
  ],
);

export const operationItems = sqliteTable(
  "operation_items",
  {
    id: text("id").primaryKey(),
    operationId: text("operation_id")
      .notNull()
      .references(() => operationJobs.id, { onDelete: "cascade" }),
    itemKey: text("item_key").notNull(),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    status: text("status")
      .notNull()
      .default("pending")
      .$type<"pending" | "running" | "completed" | "failed" | "skipped">(),
    attemptCount: integer("attempt_count").notNull().default(0),
    resultJson: text("result_json"),
    errorCode: text("error_code"),
    errorMessage: text("error_message"),
    startedAt: integer("started_at"),
    completedAt: integer("completed_at"),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("operation_items_key_unique").on(
      table.operationId,
      table.itemKey,
    ),
    index("idx_operation_items_status").on(
      table.operationId,
      table.status,
      table.updatedAt,
    ),
  ],
);

export const eventChanges = sqliteTable(
  "event_changes",
  {
    sequence: integer("sequence").primaryKey({ autoIncrement: true }),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    changeType: text("change_type")
      .notNull()
      .$type<"created" | "updated" | "deleted" | "published" | "progress">(),
    correlationId: text("correlation_id"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_event_changes_cursor").on(table.eventId, table.sequence),
  ],
);

export const savedViews = sqliteTable(
  "saved_views",
  {
    id: text("id").primaryKey(),
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    ownerPersonId: text("owner_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    area: text("area")
      .notNull()
      .$type<
        | "submissions"
        | "evaluations"
        | "speakers"
        | "sessions"
        | "tasks"
        | "operations"
      >(),
    name: text("name").notNull(),
    queryJson: text("query_json").notNull(),
    visibility: text("visibility")
      .notNull()
      .default("private")
      .$type<"private" | "event">(),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("saved_views_name_unique").on(
      table.eventId,
      table.ownerPersonId,
      table.area,
      table.name,
    ),
    index("idx_saved_views_owner").on(
      table.eventId,
      table.ownerPersonId,
      table.area,
    ),
  ],
);

export const idempotencyRecords = sqliteTable(
  "idempotency_records",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "cascade",
    }),
    actorId: text("actor_id").notNull(),
    scope: text("scope").notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    status: text("status")
      .notNull()
      .default("processing")
      .$type<"processing" | "completed" | "failed">(),
    responseStatus: integer("response_status"),
    responseJson: text("response_json"),
    entityType: text("entity_type"),
    entityId: text("entity_id"),
    expiresAt: integer("expires_at").notNull(),
    createdAt: integer("created_at").notNull().default(epochNow),
    completedAt: integer("completed_at"),
  },
  (table) => [
    uniqueIndex("ux_idempotency_event")
      .on(table.eventId, table.actorId, table.scope, table.idempotencyKey)
      .where(sql`${table.eventId} IS NOT NULL`),
    uniqueIndex("ux_idempotency_org")
      .on(
        table.organisationId,
        table.actorId,
        table.scope,
        table.idempotencyKey,
      )
      .where(sql`${table.eventId} IS NULL`),
    index("idx_idempotency_expiry").on(table.expiresAt),
  ],
);

export const abuseRateLimits = sqliteTable(
  "abuse_rate_limits",
  {
    scopeKey: text("scope_key").primaryKey(),
    windowStartedAt: integer("window_started_at").notNull(),
    requestCount: integer("request_count").notNull().default(0),
    blockedUntil: integer("blocked_until"),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_abuse_rate_limits_blocked_until").on(table.blockedUntil),
    index("idx_abuse_rate_limits_updated_at").on(table.updatedAt),
  ],
);

export const webhookEndpoints = sqliteTable("webhook_endpoints", {
  id: text("id").primaryKey(),
  organisationId: text("organisation_id")
    .notNull()
    .references(() => organisations.id, { onDelete: "cascade" }),
  eventId: text("event_id").references(() => events.id, {
    onDelete: "cascade",
  }),
  name: text("name").notNull(),
  url: text("url").notNull(),
  secretCiphertext: text("secret_ciphertext").notNull(),
  eventTypesJson: text("event_types_json").notNull(),
  status: text("status")
    .notNull()
    .default("active")
    .$type<"active" | "disabled" | "failing">(),
  failureCount: integer("failure_count").notNull().default(0),
  lastOperationId: text("last_operation_id"),
  createdByPersonId: text("created_by_person_id").references(() => people.id),
  createdAt: integer("created_at").notNull().default(epochNow),
  updatedAt: integer("updated_at").notNull().default(epochNow),
  disabledAt: integer("disabled_at"),
});

export const webhookDeliveries = sqliteTable(
  "webhook_deliveries",
  {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id")
      .notNull()
      .references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status")
      .notNull()
      .default("queued")
      .$type<"queued" | "delivering" | "delivered" | "failed" | "cancelled">(),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at"),
    deliveredAt: integer("delivered_at"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("webhook_deliveries_idempotency_unique").on(
      table.endpointId,
      table.idempotencyKey,
    ),
    index("idx_webhook_deliveries_status").on(
      table.status,
      table.nextAttemptAt,
    ),
  ],
);

export const webhookDeliveryAttempts = sqliteTable(
  "webhook_delivery_attempts",
  {
    id: text("id").primaryKey(),
    deliveryId: text("delivery_id")
      .notNull()
      .references(() => webhookDeliveries.id, { onDelete: "cascade" }),
    attemptNumber: integer("attempt_number").notNull(),
    requestTimestamp: integer("request_timestamp").notNull(),
    responseStatus: integer("response_status"),
    responseHeadersJson: text("response_headers_json"),
    responseExcerpt: text("response_excerpt"),
    errorMessage: text("error_message"),
    durationMs: integer("duration_ms"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    uniqueIndex("webhook_delivery_attempts_number_unique").on(
      table.deliveryId,
      table.attemptNumber,
    ),
    index("idx_webhook_attempts_delivery").on(
      table.deliveryId,
      table.attemptNumber,
    ),
  ],
);

export const webhookReceipts = sqliteTable(
  "webhook_receipts",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    externalEventId: text("external_event_id").notNull(),
    signatureValid: integer("signature_valid", { mode: "boolean" }).notNull(),
    payloadHash: text("payload_hash").notNull(),
    payloadJson: text("payload_json").notNull(),
    status: text("status")
      .notNull()
      .default("received")
      .$type<"received" | "processed" | "rejected" | "failed">(),
    receivedAt: integer("received_at").notNull().default(epochNow),
    processedAt: integer("processed_at"),
    errorMessage: text("error_message"),
  },
  (table) => [
    uniqueIndex("webhook_receipts_provider_event_unique").on(
      table.provider,
      table.externalEventId,
    ),
  ],
);

export const auditEvents = sqliteTable(
  "audit_events",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id").references(() => organisations.id, {
      onDelete: "cascade",
    }),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "cascade",
    }),
    actorPersonId: text("actor_person_id").references(() => people.id),
    actorId: text("actor_id"),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    correlationId: text("correlation_id"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_audit_event_created").on(table.eventId, table.createdAt),
  ],
);

export const assistantProposalExecutions = sqliteTable(
  "assistant_proposal_executions",
  {
    proposalId: text("proposal_id").primaryKey(),
    organisationId: text("organisation_id").notNull(),
    eventId: text("event_id").notNull(),
    actorPersonId: text("actor_person_id")
      .notNull()
      .references(() => people.id),
    toolName: text("tool_name").notNull(),
    status: text("status").notNull().$type<"processing" | "completed">(),
    claimToken: text("claim_token"),
    claimExpiresAt: integer("claim_expires_at"),
    resultJson: text("result_json"),
    createdAt: integer("created_at").notNull().default(epochNow),
    updatedAt: integer("updated_at").notNull().default(epochNow),
    completedAt: integer("completed_at"),
  },
  (table) => [
    check(
      "assistant_proposal_executions_state_check",
      sql`(
        (${table.status} = 'processing' AND ${table.claimToken} IS NOT NULL
          AND ${table.claimExpiresAt} IS NOT NULL AND ${table.resultJson} IS NULL
          AND ${table.completedAt} IS NULL)
        OR
        (${table.status} = 'completed' AND ${table.claimToken} IS NULL
          AND ${table.claimExpiresAt} IS NULL AND ${table.resultJson} IS NOT NULL
          AND ${table.completedAt} IS NOT NULL)
      )`,
    ),
    foreignKey({
      columns: [table.eventId, table.organisationId],
      foreignColumns: [events.id, events.organisationId],
    }).onDelete("cascade"),
    uniqueIndex("assistant_proposal_executions_claim_token_unique").on(
      table.claimToken,
    ),
    index("assistant_proposal_executions_claim_idx").on(
      table.status,
      table.claimExpiresAt,
    ),
  ],
);

export const authSessions = sqliteTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    userId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    token: text("token").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
  },
  (table) => [
    uniqueIndex("auth_sessions_token_unique").on(table.token),
    index("idx_auth_sessions_person_expiry").on(table.userId, table.expiresAt),
  ],
);

export const authAccounts = sqliteTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    userId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    providerId: text("provider_id").notNull(),
    accountId: text("account_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", {
      mode: "timestamp",
    }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", {
      mode: "timestamp",
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    uniqueIndex("auth_accounts_provider_account_unique").on(
      table.providerId,
      table.accountId,
    ),
  ],
);

export const verificationTokens = sqliteTable(
  "verification_tokens",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (table) => [
    index("idx_verification_identifier_expiry").on(
      table.identifier,
      table.expiresAt,
    ),
  ],
);

export const apiKeys = sqliteTable(
  "api_keys",
  {
    id: text("id").primaryKey(),
    organisationId: text("organisation_id")
      .notNull()
      .references(() => organisations.id, { onDelete: "cascade" }),
    eventId: text("event_id").references(() => events.id, {
      onDelete: "cascade",
    }),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull(),
    scopesJson: text("scopes_json").notNull(),
    expiresAt: integer("expires_at"),
    revokedAt: integer("revoked_at"),
    createdByPersonId: text("created_by_person_id").references(() => people.id),
    createdAt: integer("created_at").notNull().default(epochNow),
    lastUsedAt: integer("last_used_at"),
  },
  (table) => [
    uniqueIndex("api_keys_hash_unique").on(table.keyHash),
    uniqueIndex("ux_api_keys_event_active_name")
      .on(table.eventId, table.name)
      .where(sql`${table.revokedAt} IS NULL`),
    index("idx_api_keys_event").on(
      table.eventId,
      table.revokedAt,
      table.expiresAt,
    ),
  ],
);

export const authSchema = {
  user: people,
  session: authSessions,
  account: authAccounts,
  verification: verificationTokens,
};
