import { z } from "zod";

import type { AuditOrigin } from "~/platform/audit/audit-contract";
import type { Viewer } from "~/platform/auth/authorize.server";
import { outboundWebhookEventTypeSchema } from "./webhook-schema";

export const webhookQueueEventSchema = z
  .object({
    eventType: outboundWebhookEventTypeSchema,
    entityType: z.string().trim().min(1).max(100),
    entityId: z.string().trim().min(1).max(200),
    idempotencyKey: z.string().trim().min(8).max(128),
    correlationId: z.string().trim().min(1).max(200),
    data: z.record(z.string(), z.unknown()),
  })
  .strict();

export type WebhookQueueEventInput = z.infer<typeof webhookQueueEventSchema>;

export type WebhookEventScope = Pick<Viewer, "organisationId" | "eventId"> & {
  personId: string | null;
  actorId?: string;
};

export type WebhookExplicitAuditOrigin = Extract<
  AuditOrigin,
  "admin_ui" | "participant_ui" | "public_form" | "api" | "internal"
>;

export type WebhookEventActor =
  | (WebhookEventScope & {
      personId: string;
      auditOrigin: WebhookExplicitAuditOrigin;
    })
  | (WebhookEventScope & {
      personId: null;
      actorId: string;
      auditOrigin?: never;
    })
  | (WebhookEventScope & {
      personId: null;
      actorId?: never;
      auditOrigin: WebhookExplicitAuditOrigin;
    });

export function webhookActorForAudit(
  actor: WebhookEventScope & { actorId?: never },
  auditOrigin: WebhookExplicitAuditOrigin,
): WebhookEventActor {
  return actor.personId === null
    ? { ...actor, personId: null, auditOrigin }
    : { ...actor, personId: actor.personId, auditOrigin };
}

export class WebhookAuditOriginRequiredError extends Error {
  constructor() {
    super(
      "Standalone webhook events without an API-key actor require an explicit audit origin.",
    );
    this.name = "WebhookAuditOriginRequiredError";
  }
}

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

export function webhookPayloadData(
  input: Pick<WebhookQueueEventInput, "entityType" | "entityId" | "data">,
) {
  return {
    ...input.data,
    entityType: input.entityType,
    entityId: input.entityId,
  };
}

export function webhookRequestHash(input: {
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

export type WebhookEventResultStatus =
  | "queued"
  | "queue_failed"
  | "completed"
  | "partially_failed"
  | "failed"
  | "cancelled";

export function webhookReplayStatus(status: string): WebhookEventResultStatus {
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
