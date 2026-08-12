import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoSpeakerData } from "./demo.server";
import {
  SpeakerAdminIntegrityError,
  SpeakerAdminStateError,
  SpeakerProfileConflictError,
  SpeakerService,
} from "./speaker-service.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";

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

const webhookCredentialKey = btoa(
  String.fromCharCode(...Array.from({ length: 32 }, (_, index) => index)),
);

describe("speaker profile service", () => {
  it("persists and replays one durable invitation delivery operation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const email = `durable-invitation-${suffix}@example.com`;
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

    const created = await service.createManualSpeaker(admin, input);
    expect(created.delivery).toBe("queued");
    expect(queued).toHaveLength(1);
    await expect(service.createManualSpeaker(admin, input)).resolves.toEqual(
      created,
    );
    expect(queued).toHaveLength(1);
    await testEnv.DB.prepare(
      `UPDATE memberships SET accepted_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    )
      .bind(created.membershipId, admin.eventId)
      .run();
    await expect(service.createManualSpeaker(admin, input)).resolves.toEqual({
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
    const email = `fast-consumer-${suffix}@example.com`;
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

    const created = await new SpeakerService(productionEnv).createManualSpeaker(
      admin,
      {
        idempotencyKey: `fast-consumer:${suffix}`,
        name: "Fast Queue Consumer",
        email,
      },
    );

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
    const email = `missing-queue-${crypto.randomUUID()}@example.com`;
    const productionWithoutQueue = {
      ...testEnv,
      APP_ENV: "production",
      DEMO_MODE: "false",
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment;

    await expect(
      new SpeakerService(productionWithoutQueue).createManualSpeaker(admin, {
        idempotencyKey: `missing-queue:${crypto.randomUUID()}`,
        name: "Missing Queue",
        email,
      }),
    ).rejects.toThrow(/OPERATIONS_QUEUE.*no speaker invitation was saved/i);
    await expect(
      testEnv.DB.prepare("SELECT id FROM people WHERE email = ?")
        .bind(email)
        .first(),
    ).resolves.toBeNull();
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
    ]);

    await expect(
      new SpeakerService(testEnv).createManualSpeaker(admin, {
        idempotencyKey: `reactivate:${suffix}`,
        name: "Revoked Speaker",
        email,
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

  it("keeps an identity from another organisation pending until that person accepts", async () => {
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

    const result = await new SpeakerService(testEnv).createManualSpeaker(
      admin,
      {
        idempotencyKey: `cross-org:${suffix}`,
        name: "Administrator supplied name",
        email,
      },
    );
    expect(result).toMatchObject({ personId, accepted: false });
    await expect(
      new SpeakerService(testEnv).getAdminSpeakerDetail(admin, personId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      new SpeakerService(testEnv).getPortal({
        ...speaker,
        personId,
        email,
      }),
    ).rejects.toMatchObject({ status: 403 });
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
    const created = await new SpeakerService(testEnv).createManualSpeaker(
      admin,
      {
        idempotencyKey: `missing-expiry:${suffix}`,
        name: "Missing Expiry",
        email: `missing-expiry-${suffix}@example.com`,
      },
    );
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
      publish: true,
    });
    const saved = await service.getPortal(speaker);
    expect(saved.profile.jobTitle).toBe("Director");
    expect(saved.profile.revision).toBe(portal.profile.revision + 1);

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

  it("loads an event-scoped organiser speaker detail and refuses a person outside the event", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const detail = await service.getAdminSpeakerDetail(admin, speaker.personId);
    expect(detail.profile.id).toBe(speaker.personId);
    expect(detail.event.timezone).toBe("America/Toronto");
    expect(detail.sessions.map((session) => session.id)).toContain(
      "session-demo-speaker",
    );
    expect(detail.tasks.outstanding).toBeGreaterThan(0);
    expect(
      detail.files.every((file) =>
        file.versions.every((version) => version.assetId === file.id),
      ),
    ).toBe(true);

    const outsiderId = `outside-event-person-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO people (id, email, display_name, email_verified, profile_status)
       VALUES (?, ?, 'Outside Event Speaker', 1, 'draft')`,
    )
      .bind(outsiderId, `${outsiderId}@example.invalid`)
      .run();
    await expect(
      service.getAdminSpeakerDetail(admin, outsiderId),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      service.updateAdminSpeakerProfile(admin, outsiderId, {
        revision: 1,
        name: "Outside Event Speaker",
        biography: "",
        pronunciation: "",
        organisationName: "",
        jobTitle: "",
        profileStatus: "published",
      }),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      testEnv.DB.prepare(
        "SELECT profile_status AS profileStatus FROM people WHERE id = ?",
      )
        .bind(outsiderId)
        .first(),
    ).resolves.toEqual({ profileStatus: "draft" });

    const brokenAssetId = `broken-current-version-${crypto.randomUUID()}`;
    const otherAssetId = `other-current-version-${crypto.randomUUID()}`;
    const otherVersionId = `other-version-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status
         ) VALUES (?, ?, ?, 'session', ?, 'other', 'active')`,
      ).bind(
        otherAssetId,
        admin.eventId,
        speaker.personId,
        "session-demo-speaker",
      ),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, size_bytes,
           upload_status, signature_status, scan_status
         ) VALUES (?, ?, ?, 1, ?, 'other-asset.pdf', 'application/pdf', 10,
                   'uploaded', 'valid', 'clean')`,
      ).bind(
        otherVersionId,
        admin.eventId,
        otherAssetId,
        `tests/${otherVersionId}`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           current_version_id, status
         ) VALUES (?, ?, ?, 'person', ?, 'other', ?, 'active')`,
      ).bind(
        brokenAssetId,
        admin.eventId,
        speaker.personId,
        speaker.personId,
        otherVersionId,
      ),
    ]);
    await expect(
      service.getAdminSpeakerDetail(admin, speaker.personId),
    ).rejects.toBeInstanceOf(SpeakerAdminIntegrityError);
    await testEnv.DB.batch([
      testEnv.DB.prepare("DELETE FROM file_assets WHERE id = ?").bind(
        brokenAssetId,
      ),
      testEnv.DB.prepare("DELETE FROM file_assets WHERE id = ?").bind(
        otherAssetId,
      ),
    ]);
  });

  it("commits one organiser profile revision and rejects a stale organiser save", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const revokedMembershipId = `revoked-shared-membership-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role, invited_at,
         accepted_at, revoked_at, created_at
       ) VALUES (?, ?, NULL, ?, 'administrator', unixepoch() - 300,
                 unixepoch() - 200, unixepoch() - 100, unixepoch() - 300)`,
    )
      .bind(revokedMembershipId, admin.organisationId, speaker.personId)
      .run();
    const before = await service.getAdminSpeakerDetail(admin, speaker.personId);
    expect(before.profileShared).toBe(false);

    await expect(
      service.updateAdminSpeakerProfile(admin, speaker.personId, {
        revision: before.profile.revision,
        name: "Incomplete organiser input",
        biography: "This must not clear omitted fields.",
        pronunciation: "",
        organisationName: "EventLab",
        profileStatus: "published",
      }),
    ).rejects.toMatchObject({ name: "ZodError" });
    const afterRejectedInput = await service.getAdminSpeakerDetail(
      admin,
      speaker.personId,
    );
    expect(afterRejectedInput.profile).toMatchObject({
      revision: before.profile.revision,
      name: before.profile.name,
      jobTitle: before.profile.jobTitle,
    });

    const saved = await service.updateAdminSpeakerProfile(
      admin,
      speaker.personId,
      {
        revision: before.profile.revision,
        name: "Priya Shah",
        biography: "Organiser-corrected biography for the published programme.",
        pronunciation: "PREE-yah SHAH",
        organisationName: "EventLab",
        jobTitle: "Head of Experience Design",
        profileStatus: "published",
      },
    );
    expect(saved).toMatchObject({
      revision: before.profile.revision + 1,
      profileStatus: "published",
    });

    const after = await service.getAdminSpeakerDetail(admin, speaker.personId);
    expect(after.profile.jobTitle).toBe("Head of Experience Design");
    expect(after.profile.profileStatus).toBe("published");
    expect(after.profile.revision).toBe(before.profile.revision + 1);

    const audits = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE event_id = ? AND entity_id = ?
          AND action = 'speaker.admin.profile.updated'`,
    )
      .bind(admin.eventId, speaker.personId)
      .first<{ count: number }>();
    expect(audits?.count).toBe(1);

    await expect(
      service.updateAdminSpeakerProfile(admin, speaker.personId, {
        revision: before.profile.revision,
        name: "Stale Organiser Name",
        biography: "",
        pronunciation: "",
        organisationName: "",
        jobTitle: "",
        profileStatus: "draft",
      }),
    ).rejects.toBeInstanceOf(SpeakerProfileConflictError);
    const unchanged = await service.getAdminSpeakerDetail(
      admin,
      speaker.personId,
    );
    expect(unchanged.profile.name).toBe("Priya Shah");
    expect(unchanged.profile.revision).toBe(before.profile.revision + 1);
    await testEnv.DB.prepare("DELETE FROM memberships WHERE id = ?")
      .bind(revokedMembershipId)
      .run();
  });

  it("keeps a shared canonical identity read-only for an event organiser", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const token = crypto.randomUUID();
    const otherOrganisationId = `speaker-shared-org-${token}`;
    const otherEventId = `speaker-shared-event-${token}`;
    const otherSessionId = `speaker-shared-session-${token}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO organisations (id, name, slug) VALUES (?, 'Shared identity organisation', ?)",
      ).bind(otherOrganisationId, `speaker-shared-org-${token}`),
      testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json
         ) VALUES (?, ?, 'Shared identity event', ?, 'UTC', 1800000000,
                   1800086400,
                   '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
      ).bind(
        otherEventId,
        otherOrganisationId,
        `speaker-shared-event-${token}`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status,
           visibility
         ) VALUES (?, ?, 'Shared identity session', ?, 'presentation', 45,
                   'unscheduled', 'public')`,
      ).bind(otherSessionId, otherEventId, `speaker-shared-session-${token}`),
      testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label, visibility
         ) VALUES (?, ?, ?, 0, 'Speaker', 'public')`,
      ).bind(otherSessionId, otherEventId, speaker.personId),
    ]);

    const service = new SpeakerService(testEnv);
    const before = await service.getAdminSpeakerDetail(admin, speaker.personId);
    expect(before.profileShared).toBe(true);

    await expect(
      service.updateAdminSpeakerProfile(admin, speaker.personId, {
        revision: before.profile.revision,
        name: "Cross-organisation overwrite",
        biography: "This change must not reach the shared person record.",
        pronunciation: "",
        organisationName: "Wrong organisation",
        jobTitle: "Wrong title",
        profileStatus: "archived",
      }),
    ).rejects.toBeInstanceOf(SpeakerAdminStateError);

    const unchanged = await service.getAdminSpeakerDetail(
      admin,
      speaker.personId,
    );
    expect(unchanged.profile).toMatchObject({
      name: before.profile.name,
      organisationName: before.profile.organisationName,
      jobTitle: before.profile.jobTitle,
      profileStatus: before.profile.profileStatus,
      revision: before.profile.revision,
    });
  });

  it("pages the authoritative event speaker set and applies readiness filters server-side", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    await testEnv.DB.batch([
      testEnv.DB.prepare(`
        WITH RECURSIVE sequence(value) AS (
          VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 55
        )
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status
        )
        SELECT printf('speaker-page-person-%03d', value),
               printf('speaker-page-%03d@example.invalid', value),
               printf('Paged Speaker %03d', value), 1,
               CASE WHEN value % 2 = 0 THEN 'published' ELSE 'draft' END
          FROM sequence
      `),
      testEnv.DB.prepare(
        `
        WITH RECURSIVE sequence(value) AS (
          VALUES (1) UNION ALL SELECT value + 1 FROM sequence WHERE value < 55
        )
        INSERT INTO memberships (
          id, organisation_id, event_id, person_id, role, accepted_at
        )
        SELECT printf('speaker-page-membership-%03d', value), ?, ?,
               printf('speaker-page-person-%03d', value), 'speaker', unixepoch()
          FROM sequence
      `,
      ).bind(admin.organisationId, admin.eventId),
      testEnv.DB.prepare(
        `
        WITH RECURSIVE sequence(value) AS (
          VALUES (10) UNION ALL SELECT value + 10 FROM sequence WHERE value < 50
        )
        INSERT INTO task_instances (
          id, event_id, target_type, target_id, owner_person_id, title,
          task_type, impact, status, readiness_state, readiness_percent
        )
        SELECT printf('speaker-page-task-%03d', value), ?, 'speaker',
               printf('speaker-page-person-%03d', value),
               printf('speaker-page-person-%03d', value), 'Scale task',
               'short_form', 'high', 'not_started', 'at_risk', 0
          FROM sequence
      `,
      ).bind(admin.eventId),
    ]);

    const service = new SpeakerService(testEnv);
    const first = await service.listAdminSpeakerPage(admin, {}, 1);
    const second = await service.listAdminSpeakerPage(admin, {}, 2);
    expect(first.speakers).toHaveLength(50);
    expect(first.hasNext).toBe(true);
    expect(second.speakers.length).toBeGreaterThan(0);
    expect(second.hasNext).toBe(false);
    expect(first.summary.knownSpeakers).toBeGreaterThanOrEqual(56);

    const needsAttention = await service.listAdminSpeakerPage(
      admin,
      { query: "Paged Speaker", readiness: "needs_attention" },
      1,
    );
    expect(needsAttention.speakers.map((candidate) => candidate.id)).toEqual([
      "speaker-page-person-010",
      "speaker-page-person-020",
      "speaker-page-person-030",
      "speaker-page-person-040",
      "speaker-page-person-050",
    ]);
    expect(
      needsAttention.speakers.every(
        (candidate) => candidate.outstandingTasks === 1,
      ),
    ).toBe(true);

    const published = await service.listAdminSpeakerPage(
      admin,
      { query: "Paged Speaker", profileStatus: "published" },
      1,
    );
    expect(published.speakers).toHaveLength(27);
    expect(
      published.speakers.every(
        (candidate) => candidate.profileStatus === "published",
      ),
    ).toBe(true);
    await expect(
      service.listAdminSpeakerPage(admin, {}, 0),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("uses the organisation-scoped Network label after event handoff", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const personId = `network-speaker-${suffix}`;
    const email = `network-speaker-${suffix}@example.com`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (id, email, display_name, profile_status)
         VALUES (?, ?, ?, 'draft')`,
      ).bind(personId, email, email),
      testEnv.DB.prepare(
        `INSERT INTO organisation_contacts (
           organisation_id, person_id, source, status, created_by_person_id
         ) VALUES (?, ?, 'manual', 'active', ?)`,
      ).bind(admin.organisationId, personId, admin.personId),
      testEnv.DB.prepare(
        `INSERT INTO organisation_contact_profiles (
           organisation_id, person_id, display_name, organisation_name,
           job_title, source, created_by_person_id, updated_by_person_id
         ) VALUES (?, ?, 'Network Display Name', 'Network Company',
                   'Network Role', 'manual', ?, ?)`,
      ).bind(admin.organisationId, personId, admin.personId, admin.personId),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch())`,
      ).bind(
        `network-membership-${suffix}`,
        admin.organisationId,
        admin.eventId,
        personId,
      ),
    ]);

    const result = await new SpeakerService(testEnv).listAdminSpeakerPage(
      admin,
      { personId },
      1,
    );
    expect(result.speakers).toEqual([
      expect.objectContaining({
        id: personId,
        name: "Network Display Name",
        organisationName: "Network Company",
        jobTitle: "Network Role",
      }),
    ]);
  });

  it("queues the advertised speaker.updated event after the profile commit", async () => {
    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      WEBHOOK_CREDENTIALS_KEY: webhookCredentialKey,
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const webhookService = new WebhookService(testEnv);
    const endpoint = await webhookService.create(admin, {
      name: `Speaker updates ${crypto.randomUUID()}`,
      url: "https://hooks.example.com/speakers",
      eventTypes: ["speaker.updated"],
    });
    const service = new SpeakerService(testEnv);
    const portal = await service.getPortal(speaker);

    const result = await service.updateProfile(speaker, {
      revision: portal.profile.revision,
      name: portal.profile.name,
      biography:
        "Priya designs inclusive event technology experiences for teams and audiences worldwide.",
      pronunciation: portal.profile.pronunciation ?? "",
      organisationName: portal.profile.organisationName ?? "",
      jobTitle: portal.profile.jobTitle ?? "",
      publish: portal.profile.profileStatus === "published",
    });

    expect(result.webhookWarning).toBeNull();
    expect(queued).toHaveLength(1);
    expect(
      await testEnv.DB.prepare(
        `SELECT event_type AS eventType, entity_id AS entityId
           FROM webhook_deliveries
          WHERE endpoint_id = ?`,
      )
        .bind(endpoint.id)
        .first(),
    ).toEqual({
      eventType: "speaker.updated",
      entityId: speaker.personId,
    });
  });

  it("keeps the released download available while reporting a failed replacement honestly", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const before = (await service.listAdminSpeakerPage(admin, {}, 1)).speakers;
    const quarantinedBefore = before.find(
      (candidate) => candidate.id === speaker.personId,
    )?.quarantinedFiles;
    const downloadableAssetId = crypto.randomUUID();
    const releasedVersionId = crypto.randomUUID();
    const infectedVersionId = crypto.randomUUID();
    const failedAssetId = crypto.randomUUID();
    const failedVersionId = crypto.randomUUID();

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           current_version_id, status
         ) VALUES (?, ?, ?, 'person', ?, 'slides', ?, 'active')`,
      ).bind(
        downloadableAssetId,
        speaker.eventId,
        speaker.personId,
        speaker.personId,
        releasedVersionId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key, original_filename,
           declared_content_type, detected_content_type, size_bytes, upload_status,
           signature_status, scan_status, uploaded_at, scanned_at, released_at
         ) VALUES (?, ?, ?, 1, ?, 'released.pdf', 'application/pdf',
                   'application/pdf', 100, 'uploaded', 'valid', 'clean',
                   unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        releasedVersionId,
        speaker.eventId,
        downloadableAssetId,
        `tests/${releasedVersionId}`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key, original_filename,
           declared_content_type, detected_content_type, size_bytes, upload_status,
           signature_status, scan_status, uploaded_at, scanned_at, scan_error
         ) VALUES (?, ?, ?, 2, ?, 'infected-replacement.pdf', 'application/pdf',
                   'application/pdf', 101, 'uploaded', 'valid', 'infected',
                   unixepoch(), unixepoch(), 'Malware detected')`,
      ).bind(
        infectedVersionId,
        speaker.eventId,
        downloadableAssetId,
        `tests/${infectedVersionId}`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind, status
         ) VALUES (?, ?, ?, 'person', ?, 'supporting_document', 'rejected')`,
      ).bind(
        failedAssetId,
        speaker.eventId,
        speaker.personId,
        speaker.personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key, original_filename,
           declared_content_type, size_bytes, upload_status, signature_status,
           scan_status, scan_error
         ) VALUES (?, ?, ?, 1, ?, 'failed.pdf', 'application/pdf', 0,
                   'failed', 'invalid', 'pending', 'Rejected before quarantine')`,
      ).bind(
        failedVersionId,
        speaker.eventId,
        failedAssetId,
        `tests/${failedVersionId}`,
      ),
    ]);

    const portal = await service.getPortal(speaker);
    expect(
      portal.files.find((file) => file.id === downloadableAssetId),
    ).toMatchObject({
      filename: "infected-replacement.pdf",
      scanStatus: "infected",
      currentVersionId: releasedVersionId,
      downloadFilename: "released.pdf",
      downloadReleasedAt: expect.any(Number),
    });
    const after = (await service.listAdminSpeakerPage(admin, {}, 1)).speakers;
    expect(
      after.find((candidate) => candidate.id === speaker.personId)
        ?.quarantinedFiles,
    ).toBe(quarantinedBefore);
  });
});
