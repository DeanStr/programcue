import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  handleProgramCueQueueMessage,
  processCommunicationSend,
  processDecisionNotification,
  processSubmissionNotification,
  QUEUE_CLAIM_LEASE_SECONDS,
} from "../../../workers/communications-queue";
import {
  CommunicationQueueUnavailableError,
  CommunicationService,
} from "./communication-service.server";
import { snapshotSourceValues } from "./communication-service-shared";
import { CommunicationDeliveryService } from "./communication-delivery-service.server";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { CommunicationTemplateService } from "./communication-template-service.server";
import { MailpitEmailProvider } from "./mailpit.server";
import { RecipientQuery } from "./recipient-query.server";
import { ResendEmailProvider } from "./resend.server";
import {
  createCommunicationUnsubscribeUrl,
  describeCommunicationUnsubscribe,
  unsubscribeFromOptionalCommunication,
} from "./unsubscribe.server";
import { verifyResendWebhook } from "./resend-webhook.server";

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
  describe("delivery planning workflows", () => {
    it("binds an idempotency key to the exact confirmed send request", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const firstTemplate = await service.saveTemplate(viewer, {
        name: "First idempotent update",
        category: "ad_hoc",
        subject: "First update",
        content: {
          body: "First body.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      const secondTemplate = await service.saveTemplate(viewer, {
        name: "Second idempotent update",
        category: "ad_hoc",
        subject: "Second update",
        content: {
          body: "Second body.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, firstTemplate.versionId);
      await service.publishTemplate(viewer, secondTemplate.versionId);
      const idempotencyKey = `communication-request-${crypto.randomUUID()}`;
      const original = {
        templateVersionId: firstTemplate.versionId,
        audienceType: "manual" as const,
        manualRecipients: "recipient@example.com",
        kind: "transactional" as const,
        idempotencyKey,
      };
      const confirmed = await confirmPreviewed(service, original);

      await expect(
        confirmPreviewed(service, {
          ...original,
          templateVersionId: secondTemplate.versionId,
        }),
      ).rejects.toThrow(/different communication request/i);
      await expect(
        confirmPreviewed(service, { ...original, kind: "optional" }),
      ).rejects.toThrow(/different communication request/i);
      expect(sent).toHaveLength(1);
      expect(
        await testEnv.DB.prepare(
          `
          SELECT length(json_extract(audience_json, '$.requestHash')) AS requestHashLength
            FROM communications WHERE id = ?
        `,
        )
          .bind(confirmed.communicationId)
          .first(),
      ).toEqual({ requestHashLength: 64 });
    });
  });

  describe("delivery planning workflows", () => {
    it("uses a verified Mailpit sender when local capture is explicitly selected", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const mailpitEnv = {
        ...testEnv,
        APP_ENV: "test",
        EMAIL_PROVIDER: "mailpit",
        RESEND_API_KEY: undefined,
        MAILPIT_SEND_API_URL: "https://mailpit.test/api/v1/send",
      } as unknown as CloudflareEnvironment;
      await mailpitEnv.DB.prepare(
        `UPDATE sender_profiles
            SET provider = 'mailpit', status = 'verified'
          WHERE id = 'sender-test-communications' AND event_id = ?`,
      )
        .bind(viewer.eventId)
        .run();
      const service = new CommunicationService(mailpitEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Explicit Mailpit delivery",
        category: "ad_hoc",
        subject: "Captured locally",
        content: {
          body: "This message must use only the selected local provider.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "mailpit-recipient@example.com",
        kind: "transactional",
        idempotencyKey: `mailpit-explicit-${crypto.randomUUID()}`,
      });
      expect(
        await mailpitEnv.DB.prepare(
          "SELECT provider FROM communication_deliveries WHERE communication_id = ?",
        )
          .bind(confirmed.communicationId)
          .first(),
      ).toEqual({ provider: "mailpit" });
      let providerCalls = 0;
      const provider = new MailpitEmailProvider(
        "https://mailpit.test/api/v1/send",
        undefined,
        undefined,
        async () => {
          providerCalls += 1;
          return Response.json({ ID: "mailpit-local-message" });
        },
      );

      await processCommunicationSend(sent[0], mailpitEnv, { email: provider });

      expect(providerCalls).toBe(1);
      expect(
        await mailpitEnv.DB.prepare(
          "SELECT provider, status FROM communication_deliveries WHERE communication_id = ?",
        )
          .bind(confirmed.communicationId)
          .first(),
      ).toEqual({ provider: "mailpit", status: "sent" });
    });
  });

  describe("delivery planning workflows", () => {
    it("preflights communication webhook Queue readiness before recording send intent", async () => {
      const { testEnv } = await communicationEnvironment();
      const endpointId = crypto.randomUUID();
      await testEnv.DB.prepare(
        `INSERT INTO webhook_endpoints (
           id, organisation_id, event_id, name, url, secret_ciphertext,
           event_types_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'Unbound communication webhook',
                   'https://hooks.example.com/unbound-communications', 'unused-in-queue-test',
                   '["communication.completed"]', 'active', unixepoch(), unixepoch())`,
      )
        .bind(endpointId, viewer.organisationId, viewer.eventId)
        .run();
      const missingQueueEnv = {
        ...testEnv,
        OPERATIONS_QUEUE: undefined,
      } as unknown as CloudflareEnvironment;
      const service = new CommunicationService(missingQueueEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Webhook readiness template",
        category: "ad_hoc",
        subject: "Webhook readiness update",
        content: {
          body: "The send must not start without its required webhook Queue.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const input = {
        templateVersionId: saved.versionId,
        audienceType: "manual" as const,
        manualRecipients: "webhook-readiness@example.com",
        kind: "transactional" as const,
        idempotencyKey: `webhook-readiness-${crypto.randomUUID()}`,
      };
      const preview = await service.preview(viewer, input);

      await expect(
        service.confirm(viewer, { ...input, ...preview.confirmation }),
      ).rejects.toMatchObject({ name: "WebhookQueueConfigurationError" });
      await expect(
        testEnv.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM communications
               WHERE event_id = ? AND idempotency_key = ?) AS communicationCount,
             (SELECT COUNT(*) FROM webhook_deliveries
               WHERE endpoint_id = ?) AS webhookCount`,
        )
          .bind(viewer.eventId, input.idempotencyKey, endpointId)
          .first(),
      ).resolves.toEqual({ communicationCount: 0, webhookCount: 0 });
      await testEnv.DB.prepare("DELETE FROM webhook_endpoints WHERE id = ?")
        .bind(endpointId)
        .run();
    });

    it("queues the advertised communication.completed webhook from terminal recipient state", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const endpointId = crypto.randomUUID();
      await testEnv.DB.prepare(
        `INSERT INTO webhook_endpoints (
           id, organisation_id, event_id, name, url, secret_ciphertext,
           event_types_json, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'Communication completion receiver',
                   'https://hooks.example.com/communications', 'unused-in-queue-test',
                   '["communication.completed"]', 'active', unixepoch(), unixepoch())`,
      )
        .bind(endpointId, viewer.organisationId, viewer.eventId)
        .run();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Completion webhook template",
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
        manualRecipients: "Webhook Recipient <completion-webhook@example.com>",
        kind: "transactional",
        idempotencyKey: `completion-webhook-${crypto.randomUUID()}`,
      });
      let providerCalls = 0;
      const provider = new ResendEmailProvider(
        "completion-webhook-provider-key",
        async () => {
          providerCalls += 1;
          return Response.json({ id: "resend-completion-webhook" });
        },
      );

      let injectedWebhookFailure = false;
      const interruptedDb = new Proxy(testEnv.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (
                providerCalls === 1 &&
                statements.length === 9 &&
                !injectedWebhookFailure
              ) {
                injectedWebhookFailure = true;
                throw new Error("Injected webhook outbox persistence failure");
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });

      await expect(
        processCommunicationSend(
          sent[0],
          { ...testEnv, DB: interruptedDb } as CloudflareEnvironment,
          { email: provider },
        ),
      ).rejects.toThrow("Injected webhook outbox persistence failure");
      expect(providerCalls).toBe(1);

      await processCommunicationSend(sent[0], testEnv, { email: provider });

      expect(providerCalls).toBe(1);
      expect(sent).toHaveLength(2);
      expect(
        await testEnv.DB.prepare(
          `SELECT event_type AS eventType, entity_id AS entityId, payload_json AS payloadJson
             FROM webhook_deliveries
            WHERE endpoint_id = ?`,
        )
          .bind(endpointId)
          .first<{
            eventType: string;
            entityId: string;
            payloadJson: string;
          }>(),
      ).toMatchObject({
        eventType: "communication.completed",
        entityId: confirmed.communicationId,
      });
      const delivery = await testEnv.DB.prepare(
        `SELECT payload_json AS payloadJson
           FROM webhook_deliveries
          WHERE endpoint_id = ?`,
      )
        .bind(endpointId)
        .first<{ payloadJson: string }>();
      expect(JSON.parse(delivery!.payloadJson)).toMatchObject({
        type: "communication.completed",
        data: {
          entityId: confirmed.communicationId,
          status: "sent",
          total: 1,
          succeeded: 1,
          failed: 0,
        },
      });
    });
  });

  describe("delivery planning workflows", () => {
    it("processes large recipient sets in bounded Queue passes", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Bounded delivery update",
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
        (_, index) => `Recipient ${index} <bounded-${index}@example.com>`,
      ).join(", ");
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: recipients,
        kind: "transactional",
        idempotencyKey: `bounded-send-${crypto.randomUUID()}`,
      });
      const providerRequests: string[] = [];
      const provider = new ResendEmailProvider(
        "bounded-send-provider-key",
        async (_input, init) => {
          const request = JSON.parse(String(init?.body)) as { to: string[] };
          providerRequests.push(request.to[0]);
          return Response.json({
            id: `bounded-provider-${providerRequests.length}`,
          });
        },
      );

      await processCommunicationSend(sent[0], testEnv, { email: provider });
      expect(providerRequests).toHaveLength(10);
      expect(sent).toHaveLength(2);
      expect(
        await env.DB.prepare(
          `SELECT c.status AS communicationStatus, o.status AS operationStatus,
                  o.progress_total AS progressTotal, o.progress_completed AS progressCompleted
             FROM communications c
             JOIN operation_jobs o ON o.id = c.operation_id
            WHERE c.id = ?`,
        )
          .bind(confirmed.communicationId)
          .first(),
      ).toEqual({
        communicationStatus: "queued",
        operationStatus: "queued",
        progressTotal: 12,
        progressCompleted: 10,
      });

      await processCommunicationSend(sent[1], testEnv, { email: provider });
      expect(providerRequests).toHaveLength(12);
      expect(sent).toHaveLength(2);
      expect(
        await env.DB.prepare(
          `SELECT c.status AS communicationStatus, o.status AS operationStatus,
                  o.progress_total AS progressTotal, o.progress_completed AS progressCompleted
             FROM communications c
             JOIN operation_jobs o ON o.id = c.operation_id
            WHERE c.id = ?`,
        )
          .bind(confirmed.communicationId)
          .first(),
      ).toEqual({
        communicationStatus: "sent",
        operationStatus: "completed",
        progressTotal: 12,
        progressCompleted: 12,
      });
    });
  });

  describe("delivery planning workflows", () => {
    it("rechecks global provider suppression before transactional delivery", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Transactional suppression check",
        category: "ad_hoc",
        subject: "Decision from {{event.name}}",
        content: {
          body: "Hello {{recipient.firstName}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "provider-suppressed@example.com",
        kind: "transactional",
        idempotencyKey: `transactional-suppression-${crypto.randomUUID()}`,
      });
      await testEnv.DB.prepare(
        `INSERT INTO communication_unsubscribes (
           id, event_id, address, category, reason, created_at
         ) VALUES (?, ?, 'provider-suppressed@example.com', '*',
                   'email.suppressed', unixepoch())`,
      )
        .bind(crypto.randomUUID(), viewer.eventId)
        .run();
      let providerCalls = 0;
      await processCommunicationSend(sent[0], testEnv, {
        email: new ResendEmailProvider("suppressed-provider-key", async () => {
          providerCalls += 1;
          return Response.json({ id: "must-not-send-suppressed" });
        }),
      });

      expect(providerCalls).toBe(0);
      expect(
        await testEnv.DB.prepare(
          `SELECT d.status AS deliveryStatus, d.failure_code AS failureCode,
                  c.status AS communicationStatus, o.status AS operationStatus
             FROM communication_deliveries d
             JOIN communications c ON c.id = d.communication_id
             JOIN operation_jobs o ON o.id = c.operation_id
            WHERE c.id = ?`,
        )
          .bind(confirmed.communicationId)
          .first(),
      ).toEqual({
        deliveryStatus: "suppressed",
        failureCode: "recipient_unsubscribed",
        communicationStatus: "failed",
        operationStatus: "failed",
      });
    });
  });

  describe("delivery planning workflows", () => {
    it("rechecks sender authority after acquiring the send claim", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Sender disable race update",
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
        idempotencyKey: `disable-sender-race-${crypto.randomUUID()}`,
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
      const worker = processCommunicationSend(sent[0], workerEnv, {
        email: new ResendEmailProvider(
          "disable-race-provider-key",
          async () => {
            providerRequests.push({ sent: true });
            return Response.json({ id: "must-not-send" });
          },
        ),
      });
      await claimReached;
      try {
        await testEnv.DB.prepare(
          "UPDATE sender_profiles SET status = 'disabled' WHERE id = ? AND event_id = ?",
        )
          .bind("sender-test-communications", viewer.eventId)
          .run();
      } finally {
        releaseClaim();
      }

      await expect(worker).rejects.toThrow(
        "A verified sender profile is unavailable.",
      );
      expect(providerRequests).toHaveLength(0);
      await env.DB.prepare(
        "UPDATE sender_profiles SET status = 'verified' WHERE id = ? AND event_id = ?",
      )
        .bind("sender-test-communications", viewer.eventId)
        .run();
      await expect(
        env.DB.prepare(
          `SELECT status, last_error AS lastError, claim_token AS claimToken
             FROM operation_jobs WHERE id = ?`,
        )
          .bind(confirmed.operationId)
          .first(),
      ).resolves.toMatchObject({
        status: "failed",
        lastError: expect.stringContaining("verified sender profile"),
        claimToken: null,
      });
    });
  });
});
