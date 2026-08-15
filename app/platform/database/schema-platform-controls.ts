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
    organisationId: text("organisation_id"),
    eventId: text("event_id"),
    actorPersonId: text("actor_person_id"),
    actorId: text("actor_id"),
    actorKind: text("actor_kind")
      .notNull()
      .$type<
        "historical" | "person" | "api_key" | "agent" | "provider" | "system"
      >(),
    origin: text("origin")
      .notNull()
      .$type<
        | "historical"
        | "admin_ui"
        | "participant_ui"
        | "public_form"
        | "api"
        | "provider_webhook"
        | "queue"
        | "scheduled"
        | "internal"
      >(),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    correlationId: text("correlation_id"),
    metadataVersion: integer("metadata_version").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: integer("created_at").notNull().default(epochNow),
  },
  (table) => [
    index("idx_audit_events_event_created_id").on(
      table.eventId,
      table.createdAt,
      table.id,
    ),
    index("idx_audit_events_organisation_created_id").on(
      table.organisationId,
      table.createdAt,
      table.id,
    ),
    index("idx_audit_events_event_actor_created_id").on(
      table.eventId,
      table.actorPersonId,
      table.createdAt,
      table.id,
    ),
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
