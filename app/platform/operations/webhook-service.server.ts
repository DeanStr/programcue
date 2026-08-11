import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  createWebhookSecret,
  decryptWebhookSecret,
  encryptWebhookSecret,
} from "~/platform/operations/webhook-crypto.server";
import {
  outboundWebhookEventTypeSchema,
  outboundWebhookEventTypes,
  webhookDeliveryMessageSchema,
  type WebhookDeliveryMessage,
} from "~/platform/operations/webhook-schema";

type WebhookEnvironment = CloudflareEnvironment & {
  WEBHOOK_CREDENTIALS_KEY?: string;
};

export const webhookEndpointSchema = z
  .object({
    name: z.string().trim().min(2).max(80),
    url: z
      .url()
      .max(2_000)
      .transform((value, context) => {
        try {
          return validateWebhookUrl(value);
        } catch (error) {
          context.addIssue({
            code: "custom",
            message:
              error instanceof Error
                ? error.message
                : "The outbound webhook URL is invalid.",
          });
          return z.NEVER;
        }
      }),
    eventTypes: z
      .array(outboundWebhookEventTypeSchema)
      .min(1)
      .max(outboundWebhookEventTypes.length)
      .transform((items) => [...new Set(items)]),
  })
  .strict();

const queueEventSchema = z
  .object({
    eventType: outboundWebhookEventTypeSchema,
    entityType: z.string().trim().min(1).max(100),
    entityId: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().trim().min(8).max(128),
    correlationId: z.string().trim().min(1).max(200),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

type QueueEventInput = z.infer<typeof queueEventSchema>;

type WebhookEventActor = Pick<Viewer, "organisationId" | "eventId"> & {
  personId: string | null;
  actorId?: string;
};

export type WebhookEventResult = {
  endpointId: string;
  deliveryId: string;
  operationId: string;
  status: WebhookEventResultStatus;
  duplicate: boolean;
};

type PreparedWebhookCandidate = {
  endpointId: string;
  endpointIdempotencyKey: string;
  deliveryId: string;
  operationId: string;
  requestHash: string;
  message: WebhookDeliveryMessage;
  duplicate: boolean;
};

export type PreparedWebhookEvent = {
  eventId: string;
  statements: D1PreparedStatement[];
  existingResults: WebhookEventResult[];
  candidates: PreparedWebhookCandidate[];
};

function canonicalJson(value: unknown) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new Error("The outbound webhook request is not JSON serializable.");
  }
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, item]) => [key, normalize(item)]),
      );
    }
    return candidate;
  };
  return JSON.stringify(normalize(JSON.parse(serialized)));
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function webhookPayloadData(
  input: Pick<QueueEventInput, "entityType" | "entityId" | "data">,
) {
  return {
    ...input.data,
    entityType: input.entityType,
    entityId: input.entityId,
  };
}

function webhookRequestHash(input: {
  eventType: string;
  entityType: string;
  entityId: string;
  data: Record<string, unknown>;
}) {
  return sha256Hex(
    canonicalJson({
      eventType: input.eventType,
      entityType: input.entityType,
      entityId: input.entityId,
      data: webhookPayloadData(input),
    }),
  );
}

function isPrivateIpv4(hostname: string) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname);
  if (!match) return false;
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 255)) return true;
  const [a, b] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    a >= 224
  );
}

export function validateWebhookUrl(value: string) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  if (url.protocol !== "https:") {
    throw new Error("Outbound webhook URLs must use HTTPS.");
  }
  if (url.username || url.password || url.hash) {
    throw new Error(
      "Outbound webhook URLs cannot contain credentials or fragments.",
    );
  }
  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal") ||
    hostname.includes(":") ||
    isPrivateIpv4(hostname)
  ) {
    throw new Error("Outbound webhook URLs must use a public DNS hostname.");
  }
  return url.toString();
}

export type WebhookEndpointListItem = {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  status: "active" | "disabled" | "failing";
  failureCount: number;
  createdAt: number;
  updatedAt: number;
  latestDelivery: {
    id: string;
    status: string;
    attemptCount: number;
    operationId: string | null;
    createdAt: number;
  } | null;
};

