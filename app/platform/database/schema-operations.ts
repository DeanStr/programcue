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
