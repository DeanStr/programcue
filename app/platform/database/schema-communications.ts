import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { events, organisations, people } from "./schema-core";
import { epochNow } from "./schema-helpers";
import { sessions } from "./schema-schedule";

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
    renderedSubject: text("rendered_subject"),
    renderedBodySha256: text("rendered_body_sha256"),
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
    index("idx_deliveries_communication_created").on(
      table.communicationId,
      table.createdAt,
      table.id,
    ),
    index("idx_deliveries_event_created_status").on(
      table.eventId,
      table.createdAt,
      table.status,
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
