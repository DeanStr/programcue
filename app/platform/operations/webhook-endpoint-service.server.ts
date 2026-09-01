import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
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
  WebhookEndpointCredentialsErasedError,
  WebhookEndpointNotFoundError,
  WebhookQueueConfigurationError,
  webhookSecretWasErased,
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

function isIpv4Literal(hostname: string) {
  return /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.test(hostname);
}

function isPublicIpv4(address: string) {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(address);
  if (!match) return false;
  const [a, b, c] = match.slice(1).map(Number);
  if (match.slice(1).some((part) => Number(part) > 255)) return false;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Bytes(address: string) {
  const normalized = address.toLowerCase().split("%")[0];
  if (!normalized || normalized.includes(".")) return null;
  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || missing < 0) return null;
  const words = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (
    words.length !== 8 ||
    words.some((word) => !/^[0-9a-f]{1,4}$/u.test(word))
  ) {
    return null;
  }
  return Uint8Array.from(
    words.flatMap((word) => {
      const value = Number.parseInt(word, 16);
      return [value >> 8, value & 0xff];
    }),
  );
}

function isPublicIpv6(address: string) {
  const bytes = ipv6Bytes(address);
  if (!bytes) return false;
  const first = bytes[0];
  if (first === undefined || (first & 0xe0) !== 0x20) return false;
  // Special-purpose, transition and documentation ranges must never be
  // treated as delivery targets.
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && (bytes[2] ?? 0) <= 0x01) {
    return false;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return false;
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return false;
  }
  return !(bytes[0] === 0x3f && bytes[1] === 0xff);
}

export type WebhookHostnameResolver = (
  hostname: string,
) => Promise<readonly string[]>;

export async function resolveWebhookHostname(
  hostname: string,
  fetcher: typeof fetch = fetch,
) {
  const resolveType = async (type: "A" | "AAAA") => {
    const url = new URL("https://cloudflare-dns.com/dns-query");
    url.searchParams.set("name", hostname);
    url.searchParams.set("type", type);
    const response = await fetcher(url, {
      headers: { accept: "application/dns-json" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!response.ok) {
      throw new Error(`Webhook DNS lookup returned HTTP ${response.status}.`);
    }
    const body = (await response.json()) as {
      Status?: number;
      Answer?: Array<{ type?: number; data?: string }>;
    };
    if (body.Status !== 0) {
      throw new Error(
        `Webhook DNS lookup returned DNS status ${String(body.Status)}.`,
      );
    }
    const recordType = type === "A" ? 1 : 28;
    return (body.Answer ?? [])
      .filter(
        (answer) =>
          answer.type === recordType && typeof answer.data === "string",
      )
      .map((answer) => answer.data as string);
  };
  const results = await Promise.all([resolveType("A"), resolveType("AAAA")]);
  return results.flat();
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
    isIpv4Literal(hostname)
  ) {
    throw new Error("Outbound webhook URLs must use a public DNS hostname.");
  }
  return url.toString();
}

export async function validateWebhookDestination(
  value: string,
  resolver: WebhookHostnameResolver = resolveWebhookHostname,
) {
  const validated = validateWebhookUrl(value);
  const hostname = new URL(validated).hostname;
  const addresses = await resolver(hostname);
  if (
    addresses.length === 0 ||
    addresses.some(
      (address) => !isPublicIpv4(address) && !isPublicIpv6(address),
    )
  ) {
    throw new Error(
      "Outbound webhook DNS must resolve only to public network addresses.",
    );
  }
  return validated;
}

export type WebhookEndpointListItem = {
  id: string;
  name: string;
  url: string;
  eventTypes: string[];
  status: "active" | "disabled" | "failing";
  credentialsErased: boolean;
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
             we.secret_ciphertext AS secretCiphertext,
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
        secretCiphertext: string;
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
        secretCiphertext,
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
          credentialsErased: webhookSecretWasErased(secretCiphertext),
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
            this.env.WEBHOOK_CREDENTIALS_PREVIOUS_KEY,
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
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'webhook_endpoint.created', 'webhook_endpoint',
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
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `
          UPDATE webhook_endpoints
             SET status = ?, disabled_at = CASE WHEN ? = 'disabled' THEN unixepoch() ELSE NULL END,
                 failure_count = CASE WHEN ? = 'active' THEN 0 ELSE failure_count END,
                 last_operation_id = ?,
                 updated_at = unixepoch()
           WHERE id = ? AND event_id = ? AND organisation_id = ?
             AND (? = 'disabled' OR secret_ciphertext NOT LIKE 'retained-%')
        `,
        ).bind(
          status,
          status,
          status,
          operationId,
          endpointId,
          viewer.eventId,
          viewer.organisationId,
          status,
        ),
        this.env.DB.prepare(
          `
          INSERT INTO audit_events (
            id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
            entity_type, entity_id, correlation_id, metadata_json, created_at
          ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, ?, 'webhook_endpoint', ?, ?, '{}', unixepoch()
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
        atomicBatchGuardStatement(
          this.env,
          `NOT EXISTS (
             SELECT 1 FROM webhook_endpoints
              WHERE id = ? AND event_id = ? AND organisation_id = ?
                AND status = ? AND last_operation_id = ?
           )`,
          [
            endpointId,
            viewer.eventId,
            viewer.organisationId,
            status,
            operationId,
          ],
        ),
      ]);
    } catch (error) {
      if (!isAtomicBatchGuardError(error)) throw error;
      throw await this.statusConflict(viewer, endpointId, status);
    }
    return { endpointId, status };
  }

  private async statusConflict(
    viewer: Viewer,
    endpointId: string,
    status: "active" | "disabled",
  ): Promise<Error> {
    const current = await this.env.DB.prepare(
      `SELECT secret_ciphertext AS secretCiphertext
         FROM webhook_endpoints
        WHERE id = ? AND event_id = ? AND organisation_id = ?`,
    )
      .bind(endpointId, viewer.eventId, viewer.organisationId)
      .first<{ secretCiphertext: string }>();
    if (
      status === "active" &&
      current &&
      webhookSecretWasErased(current.secretCiphertext)
    ) {
      return new WebhookEndpointCredentialsErasedError();
    }
    return new WebhookEndpointNotFoundError();
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
          this.env.WEBHOOK_CREDENTIALS_PREVIOUS_KEY,
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
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'webhook_endpoint.secret_rotated',
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
