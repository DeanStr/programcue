import { desc, sql } from "drizzle-orm";
import {
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
    contentZipStorageCleanedAt: integer("content_zip_storage_cleaned_at"),
    contentZipStorageCleanupClaim: text("content_zip_storage_cleanup_claim"),
    contentZipStorageCleanupClaimedAt: integer(
      "content_zip_storage_cleanup_claimed_at",
    ),
    alertAcknowledgedAt: integer("alert_acknowledged_at"),
    alertAcknowledgedByPersonId: text(
      "alert_acknowledged_by_person_id",
    ).references(() => people.id),
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
    index("idx_operation_jobs_event_failure_alert").on(
      table.eventId,
      table.status,
      table.alertAcknowledgedAt,
      table.createdAt,
    ),
    index("idx_reviewer_ai_operations_organisation_usage").on(
      table.organisationId,
      table.type,
      table.createdAt,
    ),
    index("idx_reviewer_ai_operations_assignment_usage")
      .on(
        table.eventId,
        sql`json_extract(${table.payloadJson}, '$.assignmentId')`,
        sql`${table.createdAt} DESC`,
      )
      .where(sql`${table.type} = 'ai.reviewer_suggestion.generate'`),
    index("idx_content_zip_storage_cleanup")
      .on(
        table.type,
        table.status,
        table.contentZipStorageCleanedAt,
        table.contentZipStorageCleanupClaim,
        table.contentZipStorageCleanupClaimedAt,
        table.completedAt,
        table.updatedAt,
      )
      .where(
        sql`${table.type} = 'content.zip.export'
          AND ${table.status} IN ('completed', 'failed', 'cancelled')`,
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
