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
  describe("template and draft workflows", () => {
    it("persists, revises, previews and confirms one authoritative draft row", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Durable draft workflow",
        category: "ad_hoc",
        subject: "A current update for {{recipient.firstName}}",
        content: {
          body: "Hello {{recipient.firstName}}, this is the current event update.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);

      const draft = await service.createDraft(viewer, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "Alex Morgan <alex.draft@example.com>",
        kind: "transactional",
        scheduledAt: null,
      });
      expect(draft.revision).toBe(1);
      await expect(service.getDraft(viewer, draft.id)).resolves.toMatchObject({
        id: draft.id,
        manualRecipients: "Alex Morgan <alex.draft@example.com>",
      });

      const firstPreview = await service.previewDraft(viewer, draft.id);
      const revised = await service.updateDraft(viewer, {
        draftId: draft.id,
        revision: draft.revision,
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "Priya Current <priya.current@example.com>",
        kind: "transactional",
        scheduledAt: null,
      });
      expect(revised.revision).toBe(2);
      await expect(
        service.confirmDraft(viewer, {
          draftId: draft.id,
          revision: firstPreview.draft.revision,
          ...firstPreview.preview.confirmation,
        }),
      ).rejects.toThrow("changed after it was previewed");

      const currentPreview = await service.previewDraft(viewer, draft.id);
      const confirmation = {
        draftId: draft.id,
        revision: currentPreview.draft.revision,
        ...currentPreview.preview.confirmation,
      };
      const concurrentAttempts = await Promise.allSettled([
        service.confirmDraft(viewer, confirmation),
        service.confirmDraft(viewer, confirmation),
      ]);
      const fulfilled = concurrentAttempts.filter(
        (
          attempt,
        ): attempt is PromiseFulfilledResult<
          Awaited<ReturnType<CommunicationService["confirmDraft"]>>
        > => attempt.status === "fulfilled",
      );
      expect(fulfilled).toHaveLength(2);
      expect(
        fulfilled.map((attempt) => attempt.value.duplicate).sort(),
      ).toEqual([false, true]);
      const confirmed = fulfilled.find(
        (attempt) => !attempt.value.duplicate,
      )!.value;
      expect(confirmed).toMatchObject({
        communicationId: draft.id,
        status: "queued",
        duplicate: false,
      });
      expect(sent).toHaveLength(1);
      await expect(
        testEnv.DB.prepare(
          `SELECT status, revision, recipient_count AS recipientCount
             FROM communications WHERE id = ?`,
        )
          .bind(draft.id)
          .first(),
      ).resolves.toEqual({ status: "queued", revision: 3, recipientCount: 1 });
      await expect(
        testEnv.DB.prepare(
          `SELECT
             (SELECT COUNT(*) FROM communication_deliveries WHERE communication_id = ?) AS deliveryCount,
             (SELECT COUNT(*) FROM operation_jobs WHERE id = ?) AS operationCount,
             (SELECT COUNT(*) FROM audit_events
               WHERE entity_type = 'communication' AND entity_id = ?
                 AND action = 'communication.queued') AS auditCount,
             (SELECT COUNT(*) FROM event_changes
               WHERE entity_type = 'communication' AND entity_id = ?
                 AND change_type = 'created') AS changeCount`,
        )
          .bind(draft.id, confirmed.operationId, draft.id, draft.id)
          .first(),
      ).resolves.toEqual({
        deliveryCount: 1,
        operationCount: 1,
        auditCount: 1,
        changeCount: 1,
      });
      await expect(service.getDraft(viewer, draft.id)).rejects.toThrow(
        "not found",
      );
      await expect(
        service.confirmDraft(viewer, confirmation),
      ).resolves.toMatchObject({
        communicationId: confirmed.communicationId,
        operationId: confirmed.operationId,
        status: "queued",
        duplicate: true,
      });
      await expect(
        service.confirmDraft(viewer, {
          ...confirmation,
          deliverableFingerprint: `${confirmation.deliverableFingerprint.startsWith("0") ? "1" : "0"}${confirmation.deliverableFingerprint.slice(1)}`,
        }),
      ).rejects.toThrow("idempotency key is already associated");
      expect(sent).toHaveLength(1);

      await testEnv.DB.batch([
        testEnv.DB.prepare(
          "UPDATE communications SET status = 'failed' WHERE id = ?",
        ).bind(draft.id),
        testEnv.DB.prepare(
          "UPDATE operation_jobs SET status = 'failed' WHERE id = ?",
        ).bind(confirmed.operationId),
      ]);
      await expect(service.confirmDraft(viewer, confirmation)).rejects.toThrow(
        "failed and cannot be confirmed again",
      );
      expect(sent).toHaveLength(1);
    });

    it("rejects an exact confirmation replay after a scheduled draft is cancelled", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Cancelled scheduled draft",
        category: "ad_hoc",
        subject: "Scheduled update for {{recipient.firstName}}",
        content: {
          body: "Hello {{recipient.firstName}}, this update was scheduled.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const draft = await service.createDraft(viewer, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients: "Alex Scheduled <alex.scheduled@example.com>",
        kind: "transactional",
        scheduledAt: Math.floor(Date.now() / 1_000) + 3_600,
      });
      const preview = await service.previewDraft(viewer, draft.id);
      const confirmation = {
        draftId: draft.id,
        revision: preview.draft.revision,
        ...preview.preview.confirmation,
      };
      await expect(
        service.confirmDraft(viewer, confirmation),
      ).resolves.toMatchObject({
        communicationId: draft.id,
        operationId: null,
        status: "scheduled",
        duplicate: false,
      });
      await service.cancel(viewer, draft.id);

      await expect(service.confirmDraft(viewer, confirmation)).rejects.toThrow(
        "cancelled and cannot be confirmed again",
      );
      expect(sent).toHaveLength(0);
    });

    it("fails closed before resolving a non-manual audience from an unreadable Airtable projection", async () => {
      const unavailable = new Error("Airtable projection is unavailable.");
      const assertReadable = vi.fn(async () => {
        throw unavailable;
      });
      const service = new CommunicationDeliveryService(
        env as unknown as CloudflareEnvironment,
        {
          airtable: { assertReadable } as unknown as AirtableProviderBoundary,
        },
      );

      await expect(
        service.preview(viewer, {
          templateVersionId: "00000000-0000-4000-8000-000000000001",
          audienceType: "accepted_speakers",
          manualRecipients: "",
          kind: "transactional",
        }),
      ).rejects.toBe(unavailable);
      expect(assertReadable).toHaveBeenCalledWith(viewer);
    });

    it("limits decision audiences to submissions with published decisions", async () => {
      const { testEnv } = await communicationEnvironment();
      const token = crypto.randomUUID();
      const decidedSubmissionId = `decided-audience-${token}`;
      const directSubmissionId = `direct-audience-${token}`;
      const decidedAddress = `decided-${token}@example.com`;
      const directAddress = `direct-${token}@example.com`;
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO submissions (
             id, event_id, submitter_email, public_reference, title, status,
             answers_json, submitted_snapshot_json, submitted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'Decided proposal', 'accepted', '{}',
                     '{"answers":{},"speakers":[]}', unixepoch(), unixepoch(), unixepoch())`,
        ).bind(
          decidedSubmissionId,
          viewer.eventId,
          decidedAddress,
          `DECIDED-${token}`,
        ),
        testEnv.DB.prepare(
          `INSERT INTO submissions (
             id, event_id, submitter_email, public_reference, title, status,
             answers_json, submitted_snapshot_json, submitted_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, 'Direct-session intake', 'accepted', '{}',
                     '{"answers":{},"speakers":[]}', unixepoch(), unixepoch(), unixepoch())`,
        ).bind(
          directSubmissionId,
          viewer.eventId,
          directAddress,
          `DIRECT-${token}`,
        ),
        testEnv.DB.prepare(
          `INSERT INTO submission_decisions (
             id, event_id, submission_id, revision_number, status, decision,
             decided_by_person_id, notification_feedback_json, effect_preview_json,
             decided_at, published_at
           ) VALUES (?, ?, ?, 1, 'published', 'accepted', ?, '[]', '{}',
                     unixepoch(), unixepoch())`,
        ).bind(
          `decision-audience-${token}`,
          viewer.eventId,
          decidedSubmissionId,
          viewer.personId,
        ),
      ]);

      const preview = await new RecipientQuery(testEnv).preview(viewer, {
        audienceType: "decision_recipients",
        manualRecipients: "",
        category: "decision",
        kind: "transactional",
      });

      expect(preview.deliverable).toContainEqual(
        expect.objectContaining({
          address: decidedAddress,
          sourceId: decidedSubmissionId,
        }),
      );
      expect(preview.deliverable).not.toContainEqual(
        expect.objectContaining({
          address: directAddress,
          sourceId: directSubmissionId,
        }),
      );
    });

    it("rejects email template versions without a real subject", async () => {
      const { testEnv } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Subject invariant template",
        category: "ad_hoc",
        subject: "A valid subject",
        content: {
          body: "A valid body.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });

      await expect(
        testEnv.DB.prepare(
          "UPDATE communication_template_versions SET subject_template = NULL WHERE id = ?",
        )
          .bind(saved.versionId)
          .run(),
      ).rejects.toThrow(/CHECK constraint failed/i);
      await expect(
        testEnv.DB.prepare(
          "UPDATE communication_template_versions SET subject_template = '   ' WHERE id = ?",
        )
          .bind(saved.versionId)
          .run(),
      ).rejects.toThrow(/CHECK constraint failed/i);
    });

    it("applies the audience cap after deduplicating accepted speakers", async () => {
      const { testEnv } = await communicationEnvironment();
      const token = crypto.randomUUID();
      const eventId = `recipient-cap-event-${token}`;
      const scopedViewer = { ...viewer, eventId };
      const statements: D1PreparedStatement[] = [
        testEnv.DB.prepare(
          `INSERT INTO events (
             id, organisation_id, name, slug, timezone, starts_at, ends_at,
             file_policy_json
           ) VALUES (?, ?, 'Recipient cap fixture', ?, 'UTC', 1893456000, 1893542400,
                     '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
        ).bind(eventId, viewer.organisationId, `recipient-cap-${token}`),
      ];
      for (let personIndex = 0; personIndex < 2; personIndex += 1) {
        const personId = `recipient-cap-person-${personIndex}-${token}`;
        statements.push(
          testEnv.DB.prepare(
            `INSERT INTO people (
               id, email, display_name, email_verified, profile_status,
               created_at, updated_at
             ) VALUES (?, ?, ?, 1, 'published', unixepoch(), unixepoch())`,
          ).bind(
            personId,
            `recipient-cap-${personIndex}-${token}@example.com`,
            `Recipient ${personIndex}`,
          ),
        );
        for (let sessionIndex = 0; sessionIndex < 2; sessionIndex += 1) {
          const sessionId = `recipient-cap-session-${personIndex}-${sessionIndex}-${token}`;
          statements.push(
            testEnv.DB.prepare(
              `INSERT INTO sessions (
                 id, event_id, title, slug, format, duration_minutes, status,
                 created_at, updated_at
               ) VALUES (?, ?, ?, ?, 'presentation', 30, 'unscheduled', unixepoch(), unixepoch())`,
            ).bind(
              sessionId,
              eventId,
              `Session ${personIndex}-${sessionIndex}`,
              `session-${personIndex}-${sessionIndex}-${token}`,
            ),
            testEnv.DB.prepare(
              `INSERT INTO session_speakers (
                 session_id, event_id, person_id, position, role_label
               ) VALUES (?, ?, ?, 0, 'Speaker')`,
            ).bind(sessionId, eventId, personId),
          );
        }
      }
      await testEnv.DB.batch(statements);

      const recipientQueryClass = RecipientQuery as unknown as {
        maximumBatchSize: number;
      };
      const originalLimit = recipientQueryClass.maximumBatchSize;
      recipientQueryClass.maximumBatchSize = 2;
      try {
        const preview = await new RecipientQuery(testEnv).preview(
          scopedViewer,
          {
            audienceType: "accepted_speakers",
            manualRecipients: "",
            category: "ad_hoc",
            kind: "transactional",
          },
        );
        expect(preview.selected).toBe(2);
        expect(preview.deliverable).toHaveLength(2);
      } finally {
        recipientQueryClass.maximumBatchSize = originalLimit;
      }
    });

    it("includes guaranteed unscheduled direct-session speakers in accepted audiences", async () => {
      const { testEnv } = await communicationEnvironment();
      const token = crypto.randomUUID();
      const personId = `direct-speaker-${token}`;
      const sessionId = `direct-session-${token}`;
      const address = `direct-${token}@example.com`;
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status,
             created_at, updated_at
           ) VALUES (?, ?, 'Guaranteed Speaker', 1, 'draft', unixepoch(), unixepoch())`,
        ).bind(personId, address),
        env.DB.prepare(
          `INSERT INTO sessions (
             id, event_id, title, slug, format, duration_minutes, status,
             created_at, updated_at
           ) VALUES (?, ?, 'Guaranteed contribution', ?, 'presentation', 30,
                     'unscheduled', unixepoch(), unixepoch())`,
        ).bind(sessionId, viewer.eventId, `guaranteed-${token}`),
        env.DB.prepare(
          `INSERT INTO session_speakers (
             session_id, event_id, person_id, position, role_label
           ) VALUES (?, ?, ?, 0, 'Speaker')`,
        ).bind(sessionId, viewer.eventId, personId),
      ]);

      const preview = await new RecipientQuery(testEnv).preview(viewer, {
        audienceType: "accepted_speakers",
        manualRecipients: "",
        category: "ad_hoc",
        kind: "transactional",
      });
      expect(preview.deliverable).toContainEqual(
        expect.objectContaining({ address, sourceId: sessionId }),
      );
    });

    it("includes accepted organisation administrators in an event-administrator audience", async () => {
      const { testEnv } = await communicationEnvironment();
      const token = crypto.randomUUID();
      const personId = `organisation-admin-${token}`;
      const address = `organisation-admin-${token}@example.com`;
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status,
             created_at, updated_at
           ) VALUES (?, ?, 'Organisation administrator', 1, 'published',
                     unixepoch(), unixepoch())`,
        ).bind(personId, address),
        testEnv.DB.prepare(
          `INSERT INTO memberships (
             id, organisation_id, event_id, person_id, role, invited_at,
             invitation_expires_at, accepted_at, created_at
           ) VALUES (?, ?, NULL, ?, 'administrator', unixepoch() - 60,
                     unixepoch() + 604800, unixepoch() - 30, unixepoch())`,
        ).bind(
          `organisation-admin-membership-${token}`,
          viewer.organisationId,
          personId,
        ),
      ]);

      const preview = await new RecipientQuery(testEnv).preview(viewer, {
        audienceType: "event_administrators",
        manualRecipients: "",
        category: "ad_hoc",
        kind: "transactional",
      });

      expect(preview.deliverable).toContainEqual(
        expect.objectContaining({ personId, address }),
      );
    });
  });

  describe("template and draft workflows", () => {
    it("uses the most urgent incomplete task as reminder merge data", async () => {
      const { testEnv } = await communicationEnvironment();
      const token = crypto.randomUUID();
      const personId = `urgent-reminder-person-${token}`;
      const address = `urgent-reminder-${token}@example.com`;
      const overdueTaskId = `z-overdue-task-${token}`;
      const futureTaskId = `a-future-task-${token}`;
      const now = Math.floor(Date.now() / 1_000);
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          `INSERT INTO people (
             id, email, display_name, email_verified, profile_status,
             created_at, updated_at
           ) VALUES (?, ?, 'Urgent reminder recipient', 1, 'draft', unixepoch(), unixepoch())`,
        ).bind(personId, address),
        testEnv.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, owner_person_id, title,
             task_type, impact, status, readiness_state, due_at, created_at, updated_at
           ) VALUES (?, ?, 'speaker', ?, ?, 'Overdue task', 'checklist',
                     'high', 'overdue', 'overdue', ?, unixepoch(), unixepoch())`,
        ).bind(overdueTaskId, viewer.eventId, personId, personId, now - 3_600),
        testEnv.DB.prepare(
          `INSERT INTO task_instances (
             id, event_id, target_type, target_id, owner_person_id, title,
             task_type, impact, status, readiness_state, due_at, created_at, updated_at
           ) VALUES (?, ?, 'speaker', ?, ?, 'Future task', 'checklist',
                     'medium', 'not_started', 'on_track', ?, unixepoch(), unixepoch())`,
        ).bind(futureTaskId, viewer.eventId, personId, personId, now + 3_600),
      ]);

      const preview = await new RecipientQuery(testEnv).preview(viewer, {
        audienceType: "incomplete_speakers",
        manualRecipients: "",
        category: "task_reminder",
        kind: "transactional",
      });
      expect(preview.deliverable).toContainEqual(
        expect.objectContaining({
          personId,
          address,
          sourceId: overdueTaskId,
        }),
      );
    });
  });

  describe("template and draft workflows", () => {
    it("versions and publishes templates, previews exact exclusions, and records intent before enqueue", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      await testEnv.DB.prepare(
        "UPDATE events SET brand_accent = '#0f766e' WHERE id = ?",
      )
        .bind(viewer.eventId)
        .run();
      const saved = await service.saveTemplate(viewer, {
        name: "Optional event update",
        category: "ad_hoc",
        subject:
          "{{recipient.firstName}}, your {{event.name}} task needs attention",
        content: {
          body: "Hi {{recipient.name}},\n\nPlease review the event update before {{event.dates}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);

      await env.DB.prepare(
        `
        INSERT OR IGNORE INTO communication_unsubscribes (
          id, event_id, address, category, created_at
        ) VALUES ('unsubscribe-communications-test', ?, 'optional@example.com', 'ad_hoc', unixepoch())
      `,
      )
        .bind(viewer.eventId)
        .run();
      const preview = await service.preview(viewer, {
        templateVersionId: saved.versionId,
        audienceType: "manual",
        manualRecipients:
          "Deliverable Person <deliverable@example.com>, optional@example.com, not-an-email",
        kind: "optional",
      });
      expect(preview.recipients).toMatchObject({ selected: 3 });
      expect(
        preview.recipients.deliverable.map((recipient) => recipient.address),
      ).toEqual(["deliverable@example.com"]);
      expect(
        preview.recipients.suppressed.map((recipient) => recipient.address),
      ).toEqual(["optional@example.com"]);
      expect(preview.recipients.invalid).toEqual([
        { address: "not-an-email", name: "" },
      ]);
      expect(preview.rendered.subject).toContain("Deliverable");
      expect(preview.rendered.html).toContain("Program Cue");
      expect(preview.rendered.html).toContain("#0f766e");

      const input = {
        templateVersionId: saved.versionId,
        audienceType: "manual" as const,
        manualRecipients:
          "Deliverable Person <deliverable@example.com>, optional@example.com, not-an-email",
        kind: "optional" as const,
        idempotencyKey: `communication-test-${crypto.randomUUID()}`,
      };
      const confirmed = await confirmPreviewed(service, input);
      expect(confirmed).toMatchObject({ status: "queued", duplicate: false });
      expect(sent).toHaveLength(1);

      const durable = await env.DB.prepare(
        `
        SELECT c.status, c.recipient_count AS recipientCount, o.status AS operationStatus,
               (SELECT COUNT(*) FROM communication_deliveries d WHERE d.communication_id = c.id) AS deliveryCount
          FROM communications c JOIN operation_jobs o ON o.id = c.operation_id
         WHERE c.id = ?
      `,
      )
        .bind(confirmed.communicationId)
        .first<{
          status: string;
          recipientCount: number;
          operationStatus: string;
          deliveryCount: number;
        }>();
      expect(durable).toEqual({
        status: "queued",
        recipientCount: 1,
        operationStatus: "queued",
        deliveryCount: 1,
      });
      await expect(confirmPreviewed(service, input)).resolves.toMatchObject({
        duplicate: true,
        communicationId: confirmed.communicationId,
      });
    });
  });

  describe("template and draft workflows", () => {
    it("requires a new preview when the recipient set changes before confirmation", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Audience-bound update",
        category: "ad_hoc",
        subject: "Update from {{event.name}}",
        content: {
          body: "Hello {{recipient.firstName}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const firstPersonId = crypto.randomUUID();
      const secondPersonId = crypto.randomUUID();
      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO people (id, email, display_name) VALUES (?, ?, 'Previewed recipient')",
        ).bind(firstPersonId, `${firstPersonId}@example.com`),
        env.DB.prepare(
          `
          INSERT INTO task_instances (
            id, event_id, target_type, target_id, owner_person_id, title,
            task_type, impact, status, readiness_state, readiness_percent
          ) VALUES (?, ?, 'speaker', ?, ?, 'Previewed task', 'checklist',
                    'low', 'not_started', 'on_track', 0)
        `,
        ).bind(
          crypto.randomUUID(),
          viewer.eventId,
          firstPersonId,
          firstPersonId,
        ),
      ]);
      const input = {
        templateVersionId: saved.versionId,
        audienceType: "incomplete_speakers" as const,
        manualRecipients: "",
        kind: "transactional" as const,
        idempotencyKey: `audience-bound-${crypto.randomUUID()}`,
      };
      const preview = await service.preview(viewer, input);

      await env.DB.batch([
        env.DB.prepare(
          "INSERT INTO people (id, email, display_name) VALUES (?, ?, 'Late recipient')",
        ).bind(secondPersonId, `${secondPersonId}@example.com`),
        env.DB.prepare(
          `
          INSERT INTO task_instances (
            id, event_id, target_type, target_id, owner_person_id, title,
            task_type, impact, status, readiness_state, readiness_percent
          ) VALUES (?, ?, 'speaker', ?, ?, 'Late task', 'checklist',
                    'low', 'not_started', 'on_track', 0)
        `,
        ).bind(
          crypto.randomUUID(),
          viewer.eventId,
          secondPersonId,
          secondPersonId,
        ),
      ]);

      await expect(
        service.confirm(viewer, { ...input, ...preview.confirmation }),
      ).rejects.toThrow(/audience changed after it was previewed/i);
      expect(sent).toHaveLength(0);
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ? AND idempotency_key = ?",
        )
          .bind(viewer.eventId, input.idempotencyKey)
          .first(),
      ).toEqual({ count: 0 });
    });

    it("requires a new preview when sender-backed content changes before confirmation", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Content-bound update",
        category: "ad_hoc",
        subject: "Update from {{event.name}}",
        content: {
          body: "Hello {{recipient.firstName}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const input = {
        templateVersionId: saved.versionId,
        audienceType: "manual" as const,
        manualRecipients: "content-bound@example.com",
        kind: "transactional" as const,
        idempotencyKey: `content-bound-${crypto.randomUUID()}`,
      };
      const preview = await service.preview(viewer, input);
      const sender = preview.provider.senderProfile!;
      await testEnv.DB.prepare(
        "UPDATE sender_profiles SET from_name = 'Changed after preview' WHERE id = ? AND event_id = ?",
      )
        .bind(sender.id, viewer.eventId)
        .run();

      await expect(
        service.confirm(viewer, { ...input, ...preview.confirmation }),
      ).rejects.toThrow(/content or sender is no longer exact/i);
      expect(sent).toHaveLength(0);
      await testEnv.DB.prepare(
        "UPDATE sender_profiles SET from_name = ? WHERE id = ? AND event_id = ?",
      )
        .bind(sender.fromName, sender.id, viewer.eventId)
        .run();
    });
  });

  describe("template and draft workflows", () => {
    it("honours new suppressions without expanding the previewed audience", async () => {
      const { testEnv } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Suppression-bound update",
        category: "ad_hoc",
        subject: "Update from {{event.name}}",
        content: {
          body: "Hello {{recipient.firstName}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const input = {
        templateVersionId: saved.versionId,
        audienceType: "manual" as const,
        manualRecipients:
          "Kept Recipient <preview-kept@example.com>, Suppressed Recipient <preview-suppressed@example.com>",
        kind: "optional" as const,
        idempotencyKey: `suppression-bound-${crypto.randomUUID()}`,
      };
      const preview = await service.preview(viewer, input);
      await env.DB.prepare(
        `
        INSERT INTO communication_unsubscribes (
          id, event_id, address, category, reason, created_at
        ) VALUES (?, ?, 'preview-suppressed@example.com', 'ad_hoc',
                  'recipient_unsubscribe', unixepoch())
      `,
      )
        .bind(crypto.randomUUID(), viewer.eventId)
        .run();

      const confirmed = await service.confirm(viewer, {
        ...input,
        ...preview.confirmation,
      });
      expect(
        await env.DB.prepare(
          "SELECT recipient_count AS recipientCount FROM communications WHERE id = ?",
        )
          .bind(confirmed.communicationId)
          .first(),
      ).toEqual({ recipientCount: 1 });
    });

    it("rejects an audience that cannot provide source-specific merge data before durable intent", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Task source requirement",
        category: "task_reminder",
        subject: "Reminder: {{task.title}}",
        content: {
          body: "Hello {{recipient.firstName}}, complete {{task.title}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const idempotencyKey = `invalid-source-audience-${crypto.randomUUID()}`;

      await expect(
        confirmPreviewed(service, {
          templateVersionId: saved.versionId,
          audienceType: "manual",
          manualRecipients: "Manual Recipient <manual-source@example.com>",
          kind: "transactional",
          idempotencyKey,
        }),
      ).rejects.toThrow(/cannot provide \{\{task\.title\}\}/);
      expect(sent).toHaveLength(0);
      expect(
        await env.DB.prepare(
          `
        SELECT COUNT(*) AS count FROM operation_jobs
         WHERE event_id = ? AND idempotency_key = ?
      `,
        )
          .bind(viewer.eventId, idempotencyKey)
          .first(),
      ).toEqual({ count: 0 });
    });

    it("rejects source variables whose template category cannot resolve them", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Invalid ad hoc task merge",
        category: "ad_hoc",
        subject: "Reminder: {{task.title}}",
        content: {
          body: "Please complete {{task.title}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);

      await expect(
        service.preview(viewer, {
          templateVersionId: saved.versionId,
          audienceType: "incomplete_speakers",
          manualRecipients: "",
          kind: "transactional",
        }),
      ).rejects.toThrow(/cannot provide \{\{task\.title\}\}/);
      expect(sent).toHaveLength(0);
    });

    it("sends the source values snapshotted at confirmation", async () => {
      const { testEnv, sent } = await communicationEnvironment();
      const currentTaskId = `000-snapshot-task-${crypto.randomUUID()}`;
      await env.DB.prepare(
        `
          INSERT INTO task_instances (
            id, event_id, target_type, target_id, owner_person_id, title,
            impact, status, readiness_state, readiness_percent
          ) VALUES (?, ?, 'speaker', 'person-demo-speaker', 'person-demo-speaker',
                    'Confirmed source title', 'medium', 'not_started', 'on_track', 0)
        `,
      )
        .bind(currentTaskId, viewer.eventId)
        .run();
      const service = new CommunicationService(testEnv);
      const saved = await service.saveTemplate(viewer, {
        name: "Snapshotted task reminder",
        category: "task_reminder",
        subject: "Reminder: {{task.title}}",
        content: {
          body: "Please complete {{task.title}}.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, saved.versionId);
      const confirmed = await confirmPreviewed(service, {
        templateVersionId: saved.versionId,
        audienceType: "incomplete_speakers",
        manualRecipients: "",
        kind: "transactional",
        idempotencyKey: `snapshot-merge-${crypto.randomUUID()}`,
      });
      await env.DB.prepare(
        "UPDATE task_instances SET title = 'Changed after confirmation' WHERE id = ?",
      )
        .bind(currentTaskId)
        .run();

      const requests: Array<Record<string, unknown>> = [];
      const provider = new ResendEmailProvider(
        "snapshot-merge-provider-key",
        async (_input, init) => {
          requests.push(
            JSON.parse(String(init?.body)) as Record<string, unknown>,
          );
          return Response.json({
            id: `resend-snapshot-merge-${requests.length}`,
          });
        },
      );
      await processCommunicationSend(sent[0], testEnv, { email: provider });

      const snapshottedRequest = requests.find(
        (request) => request.subject === "Reminder: Confirmed source title",
      );
      expect(snapshottedRequest).toBeDefined();
      expect(String(snapshottedRequest?.html)).toContain(
        "Confirmed source title",
      );
      expect(String(snapshottedRequest?.html)).not.toContain(
        "Changed after confirmation",
      );
      expect(
        await env.DB.prepare(
          `
        SELECT source_id AS sourceId, source_values_json AS sourceValuesJson,
               status
          FROM communication_deliveries WHERE communication_id = ? AND source_id = ?
      `,
        )
          .bind(confirmed.communicationId, currentTaskId)
          .first(),
      ).toEqual({
        sourceId: currentTaskId,
        sourceValuesJson: JSON.stringify({
          "task.title": "Confirmed source title",
        }),
        status: "sent",
      });
    });
  });

  describe("template and draft workflows", () => {
    it("allocates adjacent immutable versions when two template saves race", async () => {
      const { testEnv } = await communicationEnvironment();
      const service = new CommunicationService(testEnv);
      const initial = await service.saveTemplate(viewer, {
        name: "Concurrent save template",
        category: "ad_hoc",
        subject: "Initial subject",
        content: {
          body: "Initial body.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });

      const saves = await Promise.all([
        service.saveTemplate(viewer, {
          templateId: initial.templateId,
          name: "Concurrent save template",
          category: "ad_hoc",
          subject: "Concurrent subject A",
          content: {
            body: "Concurrent body A.",
            physicalAddress: "100 Programme Way, Toronto",
          },
        }),
        service.saveTemplate(viewer, {
          templateId: initial.templateId,
          name: "Concurrent save template",
          category: "ad_hoc",
          subject: "Concurrent subject B",
          content: {
            body: "Concurrent body B.",
            physicalAddress: "100 Programme Way, Toronto",
          },
        }),
      ]);

      expect(saves.map((save) => save.versionNumber).sort()).toEqual([2, 3]);
      const versions = await env.DB.prepare(
        `SELECT version_number AS versionNumber, subject_template AS subject
           FROM communication_template_versions
          WHERE template_id = ? ORDER BY version_number`,
      )
        .bind(initial.templateId)
        .all<{ versionNumber: number; subject: string }>();
      expect(versions.results).toEqual([
        { versionNumber: 1, subject: "Initial subject" },
        {
          versionNumber: 2,
          subject: expect.stringMatching(/^Concurrent subject/),
        },
        {
          versionNumber: 3,
          subject: expect.stringMatching(/^Concurrent subject/),
        },
      ]);
      expect(
        new Set(versions.results.map((version) => version.subject)),
      ).toEqual(
        new Set([
          "Initial subject",
          "Concurrent subject A",
          "Concurrent subject B",
        ]),
      );
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE action = 'communication.template.version.created'
              AND entity_id = ?`,
        )
          .bind(initial.templateId)
          .first(),
      ).toEqual({ count: 3 });
    });

    it("keeps one live template version when two callers publish the same draft concurrently", async () => {
      const { testEnv } = await communicationEnvironment();
      const service = new CommunicationTemplateService(testEnv);
      const first = await service.saveTemplate(viewer, {
        name: "Concurrent template",
        category: "ad_hoc",
        subject: "First published subject",
        content: {
          body: "First published body.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });
      await service.publishTemplate(viewer, first.versionId);
      const second = await service.saveTemplate(viewer, {
        templateId: first.templateId,
        name: "Concurrent template",
        category: "ad_hoc",
        subject: "Replacement subject",
        content: {
          body: "Replacement body.",
          physicalAddress: "100 Programme Way, Toronto",
        },
      });

      type TemplateVersion = Awaited<
        ReturnType<CommunicationTemplateService["publishTemplate"]>
      >;
      const internalService = service as unknown as {
        getTemplateVersion: (
          currentViewer: Viewer,
          currentVersionId: string,
        ) => Promise<TemplateVersion>;
      };
      const readVersion = internalService.getTemplateVersion.bind(service);
      let releaseBothReads!: () => void;
      const bothReadsComplete = new Promise<void>((resolve) => {
        releaseBothReads = resolve;
      });
      let readCount = 0;
      internalService.getTemplateVersion = async (
        currentViewer,
        currentVersionId,
      ) => {
        const version = await readVersion(currentViewer, currentVersionId);
        readCount += 1;
        if (readCount === 2) releaseBothReads();
        await bothReadsComplete;
        return version;
      };

      const attempts = await Promise.allSettled([
        service.publishTemplate(viewer, second.versionId),
        service.publishTemplate(viewer, second.versionId),
      ]);
      expect(
        attempts.filter((attempt) => attempt.status === "fulfilled"),
      ).toHaveLength(1);
      expect(
        attempts.filter((attempt) => attempt.status === "rejected"),
      ).toHaveLength(1);

      const versions = await env.DB.prepare(
        `
        SELECT id, status FROM communication_template_versions
         WHERE template_id = ? AND channel = 'email' ORDER BY version_number
      `,
      )
        .bind(first.templateId)
        .all<{ id: string; status: string }>();
      expect(versions.results).toEqual([
        { id: first.versionId, status: "retired" },
        { id: second.versionId, status: "published" },
      ]);
      const audit = await env.DB.prepare(
        `
        SELECT COUNT(*) AS count FROM audit_events
         WHERE action = 'communication.template.published' AND entity_id = ?
      `,
      )
        .bind(second.versionId)
        .first<{ count: number }>();
      expect(audit?.count).toBe(1);
    });
  });
});
