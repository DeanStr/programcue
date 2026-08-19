import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { OperationService } from "~/platform/operations/operation-service.server";
import {
  handleProgramCueQueueMessage,
  processCommunicationSend,
  processDecisionNotification,
  QUEUE_CLAIM_LEASE_SECONDS,
} from "../../../workers/communications-queue";
import {
  CommunicationQueueUnavailableError,
  CommunicationService,
} from "./communication-service.server";
import { prepareDecisionNotificationIntent } from "./decision-notification-intent.server";
import { ResendEmailProvider } from "./resend.server";
import {
  createCommunicationUnsubscribeUrl,
  describeCommunicationUnsubscribe,
  unsubscribeFromOptionalCommunication,
} from "./unsubscribe.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

afterEach(() => vi.restoreAllMocks());

async function communicationEnvironment() {
  const sent: unknown[] = [];
  const realtime: unknown[] = [];
  const eventChannel = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(_input: RequestInfo | URL, init?: RequestInit) {
          realtime.push(JSON.parse(String(init?.body)));
          return Response.json({ accepted: true });
        },
      };
    },
  };
  const testEnv = {
    ...(env as unknown as CloudflareEnvironment),
    SOURCE_REVISION: "test-revision",
    DB: env.DB,
    RESEND_API_KEY: "test-resend-key",
    OPERATIONS_QUEUE: {
      send: async (message: unknown) => {
        sent.push(message);
      },
    },
    EVENT_CHANNEL: eventChannel,
  } as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await env.DB.prepare(
    "DELETE FROM webhook_endpoints WHERE event_id = ? AND name = 'Communication completion receiver'",
  )
    .bind(viewer.eventId)
    .run();
  await env.DB.prepare(
    `
    INSERT OR IGNORE INTO sender_profiles (
      id, event_id, name, from_name, from_email, reply_to_email, provider, status, created_at, updated_at
    ) VALUES ('sender-test-communications', ?, 'Test communications', 'Program Cue', 'events@example.com',
              'reply@example.com', 'resend', 'verified', unixepoch(), unixepoch())
  `,
  )
    .bind(viewer.eventId)
    .run();
  await env.DB.prepare(
    `UPDATE sender_profiles
        SET provider = 'resend', status = 'verified'
      WHERE id = 'sender-test-communications' AND event_id = ?`,
  )
    .bind(viewer.eventId)
    .run();
  return { testEnv, sent, realtime };
}

async function confirmPreviewed(
  service: CommunicationService,
  input: Parameters<CommunicationService["preview"]>[1] & {
    idempotencyKey: string;
  },
) {
  const preview = await service.preview(viewer, input);
  return service.confirm(viewer, {
    ...input,
    ...preview.confirmation,
  });
}

