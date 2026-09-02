import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ResourceService } from "~/modules/resources/resource-service.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoSpeakerData } from "./demo.server";
import {
  SpeakerProfileConflictError,
  SpeakerService,
} from "./speaker-service.server";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    FILES: R2Bucket;
  }
}

const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const submitter: Viewer = {
  personId: "person-demo-submitter",
  name: "Alex Morgan",
  email: "alex.submitter@example.com",
  role: "submitter",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function addRosterRecord(
  service: SpeakerService,
  input: { idempotencyKey: string; name: string; email: string },
) {
  return service.addManualSpeakerRecord(admin, {
    ...input,
    idempotencyKey: `record:${input.idempotencyKey}`,
    jobTitle: "",
    organisationName: "",
    biography: "",
  });
}

async function inviteRosterRecord(
  service: SpeakerService,
  input: { idempotencyKey: string; personId: string },
) {
  return service.inviteSpeakerRecord(admin, {
    ...input,
    confirmation: "send",
  });
}

describe("speaker profile service", () => {
  it("reopens a declined session relationship when a pending role is assigned", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE session_participant_roles
            SET participation_status = 'declined', participation_revision = 2,
                participation_confirmed_at = NULL,
                participation_declined_at = unixepoch(),
                participation_decline_reason = 'Not available'
          WHERE event_id = ? AND session_id = ? AND person_id = ?
            AND role = 'speaker'`,
      ).bind(speaker.eventId, sessionId, speaker.personId),
      testEnv.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'declined', participation_revision = 2,
                participation_confirmed_at = NULL,
                participation_declined_at = unixepoch(),
                participation_decline_reason = 'Not available'
          WHERE event_id = ? AND session_id = ? AND person_id = ?`,
      ).bind(speaker.eventId, sessionId, speaker.personId),
    ]);

    const resources = new ResourceService(testEnv);
    const pageId = await resources.save(admin, {
      title: "Role assignment briefing",
      slug: `role-assignment-${crypto.randomUUID().slice(0, 8)}`,
      category: "Preparation",
      audienceScope: "accepted_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Read me." }] },
        ],
      },
    });
    const draft = (await resources.getAdminWorkspace(admin, pageId)).selected!;
    await resources.publish(admin, pageId, draft.revision);
    const taskId = `resource-ack:${pageId}:${speaker.personId}`;
    await expect(
      testEnv.DB.prepare("SELECT id FROM task_instances WHERE id = ?")
        .bind(taskId)
        .first(),
    ).resolves.toBeNull();

    try {
      const assignment = await service.addRole(admin, speaker.personId, {
        sessionId,
        role: "chair",
        confirmation: "add",
      });
      expect(assignment).toMatchObject({
        role: "chair",
        label: "Chair",
        changed: true,
      });
      await expect(
        service.addRole(admin, speaker.personId, {
          sessionId,
          role: "chair",
          confirmation: "add",
        }),
      ).resolves.toMatchObject({
        role: "chair",
        changed: false,
        changeSequence: assignment.changeSequence,
      });

      await expect(
        testEnv.DB.prepare(
          `SELECT participation_status AS participationStatus,
                  participation_revision AS participationRevision,
                  participation_confirmed_at AS participationConfirmedAt,
                  participation_declined_at AS participationDeclinedAt,
                  participation_decline_reason AS participationDeclineReason
             FROM session_speakers
            WHERE event_id = ? AND session_id = ? AND person_id = ?`,
        )
          .bind(speaker.eventId, sessionId, speaker.personId)
          .first(),
      ).resolves.toEqual({
        participationStatus: "pending",
        participationRevision: 3,
        participationConfirmedAt: null,
        participationDeclinedAt: null,
        participationDeclineReason: null,
      });
      await expect(
        testEnv.DB.prepare("SELECT status FROM task_instances WHERE id = ?")
          .bind(taskId)
          .first(),
      ).resolves.toEqual({ status: "not_started" });
    } finally {
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          "DELETE FROM resource_pages WHERE id = ? AND event_id = ?",
        ).bind(pageId, speaker.eventId),
        testEnv.DB.prepare(
          `DELETE FROM session_participant_roles
            WHERE event_id = ? AND session_id = ? AND person_id = ?
              AND role = 'chair'`,
        ).bind(speaker.eventId, sessionId, speaker.personId),
        testEnv.DB.prepare(
          `UPDATE session_participant_roles
              SET participation_status = 'pending', participation_revision = 1,
                  participation_confirmed_at = NULL,
                  participation_declined_at = NULL,
                  participation_decline_reason = NULL
            WHERE event_id = ? AND session_id = ? AND person_id = ?
              AND role = 'speaker'`,
        ).bind(speaker.eventId, sessionId, speaker.personId),
        testEnv.DB.prepare(
          `UPDATE session_speakers
              SET participation_status = 'pending', participation_revision = 1,
                  participation_confirmed_at = NULL,
                  participation_declined_at = NULL,
                  participation_decline_reason = NULL
            WHERE event_id = ? AND session_id = ? AND person_id = ?`,
        ).bind(speaker.eventId, sessionId, speaker.personId),
      ]);
    }
  });

  it("materialises acknowledgements when a declined role is reset", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE session_participant_roles
            SET participation_status = 'declined', participation_revision = 2,
                participation_confirmed_at = NULL,
                participation_declined_at = unixepoch(),
                participation_decline_reason = 'Not available'
          WHERE event_id = ? AND session_id = ? AND person_id = ?
            AND role = 'speaker'`,
      ).bind(speaker.eventId, sessionId, speaker.personId),
      testEnv.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'declined', participation_revision = 2,
                participation_confirmed_at = NULL,
                participation_declined_at = unixepoch(),
                participation_decline_reason = 'Not available'
          WHERE event_id = ? AND session_id = ? AND person_id = ?`,
      ).bind(speaker.eventId, sessionId, speaker.personId),
    ]);
    const resources = new ResourceService(testEnv);
    const pageId = await resources.save(admin, {
      title: "Role reset briefing",
      slug: `role-reset-${crypto.randomUUID().slice(0, 8)}`,
      category: "Preparation",
      audienceScope: "accepted_speakers",
      acknowledgementRequired: true,
      document: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Read me." }] },
        ],
      },
    });
    const draft = (await resources.getAdminWorkspace(admin, pageId)).selected!;
    await resources.publish(admin, pageId, draft.revision);
    const taskId = `resource-ack:${pageId}:${speaker.personId}`;

    try {
      const reset = await service.resetRole(admin, speaker.personId, {
        sessionId,
        role: "speaker",
        roleRevision: 2,
        resetConfirmation: "pending",
      });
      expect(reset).toMatchObject({
        role: "speaker",
        participationStatus: "pending",
        changed: true,
      });
      await expect(
        service.resetRole(admin, speaker.personId, {
          sessionId,
          role: "speaker",
          roleRevision: 2,
          resetConfirmation: "pending",
        }),
      ).resolves.toMatchObject({
        role: "speaker",
        participationStatus: "pending",
        changed: false,
        changeSequence: reset.changeSequence,
      });
      await expect(
        testEnv.DB.prepare("SELECT status FROM task_instances WHERE id = ?")
          .bind(taskId)
          .first(),
      ).resolves.toEqual({ status: "not_started" });
    } finally {
      await testEnv.DB.batch([
        testEnv.DB.prepare(
          "DELETE FROM resource_pages WHERE id = ? AND event_id = ?",
        ).bind(pageId, speaker.eventId),
        testEnv.DB.prepare(
          `UPDATE session_participant_roles
              SET participation_status = 'pending', participation_revision = 1,
                  participation_confirmed_at = NULL,
                  participation_declined_at = NULL,
                  participation_decline_reason = NULL
            WHERE event_id = ? AND session_id = ? AND person_id = ?
              AND role = 'speaker'`,
        ).bind(speaker.eventId, sessionId, speaker.personId),
        testEnv.DB.prepare(
          `UPDATE session_speakers
              SET participation_status = 'pending', participation_revision = 1,
                  participation_confirmed_at = NULL,
                  participation_declined_at = NULL,
                  participation_decline_reason = NULL
            WHERE event_id = ? AND session_id = ? AND person_id = ?`,
        ).bind(speaker.eventId, sessionId, speaker.personId),
      ]);
    }
  });

  it("tracks multiple session roles and their responses independently", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const sessionId = "session-demo-speaker";
    await testEnv.DB.prepare(
      `UPDATE session_participant_roles
          SET participation_status = 'pending', participation_revision = 1,
              participation_confirmed_at = NULL,
              participation_declined_at = NULL,
              participation_decline_reason = NULL
        WHERE event_id = ? AND session_id = ? AND person_id = ?
          AND role = 'speaker'`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .run();

    await expect(
      service.addRole(admin, speaker.personId, {
        sessionId,
        role: "moderator",
        confirmation: "add",
      }),
    ).resolves.toMatchObject({ role: "moderator", label: "Moderator" });
    const confirmation = await service.respondOwnRole(speaker, {
      sessionId,
      role: "speaker",
      roleRevision: 1,
      response: "confirmed",
      reason: "",
    });
    expect(confirmation).toMatchObject({
      role: "speaker",
      participationStatus: "confirmed",
      changed: true,
    });
    await expect(
      service.respondOwnRole(speaker, {
        sessionId,
        role: "speaker",
        roleRevision: 1,
        response: "confirmed",
        reason: "",
      }),
    ).resolves.toMatchObject({
      role: "speaker",
      participationStatus: "confirmed",
      changed: false,
      changeSequence: confirmation.changeSequence,
    });
    await expect(
      service.respondOwnRole(speaker, {
        sessionId,
        role: "moderator",
        roleRevision: 1,
        response: "declined",
        reason: "Not moderating this session",
      }),
    ).resolves.toMatchObject({
      role: "moderator",
      participationStatus: "declined",
    });

    const roles = await testEnv.DB.prepare(
      `SELECT role, participation_status AS participationStatus
         FROM session_participant_roles
        WHERE event_id = ? AND session_id = ? AND person_id = ?
        ORDER BY role`,
    )
      .bind(speaker.eventId, sessionId, speaker.personId)
      .all<{ role: string; participationStatus: string }>();
    expect(roles.results).toEqual([
      { role: "moderator", participationStatus: "declined" },
      { role: "speaker", participationStatus: "confirmed" },
    ]);
    await expect(
      testEnv.DB.prepare(
        `SELECT participation_status AS participationStatus
           FROM session_speakers
          WHERE event_id = ? AND session_id = ? AND person_id = ?`,
      )
        .bind(speaker.eventId, sessionId, speaker.personId)
        .first(),
    ).resolves.toEqual({ participationStatus: "confirmed" });
  });

  it("fails role mutations before D1 when provider authority is unavailable", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE session_participant_roles
            SET participation_status = 'pending', participation_revision = 1,
                participation_confirmed_at = NULL,
                participation_declined_at = NULL,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = 'session-demo-speaker'
            AND person_id = ? AND role = 'speaker'`,
      ).bind(speaker.eventId, speaker.personId),
      testEnv.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'pending', participation_revision = 1,
                participation_confirmed_at = NULL,
                participation_declined_at = NULL,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = 'session-demo-speaker'
            AND person_id = ?`,
      ).bind(speaker.eventId, speaker.personId),
    ]);
    const providerFailure = new Error("Authoritative provider is unavailable.");
    const airtable = {
      executeIdempotent: async () => {
        throw providerFailure;
      },
    } as unknown as AirtableProviderBoundary;
    const service = new SpeakerService(testEnv, { airtable });

    await expect(
      service.respondOwnRole(speaker, {
        sessionId: "session-demo-speaker",
        role: "speaker",
        roleRevision: 1,
        response: "confirmed",
        reason: "",
      }),
    ).rejects.toBe(providerFailure);
    await expect(
      testEnv.DB.prepare(
        `SELECT participation_status AS status,
                participation_revision AS revision
           FROM session_participant_roles
          WHERE event_id = ? AND session_id = 'session-demo-speaker'
            AND person_id = ? AND role = 'speaker'`,
      )
        .bind(speaker.eventId, speaker.personId)
        .first(),
    ).resolves.toEqual({ status: "pending", revision: 1 });
  });

  it("persists and replays one durable invitation delivery operation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const email = `durable-invitation-${suffix}@programcue.dev`;
    const queued: unknown[] = [];
    await testEnv.DB.prepare(
      `INSERT INTO sender_profiles (
         id, event_id, name, from_name, from_email, reply_to_email,
         provider, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'Program Cue', 'speakers@example.com',
                 'speakers@example.com', 'resend', 'verified',
                 unixepoch(), unixepoch())`,
    )
      .bind(
        `durable-speaker-sender-${suffix}`,
        admin.eventId,
        `Durable speaker sender ${suffix}`,
      )
      .run();
    const productionEnv = {
      ...testEnv,
      APP_ENV: "production",
      DEMO_MODE: "false",
      BETTER_AUTH_URL: "https://programcue.test",
      BETTER_AUTH_SECRET: "a".repeat(32),
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "test-provider-key",
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    const input = {
      idempotencyKey: `durable-invitation:${suffix}`,
      name: "Durable Invitee",
      email,
    };
    const service = new SpeakerService(productionEnv);

    const record = await addRosterRecord(service, input);
    const created = await inviteRosterRecord(service, {
      idempotencyKey: input.idempotencyKey,
      personId: record.personId,
    });
    expect(created.delivery).toBe("queued");
    expect(queued).toHaveLength(1);
    await expect(
      testEnv.DB.prepare(
        `SELECT workflow.status, workflow.source,
                workflow.updated_by_person_id AS updatedByPersonId
           FROM event_speaker_workflows workflow
          WHERE workflow.event_id = ? AND workflow.person_id = ?`,
      )
        .bind(admin.eventId, created.personId)
        .first(),
    ).resolves.toEqual({
      status: "invited",
      source: "manual",
      updatedByPersonId: admin.personId,
    });
    await expect(
      inviteRosterRecord(service, {
        idempotencyKey: input.idempotencyKey,
        personId: record.personId,
      }),
    ).resolves.toEqual(created);
    expect(queued).toHaveLength(1);
    await testEnv.DB.prepare(
      `UPDATE memberships SET accepted_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    )
      .bind(created.membershipId, admin.eventId)
      .run();
    await expect(
      inviteRosterRecord(service, {
        idempotencyKey: input.idempotencyKey,
        personId: record.personId,
      }),
    ).resolves.toEqual({
      ...created,
      accepted: true,
      delivery: "not_required",
    });
    expect(queued).toHaveLength(1);
    await expect(
      testEnv.DB.prepare(
        `SELECT operation.status, operation.dispatched_at IS NOT NULL AS dispatched,
                communication.status AS communicationStatus,
                delivery.status AS deliveryStatus
           FROM operation_jobs operation
           JOIN communications communication
             ON communication.operation_id = operation.id
           JOIN communication_deliveries delivery
             ON delivery.communication_id = communication.id
          WHERE operation.event_id = ?
            AND json_extract(communication.audience_json, '$.email') = ?`,
      )
        .bind(admin.eventId, email)
        .first(),
    ).resolves.toEqual({
      status: "queued",
      dispatched: 1,
      communicationStatus: "queued",
      deliveryStatus: "queued",
    });
  });

  it("records a successful dispatch after a fast Queue consumer advances the job", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const email = `fast-consumer-${suffix}@programcue.dev`;
    await testEnv.DB.prepare(
      `INSERT INTO sender_profiles (
         id, event_id, name, from_name, from_email, reply_to_email,
         provider, status, created_at, updated_at
       ) VALUES (?, ?, ?, 'Program Cue', 'speakers@example.com',
                 'speakers@example.com', 'resend', 'verified',
                 unixepoch(), unixepoch())`,
    )
      .bind(
        `fast-consumer-sender-${suffix}`,
        admin.eventId,
        `Fast consumer sender ${suffix}`,
      )
      .run();
    const productionEnv = {
      ...testEnv,
      APP_ENV: "production",
      DEMO_MODE: "false",
      BETTER_AUTH_URL: "https://programcue.test",
      BETTER_AUTH_SECRET: "a".repeat(32),
      EMAIL_PROVIDER: "resend",
      RESEND_API_KEY: "test-provider-key",
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => {
          const operationId = (message as { operationId: string }).operationId;
          await testEnv.DB.prepare(
            `UPDATE operation_jobs SET status = 'running'
              WHERE id = ? AND event_id = ? AND status = 'queued'`,
          )
            .bind(operationId, admin.eventId)
            .run();
        },
      },
    } as unknown as CloudflareEnvironment;

    const service = new SpeakerService(productionEnv);
    const input = {
      idempotencyKey: `fast-consumer:${suffix}`,
      name: "Fast Queue Consumer",
      email,
    };
    const record = await addRosterRecord(service, input);
    const created = await inviteRosterRecord(service, {
      idempotencyKey: input.idempotencyKey,
      personId: record.personId,
    });

    expect(created.delivery).toBe("queued");
    await expect(
      testEnv.DB.prepare(
        `SELECT operation.status,
                operation.dispatched_at IS NOT NULL AS dispatched
           FROM operation_jobs operation
           JOIN communications communication
             ON communication.operation_id = operation.id
            AND communication.event_id = operation.event_id
          WHERE operation.event_id = ?
            AND json_extract(communication.audience_json, '$.email') = ?`,
      )
        .bind(admin.eventId, email)
        .first(),
    ).resolves.toEqual({ status: "running", dispatched: 1 });
  });

  it("fails before saving an invitation when durable delivery is unavailable", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const email = `missing-queue-${crypto.randomUUID()}@programcue.dev`;
    const productionWithoutQueue = {
      ...testEnv,
      APP_ENV: "production",
      DEMO_MODE: "false",
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment;

    const service = new SpeakerService(productionWithoutQueue);
    const input = {
      idempotencyKey: `missing-queue:${crypto.randomUUID()}`,
      name: "Missing Queue",
      email,
    };
    const record = await addRosterRecord(service, input);
    await expect(
      inviteRosterRecord(service, {
        idempotencyKey: input.idempotencyKey,
        personId: record.personId,
      }),
    ).rejects.toThrow(/OPERATIONS_QUEUE.*no speaker invitation was saved/i);
    await expect(
      testEnv.DB.prepare(
        `SELECT invited_at AS invitedAt, invitation_expires_at AS expiresAt
           FROM memberships WHERE event_id = ? AND person_id = ?`,
      )
        .bind(admin.eventId, record.personId)
        .first(),
    ).resolves.toEqual({ invitedAt: null, expiresAt: null });
  });

  it("reactivates the existing event membership when an administrator re-adds a revoked speaker", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const personId = `manual-reactivate-person-${suffix}`;
    const membershipId = `manual-reactivate-membership-${suffix}`;
    const email = `manual-reactivate-${suffix}@example.com`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name, email_verified, profile_status)
         VALUES (?, ?, 'Revoked Speaker', 1, 'draft')`,
      ).bind(personId, email),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, revoked_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch() - 200,
                   unixepoch() - 100, unixepoch() - 50)`,
      ).bind(membershipId, admin.organisationId, admin.eventId, personId),
      testEnv.DB.prepare(
        `INSERT INTO event_speaker_workflows (
           event_id, person_id, status, source, last_operation_id,
           updated_by_person_id, created_at, updated_at
         ) VALUES (?, ?, 'withdrawn', 'manual', ?, ?, unixepoch(), unixepoch())`,
      ).bind(
        admin.eventId,
        personId,
        `reactivate-workflow:${suffix}`,
        admin.personId,
      ),
    ]);

    await expect(
      new SpeakerService(testEnv).inviteSpeakerRecord(admin, {
        idempotencyKey: `reactivate:${suffix}`,
        personId,
        confirmation: "send",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      testEnv.DB.prepare(
        `SELECT id, accepted_at AS acceptedAt, revoked_at AS revokedAt
           FROM memberships
          WHERE event_id = ? AND person_id = ? AND role = 'speaker'`,
      )
        .bind(admin.eventId, personId)
        .first(),
    ).resolves.toEqual({
      id: membershipId,
      acceptedAt: expect.any(Number),
      revokedAt: expect.any(Number),
    });

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE event_speaker_workflows
            SET status = 'prospect', revision = revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE event_id = ? AND person_id = ?`,
      ).bind(`reactivate-approved:${suffix}`, admin.eventId, personId),
      testEnv.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_by_person_id,
           created_at, updated_at
         ) VALUES (?, ?, 'event', 'active', ?, unixepoch(), unixepoch())`,
      ).bind(admin.organisationId, personId, admin.personId),
    ]);
    await expect(
      new SpeakerService(testEnv).inviteSpeakerRecord(admin, {
        idempotencyKey: `reactivate-approved:${suffix}`,
        personId,
        confirmation: "send",
      }),
    ).resolves.toMatchObject({
      personId,
      membershipId,
      email,
      accepted: false,
      delivery: "demo_not_sent",
      invitationExpiresAt: expect.any(Number),
    });

    await expect(
      testEnv.DB.prepare(
        `SELECT id, accepted_at AS acceptedAt, revoked_at AS revokedAt,
                invitation_expires_at AS invitationExpiresAt
           FROM memberships
          WHERE event_id = ? AND person_id = ? AND role = 'speaker'`,
      )
        .bind(admin.eventId, personId)
        .first(),
    ).resolves.toEqual({
      id: membershipId,
      acceptedAt: null,
      revokedAt: null,
      invitationExpiresAt: expect.any(Number),
    });
  });

  it("does not invite an identity from another organisation without an event roster relationship", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const otherOrganisationId = `other-org-${suffix}`;
    const personId = `other-person-${suffix}`;
    const email = `other-person-${suffix}@example.com`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO organisations (id, name, slug)
         VALUES (?, 'Other organisation', ?)`,
      ).bind(otherOrganisationId, otherOrganisationId),
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, biography, profile_status
         ) VALUES (?, ?, 'Person-owned name', 1, 'Person-owned biography', 'published')`,
      ).bind(personId, email),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           accepted_at, created_at
         ) VALUES (?, ?, NULL, ?, 'owner', unixepoch(), unixepoch(), unixepoch())`,
      ).bind(`other-membership-${suffix}`, otherOrganisationId, personId),
    ]);

    await expect(
      new SpeakerService(testEnv).inviteSpeakerRecord(admin, {
        idempotencyKey: `cross-org:${suffix}`,
        personId,
        confirmation: "send",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      testEnv.DB.prepare(
        `SELECT display_name AS name, biography
           FROM people WHERE id = ?`,
      )
        .bind(personId)
        .first(),
    ).resolves.toEqual({
      name: "Person-owned name",
      biography: "Person-owned biography",
    });
  });

  it("fails closed when a pending speaker invitation has no expiry", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const service = new SpeakerService(testEnv);
    const input = {
      idempotencyKey: `missing-expiry:${suffix}`,
      name: "Missing Expiry",
      email: `missing-expiry-${suffix}@example.com`,
    };
    const record = await addRosterRecord(service, input);
    const created = await inviteRosterRecord(service, {
      idempotencyKey: input.idempotencyKey,
      personId: record.personId,
    });
    await testEnv.DB.prepare(
      "UPDATE memberships SET invitation_expires_at = NULL WHERE id = ?",
    )
      .bind(created.membershipId)
      .run();

    await expect(
      new SpeakerService(testEnv).listAdminSpeakerPage(
        admin,
        { personId: "", query: "", profileStatus: "", readiness: "" },
        1,
      ),
    ).rejects.toThrow(/missing its required expiry/i);
    await testEnv.DB.prepare(
      "UPDATE memberships SET invitation_expires_at = unixepoch() + 604800 WHERE id = ?",
    )
      .bind(created.membershipId)
      .run();
  });

  it("derives application capability inside the scoped portal read", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    await ensureDemoSubmissionForm(testEnv);
    const suffix = crypto.randomUUID();
    const submissionId = `portal-application-${suffix}`;
    const otherPersonId = `portal-other-speaker-${suffix}`;
    const formVersion = await testEnv.DB.prepare(
      `SELECT version.id
         FROM form_versions version
         JOIN form_definitions form
           ON form.id = version.form_id AND form.event_id = version.event_id
        WHERE version.event_id = ? AND version.status = 'published'
          AND form.public_slug = 'form'`,
    )
      .bind(speaker.eventId)
      .first<{ id: string }>();
    if (!formVersion) throw new Error("Expected the published demo form.");
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name, email_verified)
         VALUES (?, ?, 'Unrelated Portal Speaker', 1)`,
      ).bind(otherPersonId, `${otherPersonId}@example.test`),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        speaker.organisationId,
        speaker.eventId,
        otherPersonId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, form_version_id, submitter_person_id,
           public_reference, title, status, revision, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, 'Scoped portal application', 'draft', 1,
                   unixepoch(), unixepoch())`,
      ).bind(
        submissionId,
        speaker.eventId,
        formVersion.id,
        speaker.personId,
        `PC-PORTAL-${suffix}`,
      ),
    ]);
    const assertReadable = vi.fn(async () => null);
    const service = new SpeakerService(testEnv, {
      airtable: { assertReadable } as unknown as AirtableProviderBoundary,
    });
    const otherSpeaker: Viewer = {
      personId: otherPersonId,
      name: "Unrelated Portal Speaker",
      email: `${otherPersonId}@example.test`,
      role: "speaker",
      organisationId: speaker.organisationId,
      eventId: speaker.eventId,
      demo: true,
    };

    await expect(service.getPortal(speaker)).resolves.toMatchObject({
      hasApplications: true,
    });
    await expect(service.getPortal(otherSpeaker)).resolves.toMatchObject({
      hasApplications: false,
    });
    expect(assertReadable).toHaveBeenCalledTimes(2);

    await testEnv.DB.prepare(
      `INSERT INTO submission_speakers (
         id, event_id, submission_id, person_id, email, display_name,
         role_label, position, invitation_status, is_primary,
         invited_at, claimed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'Unrelated Portal Speaker', 'Co-speaker', 1,
                 'claimed', 0, unixepoch(), unixepoch(), unixepoch(), unixepoch())`,
    )
      .bind(
        crypto.randomUUID(),
        speaker.eventId,
        submissionId,
        otherPersonId,
        otherSpeaker.email,
      )
      .run();
    await expect(service.getPortal(otherSpeaker)).resolves.toMatchObject({
      hasApplications: true,
    });
    expect(assertReadable).toHaveBeenCalledTimes(3);
  });

  it("loads only the authenticated speaker workspace and protects revision updates", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const portal = await service.getPortal(speaker);
    expect(portal.profile.id).toBe(speaker.personId);
    expect(portal.sessions.map((session) => session.id)).toContain(
      "session-demo-speaker",
    );

    await service.updateProfile(speaker, {
      revision: portal.profile.revision,
      name: "Priya Shah",
      biography:
        "Priya designs inclusive event technology experiences for teams and audiences worldwide.",
      pronunciation: "PREE-yah SHAH",
      organisationName: "EventLab",
      jobTitle: "Director",
      linkedinUrl: "https://www.linkedin.com/in/priya-shah",
      xHandle: "@priya_shah",
      travelPreferences: "Vegetarian meals and step-free ground transport.",
      publish: true,
    });
    const saved = await service.getPortal(speaker);
    expect(saved.profile.jobTitle).toBe("Director");
    expect(saved.profile).toMatchObject({
      linkedinUrl: "https://www.linkedin.com/in/priya-shah",
      xHandle: "priya_shah",
      travelPreferences: "Vegetarian meals and step-free ground transport.",
    });
    expect(saved.profile.revision).toBe(portal.profile.revision + 1);
    expect(saved.profileHistory[0]).toMatchObject({
      source: "canonical_person",
      profileRevision: saved.profile.revision,
      displayName: saved.profile.name,
      jobTitle: "Director",
      publicationStatus: "published",
      recordedByName: speaker.name,
    });
    expect(saved.profileHistory[0]).not.toHaveProperty("travelPreferences");
    expect(saved.profileHistory[0]).not.toHaveProperty("email");
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO speaker_profile_revisions (
           id, organisation_id, event_id, person_id, source, profile_revision,
           display_name, publication_status, correlation_id, created_at
         ) VALUES (?, 'other-organisation', ?, ?, 'canonical_person', 999,
                   'Cross-organisation leak', 'published', ?, unixepoch() + 10)`,
      ).bind(
        crypto.randomUUID(),
        speaker.eventId,
        speaker.personId,
        crypto.randomUUID(),
      ),
      testEnv.DB.prepare(
        `INSERT INTO speaker_profile_revisions (
           id, organisation_id, event_id, person_id, source, profile_revision,
           display_name, publication_status, correlation_id, created_at
         ) VALUES (?, ?, 'other-event', ?, 'canonical_person', 998,
                   'Cross-event leak', 'published', ?, unixepoch() + 10)`,
      ).bind(
        crypto.randomUUID(),
        speaker.organisationId,
        speaker.personId,
        crypto.randomUUID(),
      ),
    ]);
    expect(
      (await service.getPortal(speaker)).profileHistory.map(
        ({ displayName }) => displayName,
      ),
    ).not.toEqual(
      expect.arrayContaining(["Cross-organisation leak", "Cross-event leak"]),
    );

    await expect(
      service.updateProfile(speaker, {
        revision: saved.profile.revision,
        name: saved.profile.name,
        biography: saved.profile.biography ?? "",
        pronunciation: saved.profile.pronunciation ?? "",
        organisationName: saved.profile.organisationName ?? "",
        jobTitle: saved.profile.jobTitle ?? "",
        linkedinUrl: "https://example.com/not-linkedin",
        xHandle: "invalid handle",
        travelPreferences: saved.profile.travelPreferences ?? "",
        publish: true,
      }),
    ).rejects.toMatchObject({ name: "ZodError" });

    const auditCountBeforeStale = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM audit_events
        WHERE event_id = ? AND entity_id = ? AND action = 'participant.profile.updated'`,
    )
      .bind(speaker.eventId, speaker.personId)
      .first<{ count: number }>();

    await expect(
      service.updateProfile(speaker, {
        revision: portal.profile.revision,
        name: "Stale Name",
        biography:
          "This biography is deliberately long enough but must never replace the latest profile value.",
        pronunciation: "",
        organisationName: "",
        jobTitle: "",
        linkedinUrl: "",
        xHandle: "",
        travelPreferences: "",
        publish: false,
      }),
    ).rejects.toBeInstanceOf(SpeakerProfileConflictError);

    const auditCountAfterStale = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM audit_events
        WHERE event_id = ? AND entity_id = ? AND action = 'participant.profile.updated'`,
    )
      .bind(speaker.eventId, speaker.personId)
      .first<{ count: number }>();
    expect(auditCountAfterStale?.count).toBe(auditCountBeforeStale?.count);
    expect(auditCountAfterStale?.count).toBe(1);
  });

  it("omits hidden fixed profile fields and their history values from the participant portal", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const before = await service.getPortal(speaker);
    await service.updateProfile(speaker, {
      revision: before.profile.revision,
      name: before.profile.name,
      biography:
        before.profile.biography ??
        "Priya designs inclusive event technology experiences for teams and audiences worldwide.",
      pronunciation: before.profile.pronunciation ?? "",
      organisationName: before.profile.organisationName ?? "",
      jobTitle: before.profile.jobTitle ?? "",
      linkedinUrl: before.profile.linkedinUrl ?? "",
      xHandle: before.profile.xHandle ?? "",
      travelPreferences: before.profile.travelPreferences ?? "",
      publish: before.profile.profileStatus === "published",
    });
    const hiddenFields = [
      "name",
      "biography",
      "pronunciation",
      "organisation_name",
      "job_title",
      "linkedin_url",
      "x_handle",
      "travel_preferences",
    ];
    await testEnv.DB.batch(
      hiddenFields.map((fieldKey) =>
        testEnv.DB.prepare(
          `INSERT INTO event_participant_field_policies (
             event_id, field_key, participant_access,
             updated_by_person_id, updated_at
           ) VALUES (?, ?, 'hidden', ?, unixepoch())
           ON CONFLICT(event_id, field_key) DO UPDATE SET
             participant_access = 'hidden',
             updated_by_person_id = excluded.updated_by_person_id,
             updated_at = excluded.updated_at`,
        ).bind(speaker.eventId, fieldKey, admin.personId),
      ),
    );

    try {
      const portal = await service.getPortal(speaker);
      for (const property of [
        "name",
        "biography",
        "pronunciation",
        "organisationName",
        "jobTitle",
        "linkedinUrl",
        "xHandle",
        "travelPreferences",
      ]) {
        expect(portal.profile).not.toHaveProperty(property);
      }
      expect(portal.profileHistory.length).toBeGreaterThan(0);
      for (const property of [
        "displayName",
        "biography",
        "pronunciation",
        "organisationName",
        "jobTitle",
      ]) {
        expect(portal.profileHistory[0]).not.toHaveProperty(property);
      }
    } finally {
      await testEnv.DB.prepare(
        `DELETE FROM event_participant_field_policies
          WHERE event_id = ? AND field_key IN (${hiddenFields.map(() => "?").join(",")})`,
      )
        .bind(speaker.eventId, ...hiddenFields)
        .run();
    }
  });

  it("allows a partial draft save when a protected profile field is incomplete", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE people
            SET biography = NULL, profile_status = 'draft'
          WHERE id = ?`,
      ).bind(speaker.personId),
      testEnv.DB.prepare(
        `INSERT INTO event_participant_field_policies (
           event_id, field_key, participant_access,
           updated_by_person_id, updated_at
         ) VALUES (?, 'biography', 'read_only', ?, unixepoch())
         ON CONFLICT(event_id, field_key) DO UPDATE SET
           participant_access = 'read_only',
           updated_by_person_id = excluded.updated_by_person_id,
           updated_at = excluded.updated_at`,
      ).bind(speaker.eventId, admin.personId),
    ]);
    const before = await service.getPortal(speaker);

    await service.updateProfile(speaker, {
      revision: before.profile.revision,
      name: "Priya Partial Save",
      publish: false,
    });

    await expect(service.getPortal(speaker)).resolves.toMatchObject({
      profile: {
        name: "Priya Partial Save",
        biography: null,
        profileStatus: "draft",
        revision: before.profile.revision + 1,
      },
    });
  });

  it("publishes with protected nullable optional profile fields", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE people
            SET pronunciation = NULL, organisation_name = NULL,
                job_title = NULL, linkedin_url = NULL, x_handle = NULL,
                profile_status = 'draft'
          WHERE id = ?`,
      ).bind(speaker.personId),
      testEnv.DB.prepare(
        `UPDATE event_participant_profiles
            SET travel_preferences = NULL
          WHERE event_id = ? AND organisation_id = ? AND person_id = ?`,
      ).bind(speaker.eventId, speaker.organisationId, speaker.personId),
      ...[
        "pronunciation",
        "organisation_name",
        "job_title",
        "linkedin_url",
        "x_handle",
        "travel_preferences",
      ].map((fieldKey) =>
        testEnv.DB.prepare(
          `INSERT INTO event_participant_field_policies (
             event_id, field_key, participant_access,
             updated_by_person_id, updated_at
           ) VALUES (?, ?, 'read_only', ?, unixepoch())
           ON CONFLICT(event_id, field_key) DO UPDATE SET
             participant_access = 'read_only',
             updated_by_person_id = excluded.updated_by_person_id,
             updated_at = excluded.updated_at`,
        ).bind(speaker.eventId, fieldKey, admin.personId),
      ),
    ]);

    try {
      const before = await service.getPortal(speaker);
      await service.updateProfile(speaker, {
        revision: before.profile.revision,
        name: "Priya Published Profile",
        biography:
          "Priya builds inclusive event technology for programme teams and their audiences.",
        publish: true,
      });

      await expect(service.getPortal(speaker)).resolves.toMatchObject({
        profile: {
          name: "Priya Published Profile",
          pronunciation: null,
          organisationName: null,
          jobTitle: null,
          linkedinUrl: null,
          xHandle: null,
          travelPreferences: null,
          profileStatus: "published",
          revision: before.profile.revision + 1,
        },
      });
    } finally {
      await testEnv.DB.prepare(
        `DELETE FROM event_participant_field_policies
          WHERE event_id = ? AND field_key IN (
            'pronunciation','organisation_name','job_title','linkedin_url',
            'x_handle','travel_preferences'
          )`,
      )
        .bind(speaker.eventId)
        .run();
    }
  });

  it("updates a profile through an accepted submitter membership", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const portal = await service.getPortal(submitter);

    await service.updateProfile(submitter, {
      revision: portal.profile.revision,
      name: "Alex Morgan",
      biography:
        "Alex develops practical event proposals and collaborates with programme teams worldwide.",
      pronunciation: "AL-ex MOR-gan",
      organisationName: "Morgan Events",
      jobTitle: "Programme Lead",
      linkedinUrl: "",
      xHandle: "",
      travelPreferences: "",
      publish: true,
    });

    await expect(service.getPortal(submitter)).resolves.toMatchObject({
      profile: {
        name: "Alex Morgan",
        jobTitle: "Programme Lead",
        revision: portal.profile.revision + 1,
      },
    });
  });

  it("isolates private travel preferences for the same participant across organisations", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const token = crypto.randomUUID();
    const personId = `travel-profile-person-${token}`;
    const firstOrganisationId = `travel-profile-org-a-${token}`;
    const secondOrganisationId = `travel-profile-org-b-${token}`;
    const firstEventId = `travel-profile-event-a-${token}`;
    const secondEventId = `travel-profile-event-b-${token}`;
    const filePolicy =
      '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}';
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, biography, profile_status,
           created_at, updated_at
         ) VALUES (?, ?, 'Shared Travel Speaker',
                   'A sufficiently detailed biography for the shared travel profile isolation test.',
                   'published', unixepoch(), unixepoch())`,
      ).bind(personId, `travel-profile-${token}@example.com`),
      testEnv.DB.prepare(
        "INSERT INTO organisations (id, name, slug) VALUES (?, 'Travel profile organisation A', ?)",
      ).bind(firstOrganisationId, `travel-profile-org-a-${token}`),
      testEnv.DB.prepare(
        "INSERT INTO organisations (id, name, slug) VALUES (?, 'Travel profile organisation B', ?)",
      ).bind(secondOrganisationId, `travel-profile-org-b-${token}`),
      testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json
         ) VALUES (?, ?, 'Travel profile event A', ?, 'UTC', 1800000000,
                   1800086400, ?)`,
      ).bind(
        firstEventId,
        firstOrganisationId,
        `travel-profile-event-a-${token}`,
        filePolicy,
      ),
      testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json
         ) VALUES (?, ?, 'Travel profile event B', ?, 'UTC', 1800000000,
                   1800086400, ?)`,
      ).bind(
        secondEventId,
        secondOrganisationId,
        `travel-profile-event-b-${token}`,
        filePolicy,
      ),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch())`,
      ).bind(
        `travel-profile-membership-a-${token}`,
        firstOrganisationId,
        firstEventId,
        personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch())`,
      ).bind(
        `travel-profile-membership-b-${token}`,
        secondOrganisationId,
        secondEventId,
        personId,
      ),
    ]);
    const service = new SpeakerService(testEnv);
    const firstSpeaker: Viewer = {
      personId,
      name: "Shared Travel Speaker",
      email: `travel-profile-${token}@example.com`,
      role: "speaker",
      organisationId: firstOrganisationId,
      eventId: firstEventId,
      demo: true,
    };
    const secondSpeaker: Viewer = {
      ...firstSpeaker,
      organisationId: secondOrganisationId,
      eventId: secondEventId,
    };
    const update = async (viewer: Viewer, travelPreferences: string) => {
      const portal = await service.getPortal(viewer);
      await service.updateProfile(viewer, {
        revision: portal.profile.revision,
        name: portal.profile.name,
        biography: portal.profile.biography ?? "",
        pronunciation: portal.profile.pronunciation ?? "",
        organisationName: portal.profile.organisationName ?? "",
        jobTitle: portal.profile.jobTitle ?? "",
        linkedinUrl: portal.profile.linkedinUrl ?? "",
        xHandle: portal.profile.xHandle ?? "",
        travelPreferences,
        publish: portal.profile.profileStatus === "published",
      });
    };

    await update(firstSpeaker, "Primary event ground transport preferences");
    await update(secondSpeaker, "Other organisation dietary preferences");

    await expect(service.getPortal(firstSpeaker)).resolves.toMatchObject({
      profile: {
        travelPreferences: "Primary event ground transport preferences",
      },
    });
    await expect(service.getPortal(secondSpeaker)).resolves.toMatchObject({
      profile: {
        travelPreferences: "Other organisation dietary preferences",
      },
    });
    await expect(
      service.getAdminSpeakerDetail(
        {
          ...admin,
          organisationId: firstOrganisationId,
          eventId: firstEventId,
        },
        personId,
      ),
    ).resolves.toMatchObject({
      profile: {
        travelPreferences: "Primary event ground transport preferences",
      },
    });
    await expect(
      service.getAdminSpeakerDetail(
        {
          ...admin,
          organisationId: secondOrganisationId,
          eventId: secondEventId,
        },
        personId,
      ),
    ).resolves.toMatchObject({
      profile: {
        travelPreferences: "Other organisation dietary preferences",
      },
    });
    const storedProfiles = await testEnv.DB.prepare(
      `SELECT event_id AS eventId, organisation_id AS organisationId,
              travel_preferences AS travelPreferences
         FROM event_participant_profiles
        WHERE person_id = ?
          AND event_id IN (?, ?)
        ORDER BY event_id`,
    )
      .bind(personId, firstEventId, secondEventId)
      .all();
    expect(storedProfiles.results).toEqual(
      expect.arrayContaining([
        {
          eventId: firstEventId,
          organisationId: firstOrganisationId,
          travelPreferences: "Primary event ground transport preferences",
        },
        {
          eventId: secondEventId,
          organisationId: secondOrganisationId,
          travelPreferences: "Other organisation dietary preferences",
        },
      ]),
    );
    await expect(
      service.getPortal({
        ...firstSpeaker,
        organisationId: secondOrganisationId,
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.getAdminSpeakerDetail(
        {
          ...admin,
          organisationId: secondOrganisationId,
          eventId: firstEventId,
        },
        personId,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects a person without a current speaker membership", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    await expect(
      new SpeakerService(testEnv).getPortal({
        ...speaker,
        personId: "person-demo-admin",
        role: "speaker",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
