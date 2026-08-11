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
} from "~/platform/operations/webhook-schema";
import {
  WebhookEndpointNotFoundError,
  WebhookQueueConfigurationError,
} from "./webhook-errors";

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

export class WebhookEndpointService {
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
}
