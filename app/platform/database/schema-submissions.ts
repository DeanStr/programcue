import { desc, sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

import { events, people } from "./schema-core";
import { epochNow } from "./schema-helpers";

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