describe("Communications D1 vertical slice", () => {
  describe("provider delivery workflows", () => {
    it("keeps a queue-failed replay failed and points to the durable operation", async () => {
      const log = vi
        .spyOn(console, "error")
        .mockImplementation(() => undefined);
      const { testEnv } = await communicationEnvironment();
      let dispatchAttempts = 0;
      testEnv.OPERATIONS_QUEUE = {
        send: async () => {
          dispatchAttempts += 1;
          throw new Error("private queue transport detail");
        },
      } as unknown as Queue;
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Queue failure update",
        category: "ad_hoc",
        subject: "Queue failure update",
        content: {
          body: "Queue failure body.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const input = {
        templateVersionId: saved.versionId,
        audienceType: "manual" as const,
        manualRecipients: "recipient@example.com",
        kind: "transactional" as const,
        idempotencyKey: `communication-queue-failure-${crypto.randomUUID()}`,
      };
      const preview = await service.preview(viewer, input);
      const confirmation = { ...input, ...preview.confirmation };
      let initialError: unknown;
      try {
        await service.confirm(viewer, confirmation);
      } catch (error) {
        initialError = error;
      }
      expect(initialError).toBeInstanceOf(CommunicationQueueUnavailableError);
      expect((initialError as Error).message).not.toContain(
        "private queue transport detail",
      );
      const operationId = (initialError as CommunicationQueueUnavailableError)
        .operationId;
      expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
        subsystem: "communication-dispatch",
        event: "queue-dispatch-failed",
        sourceRevision: "test-revision",
        eventId: viewer.eventId,
        operationId,
        provider: "cloudflare-queue",
        message: "The durable communication operation could not be queued.",
      });
      expect(JSON.stringify(log.mock.calls)).not.toContain(
        "private queue transport detail",
      );

      await expect(service.confirm(viewer, confirmation)).rejects.toMatchObject(
        {
          name: "CommunicationQueueUnavailableError",
          operationId,
        },
      );
      expect(dispatchAttempts).toBe(1);
      expect(
        await testEnv.DB.prepare(
          `
          SELECT communication.status, operation.status AS operationStatus
            FROM communications communication
            JOIN operation_jobs operation ON operation.id = communication.operation_id
           WHERE communication.operation_id = ?
        `,
        )
          .bind(operationId)
          .first(),
      ).toEqual({ status: "failed", operationStatus: "queue_failed" });
    });

    it("derives a stable provider-safe delivery key for maximum-length inputs", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Long-address update",
        category: "ad_hoc",
        subject: "Update from {{event.name}}",
        content: {
          body: "Hello {{recipient.firstName}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);

      const recipientAddress = `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(57)}`;
      const idempotencyKey = "i".repeat(128);
      const input = {
        templateVersionId: saved.versionId,
        audienceType: "manual" as const,
        manualRecipients: recipientAddress,
        kind: "transactional" as const,
        idempotencyKey,
      };
      const confirmed = await confirmPreviewed(service, input);
      const delivery = await env.DB.prepare(
        `
        SELECT idempotency_key AS idempotencyKey
          FROM communication_deliveries
         WHERE communication_id = ?
      `,
      )
        .bind(confirmed.communicationId)
        .first<{ idempotencyKey: string }>();
      expect(delivery).not.toBeNull();

      const digest = new Uint8Array(
        await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(
            JSON.stringify([idempotencyKey, recipientAddress]),
          ),
        ),
      );
      const fingerprint = Array.from(digest, (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      const expectedKey = `programcue:communication-delivery:v1:${fingerprint}`;
      expect(delivery?.idempotencyKey).toBe(expectedKey);
      expect(delivery?.idempotencyKey).toHaveLength(101);
      expect(delivery?.idempotencyKey.length).toBeLessThanOrEqual(256);
      expect(delivery?.idempotencyKey).not.toContain(recipientAddress);

      await expect(confirmPreviewed(service, input)).resolves.toMatchObject({
        communicationId: confirmed.communicationId,
        duplicate: true,
      });
      expect(
        await env.DB.prepare(
          `
        SELECT COUNT(*) AS count, MIN(idempotency_key) AS idempotencyKey
          FROM communication_deliveries
         WHERE communication_id = ?
      `,
        )
          .bind(confirmed.communicationId)
          .first(),
      ).toEqual({ count: 1, idempotencyKey: expectedKey });

      const providerKeys: string[] = [];
      const providerTags: unknown[] = [];
      const provider = new ResendEmailProvider(
        "long-address-provider-key",
        async (_input, init) => {
          providerKeys.push(
            new Headers(init?.headers).get("idempotency-key") ?? "",
          );
          providerTags.push(
            (JSON.parse(String(init?.body)) as { tags?: unknown }).tags,
          );
          return Response.json({ id: "resend-long-address-001" });
        },
      );
      await processCommunicationSend(sent[0], testEnv, { email: provider });
      expect(providerKeys).toEqual([expectedKey]);
      expect(providerTags).toEqual([
        [{ name: "program_cue_delivery", value: "tracked" }],
      ]);
    });

    it("rejects provider drift before claiming or sending a queued communication", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Provider-bound update",
        category: "ad_hoc",
        subject: "Provider-bound update",
        content: {
          body: "This delivery must use its recorded provider.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "provider-bound@example.com",
        kind: "transactional",
        idempotencyKey: `provider-bound-${crypto.randomUUID()}`,
      });
      await testEnv.DB.prepare(
        "UPDATE communication_deliveries SET provider = 'mailpit' WHERE communication_id = ?",
      )
        .bind(confirmed.communicationId)
        .run();
      let providerCalls = 0;
      const provider = new ResendEmailProvider(
        "provider-drift-test-key",
        async () => {
          providerCalls += 1;
          return Response.json({ id: "must-not-send-provider-drift" });
        },
      );

      await expect(
        processCommunicationSend(sent[0], testEnv, { email: provider }),
      ).rejects.toThrow(/provider does not match its durable intent/i);
      expect(providerCalls).toBe(0);
      await expect(
        testEnv.DB.prepare(
          `SELECT communication.status, operation.status AS operationStatus,
                  operation.claim_token AS claimToken
             FROM communications communication
             JOIN operation_jobs operation ON operation.id = communication.operation_id
            WHERE communication.id = ?`,
        )
          .bind(confirmed.communicationId)
          .first(),
      ).resolves.toEqual({
        status: "queued",
        operationStatus: "queued",
        claimToken: null,
      });
    });
  });

  describe("provider delivery workflows", () => {
    it("renders a signed unsubscribe link only for optional email and rechecks opt-outs before provider delivery", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Optional event update",
        category: "ad_hoc",
        subject: "Optional update from {{event.name}}",
        content: {
          body: "Hello {{recipient.firstName}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "Optional Recipient <optional-link@example.com>",
        kind: "optional",
        idempotencyKey: `optional-link-${crypto.randomUUID()}`,
      });

      const requests: Array<Record<string, unknown>> = [];
      const provider = new ResendEmailProvider(
        "optional-link-provider-key",
        async (_input, init) => {
          requests.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return Response.json({ id: `resend-optional-${requests.length}` });
        },
      );
      await processCommunicationSend(sent[0], testEnv, { email: provider });
      expect(requests).toHaveLength(1);
      const html = String(requests[0]?.html);
      const href = html.match(
        /href="([^"]*\/communications\/unsubscribe\/[^"]+)"/,
      )?.[1];
      expect(href).toBeDefined();
      const unsubscribeUrl = new URL(href!);
      expect(unsubscribeUrl.origin).toBe("http://localhost");
      const token = decodeURIComponent(
        unsubscribeUrl.pathname.split("/").at(-1)!,
      );
      await expect(
        describeCommunicationUnsubscribe(testEnv, token),
      ).resolves.toMatchObject({
        eventId: viewer.eventId,
        address: "optional-link@example.com",
        category: "ad_hoc",
        isUnsubscribed: false,
      });
      const [encodedPayload, encodedSignature] = token.split(".");
      if (!encodedPayload || !encodedSignature)
        throw new Error("Expected a signed unsubscribe token.");
      const tamperedSignature = `${encodedSignature[0] === "A" ? "B" : "A"}${encodedSignature.slice(1)}`;
      await expect(
        describeCommunicationUnsubscribe(
          testEnv,
          `${encodedPayload}.${tamperedSignature}`,
        ),
      ).rejects.toThrow("invalid or has expired");
      await expect(
        unsubscribeFromOptionalCommunication(testEnv, token),
      ).resolves.toMatchObject({ changed: true });
      await expect(
        unsubscribeFromOptionalCommunication(testEnv, token),
      ).resolves.toMatchObject({ changed: false });

      const lateConfirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "Late Recipient <late-optout@example.com>",
        kind: "optional",
        idempotencyKey: `late-optout-${crypto.randomUUID()}`,
      });
      const lateDelivery = await env.DB.prepare(
        `
        SELECT id FROM communication_deliveries WHERE communication_id = ?
      `,
      )
        .bind(lateConfirmed.communicationId)
        .first<{ id: string }>();
      expect(lateDelivery).not.toBeNull();
      const lateUrl = await createCommunicationUnsubscribeUrl(
        testEnv,
        lateDelivery!.id,
      );
      const lateToken = decodeURIComponent(
        new URL(lateUrl).pathname.split("/").at(-1)!,
      );
      await unsubscribeFromOptionalCommunication(testEnv, lateToken);
      await processCommunicationSend(sent[1], testEnv, { email: provider });
      expect(requests).toHaveLength(1);
      expect(
        await env.DB.prepare(
          `
        SELECT d.status AS deliveryStatus, d.failure_code AS failureCode,
               oi.status AS itemStatus, c.status AS communicationStatus, o.status AS operationStatus
          FROM communication_deliveries d
          JOIN communications c ON c.id = d.communication_id
          JOIN operation_jobs o ON o.id = c.operation_id
          JOIN operation_items oi ON oi.operation_id = o.id AND oi.entity_id = d.id
         WHERE c.id = ?
      `,
        )
          .bind(lateConfirmed.communicationId)
          .first(),
      ).toEqual({
        deliveryStatus: "suppressed",
        failureCode: "recipient_unsubscribed",
        itemStatus: "skipped",
        communicationStatus: "failed",
        operationStatus: "failed",
      });
    });

    it("fails optional delivery before the provider when secure unsubscribe signing is unavailable", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Secure optional update",
        category: "ad_hoc",
        subject: "Optional update",
        content: {
          body: "Hello.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "secure-optout@example.com",
        kind: "optional",
        idempotencyKey: `secure-optout-${crypto.randomUUID()}`,
      });
      let providerCalls = 0;
      const provider = new ResendEmailProvider(
        "must-not-send-provider-key",
        async () => {
          providerCalls += 1;
          return Response.json({ id: "must-not-send" });
        },
      );
      const insecureEnv = {
        ...testEnv,
        BETTER_AUTH_SECRET: undefined,
      } as CloudflareEnvironment;
      await processCommunicationSend(sent[0], insecureEnv, { email: provider });
      expect(providerCalls).toBe(0);
      expect(
        await env.DB.prepare(
          `
        SELECT d.status AS deliveryStatus, d.failure_code AS failureCode,
               c.status AS communicationStatus, o.status AS operationStatus
          FROM communication_deliveries d
          JOIN communications c ON c.id = d.communication_id
          JOIN operation_jobs o ON o.id = c.operation_id
         WHERE c.id = ?
      `,
        )
          .bind(confirmed.communicationId)
          .first(),
      ).toEqual({
        deliveryStatus: "failed",
        failureCode: "UnsubscribeConfigurationError",
        communicationStatus: "failed",
        operationStatus: "failed",
      });
    });

    it("reclaims an expired communication claim after a crash before provider delivery", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Crash recovery update",
        category: "ad_hoc",
        subject: "Update from {{event.name}}",
        content: {
          body: "Hello {{recipient.firstName}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "Crash Recovery <crash-recovery@example.com>",
        kind: "transactional",
        idempotencyKey: `communication-crash-${crypto.randomUUID()}`,
      });

      let committedClaim = false;
      const crashingDb = new Proxy(testEnv.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              const results = await target.batch(statements);
              if (!committedClaim) {
                committedClaim = true;
                throw new Error(
                  "Injected crash after communication claim commit",
                );
              }
              return results;
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const crashEnv = { ...testEnv, DB: crashingDb } as CloudflareEnvironment;
      let providerCalls = 0;
      const provider = new ResendEmailProvider(
        "crash-recovery-provider-key",
        async () => {
          providerCalls += 1;
          return Response.json({ id: "resend-crash-recovery" });
        },
      );

      await expect(
        processCommunicationSend(sent[0], crashEnv, { email: provider }),
      ).rejects.toThrow("Injected crash after communication claim commit");
      expect(providerCalls).toBe(0);
      expect(
        await env.DB.prepare(
          `
        SELECT status, claim_token IS NOT NULL AS hasClaim,
               claim_expires_at > unixepoch() AS leaseActive
          FROM operation_jobs WHERE id = ?
      `,
        )
          .bind(confirmed.operationId)
          .first(),
      ).toEqual({ status: "running", hasClaim: 1, leaseActive: 1 });

      await env.DB.prepare(
        `UPDATE operation_jobs SET claim_expires_at = unixepoch() - 1 WHERE id = ?`,
      )
        .bind(confirmed.operationId)
        .run();
      await processCommunicationSend(sent[0], testEnv, { email: provider });
      expect(providerCalls).toBe(1);
      expect(
        await env.DB.prepare(
          `
        SELECT o.status AS operationStatus, o.claim_token AS claimToken,
               o.claim_expires_at AS claimExpiresAt, c.status AS communicationStatus,
               d.status AS deliveryStatus
          FROM operation_jobs o
          JOIN communications c ON c.operation_id = o.id
          JOIN communication_deliveries d ON d.communication_id = c.id
         WHERE o.id = ?
      `,
        )
          .bind(confirmed.operationId)
          .first(),
      ).toEqual({
        operationStatus: "completed",
        claimToken: null,
        claimExpiresAt: null,
        communicationStatus: "sent",
        deliveryStatus: "sent",
      });
    });

    it("delays an exact Queue redelivery while its communication lease is active", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Busy lease update",
        category: "ad_hoc",
        subject: "Update from {{event.name}}",
        content: {
          body: "Hello.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "Busy Lease <busy-lease@example.com>",
        kind: "transactional",
        idempotencyKey: `communication-busy-${crypto.randomUUID()}`,
      });
      await env.DB.batch([
        env.DB.prepare(
          `UPDATE communications SET status = 'sending' WHERE id = ?`,
        ).bind(confirmed.communicationId),
        env.DB.prepare(
          `UPDATE operation_jobs
          SET status = 'running', claim_token = 'active-test-claim',
              claim_expires_at = unixepoch() + ?, updated_at = unixepoch()
          WHERE id = ?`,
        ).bind(QUEUE_CLAIM_LEASE_SECONDS, confirmed.operationId),
      ]);

      let acknowledgements = 0;
      const retries: QueueRetryOptions[] = [];
      const queueMessage = {
        id: "busy-lease-message",
        timestamp: new Date(),
        attempts: 2,
        body: sent[0],
        ack() {
          acknowledgements += 1;
        },
        retry(options?: QueueRetryOptions) {
          retries.push(options ?? {});
        },
      } satisfies Message;
      await handleProgramCueQueueMessage(queueMessage, testEnv);
      expect(acknowledgements).toBe(0);
      expect(retries).toEqual([{ delaySeconds: QUEUE_CLAIM_LEASE_SECONDS }]);
      expect(
        await env.DB.prepare(
          "SELECT status, claim_token AS claimToken FROM operation_jobs WHERE id = ?",
        )
          .bind(confirmed.operationId)
          .first(),
      ).toEqual({ status: "running", claimToken: "active-test-claim" });
    });
  });

  describe("provider delivery workflows", () => {
    it("fails durably and retries when an owned delivery becomes unclaimable", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Delivery claim invariant",
        category: "ad_hoc",
        subject: "Update from {{event.name}}",
        content: {
          body: "Hello {{recipient.firstName}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "Claim Invariant <claim-invariant@example.com>",
        kind: "transactional",
        idempotencyKey: `communication-claim-invariant-${crypto.randomUUID()}`,
      });

      let batchCount = 0;
      const changingDb = new Proxy(testEnv.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              batchCount += 1;
              if (batchCount === 2) {
                await target
                  .prepare(
                    `UPDATE communication_deliveries
                  SET status = 'cancelled' WHERE communication_id = ?`,
                  )
                  .bind(confirmed.communicationId)
                  .run();
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const workerEnv = { ...testEnv, DB: changingDb } as CloudflareEnvironment;
      let acknowledgements = 0;
      const retries: QueueRetryOptions[] = [];
      const queueMessage = {
        id: "claim-invariant-message",
        timestamp: new Date(),
        attempts: 1,
        body: sent[0],
        ack() {
          acknowledgements += 1;
        },
        retry(options?: QueueRetryOptions) {
          retries.push(options ?? {});
        },
      } satisfies Message;

      await handleProgramCueQueueMessage(queueMessage, workerEnv);

      expect(acknowledgements).toBe(0);
      expect(retries).toEqual([{}]);
      expect(
        await env.DB.prepare(
          `
        SELECT o.status AS operationStatus, o.claim_token IS NOT NULL AS hasClaim,
               c.status AS communicationStatus, d.status AS deliveryStatus
          FROM operation_jobs o
          JOIN communications c ON c.operation_id = o.id
          JOIN communication_deliveries d ON d.communication_id = c.id
         WHERE o.id = ?
      `,
        )
          .bind(confirmed.operationId)
          .first(),
      ).toEqual({
        operationStatus: "failed",
        hasClaim: 0,
        communicationStatus: "failed",
        deliveryStatus: "cancelled",
      });
    });
  });

  describe("provider delivery workflows", () => {
    it("delivers through Resend and derives a monotonic status from persisted delivery events", async () => {
      const { testEnv, sent, realtime } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Ad hoc update",
        category: "ad_hoc",
        subject: "Update from {{event.name}}",
        content: {
          body: "Hello {{recipient.firstName}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "Avery Example <avery@example.com>",
        kind: "transactional",
        idempotencyKey: `delivery-test-${crypto.randomUUID()}`,
      });
      const requests: Array<Record<string, unknown>> = [];
      const provider = new ResendEmailProvider(
        "provider-test-key",
        async (_input, init) => {
          requests.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return Response.json({ id: "resend-message-001" });
        },
      );
      await processCommunicationSend(sent[0], testEnv, { email: provider });
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        to: ["avery@example.com"],
        subject: "Update from Future of Events 2027",
      });
      expect(String(requests[0]?.html)).not.toContain(
        "/communications/unsubscribe/",
      );
      expect(realtime).toHaveLength(1);
      expect(realtime[0]).toMatchObject({
        type: "event-change",
        entityType: "communication",
        entityId: confirmed.communicationId,
        changeType: "progress",
      });

      const delivered = await env.DB.prepare(
        `
        SELECT d.status, d.provider, d.provider_message_id AS providerMessageId,
               c.status AS communicationStatus, o.status AS operationStatus
          FROM communication_deliveries d
          JOIN communications c ON c.id = d.communication_id
          JOIN operation_jobs o ON o.id = c.operation_id
         WHERE c.id = ?
      `,
      )
        .bind(confirmed.communicationId)
        .first<{
          status: string;
          provider: string;
          providerMessageId: string;
          communicationStatus: string;
          operationStatus: string;
        }>();
      expect(delivered).toEqual({
        status: "sent",
        provider: "resend",
        providerMessageId: "resend-message-001",
        communicationStatus: "sent",
        operationStatus: "completed",
      });

      const payload = JSON.stringify({
        type: "email.delivered",
        created_at: new Date().toISOString(),
        data: { email_id: "resend-message-001" },
      });
      const realtimeBeforeWebhook = realtime.length;
      await expect(
        service.reconcileResendEvent(
          JSON.parse(payload),
          payload,
          "provider-event-001",
        ),
      ).resolves.toEqual({ matched: true, duplicate: false });
      await expect(
        service.reconcileResendEvent(
          JSON.parse(payload),
          payload,
          "provider-event-001",
        ),
      ).resolves.toEqual({ matched: true, duplicate: true });
      expect(realtime).toHaveLength(realtimeBeforeWebhook + 1);
      expect(realtime.at(-1)).toMatchObject({
        type: "event-change",
        entityType: "communication_delivery",
        changeType: "progress",
      });
      await expect(
        env.DB.prepare(
          `SELECT COUNT(*) AS count
             FROM event_changes
            WHERE event_id = ? AND entity_type = 'communication_delivery'
              AND correlation_id = 'provider-event-001'`,
        )
          .bind(viewer.eventId)
          .first(),
      ).resolves.toEqual({ count: 1 });
      const invalidTimestampPayload = JSON.stringify({
        type: "email.opened",
        created_at: "not-a-provider-timestamp",
        data: { email_id: "resend-message-001" },
      });
      await expect(
        service.reconcileResendEvent(
          JSON.parse(invalidTimestampPayload),
          invalidTimestampPayload,
          "provider-event-invalid-timestamp",
        ),
      ).rejects.toThrow();
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM communication_delivery_events
        WHERE provider_event_id = 'provider-event-invalid-timestamp'`,
        ).first(),
      ).toEqual({ count: 0 });
      const reconciled = await env.DB.prepare(
        "SELECT status FROM communication_deliveries WHERE provider_message_id = 'resend-message-001'",
      ).first<{ status: string }>();
      expect(reconciled?.status).toBe("delivered");

      const bouncePayload = JSON.stringify({
        type: "email.bounced",
        created_at: new Date(Date.now() + 20_000).toISOString(),
        data: { email_id: "resend-message-001" },
      });
      await service.reconcileResendEvent(
        JSON.parse(bouncePayload),
        bouncePayload,
        "provider-event-002",
      );
      const delayedSentPayload = JSON.stringify({
        type: "email.sent",
        created_at: new Date(Date.now() - 20_000).toISOString(),
        data: { email_id: "resend-message-001" },
      });
      await service.reconcileResendEvent(
        JSON.parse(delayedSentPayload),
        delayedSentPayload,
        "provider-event-003",
      );
      expect(
        await env.DB.prepare(
          `
        SELECT d.status, d.failure_code AS failureCode, c.status AS communicationStatus
          FROM communication_deliveries d
          JOIN communications c ON c.id = d.communication_id
         WHERE d.provider_message_id = 'resend-message-001'
      `,
        ).first(),
      ).toEqual({
        status: "bounced",
        failureCode: "email.bounced",
        communicationStatus: "failed",
      });

      const suppressedPayload = JSON.stringify({
        type: "email.suppressed",
        created_at: new Date(Date.now() + 40_000).toISOString(),
        data: { email_id: "resend-message-001" },
      });
      await service.reconcileResendEvent(
        JSON.parse(suppressedPayload),
        suppressedPayload,
        "provider-event-004",
      );
      expect(
        await env.DB.prepare(
          `
        SELECT d.status, d.failure_code AS failureCode, c.status AS communicationStatus
          FROM communication_deliveries d
          JOIN communications c ON c.id = d.communication_id
         WHERE d.provider_message_id = 'resend-message-001'
      `,
        ).first(),
      ).toEqual({
        status: "suppressed",
        failureCode: "email.suppressed",
        communicationStatus: "failed",
      });

      expect(
        await env.DB.prepare(
          `
        SELECT address, category, reason, revoked_at AS revokedAt
          FROM communication_unsubscribes
         WHERE event_id = ? AND address = 'avery@example.com' AND category = '*'
      `,
        )
          .bind(viewer.eventId)
          .first(),
      ).toEqual({
        address: "avery@example.com",
        category: "*",
        reason: "email.suppressed",
        revokedAt: null,
      });
      await env.DB.prepare(
        `
        UPDATE communication_unsubscribes SET revoked_at = unixepoch()
         WHERE event_id = ? AND address = 'avery@example.com' AND category = '*'
      `,
      )
        .bind(viewer.eventId)
        .run();
      const complainedPayload = JSON.stringify({
        type: "email.complained",
        created_at: new Date(Date.now() + 60_000).toISOString(),
        data: { email_id: "resend-message-001" },
      });
      await expect(
        service.reconcileResendEvent(
          JSON.parse(complainedPayload),
          complainedPayload,
          "provider-event-005",
        ),
      ).resolves.toEqual({ matched: true, duplicate: false });
      await expect(
        service.reconcileResendEvent(
          JSON.parse(complainedPayload),
          complainedPayload,
          "provider-event-005",
        ),
      ).resolves.toEqual({ matched: true, duplicate: true });
      const newerGenericFailure = JSON.stringify({
        type: "email.failed",
        created_at: new Date(Date.now() + 120_000).toISOString(),
        data: { email_id: "resend-message-001" },
      });
      await service.reconcileResendEvent(
        JSON.parse(newerGenericFailure),
        newerGenericFailure,
        "provider-event-006",
      );
      await expect(
        env.DB.prepare(
          "SELECT status, failure_code AS failureCode FROM communication_deliveries WHERE provider_message_id = 'resend-message-001'",
        ).first(),
      ).resolves.toEqual({
        status: "suppressed",
        failureCode: "email.complained",
      });
      expect(
        await env.DB.prepare(
          `
        SELECT reason, revoked_at AS revokedAt
          FROM communication_unsubscribes
         WHERE event_id = ? AND address = 'avery@example.com' AND category = '*'
      `,
        )
          .bind(viewer.eventId)
          .first(),
      ).toEqual({ reason: "email.complained", revokedAt: null });

      const optionalPreview = await service.preview(viewer, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "avery@example.com",
        kind: "optional",
      });
      expect(optionalPreview.recipients.deliverable).toHaveLength(0);
      expect(
        optionalPreview.recipients.suppressed.map(
          (recipient) => recipient.address,
        ),
      ).toEqual(["avery@example.com"]);
      const transactionalPreview = await service.preview(viewer, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "avery@example.com",
        kind: "transactional",
      });
      expect(transactionalPreview.recipients.deliverable).toHaveLength(0);
      expect(
        transactionalPreview.recipients.suppressed.map(
          (recipient) => recipient.address,
        ),
      ).toEqual(["avery@example.com"]);
    });
  });

  describe("provider delivery workflows", () => {
    it("selects the delivery batch after a delayed worker acquires the claim", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Delayed claim delivery update",
        category: "ad_hoc",
        subject: "Update from {{event.name}}",
        content: {
          body: "Hello {{recipient.firstName}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const recipients = Array.from(
        { length: 12 },
        (_, index) => `Delayed ${index} <delayed-${index}@example.com>`,
      ).join(", ");
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: recipients,
        kind: "transactional",
        idempotencyKey: `delayed-claim-send-${crypto.randomUUID()}`,
      });
      const providerRequests: string[] = [];
      const provider = new ResendEmailProvider(
        "delayed-claim-provider-key",
        async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as { to: string[] };
          providerRequests.push(request.to[0]);
          return Response.json({
            id: `delayed-claim-provider-${providerRequests.length}`,
          });
        },
      );

      let releaseClaim!: () => void;
      const claimReleased = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      let claimReachedResolve!: () => void;
      const claimReached = new Promise<void>((resolve) => {
        claimReachedResolve = resolve;
      });
      let interceptedClaim = false;
      const delayedDb = new Proxy(testEnv.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!interceptedClaim) {
                interceptedClaim = true;
                claimReachedResolve();
                await claimReleased;
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const staleEnv = { ...testEnv, DB: delayedDb } as CloudflareEnvironment;
      const staleWorker = processCommunicationSend(sent[0], staleEnv, {
        email: provider,
      });
      await claimReached;
      try {
        await processCommunicationSend(sent[0], testEnv, { email: provider });
      } finally {
        releaseClaim();
      }
      await staleWorker;

      expect(providerRequests).toHaveLength(12);
      expect(new Set(providerRequests).size).toBe(12);
      expect(sent).toHaveLength(2);
      await expect(
        testEnv.DB.prepare(
          `SELECT c.status AS communicationStatus,
                  o.status AS operationStatus,
                  o.progress_total AS progressTotal,
                  o.progress_completed AS progressCompleted,
                  o.progress_failed AS progressFailed,
                  SUM(CASE WHEN d.status = 'sent' THEN 1 ELSE 0 END) AS sentCount,
                  SUM(CASE WHEN d.status = 'failed' THEN 1 ELSE 0 END) AS failedCount
             FROM communications c
             JOIN operation_jobs o ON o.id = c.operation_id
             JOIN communication_deliveries d ON d.communication_id = c.id
            WHERE c.id = ?
            GROUP BY c.id, o.id`,
        )
          .bind(confirmed.communicationId)
          .first(),
      ).resolves.toEqual({
        communicationStatus: "sent",
        operationStatus: "completed",
        progressTotal: 12,
        progressCompleted: 12,
        progressFailed: 0,
        sentCount: 12,
        failedCount: 0,
      });
    });
  });

  describe("provider delivery workflows", () => {
    it("does not call the provider when cancellation wins the send claim race", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Cancelled race update",
        category: "ad_hoc",
        subject: "Update from {{event.name}}",
        content: {
          body: "Hello {{recipient.firstName}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "Casey Example <casey@example.com>",
        kind: "transactional",
        idempotencyKey: `cancel-send-race-${crypto.randomUUID()}`,
      });

      let releaseClaim!: () => void;
      const claimReleased = new Promise<void>((resolve) => {
        releaseClaim = resolve;
      });
      let claimReachedResolve!: () => void;
      const claimReached = new Promise<void>((resolve) => {
        claimReachedResolve = resolve;
      });
      let interceptedClaim = false;
      const delayedDb = new Proxy(testEnv.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!interceptedClaim) {
                interceptedClaim = true;
                claimReachedResolve();
                await claimReleased;
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const workerEnv = { ...testEnv, DB: delayedDb } as CloudflareEnvironment;
      const providerRequests: unknown[] = [];
      const provider = new ResendEmailProvider(
        "cancel-race-provider-key",
        async () => {
          providerRequests.push({ sent: true });
          return Response.json({ id: "must-not-send" });
        },
      );

      const worker = processCommunicationSend(sent[0], workerEnv, {
        email: provider,
      });
      await claimReached;
      try {
        await service.cancel(viewer, confirmed.communicationId);
      } finally {
        releaseClaim();
      }
      await worker;

      expect(providerRequests).toHaveLength(0);
      expect(
        await env.DB.prepare(
          `
        SELECT c.status AS communicationStatus, c.cancelled_at IS NOT NULL AS wasCancelled,
               d.status AS deliveryStatus, o.status AS operationStatus, oi.status AS itemStatus,
               (SELECT COUNT(*) FROM audit_events cancellation_audit
                 WHERE cancellation_audit.action = 'communication.cancelled'
                   AND cancellation_audit.entity_id = c.id) AS cancellationAuditCount,
               (SELECT COUNT(*) FROM audit_events completion_audit
                 WHERE completion_audit.action = 'communication.delivery.finished'
                   AND completion_audit.entity_id = c.id) AS completionAuditCount
          FROM communications c
          JOIN communication_deliveries d ON d.communication_id = c.id
          JOIN operation_jobs o ON o.id = c.operation_id
          JOIN operation_items oi ON oi.operation_id = o.id AND oi.entity_id = d.id
         WHERE c.id = ?
      `,
        )
          .bind(confirmed.communicationId)
          .first(),
      ).toEqual({
        communicationStatus: "cancelled",
        wasCancelled: 1,
        deliveryStatus: "cancelled",
        operationStatus: "cancelled",
        itemStatus: "skipped",
        cancellationAuditCount: 1,
        completionAuditCount: 0,
      });
    });
  });

  describe("provider delivery workflows", () => {
    it("sends the recipient and template pinned at decision release exactly once", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const template = await service.saveTemplate(viewer, {
        name: "Decision notification",
        category: "decision",
        subject: "Your proposal was {{decision.outcome}}",
        content: {
          body: "Hi {{recipient.firstName}},\n\n{{submission.title}} was {{decision.outcome}}.\n\n{{decision.rationale}}\n\nReviewer feedback:\n{{decision.feedback}}",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, template.versionId);
      await service.saveTemplate(viewer, {
        templateId: template.templateId,
        name: "Unpublished task reminder reclassification",
        category: "task_reminder",
        subject: "This draft must not send",
        content: {
          body: "This unpublished draft must not replace the live decision message.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      const token = crypto.randomUUID().slice(0, 8);
      const submissionId = `decision-submission-${token}`;
      const decisionId = `decision-${token}`;
      const operationId = `decision-operation-${token}`;
      const event = await env.DB.prepare(
        `SELECT name, brand_accent AS brandAccent, starts_at AS startsAt,
                ends_at AS endsAt
           FROM events WHERE id = ?`,
      )
        .bind(viewer.eventId)
        .first<{
          name: string;
          brandAccent: string;
          startsAt: number;
          endsAt: number;
        }>();
      if (!event) throw new Error("Test event is unavailable.");
      const prepared = await prepareDecisionNotificationIntent(testEnv, {
        viewer,
        decisionId,
        operationId,
        submissionId,
        submissionTitle: "A measured proposal",
        decision: "accepted",
        rationale: "A strong fit for this audience.",
        feedback: [
          "Clarify the intended experience level in the final description.",
        ],
        recipientPersonId: "person-demo-submitter",
        recipientAddress: "alex.submitter@example.com",
        recipientName: "Alex Morgan",
        event,
      });
      if (!prepared.intent) throw new Error(prepared.error);
      const intent = prepared.intent;
      const message = JSON.parse(intent.queuePayloadJson) as unknown;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO submissions (
          id, event_id, submitter_person_id, submitter_email, public_reference, title, status,
          answers_json, submitted_snapshot_json, submitted_at, created_at, updated_at
        ) VALUES (?, ?, 'person-demo-submitter', 'alex.submitter@example.com', ?,
                  'A measured proposal', 'accepted', '{}', '{"answers":{},"speakers":[]}',
                  unixepoch(), unixepoch(), unixepoch())`,
        ).bind(submissionId, viewer.eventId, `DEC-${token}`),
        env.DB.prepare(
          `INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type, idempotency_key,
          correlation_id, status, payload_json, progress_total, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'decision.notification', ?, ?, 'queued', ?, 1, unixepoch(), unixepoch())`,
        ).bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          intent.operationIdempotencyKey,
          intent.correlationId,
          intent.queuePayloadJson,
        ),
        env.DB.prepare(
          `INSERT INTO submission_decisions (
          id, event_id, submission_id, revision_number, status, decision, decided_by_person_id,
          rationale, notification_feedback_json, effect_preview_json,
          idempotency_key, notification_operation_id, decided_at, published_at
        ) VALUES (?, ?, ?, 1, 'published', 'accepted', ?, ?, ?, '{}', ?, ?, unixepoch(), unixepoch())`,
        ).bind(
          decisionId,
          viewer.eventId,
          submissionId,
          viewer.personId,
          "A strong fit for this audience.",
          JSON.stringify([
            "Clarify the intended experience level in the final description.",
          ]),
          `decision-${token}`,
          operationId,
        ),
        env.DB.prepare(
          `INSERT INTO communications (
          id, event_id, template_version_id, sender_profile_id, operation_id,
          idempotency_key, kind, channel, status, audience_json,
          content_snapshot_json, recipient_count, queued_at,
          created_by_person_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'transactional', 'email', 'queued', ?, ?, 1,
                  unixepoch(), ?, unixepoch(), unixepoch())`,
        ).bind(
          intent.communicationId,
          viewer.eventId,
          intent.templateVersionId,
          intent.senderProfileId,
          operationId,
          intent.operationIdempotencyKey,
          intent.audienceJson,
          intent.contentSnapshotJson,
          viewer.personId,
        ),
        env.DB.prepare(
          `INSERT INTO communication_deliveries (
          id, event_id, communication_id, person_id, recipient_address,
          recipient_name, source_id, source_values_json, channel, provider,
          idempotency_key, status, rendered_subject, rendered_body_sha256,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'email', ?, ?, 'queued', ?, ?,
                  unixepoch(), unixepoch())`,
        ).bind(
          intent.deliveryId,
          viewer.eventId,
          intent.communicationId,
          intent.recipientPersonId,
          intent.recipientAddress,
          intent.recipientName,
          submissionId,
          intent.sourceValuesJson,
          intent.senderProvider,
          intent.deliveryIdempotencyKey,
          intent.renderedSubject,
          intent.renderedBodySha256,
        ),
        env.DB.prepare(
          `INSERT INTO operation_items (
          id, operation_id, item_key, entity_type, entity_id, status,
          result_json, updated_at
        ) VALUES (?, ?, ?, 'communication_delivery', ?, 'pending', '{}', unixepoch())`,
        ).bind(
          intent.operationItemId,
          operationId,
          intent.deliveryIdempotencyKey,
          intent.deliveryId,
        ),
      ]);
      await expect(
        env.DB.prepare(
          `INSERT INTO communications (
             id, event_id, template_version_id, sender_profile_id, operation_id,
             idempotency_key, kind, channel, status, audience_json,
             content_snapshot_json, recipient_count, created_by_person_id
           ) VALUES (?, ?, ?, ?, ?, ?, 'transactional', 'email', 'queued', ?,
                     '{}', 1, ?)`,
        )
          .bind(
            `malformed-decision-communication-${token}`,
            viewer.eventId,
            intent.templateVersionId,
            intent.senderProfileId,
            operationId,
            `malformed-decision-communication-key-${token}`,
            intent.audienceJson,
            viewer.personId,
          )
          .run(),
      ).rejects.toThrow(
        /decision communication requires complete pinned intent/i,
      );
      await expect(
        env.DB.prepare(
          `INSERT INTO communication_deliveries (
             id, event_id, communication_id, person_id, recipient_address,
             recipient_name, source_id, source_values_json, channel, provider,
             idempotency_key, status, rendered_subject, rendered_body_sha256
           ) VALUES (?, ?, ?, ?, ?, NULL, ?, ?, 'email', ?, ?, 'queued', ?, ?)`,
        )
          .bind(
            `malformed-decision-delivery-${token}`,
            viewer.eventId,
            intent.communicationId,
            intent.recipientPersonId,
            intent.recipientAddress,
            submissionId,
            intent.sourceValuesJson,
            intent.senderProvider,
            `malformed-decision-delivery-key-${token}`,
            intent.renderedSubject,
            intent.renderedBodySha256,
          )
          .run(),
      ).rejects.toThrow(/decision delivery requires complete pinned evidence/i);
      await expect(
        env.DB.prepare(
          `UPDATE operation_jobs SET payload_json = '{}'
            WHERE id = ?`,
        )
          .bind(operationId)
          .run(),
      ).rejects.toThrow(/decision notification operation intent is immutable/i);
      await expect(
        env.DB.prepare(
          `UPDATE communications SET content_snapshot_json = '{}'
            WHERE id = ?`,
        )
          .bind(intent.communicationId)
          .run(),
      ).rejects.toThrow(/decision communication intent is immutable/i);
      await expect(
        env.DB.prepare(
          `UPDATE communication_deliveries
              SET recipient_address = 'substituted@example.com'
            WHERE id = ?`,
        )
          .bind(intent.deliveryId)
          .run(),
      ).rejects.toThrow(/decision delivery intent is immutable/i);
      const replacement = await service.saveTemplate(viewer, {
        templateId: template.templateId,
        name: "Decision notification changed after release",
        category: "decision",
        subject: "Changed subject for {{submission.title}}",
        content: {
          body: "This newer template must not replace released intent.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, replacement.versionId);
      await env.DB.prepare(
        `UPDATE submissions SET submitter_email = 'changed@example.com'
          WHERE id = ? AND event_id = ?`,
      )
        .bind(submissionId, viewer.eventId)
        .run();
      await env.DB.prepare(
        `UPDATE sender_profiles
            SET from_name = 'Changed sender', from_email = 'changed-sender@example.com',
                reply_to_email = 'changed-reply@example.com'
          WHERE id = ? AND event_id = ?`,
      )
        .bind(intent.senderProfileId, viewer.eventId)
        .run();
      const requests: Array<Record<string, unknown>> = [];
      const providerKeys: string[] = [];
      const provider = new ResendEmailProvider(
        "decision-provider-key",
        async (_input, init) => {
          providerKeys.push(
            new Headers(init?.headers).get("idempotency-key") ?? "",
          );
          requests.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          if (requests.length === 1) {
            return Response.json(
              { name: "rate_limited", message: "Retry the request." },
              { status: 429 },
            );
          }
          return Response.json({ id: "resend-decision-001" });
        },
      );
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE submission_decisions SET status = 'superseded' WHERE id = ?",
        ).bind(decisionId),
        env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'cancelled', completed_at = unixepoch()
            WHERE id = ?`,
        ).bind(operationId),
      ]);
      await processDecisionNotification(message, testEnv, { email: provider });
      expect(requests).toHaveLength(0);
      await env.DB.batch([
        env.DB.prepare(
          "UPDATE submission_decisions SET status = 'published' WHERE id = ?",
        ).bind(decisionId),
        env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'queued', completed_at = NULL
            WHERE id = ?`,
        ).bind(operationId),
      ]);
      await processDecisionNotification(message, testEnv, { email: provider });
      expect(requests).toHaveLength(1);
      expect(
        await env.DB.prepare(
          `SELECT o.status AS operationStatus, c.status AS communicationStatus,
                  d.status AS deliveryStatus, oi.status AS itemStatus
             FROM operation_jobs o
             JOIN communications c ON c.operation_id = o.id
             JOIN communication_deliveries d ON d.communication_id = c.id
             JOIN operation_items oi
               ON oi.operation_id = o.id AND oi.entity_id = d.id
            WHERE o.id = ?`,
        )
          .bind(operationId)
          .first(),
      ).toEqual({
        operationStatus: "failed",
        communicationStatus: "failed",
        deliveryStatus: "failed",
        itemStatus: "failed",
      });

      await new OperationService(testEnv).retry(viewer, operationId);
      expect(sent).toEqual([message]);
      expect(
        await env.DB.prepare(
          `SELECT o.status AS operationStatus, c.status AS communicationStatus,
                  d.status AS deliveryStatus, d.failure_code AS failureCode,
                  oi.status AS itemStatus, oi.error_code AS itemErrorCode
             FROM operation_jobs o
             JOIN communications c ON c.operation_id = o.id
             JOIN communication_deliveries d ON d.communication_id = c.id
             JOIN operation_items oi
               ON oi.operation_id = o.id AND oi.entity_id = d.id
            WHERE o.id = ?`,
        )
          .bind(operationId)
          .first(),
      ).toEqual({
        operationStatus: "queued",
        communicationStatus: "queued",
        deliveryStatus: "queued",
        failureCode: null,
        itemStatus: "pending",
        itemErrorCode: null,
      });
      await processDecisionNotification(sent[0], testEnv, { email: provider });
      await processDecisionNotification(sent[0], testEnv, { email: provider });
      expect(requests).toHaveLength(2);
      expect(new Set(providerKeys).size).toBe(1);
      expect(providerKeys[1]).toMatch(
        /^programcue:communication-delivery:v1:[0-9a-f]{64}$/,
      );
      expect(requests[1]).toMatchObject({
        from: `"${intent.senderFromName}" <${intent.senderFromEmail}>`,
        to: ["alex.submitter@example.com"],
        subject: "Your proposal was accepted",
      });
      expect(JSON.stringify(requests[1])).toContain(
        "A strong fit for this audience.",
      );
      expect(JSON.stringify(requests[1])).toContain(
        "Clarify the intended experience level",
      );
      expect(JSON.stringify(requests[1])).not.toContain("changed@example.com");
      expect(JSON.stringify(requests[1])).not.toContain("Changed subject");
      expect(
        await env.DB.prepare(
          `
        SELECT o.status AS operationStatus, c.status AS communicationStatus,
               d.provider_message_id AS providerMessageId
          FROM operation_jobs o
          JOIN communications c ON c.operation_id = o.id
          JOIN communication_deliveries d ON d.communication_id = c.id
         WHERE o.id = ?
      `,
        )
          .bind(operationId)
          .first(),
      ).toEqual({
        operationStatus: "completed",
        communicationStatus: "sent",
        providerMessageId: "resend-decision-001",
      });

      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO communication_unsubscribes (
             id, event_id, address, category, reason, created_at
           ) VALUES (?, ?, ?, '*', 'email.suppressed', unixepoch())`,
        ).bind(crypto.randomUUID(), viewer.eventId, intent.recipientAddress),
        env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'queued', progress_completed = 0,
                  progress_failed = 0, completed_at = NULL
            WHERE id = ?`,
        ).bind(operationId),
        env.DB.prepare(
          `UPDATE communications SET status = 'queued', sent_at = NULL
            WHERE id = ?`,
        ).bind(intent.communicationId),
        env.DB.prepare(
          `UPDATE communication_deliveries
              SET status = 'queued', provider_message_id = NULL,
                  failure_code = NULL, failure_message = NULL
            WHERE id = ?`,
        ).bind(intent.deliveryId),
        env.DB.prepare(
          `UPDATE operation_items
              SET status = 'pending', error_code = NULL, error_message = NULL,
                  completed_at = NULL
            WHERE id = ?`,
        ).bind(intent.operationItemId),
      ]);
      await processDecisionNotification(message, testEnv, { email: provider });
      expect(requests).toHaveLength(2);
      expect(
        await env.DB.prepare(
          `SELECT o.status AS operationStatus,
                  d.status AS deliveryStatus,
                  d.failure_code AS failureCode
             FROM operation_jobs o
             JOIN communications c ON c.operation_id = o.id
             JOIN communication_deliveries d ON d.communication_id = c.id
            WHERE o.id = ?`,
        )
          .bind(operationId)
          .first(),
      ).toEqual({
        operationStatus: "failed",
        deliveryStatus: "suppressed",
        failureCode: "recipient_unsubscribed",
      });
    });

    it("rejects included reviewer feedback that exceeds the durable email budget", async () => {
      const { testEnv } = await communicationEnvironment();
      const event = await env.DB.prepare(
        `SELECT name, brand_accent AS brandAccent, starts_at AS startsAt,
                ends_at AS endsAt
           FROM events WHERE id = ?`,
      )
        .bind(viewer.eventId)
        .first<{
          name: string;
          brandAccent: string;
          startsAt: number;
          endsAt: number;
        }>();
      if (!event) throw new Error("Test event is unavailable.");
      await expect(
        prepareDecisionNotificationIntent(testEnv, {
          viewer,
          decisionId: "decision-feedback-limit",
          operationId: "operation-feedback-limit",
          submissionId: "submission-feedback-limit",
          submissionTitle: "A measured proposal",
          decision: "rejected",
          rationale: "The programme is already full.",
          feedback: ["x".repeat(64_001)],
          recipientPersonId: "person-demo-submitter",
          recipientAddress: "alex.submitter@example.com",
          recipientName: "Alex Morgan",
          event,
        }),
      ).resolves.toMatchObject({
        error: expect.stringMatching(/too long to send/i),
        intent: null,
      });
    });
  });
});