export class WebhookEndpointNotFoundError extends Error {
  constructor() {
    super("Webhook endpoint not found.");
    this.name = "WebhookEndpointNotFoundError";
  }
}

export class WebhookQueueUnavailableError extends Error {
  constructor(readonly operationId: string) {
    super(
      `Webhook test ${operationId} was saved but could not be queued. Retry it from the Operation Centre.`,
    );
    this.name = "WebhookQueueUnavailableError";
  }
}

export class WebhookQueueConfigurationError extends Error {
  constructor() {
    super("Outbound webhook delivery requires the OPERATIONS_QUEUE binding.");
    this.name = "WebhookQueueConfigurationError";
  }
}

export class WebhookEventIdempotencyConflictError extends Error {
  constructor(readonly operationId: string) {
    super(
      `Webhook operation ${operationId} already uses this idempotency key for different event content.`,
    );
    this.name = "WebhookEventIdempotencyConflictError";
  }
}

type WebhookEventResultStatus =
  | "queued"
  | "queue_failed"
  | "completed"
  | "partially_failed"
  | "failed"
  | "cancelled";

function webhookReplayStatus(status: string): WebhookEventResultStatus {
  if (status === "queue_failed") return "queue_failed";
  if (["queued", "received", "running", "retrying"].includes(status)) {
    return "queued";
  }
  if (
    ["completed", "partially_failed", "failed", "cancelled"].includes(status)
  ) {
    return status as Exclude<
      WebhookEventResultStatus,
      "queued" | "queue_failed"
    >;
  }
  throw new Error(
    `Webhook operation has unsupported status ${JSON.stringify(status)}.`,
  );
}

export class WebhookService {
  constructor(private readonly env: WebhookEnvironment) {}

