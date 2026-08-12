import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  WebhookEndpointService,
  type WebhookEndpointListItem,
} from "./webhook-endpoint-service.server";
export {
  validateWebhookUrl,
  webhookEndpointSchema,
} from "./webhook-endpoint-service.server";
export type { WebhookEndpointListItem } from "./webhook-endpoint-service.server";
import {
  WebhookEndpointNotFoundError,
  WebhookEventIdempotencyConflictError,
  WebhookQueueConfigurationError,
  WebhookQueueUnavailableError,
} from "./webhook-errors";
import {
  outboundWebhookEventTypeSchema,
  outboundWebhookEventTypes,
  webhookDeliveryMessageSchema,
  type WebhookDeliveryMessage,
} from "~/platform/operations/webhook-schema";

type WebhookEnvironment = CloudflareEnvironment & {
  WEBHOOK_CREDENTIALS_KEY?: string;
};

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

export {
  WebhookEndpointNotFoundError,
  WebhookEventIdempotencyConflictError,
  WebhookQueueConfigurationError,
  WebhookQueueUnavailableError,
} from "./webhook-errors";

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

  private endpointService() {
    return new WebhookEndpointService(this.env);
  }

  assertEventDeliveryReady(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
    rawEventType: unknown,
  ) {
    return this.endpointService().assertEventDeliveryReady(
      viewer,
      rawEventType,
    );
  }

  list(viewer: Viewer): Promise<WebhookEndpointListItem[]> {
    return this.endpointService().list(viewer);
  }

  create(
    viewer: Viewer,
    rawInput: unknown,
    command?: { operationId: string; endpointId: string },
  ) {
    return this.endpointService().create(viewer, rawInput, command);
  }

  setStatus(
    viewer: Viewer,
    endpointId: string,
    status: "active" | "disabled",
    operationId: string = crypto.randomUUID(),
  ) {
    return this.endpointService().setStatus(
      viewer,
      endpointId,
      status,
      operationId,
    );
  }

  rotateSecret(
    viewer: Viewer,
    endpointId: string,
    operationId: string = crypto.randomUUID(),
  ) {
    return this.endpointService().rotateSecret(viewer, endpointId, operationId);
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

  /**
   * Resumes only deliveries already persisted with an audited mutation. New
   * endpoints must not receive historical events merely because they were
   * registered during a response-persistence recovery window.
   */
  async resumePreparedEventForAudit(
    viewer: WebhookEventActor,
    rawInput: unknown,
    auditEventId: string,
  ) {
    const input = queueEventSchema.parse(rawInput);
    const requestHash = await webhookRequestHash(input);
    const persisted = await this.env.DB.prepare(
      `SELECT endpoint.id AS endpointId, delivery.id AS deliveryId,
              delivery.request_hash AS requestHash,
              delivery.idempotency_key AS endpointIdempotencyKey,
              operation.id AS operationId, operation.status,
              operation.payload_json AS payloadJson,
              operation.dispatched_at AS dispatchedAt
         FROM webhook_deliveries delivery
         JOIN webhook_endpoints endpoint ON endpoint.id = delivery.endpoint_id
         JOIN operation_items item
           ON item.entity_type = 'webhook_delivery'
          AND item.entity_id = delivery.id
         JOIN operation_jobs operation ON operation.id = item.operation_id
        WHERE endpoint.organisation_id = ? AND endpoint.event_id = ?
          AND operation.organisation_id = ? AND operation.event_id = ?
          AND delivery.event_type = ? AND delivery.entity_type = ?
          AND delivery.entity_id = ?
          AND delivery.idempotency_key =
              'webhook:' || endpoint.id || ':' || ?
          AND EXISTS (
            SELECT 1 FROM audit_events audited
             WHERE audited.id = ? AND audited.organisation_id = ?
               AND audited.event_id = ?
          )
        ORDER BY endpoint.id`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        input.eventType,
        input.entityType,
        input.entityId,
        input.idempotencyKey,
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
      )
      .all<{
        endpointId: string;
        deliveryId: string;
        requestHash: string;
        endpointIdempotencyKey: string;
        operationId: string;
        status: string;
        payloadJson: string;
        dispatchedAt: number | null;
      }>();
    const existingResults: WebhookEventResult[] = [];
    const candidates: PreparedWebhookCandidate[] = [];
    for (const row of persisted.results) {
      if (row.requestHash !== requestHash) {
        throw new WebhookEventIdempotencyConflictError(row.operationId);
      }
      if (
        webhookReplayStatus(row.status) === "queued" &&
        !row.dispatchedAt
      ) {
        candidates.push({
          endpointId: row.endpointId,
          endpointIdempotencyKey: row.endpointIdempotencyKey,
          deliveryId: row.deliveryId,
          operationId: row.operationId,
          requestHash,
          message: webhookDeliveryMessageSchema.parse(
            JSON.parse(row.payloadJson),
          ),
          duplicate: true,
        });
      } else {
        existingResults.push({
          endpointId: row.endpointId,
          deliveryId: row.deliveryId,
          operationId: row.operationId,
          status: webhookReplayStatus(row.status),
          duplicate: true,
        });
      }
    }
    return this.dispatchPreparedEvent({
      eventId: viewer.eventId,
      statements: [],
      existingResults,
      candidates,
    });
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
