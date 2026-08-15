import { sql } from "drizzle-orm";
import {
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { events, organisations } from "./schema-core";
import { epochNow } from "./schema-helpers";

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
