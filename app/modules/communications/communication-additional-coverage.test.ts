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
import { CommunicationService } from "./communication-service.server";
import { RecipientQuery } from "./recipient-query.server";
import { ResendEmailProvider } from "./resend.server";

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
  describe("additional workflow coverage", () => {
    it("addresses incomplete-speaker reminders to the task target rather than its optional owner", async () => {
      const { testEnv } = await communicationEnvironment();
      const token = crypto.randomUUID();
      const targetId = `reminder-target-${token}`;
      const ownerId = `reminder-owner-${token}`;
      const targetAddress = `reminder-target-${token}@example.com`;
      const ownerAddress = `reminder-owner-${token}@example.com`;
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status,
             created_at, updated_at
           ) VALUES (?, ?, 'Reminder target', 1, 'draft', unixepoch(), unixepoch())`,
        ).bind(targetId, targetAddress),
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status,
             created_at, updated_at
           ) VALUES (?, ?, 'Different owner', 1, 'draft', unixepoch(), unixepoch())`,
        ).bind(ownerId, ownerAddress),
        testEnv.DB.prepare(
          `INSERT INTO event_speaker_workflows (
             event_id, person_id, status, source, last_operation_id,
             updated_by_person_id, created_at, updated_at
           ) VALUES (?, ?, 'confirmed', 'manual', ?, ?, unixepoch(), unixepoch())`,
        ).bind(
          viewer.eventId,
          targetId,
          `reminder-workflow-${token}`,
          viewer.personId,
        ),
        testEnv.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, owner_person_id, title,
             task_type, impact, status, readiness_state, created_at, updated_at
           ) VALUES (?, ?, 'speaker', ?, ?, 'Targeted reminder', 'checklist',
                     'medium', 'not_started', 'on_track', unixepoch(), unixepoch())`,
        ).bind(`reminder-task-${token}`, viewer.eventId, targetId, ownerId),
      ]);

      const preview = await new RecipientQuery(testEnv).preview(viewer, {
        audienceType: "incomplete_speakers",
        manualRecipients: "",
        category: "task_reminder",
        kind: "transactional",
      });
      expect(preview.deliverable).toContainEqual(
        expect.objectContaining({
          personId: targetId,
          address: targetAddress,
          sourceId: `reminder-task-${token}`,
        }),
      );
      expect(
        preview.deliverable.some(
          (recipient) => recipient.address === ownerAddress,
        ),
      ).toBe(false);
    });

    it("excludes declined and withdrawn speaker workflows from task reminders", async () => {
      const { testEnv } = await communicationEnvironment();
      const token = crypto.randomUUID();
      const activeId = `reminder-active-${token}`;
      const declinedId = `reminder-declined-${token}`;
      const withdrawnId = `reminder-withdrawn-${token}`;
      await testEnv.DB.batch(
        [activeId, declinedId, withdrawnId].flatMap((personId, index) => [
          testEnv.DB.prepare(
            `INSERT INTO people (
               id, email, display_name, email_verified, profile_status,
               created_at, updated_at
             ) VALUES (?, ?, ?, 1, 'draft', unixepoch(), unixepoch())`,
          ).bind(
            personId,
            `${personId}@example.com`,
            `Reminder ${index} speaker`,
          ),
          testEnv.DB.prepare(
            `INSERT INTO event_speaker_workflows (
               event_id, person_id, status, source, last_operation_id,
               updated_by_person_id, created_at, updated_at
             ) VALUES (?, ?, ?, 'manual', ?, ?, unixepoch(), unixepoch())`,
          ).bind(
            viewer.eventId,
            personId,
            index === 0 ? "confirmed" : index === 1 ? "declined" : "withdrawn",
            `reminder-status-workflow-${personId}`,
            viewer.personId,
          ),
          testEnv.DB.prepare(
            `INSERT INTO task_instances (
               id, event_id, target_type, target_id, title, task_type,
               impact, status, readiness_state, created_at, updated_at
             ) VALUES (?, ?, 'speaker', ?, 'Outstanding speaker task',
                       'checklist', 'medium', 'not_started', 'on_track',
                       unixepoch(), unixepoch())`,
          ).bind(`reminder-status-task-${personId}`, viewer.eventId, personId),
        ]),
      );

      const preview = await new RecipientQuery(testEnv).preview(viewer, {
        audienceType: "incomplete_speakers",
        manualRecipients: "",
        category: "task_reminder",
        kind: "transactional",
      });
      const addresses = preview.deliverable.map(
        (recipient) => recipient.address,
      );
      expect(addresses).toContain(`${activeId}@example.com`);
      expect(addresses).not.toContain(`${declinedId}@example.com`);
      expect(addresses).not.toContain(`${withdrawnId}@example.com`);
    });
  });

  describe("additional workflow coverage", () => {
    it("rejects non-HTTPS email action URLs", async () => {
      const { testEnv } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);

      await expect(
        service.saveTemplate(viewer, {
          name: "Unsafe action URL",
          category: "ad_hoc",
          subject: "Event update",
          content: {
            body: "Review the event update.",
            physicalAddress: "100 Programme Way, Toronto",
            buttonText: "Review",
            buttonUrl: "data:text/html,unsafe",
          },
        }),
      ).rejects.toThrow(/must use HTTPS/i);
    });
  });

  describe("additional workflow coverage", () => {
    it("persists a terminal operation failure before retrying an unclaimable send", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Sender removed before delivery",
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
        manualRecipients: "Missing Sender <missing-sender@example.com>",
        kind: "transactional",
        idempotencyKey: `communication-missing-sender-${crypto.randomUUID()}`,
      });
      await env.DB.prepare(
        "UPDATE sender_profiles SET status = 'disabled' WHERE event_id = ?",
      )
        .bind(viewer.eventId)
        .run();

      let acknowledgements = 0;
      const retries: QueueRetryOptions[] = [];
      const queueMessage = {
        id: "missing-sender-message",
        timestamp: new Date(),
        attempts: 3,
        body: sent[0],
        ack() {
          acknowledgements += 1;
        },
        retry(options?: QueueRetryOptions) {
          retries.push(options ?? {});
        },
      } satisfies Message;
      await handleProgramCueQueueMessage(queueMessage, testEnv);
      await env.DB.prepare(
        "UPDATE sender_profiles SET status = 'verified' WHERE event_id = ?",
      )
        .bind(viewer.eventId)
        .run();

      expect(acknowledgements).toBe(0);
      expect(retries).toEqual([{}]);
      expect(
        await env.DB.prepare(
          `
        SELECT o.status AS operationStatus, o.last_error AS lastError,
               o.claim_token AS claimToken, c.status AS communicationStatus,
               d.status AS deliveryStatus, oi.status AS itemStatus
          FROM operation_jobs o
          JOIN communications c ON c.operation_id = o.id
          JOIN communication_deliveries d ON d.communication_id = c.id
          JOIN operation_items oi ON oi.operation_id = o.id AND oi.entity_id = d.id
         WHERE o.id = ?
      `,
        )
          .bind(confirmed.operationId)
          .first(),
      ).toMatchObject({
        operationStatus: "failed",
        lastError: expect.stringContaining(
          "verified sender profile is unavailable",
        ),
        claimToken: null,
        communicationStatus: "failed",
        deliveryStatus: "failed",
        itemStatus: "failed",
      });

      let duplicateProviderCalls = 0;
      await processCommunicationSend(sent[0], testEnv, {
        email: new ResendEmailProvider(
          "terminal-redelivery-provider-key",
          async () => {
            duplicateProviderCalls += 1;
            return Response.json({ id: "unexpected-duplicate-send" });
          },
        ),
      });
      expect(duplicateProviderCalls).toBe(0);
    });
  });

  describe("additional workflow coverage", () => {
    it("fails durably and retries an owned communication with incomplete deliveries", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Incomplete delivery invariant",
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
        manualRecipients:
          "Incomplete Delivery <incomplete-delivery@example.com>",
        kind: "transactional",
        idempotencyKey: `communication-incomplete-${crypto.randomUUID()}`,
      });
      await env.DB.prepare(
        `UPDATE communication_deliveries
        SET status = 'cancelled' WHERE communication_id = ?`,
      )
        .bind(confirmed.communicationId)
        .run();

      let acknowledgements = 0;
      const retries: QueueRetryOptions[] = [];
      const queueMessage = {
        id: "incomplete-delivery-message",
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

      await handleProgramCueQueueMessage(queueMessage, testEnv);

      expect(acknowledgements).toBe(0);
      expect(retries).toEqual([{}]);
      expect(
        await env.DB.prepare(
          `SELECT status, claim_token IS NOT NULL AS hasClaim
        FROM operation_jobs WHERE id = ?`,
        )
          .bind(confirmed.operationId)
          .first(),
      ).toEqual({ status: "failed", hasClaim: 0 });
    });
  });

  describe("additional workflow coverage", () => {
    it("acknowledges a migration-cancelled legacy decision notification", async () => {
      const { testEnv } = await communicationEnvironment();
      const token = crypto.randomUUID().slice(0, 8);
      const operationId = `legacy-decision-operation-${token}`;
      const message = {
        type: "decision.notification" as const,
        operationId,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        idempotencyKey: `legacy-decision-${token}`,
        payload: { decisionId: `legacy-decision-${token}` },
      };
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO operation_jobs (
             id, organisation_id, event_id, requested_by_person_id, type,
             idempotency_key, correlation_id, status, payload_json,
             completed_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'decision.notification', ?, ?, 'cancelled', ?,
                     unixepoch(), unixepoch(), unixepoch())`,
        ).bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          message.idempotencyKey,
          `legacy-decision-correlation-${token}`,
          JSON.stringify(message),
        ),
        env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id,
             event_id, action, entity_type, entity_id, correlation_id,
             metadata_json, created_at
           ) VALUES (?, 'system', 'internal', 1, ?, ?,
                     'decision.notification.legacy_cancelled', 'operation_job',
                     ?, ?, ?, unixepoch())`,
        ).bind(
          `legacy-decision-cancelled-${token}`,
          viewer.organisationId,
          viewer.eventId,
          operationId,
          `legacy-decision-correlation-${token}`,
          JSON.stringify({
            reason: "legacy intent lacks pinned communication evidence",
          }),
        ),
      ]);
      let acknowledgements = 0;
      const retries: QueueRetryOptions[] = [];
      const queueMessage = {
        id: `legacy-decision-message-${token}`,
        timestamp: new Date(),
        attempts: 1,
        body: message,
        ack() {
          acknowledgements += 1;
        },
        retry(options?: QueueRetryOptions) {
          retries.push(options ?? {});
        },
      } satisfies Message;

      await handleProgramCueQueueMessage(queueMessage, testEnv);

      expect(acknowledgements).toBe(1);
      expect(retries).toEqual([]);
      await expect(
        env.DB.prepare(
          "SELECT status, attempt_count AS attemptCount FROM operation_jobs WHERE id = ?",
        )
          .bind(operationId)
          .first(),
      ).resolves.toEqual({ status: "cancelled", attemptCount: 0 });
    });
  });

  describe("additional workflow coverage", () => {
    it("rejects notification bodies that substitute a same-event domain entity", async () => {
      const { testEnv } = await communicationEnvironment();
      const decisionOperationId = `decision-payload-${crypto.randomUUID()}`;
      const submissionOperationId = `submission-payload-${crypto.randomUUID()}`;
      const decisionMessage = {
        type: "decision.notification" as const,
        operationId: decisionOperationId,
        communicationId: `decision-communication-${decisionOperationId}`,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        idempotencyKey: `decision-payload-${crypto.randomUUID()}`,
        payload: { decisionId: "durable-decision-a" },
      };
      const submissionMessage = {
        type: "submission.notification" as const,
        operationId: submissionOperationId,
        communicationId: `submission-communication-${crypto.randomUUID()}`,
        submissionId: "durable-submission-a",
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        idempotencyKey: `submission-payload-${crypto.randomUUID()}`,
      };
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO operation_jobs (
             id, organisation_id, event_id, requested_by_person_id, type,
             idempotency_key, correlation_id, status, payload_json
           ) VALUES (?, ?, ?, ?, 'decision.notification', ?, ?, 'queued', ?)`,
        ).bind(
          decisionOperationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          decisionMessage.idempotencyKey,
          crypto.randomUUID(),
          JSON.stringify(decisionMessage),
        ),
        testEnv.DB.prepare(
          `INSERT INTO operation_jobs (
             id, organisation_id, event_id, requested_by_person_id, type,
             idempotency_key, correlation_id, status, payload_json
           ) VALUES (?, ?, ?, ?, 'submission.notification', ?, ?, 'queued', ?)`,
        ).bind(
          submissionOperationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          submissionMessage.idempotencyKey,
          crypto.randomUUID(),
          JSON.stringify(submissionMessage),
        ),
      ]);

      await expect(
        processDecisionNotification(
          {
            ...decisionMessage,
            payload: { decisionId: "substituted-decision-b" },
          },
          testEnv,
        ),
      ).rejects.toThrow("does not exist in the authorised event");
      await expect(
        processSubmissionNotification(
          { ...submissionMessage, submissionId: "substituted-submission-b" },
          testEnv,
        ),
      ).rejects.toThrow("does not match its durable operation payload");
      await expect(
        testEnv.DB.prepare(
          `SELECT COUNT(*) AS count FROM communications
            WHERE operation_id IN (?, ?)`,
        )
          .bind(decisionOperationId, submissionOperationId)
          .first(),
      ).resolves.toEqual({ count: 0 });
    });
  });

  describe("additional workflow coverage", () => {
    it("rejects an orphaned decision operation without changing its active lease", async () => {
      const { testEnv } = await communicationEnvironment();
      const token = crypto.randomUUID().slice(0, 8);
      const operationId = `decision-missing-operation-${token}`;
      const message = {
        type: "decision.notification" as const,
        operationId,
        communicationId: `decision-communication-${operationId}`,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        idempotencyKey: `decision-missing-${token}`,
        payload: { decisionId: `missing-decision-${token}` },
      };
      await env.DB.prepare(
        `INSERT INTO operation_jobs (
        id, organisation_id, event_id, requested_by_person_id, type, idempotency_key,
        correlation_id, status, payload_json, progress_total, claim_token, claim_expires_at,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'decision.notification', ?, ?, 'running', ?, 1,
                'active-trigger-claim', unixepoch() + ?, unixepoch(), unixepoch())`,
      )
        .bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          message.idempotencyKey,
          crypto.randomUUID(),
          JSON.stringify(message),
          QUEUE_CLAIM_LEASE_SECONDS,
        )
        .run();

      await expect(
        processDecisionNotification(message, testEnv),
      ).rejects.toThrow("does not exist in the authorised event");
      expect(
        await env.DB.prepare(
          `SELECT status, claim_token AS claimToken
        FROM operation_jobs WHERE id = ?`,
        )
          .bind(operationId)
          .first(),
      ).toEqual({ status: "running", claimToken: "active-trigger-claim" });

      await env.DB.prepare(
        `UPDATE operation_jobs SET claim_expires_at = unixepoch() - 1 WHERE id = ?`,
      )
        .bind(operationId)
        .run();
      await expect(
        processDecisionNotification(message, testEnv),
      ).rejects.toThrow("does not exist in the authorised event");
      expect(
        await env.DB.prepare(
          `SELECT status, claim_token AS claimToken, claim_expires_at AS claimExpiresAt
        FROM operation_jobs WHERE id = ?`,
        )
          .bind(operationId)
          .first(),
      ).toEqual({
        status: "running",
        claimToken: "active-trigger-claim",
        claimExpiresAt: expect.any(Number),
      });
    });
  });
});
