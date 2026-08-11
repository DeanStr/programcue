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

it("rejects decision merge values when no published decision exists", async () => {
  const { testEnv } = await communicationEnvironment();
  const submissionId = `decision-source-${crypto.randomUUID()}`;
  await testEnv.DB.prepare(
    `INSERT INTO submissions (
       id, event_id, submitter_email, public_reference, title, status,
       answers_json, submitted_snapshot_json, submitted_at, created_at, updated_at
     ) VALUES (?, ?, 'decision-source@example.com', ?, 'Decision source',
               'submitted', '{}', '{"answers":{},"speakers":[]}',
               unixepoch(), unixepoch(), unixepoch())`,
  )
    .bind(submissionId, viewer.eventId, `SOURCE-${submissionId.slice(-8)}`)
    .run();
  const recipients = [
    {
      personId: null,
      address: "decision-source@example.com",
      name: "Decision source",
      sourceId: submissionId,
    },
  ];

  await expect(
    snapshotSourceValues(
      testEnv,
      viewer.eventId,
      ["decision.outcome"],
      recipients,
    ),
  ).rejects.toThrow(/published decision.*unavailable/i);
  await expect(
    snapshotSourceValues(
      testEnv,
      viewer.eventId,
      ["submission.title"],
      recipients,
    ),
  ).resolves.toEqual(
    new Map([[submissionId, { "submission.title": "Decision source" }]]),
  );
});

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
      const provider = new ResendEmailProvider(
        "long-address-provider-key",
        async (_input, init) => {
          providerKeys.push(
            new Headers(init?.headers).get("idempotency-key") ?? "",
          );
          return Response.json({ id: "resend-long-address-001" });
        },
      );
      await processCommunicationSend(sent[0], testEnv, { email: provider });
      expect(providerKeys).toEqual([expectedKey]);
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
      const confirmed = await confirmPreviewed(service, {
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
        subject: "Update from Future of Events 2025",
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

  describe("additional workflow coverage", () => {
    it("rejects notification bodies that substitute a same-event domain entity", async () => {
      const { testEnv } = await communicationEnvironment();
      const decisionOperationId = `decision-payload-${crypto.randomUUID()}`;
      const submissionOperationId = `submission-payload-${crypto.randomUUID()}`;
      const decisionMessage = {
        type: "decision.notification" as const,
        operationId: decisionOperationId,
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
      ).rejects.toThrow("does not match its durable operation payload");
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

  describe("provider delivery workflows", () => {
    it("keeps a released-decision delivery terminal when a stale duplicate resumes materialisation", async () => {
      const { testEnv } = await communicationEnvironment();
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
      const message = {
        type: "decision.notification",
        operationId,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        idempotencyKey: `decision-notification-${token}`,
        payload: { decisionId },
      };
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
          `INSERT INTO submission_decisions (
        id, event_id, submission_id, revision_number, status, decision, decided_by_person_id,
        rationale, notification_feedback_json, effect_preview_json,
        idempotency_key, decided_at, published_at
      ) VALUES (?, ?, ?, 1, 'published', 'accepted', ?, ?, ?, '{}', ?, unixepoch(), unixepoch())`,
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
        ),
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
          message.idempotencyKey,
          crypto.randomUUID(),
          JSON.stringify(message),
        ),
      ]);
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
          return Response.json({ id: "resend-decision-001" });
        },
      );
      let releaseStaleMaterialisation!: () => void;
      const staleMaterialisationReleased = new Promise<void>((resolve) => {
        releaseStaleMaterialisation = resolve;
      });
      let staleMaterialisationReachedResolve!: () => void;
      const staleMaterialisationReached = new Promise<void>((resolve) => {
        staleMaterialisationReachedResolve = resolve;
      });
      let interceptedMaterialisation = false;
      const delayedDb = new Proxy(testEnv.DB, {
        get(target, property) {
          if (property === "batch") {
            return async (statements: D1PreparedStatement[]) => {
              if (!interceptedMaterialisation) {
                interceptedMaterialisation = true;
                staleMaterialisationReachedResolve();
                await staleMaterialisationReleased;
              }
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const staleWorker = processDecisionNotification(
        message,
        { ...testEnv, DB: delayedDb },
        { email: provider },
      );
      await staleMaterialisationReached;
      try {
        await processDecisionNotification(message, testEnv, {
          email: provider,
        });
      } finally {
        releaseStaleMaterialisation();
      }
      await staleWorker;
      expect(requests).toHaveLength(1);
      expect(providerKeys[0]).toMatch(
        /^programcue:communication-delivery:v1:[0-9a-f]{64}$/,
      );
      expect(requests[0]).toMatchObject({
        to: ["alex.submitter@example.com"],
        subject: "Your proposal was accepted",
      });
      expect(JSON.stringify(requests[0])).toContain(
        "A strong fit for this audience.",
      );
      expect(JSON.stringify(requests[0])).toContain(
        "Clarify the intended experience level",
      );
      const result = await env.DB.prepare(
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
        .first();
      expect(result).toEqual({
        operationStatus: "completed",
        communicationStatus: "sent",
        providerMessageId: "resend-decision-001",
      });
    });
  });

  describe("additional workflow coverage", () => {
    it("keeps an active trigger-failure lease and reclaims it only after expiry", async () => {
      const { testEnv } = await communicationEnvironment();
      const token = crypto.randomUUID().slice(0, 8);
      const operationId = `decision-missing-operation-${token}`;
      const message = {
        type: "decision.notification" as const,
        operationId,
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
      ).rejects.toThrow("active Queue claim lease");
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
      await processDecisionNotification(message, testEnv);
      expect(
        await env.DB.prepare(
          `SELECT status, claim_token AS claimToken, claim_expires_at AS claimExpiresAt
      FROM operation_jobs WHERE id = ?`,
        )
          .bind(operationId)
          .first(),
      ).toEqual({ status: "failed", claimToken: null, claimExpiresAt: null });
    });
  });

  describe("receipt and webhook workflows", () => {
    it("verifies the signed webhook body and rejects replayed timestamps", async () => {
      const secretBytes = crypto.getRandomValues(new Uint8Array(32));
      let binary = "";
      for (const byte of secretBytes) binary += String.fromCharCode(byte);
      const secret = `whsec_${btoa(binary)}`;
      const body = JSON.stringify({
        type: "email.sent",
        data: { email_id: "email-id" },
      });
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const webhookId = "msg_webhook_test";
      const key = await crypto.subtle.importKey(
        "raw",
        secretBytes,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"],
      );
      const signed = new Uint8Array(
        await crypto.subtle.sign(
          "HMAC",
          key,
          new TextEncoder().encode(`${webhookId}.${timestamp}.${body}`),
        ),
      );
      let signatureBinary = "";
      for (const byte of signed) signatureBinary += String.fromCharCode(byte);
      await expect(
        verifyResendWebhook({
          body,
          webhookId,
          timestamp,
          signature: `v1,${btoa(signatureBinary)}`,
          secret,
        }),
      ).resolves.toBeUndefined();
      await expect(
        verifyResendWebhook({
          body,
          webhookId,
          timestamp,
          signature: `v1,%%% v1,${btoa(signatureBinary)}`,
          secret,
        }),
      ).resolves.toBeUndefined();
      await expect(
        verifyResendWebhook({
          body,
          webhookId,
          timestamp: String(Number(timestamp) - 1_000),
          signature: `v1,${btoa(signatureBinary)}`,
          secret,
        }),
      ).rejects.toThrow("replay window");
    });
  });
});