  async assertEventDeliveryReady(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
    rawEventType: unknown,
  ) {
    const eventType = outboundWebhookEventTypeSchema.parse(rawEventType);
    const endpoint = await this.env.DB.prepare(
      `SELECT 1
         FROM webhook_endpoints endpoint
         JOIN events event
           ON event.id = endpoint.event_id AND event.organisation_id = ?
        WHERE endpoint.event_id = ? AND endpoint.status IN ('active','failing')
          AND EXISTS (
            SELECT 1 FROM json_each(endpoint.event_types_json)
             WHERE value = ?
          )
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, eventType)
      .first();
    if (endpoint && !this.env.OPERATIONS_QUEUE)
      throw new WebhookQueueConfigurationError();
  }

  async list(viewer: Viewer): Promise<WebhookEndpointListItem[]> {
    const rows = await this.env.DB.prepare(
      `
      SELECT we.id, we.name, we.url, we.event_types_json AS eventTypesJson,
             we.status, we.failure_count AS failureCount,
             we.created_at AS createdAt, we.updated_at AS updatedAt,
             wd.id AS deliveryId, wd.status AS deliveryStatus,
             wd.attempt_count AS deliveryAttemptCount,
             wd.created_at AS deliveryCreatedAt,
             (
               SELECT oi.operation_id FROM operation_items oi
                WHERE oi.entity_type = 'webhook_delivery' AND oi.entity_id = wd.id
                ORDER BY oi.updated_at DESC LIMIT 1
             ) AS operationId
        FROM webhook_endpoints we
        JOIN events e ON e.id = we.event_id AND e.organisation_id = ?
        LEFT JOIN webhook_deliveries wd ON wd.id = (
          SELECT latest.id FROM webhook_deliveries latest
           WHERE latest.endpoint_id = we.id
           ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1
        )
       WHERE we.event_id = ?
       ORDER BY we.status = 'disabled', we.updated_at DESC, we.name
    `,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        id: string;
        name: string;
        url: string;
        eventTypesJson: string;
        status: "active" | "disabled" | "failing";
        failureCount: number;
        createdAt: number;
        updatedAt: number;
        deliveryId: string | null;
        deliveryStatus: string | null;
        deliveryAttemptCount: number | null;
        deliveryCreatedAt: number | null;
        operationId: string | null;
      }>();
    return rows.results.map(
      ({
        eventTypesJson,
        deliveryId,
        deliveryStatus,
        deliveryAttemptCount,
        deliveryCreatedAt,
        operationId,
        ...endpoint
      }) => {
        let decoded: unknown;
        try {
          decoded = JSON.parse(eventTypesJson);
        } catch {
          throw new Error(
            `Webhook endpoint ${endpoint.id} has invalid events.`,
          );
        }
        const eventTypes = z
          .array(outboundWebhookEventTypeSchema)
          .safeParse(decoded);
        if (!eventTypes.success) {
          throw new Error(
            `Webhook endpoint ${endpoint.id} has invalid events.`,
          );
        }
        return {
          ...endpoint,
          eventTypes: eventTypes.data,
          latestDelivery:
            deliveryId &&
            deliveryStatus &&
            deliveryAttemptCount !== null &&
            deliveryCreatedAt !== null
              ? {
                  id: deliveryId,
                  status: deliveryStatus,
                  attemptCount: deliveryAttemptCount,
                  operationId,
                  createdAt: deliveryCreatedAt,
                }
              : null,
        };
      },
    );
  }

  async create(
    viewer: Viewer,
    rawInput: unknown,
    command?: { operationId: string; endpointId: string },
  ) {
    const input = webhookEndpointSchema.parse(rawInput);
    const id = command?.endpointId ?? crypto.randomUUID();
    if (command) {
      const recovered = await this.env.DB.prepare(
        `SELECT secret_ciphertext AS secretCiphertext
           FROM webhook_endpoints
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND last_operation_id = ?`,
      )
        .bind(id, viewer.organisationId, viewer.eventId, command.operationId)
        .first<{ secretCiphertext: string }>();
      if (recovered) {
        return {
          id,
          secret: await decryptWebhookSecret(
            recovered.secretCiphertext,
            id,
            this.env.WEBHOOK_CREDENTIALS_KEY,
          ),
          secretCiphertext: recovered.secretCiphertext,
        };
      }
    }
    const secret = createWebhookSecret();
    const ciphertext = await encryptWebhookSecret(
      secret,
      id,
      this.env.WEBHOOK_CREDENTIALS_KEY,
    );
    const [created] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO webhook_endpoints (
          id, organisation_id, event_id, name, url, secret_ciphertext,
          event_types_json, status, failure_count, last_operation_id,
          created_by_person_id,
          created_at, updated_at
        )
        SELECT ?, e.organisation_id, e.id, ?, ?, ?, ?, 'active', 0, ?, ?,
               unixepoch(), unixepoch()
          FROM events e WHERE e.id = ? AND e.organisation_id = ?
      `,
      ).bind(
        id,
        input.name,
        input.url,
        ciphertext,
        JSON.stringify(input.eventTypes),
        command?.operationId ?? null,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'webhook_endpoint.created', 'webhook_endpoint',
                 ?, ?, unixepoch()
           WHERE EXISTS (SELECT 1 FROM webhook_endpoints WHERE id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        id,
        JSON.stringify({
          name: input.name,
          url: input.url,
          eventTypes: input.eventTypes,
        }),
        id,
      ),
    ]);
    if ((created.meta.changes ?? 0) !== 1) {
      throw new Error("The webhook endpoint could not be created.");
    }
    return { id, secret, secretCiphertext: ciphertext };
  }

  async setStatus(
    viewer: Viewer,
    endpointId: string,
    status: "active" | "disabled",
    operationId: string = crypto.randomUUID(),
  ) {
    const recovered = await this.env.DB.prepare(
      `SELECT 1 FROM webhook_endpoints
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND status = ? AND last_operation_id = ?`,
    )
      .bind(
        endpointId,
        viewer.eventId,
        viewer.organisationId,
        status,
        operationId,
      )
      .first();
    if (recovered) return { endpointId, status };
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE webhook_endpoints
           SET status = ?, disabled_at = CASE WHEN ? = 'disabled' THEN unixepoch() ELSE NULL END,
               failure_count = CASE WHEN ? = 'active' THEN 0 ELSE failure_count END,
               last_operation_id = ?,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND organisation_id = ?
      `,
      ).bind(
        status,
        status,
        status,
        operationId,
        endpointId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, ?, 'webhook_endpoint', ?, ?, '{}', unixepoch()
           WHERE changes() = 1
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `webhook_endpoint.${status === "active" ? "enabled" : "disabled"}`,
        endpointId,
        operationId,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new WebhookEndpointNotFoundError();
    }
    return { endpointId, status };
  }

  async rotateSecret(
    viewer: Viewer,
    endpointId: string,
    operationId: string = crypto.randomUUID(),
  ) {
    const current = await this.env.DB.prepare(
      `SELECT secret_ciphertext AS secretCiphertext, last_operation_id AS lastOperationId
         FROM webhook_endpoints
        WHERE id = ? AND event_id = ? AND organisation_id = ?`,
    )
      .bind(endpointId, viewer.eventId, viewer.organisationId)
      .first<{ secretCiphertext: string; lastOperationId: string | null }>();
    if (!current) throw new WebhookEndpointNotFoundError();
    if (current.lastOperationId === operationId) {
      return {
        endpointId,
        secret: await decryptWebhookSecret(
          current.secretCiphertext,
          endpointId,
          this.env.WEBHOOK_CREDENTIALS_KEY,
        ),
        secretCiphertext: current.secretCiphertext,
      };
    }
    const secret = createWebhookSecret();
    const ciphertext = await encryptWebhookSecret(
      secret,
      endpointId,
      this.env.WEBHOOK_CREDENTIALS_KEY,
    );
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE webhook_endpoints
            SET secret_ciphertext = ?, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?`,
      ).bind(
        ciphertext,
        operationId,
        endpointId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'webhook_endpoint.secret_rotated',
                  'webhook_endpoint', ?, ?, '{}', unixepoch()
             FROM webhook_endpoints
            WHERE id = ? AND event_id = ? AND organisation_id = ?
              AND last_operation_id = ?`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        endpointId,
        operationId,
        endpointId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new WebhookEndpointNotFoundError();
    }
    return { endpointId, secret, secretCiphertext: ciphertext };
  }

  async prepareEventForAudit(
    viewer: WebhookEventActor,
    rawInput: unknown,
    auditEventId: string | null,
  ): Promise<PreparedWebhookEvent> {
    const input = queueEventSchema.parse(rawInput);
    const requestHash = await webhookRequestHash(input);
    const endpoints = await this.env.DB.prepare(
      `
      SELECT we.id
        FROM webhook_endpoints we
        JOIN events e ON e.id = we.event_id AND e.organisation_id = ?
       WHERE we.event_id = ? AND we.status IN ('active','failing')
         AND EXISTS (
           SELECT 1 FROM json_each(we.event_types_json)
            WHERE value = ?
         )
       ORDER BY we.id
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, input.eventType)
      .all<{ id: string }>();
    const existingResults: WebhookEventResult[] = [];
    const candidates: PreparedWebhookCandidate[] = [];
    const statements: D1PreparedStatement[] = [];

    if (endpoints.results.length === 0) {
      return {
        eventId: viewer.eventId,
        statements,
        existingResults,
        candidates,
      };
    }
    if (!this.env.OPERATIONS_QUEUE) throw new WebhookQueueConfigurationError();

    for (const endpoint of endpoints.results) {
      const endpointIdempotencyKey = `webhook:${endpoint.id}:${input.idempotencyKey}`;
      const existing = await this.env.DB.prepare(
        `
        SELECT wd.id AS deliveryId, wd.request_hash AS requestHash,
               oi.operation_id AS operationId, o.status,
               o.payload_json AS payloadJson, o.dispatched_at AS dispatchedAt
          FROM webhook_deliveries wd
          JOIN operation_items oi ON oi.entity_type = 'webhook_delivery'
            AND oi.entity_id = wd.id
          JOIN operation_jobs o ON o.id = oi.operation_id
         WHERE wd.endpoint_id = ? AND wd.idempotency_key = ?
           AND o.event_id = ? AND o.organisation_id = ?
         LIMIT 1
      `,
      )
        .bind(
          endpoint.id,
          endpointIdempotencyKey,
          viewer.eventId,
          viewer.organisationId,
        )
        .first<{
          deliveryId: string;
          requestHash: string;
          operationId: string;
          status: string;
          payloadJson: string;
          dispatchedAt: number | null;
        }>();
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new WebhookEventIdempotencyConflictError(existing.operationId);
        }
        if (
          webhookReplayStatus(existing.status) === "queued" &&
          !existing.dispatchedAt
        ) {
          candidates.push({
            endpointId: endpoint.id,
            endpointIdempotencyKey,
            deliveryId: existing.deliveryId,
            operationId: existing.operationId,
            requestHash,
            message: webhookDeliveryMessageSchema.parse(
              JSON.parse(existing.payloadJson),
            ),
            duplicate: true,
          });
        } else {
          existingResults.push({
            endpointId: endpoint.id,
            deliveryId: existing.deliveryId,
            operationId: existing.operationId,
            status: webhookReplayStatus(existing.status),
            duplicate: true,
          });
        }
        continue;
      }

      const operationId = crypto.randomUUID();
      const deliveryId = crypto.randomUUID();
      const operationCorrelationId = crypto.randomUUID();
      const payload = JSON.stringify({
        id: deliveryId,
        type: input.eventType,
        createdAt: new Date().toISOString(),
        eventId: viewer.eventId,
        correlationId: input.correlationId,
        data: webhookPayloadData(input),
      });
      if (new TextEncoder().encode(payload).byteLength > 64_000) {
        throw new Error("Outbound webhook payloads cannot exceed 64 KB.");
      }
      const message: WebhookDeliveryMessage = {
        type: "webhook.deliver",
        operationId,
        deliveryId,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        idempotencyKey: endpointIdempotencyKey,
      };
      const delivery = auditEventId
        ? this.env.DB.prepare(
            `INSERT OR IGNORE INTO webhook_deliveries (
               id, endpoint_id, event_type, entity_type, entity_id,
               idempotency_key, request_hash, payload_json, status, attempt_count,
               created_at, updated_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, unixepoch(), unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM audit_events
                 WHERE id = ? AND organisation_id = ? AND event_id = ?
              )`,
          ).bind(
            deliveryId,
            endpoint.id,
            input.eventType,
            input.entityType,
            input.entityId,
            endpointIdempotencyKey,
            requestHash,
            payload,
            auditEventId,
            viewer.organisationId,
            viewer.eventId,
          )
        : this.env.DB.prepare(
            `INSERT OR IGNORE INTO webhook_deliveries (
               id, endpoint_id, event_type, entity_type, entity_id,
               idempotency_key, request_hash, payload_json, status, attempt_count,
               created_at, updated_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', 0, unixepoch(), unixepoch())`,
          ).bind(
            deliveryId,
            endpoint.id,
            input.eventType,
            input.entityType,
            input.entityId,
            endpointIdempotencyKey,
            requestHash,
            payload,
          );
      statements.push(
        delivery,
        this.env.DB.prepare(
          `
          INSERT INTO operation_jobs (
            id, organisation_id, event_id, requested_by_person_id, type,
            idempotency_key, correlation_id, status, payload_json,
            progress_total, progress_completed, progress_failed, cancellable,
            created_at, updated_at
          ) SELECT ?, ?, ?, ?, 'webhook.deliver', ?, ?, 'queued', ?, 1, 0, 0,
                   0, unixepoch(), unixepoch()
             WHERE EXISTS (
               SELECT 1 FROM webhook_deliveries
                WHERE id = ? AND endpoint_id = ? AND status = 'queued'
             )
        `,
        ).bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          endpointIdempotencyKey,
          operationCorrelationId,
          JSON.stringify(message),
          deliveryId,
          endpoint.id,
        ),
        this.env.DB.prepare(
          `
          INSERT INTO operation_items (
            id, operation_id, item_key, entity_type, entity_id, status, updated_at
          ) SELECT ?, ?, ?, 'webhook_delivery', ?, 'pending', unixepoch()
             WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
        `,
        ).bind(
          crypto.randomUUID(),
          operationId,
          endpointIdempotencyKey,
          deliveryId,
          operationId,
        ),
        this.env.DB.prepare(
          `
          INSERT INTO audit_events (
            id, organisation_id, event_id, actor_person_id, actor_id, action,
            entity_type, entity_id, correlation_id, metadata_json, created_at
          ) SELECT ?, ?, ?, ?, ?, 'webhook.queued', 'webhook_delivery', ?, ?, ?, unixepoch()
             WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
        `,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          viewer.actorId ?? null,
          deliveryId,
          input.correlationId,
          JSON.stringify({
            operationId,
            endpointId: endpoint.id,
            eventType: input.eventType,
            entityType: input.entityType,
            entityId: input.entityId,
          }),
          operationId,
        ),
        this.env.DB.prepare(
          `
          INSERT INTO event_changes (
            event_id, entity_type, entity_id, change_type, correlation_id, created_at
          ) SELECT ?, 'operation', ?, 'created', ?, unixepoch()
             WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
        `,
        ).bind(
          viewer.eventId,
          operationId,
          operationCorrelationId,
          operationId,
        ),
      );
      candidates.push({
        endpointId: endpoint.id,
        endpointIdempotencyKey,
        deliveryId,
        operationId,
        requestHash,
        message,
        duplicate: false,
      });
    }
    return {
      eventId: viewer.eventId,
      statements,
      existingResults,
      candidates,
    };
  }

  async dispatchPreparedEvent(prepared: PreparedWebhookEvent) {
    const results = [...prepared.existingResults];
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (prepared.candidates.length && !operationsQueue) {
      throw new WebhookQueueConfigurationError();
    }
    for (const candidate of prepared.candidates) {
      const converged = await this.env.DB.prepare(
        `SELECT wd.id AS deliveryId, wd.request_hash AS requestHash,
                oi.operation_id AS operationId, o.status
           FROM webhook_deliveries wd
           JOIN operation_items oi ON oi.entity_type = 'webhook_delivery'
             AND oi.entity_id = wd.id
           JOIN operation_jobs o ON o.id = oi.operation_id
          WHERE wd.endpoint_id = ? AND wd.idempotency_key = ?
            AND o.event_id = ?
          LIMIT 1`,
      )
        .bind(
          candidate.endpointId,
          candidate.endpointIdempotencyKey,
          prepared.eventId,
        )
        .first<{
          deliveryId: string;
          requestHash: string;
          operationId: string;
          status: string;
        }>();
      if (!converged) {
        throw new Error(
          "The outbound webhook idempotency record is incomplete.",
        );
      }
      if (converged.requestHash !== candidate.requestHash) {
        throw new WebhookEventIdempotencyConflictError(converged.operationId);
      }
      if (converged.operationId !== candidate.operationId) {
        results.push({
          endpointId: candidate.endpointId,
          deliveryId: converged.deliveryId,
          operationId: converged.operationId,
          status: webhookReplayStatus(converged.status),
          duplicate: true,
        });
        continue;
      }
      try {
        await operationsQueue!.send(candidate.message);
        await this.env.DB.prepare(
          `UPDATE operation_jobs SET dispatched_at = COALESCE(dispatched_at, unixepoch()),
                  updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND type = 'webhook.deliver'
              AND status = 'queued'`,
        )
          .bind(candidate.operationId, prepared.eventId)
          .run();
        results.push({
          endpointId: candidate.endpointId,
          deliveryId: candidate.deliveryId,
          operationId: candidate.operationId,
          status: "queued",
          duplicate: candidate.duplicate,
        });
      } catch (error) {
        const failure = error instanceof Error ? error.message : String(error);
        await this.markQueueFailure(
          prepared.eventId,
          candidate.operationId,
          candidate.deliveryId,
          failure,
        );
        results.push({
          endpointId: candidate.endpointId,
          deliveryId: candidate.deliveryId,
          operationId: candidate.operationId,
          status: "queue_failed",
          duplicate: false,
        });
      }
    }
    return results;
  }

  async queueEvent(viewer: WebhookEventActor, rawInput: unknown) {
    const prepared = await this.prepareEventForAudit(viewer, rawInput, null);
    if (prepared.statements.length)
      await this.env.DB.batch(prepared.statements);
    return this.dispatchPreparedEvent(prepared);
  }

  async dispatchPendingEvents(limit = 50) {
    const queue = this.env.OPERATIONS_QUEUE;
    if (!queue) throw new WebhookQueueConfigurationError();
    const pending = await this.env.DB.prepare(
      `SELECT operation.id AS operationId, operation.event_id AS eventId,
              operation.payload_json AS payloadJson, delivery.id AS deliveryId
         FROM operation_jobs operation
         JOIN operation_items item ON item.operation_id = operation.id
          AND item.entity_type = 'webhook_delivery'
         JOIN webhook_deliveries delivery ON delivery.id = item.entity_id
        WHERE operation.type = 'webhook.deliver' AND operation.status = 'queued'
          AND operation.dispatched_at IS NULL
          AND delivery.status = 'queued'
        ORDER BY operation.created_at, operation.id
        LIMIT ?`,
    )
      .bind(Math.max(1, Math.min(100, Math.trunc(limit))))
      .all<{
        operationId: string;
        eventId: string;
        payloadJson: string;
        deliveryId: string;
      }>();
    let queued = 0;
    let queueFailed = 0;
    for (const row of pending.results) {
      let message: WebhookDeliveryMessage;
      try {
        message = webhookDeliveryMessageSchema.parse(
          JSON.parse(row.payloadJson),
        );
        await queue.send(message);
        await this.env.DB.prepare(
          `UPDATE operation_jobs SET dispatched_at = COALESCE(dispatched_at, unixepoch()),
                  updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND type = 'webhook.deliver'
              AND status = 'queued'`,
        )
          .bind(row.operationId, row.eventId)
          .run();
        queued += 1;
      } catch (error) {
        queueFailed += 1;
        await this.markQueueFailure(
          row.eventId,
          row.operationId,
          row.deliveryId,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
    return { queued, queueFailed };
  }

  async queueTest(
    viewer: Viewer,
    endpointId: string,
    suppliedIdempotencyKey: string = crypto.randomUUID(),
  ) {
    const endpoint = await this.env.DB.prepare(
      `
      SELECT we.id, we.name, we.status
        FROM webhook_endpoints we
        JOIN events e ON e.id = we.event_id AND e.organisation_id = ?
       WHERE we.id = ? AND we.event_id = ?
       LIMIT 1
    `,
    )
      .bind(viewer.organisationId, endpointId, viewer.eventId)
      .first<{ id: string; name: string; status: string }>();
    if (!endpoint) throw new WebhookEndpointNotFoundError();
    if (endpoint.status === "disabled") {
      throw new Error("Enable this webhook endpoint before sending a test.");
    }
    const idempotencyKey = `webhook-test:${endpointId}:${suppliedIdempotencyKey}`;
    const existing = await this.env.DB.prepare(
      `SELECT delivery.id AS deliveryId, item.operation_id AS operationId,
              operation.status
         FROM webhook_deliveries delivery
         JOIN operation_items item
           ON item.entity_type = 'webhook_delivery'
          AND item.entity_id = delivery.id
         JOIN operation_jobs operation ON operation.id = item.operation_id
        WHERE delivery.endpoint_id = ? AND delivery.idempotency_key = ?
          AND operation.event_id = ? AND operation.organisation_id = ?
        LIMIT 1`,
    )
      .bind(endpointId, idempotencyKey, viewer.eventId, viewer.organisationId)
      .first<{ deliveryId: string; operationId: string; status: string }>();
    if (existing) {
      return {
        operationId: existing.operationId,
        deliveryId: existing.deliveryId,
        status: existing.status,
        replayed: true,
      };
    }
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (!operationsQueue) throw new WebhookQueueConfigurationError();
    const operationId = crypto.randomUUID();
    const deliveryId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const payload = JSON.stringify({
      id: deliveryId,
      type: "program_cue.test",
      createdAt: new Date().toISOString(),
      eventId: viewer.eventId,
      data: { message: "Program Cue outbound webhook test" },
    });
    const requestHash = await webhookRequestHash({
      eventType: "program_cue.test",
      entityType: "webhook_endpoint",
      entityId: endpoint.id,
      data: { message: "Program Cue outbound webhook test" },
    });
    const message: WebhookDeliveryMessage = {
      type: "webhook.deliver",
      operationId,
      deliveryId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
      idempotencyKey,
    };
    const [created] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO webhook_deliveries (
          id, endpoint_id, event_type, entity_type, entity_id,
          idempotency_key, request_hash, payload_json, status, attempt_count,
          created_at, updated_at
        ) VALUES (?, ?, 'program_cue.test', 'webhook_endpoint', ?, ?, ?, ?,
                  'queued', 0, unixepoch(), unixepoch())
      `,
      ).bind(
        deliveryId,
        endpoint.id,
        endpoint.id,
        idempotencyKey,
        requestHash,
        payload,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json,
          progress_total, progress_completed, progress_failed, cancellable,
          created_at, updated_at
        ) SELECT ?, ?, ?, ?, 'webhook.deliver', ?, ?, 'queued', ?, 1, 0, 0,
                 0, unixepoch(), unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM webhook_deliveries
              WHERE id = ? AND endpoint_id = ? AND status = 'queued'
           )
      `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        idempotencyKey,
        correlationId,
        JSON.stringify(message),
        deliveryId,
        endpoint.id,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO operation_items (
          id, operation_id, item_key, entity_type, entity_id, status, updated_at
        ) SELECT ?, ?, ?, 'webhook_delivery', ?, 'pending', unixepoch()
           WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        operationId,
        idempotencyKey,
        deliveryId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'webhook.test_queued', 'webhook_delivery', ?,
                 ?, ?, unixepoch()
           WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        deliveryId,
        correlationId,
        JSON.stringify({ operationId, endpointId: endpoint.id }),
        operationId,
      ),
    ]);
    if ((created.meta.changes ?? 0) !== 1) {
      const converged = await this.env.DB.prepare(
        `SELECT delivery.id AS deliveryId, item.operation_id AS operationId,
                operation.status
           FROM webhook_deliveries delivery
           JOIN operation_items item
             ON item.entity_type = 'webhook_delivery'
            AND item.entity_id = delivery.id
           JOIN operation_jobs operation ON operation.id = item.operation_id
          WHERE delivery.endpoint_id = ? AND delivery.idempotency_key = ?
            AND operation.event_id = ? AND operation.organisation_id = ?
          LIMIT 1`,
      )
        .bind(endpointId, idempotencyKey, viewer.eventId, viewer.organisationId)
        .first<{ deliveryId: string; operationId: string; status: string }>();
      if (!converged) {
        throw new Error("The webhook test idempotency record is incomplete.");
      }
      return {
        operationId: converged.operationId,
        deliveryId: converged.deliveryId,
        status: converged.status,
        replayed: true,
      };
    }
    try {
      await operationsQueue.send(message);
      await this.env.DB.prepare(
        `UPDATE operation_jobs SET dispatched_at = COALESCE(dispatched_at, unixepoch()),
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'webhook.deliver' AND status = 'queued'`,
      )
        .bind(operationId, viewer.eventId, viewer.organisationId)
        .run();
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error);
      await this.markQueueFailure(
        viewer.eventId,
        operationId,
        deliveryId,
        failure,
      );
      throw new WebhookQueueUnavailableError(operationId);
    }
    return { operationId, deliveryId, status: "queued", replayed: false };
  }

  private async markQueueFailure(
    eventId: string,
    operationId: string,
    deliveryId: string,
    error: string,
  ) {
    const failure = error.slice(0, 2_000);
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND status = 'queued'`,
      ).bind(failure, operationId, eventId),
      this.env.DB.prepare(
        `UPDATE webhook_deliveries SET status = 'failed', updated_at = unixepoch()
          WHERE id = ? AND status = 'queued'`,
      ).bind(deliveryId),
      this.env.DB.prepare(
        `UPDATE operation_items SET status = 'failed', error_code = 'QUEUE_UNAVAILABLE',
                error_message = ?, completed_at = unixepoch(), updated_at = unixepoch()
          WHERE operation_id = ? AND entity_id = ? AND status = 'pending'`,
      ).bind(failure, operationId, deliveryId),
    ]);
  }
}
