import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoSpeakerData } from "./demo.server";
import {
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
        biography: "",
        organisationName: "",
        jobTitle: "",
      }),
    ).resolves.toEqual({ personId });

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
      acceptedAt: expect.any(Number),
      revokedAt: null,
      invitationExpiresAt: null,
    });
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
        WHERE event_id = ? AND entity_id = ? AND action = 'speaker.profile.updated'`,
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
        WHERE event_id = ? AND entity_id = ? AND action = 'speaker.profile.updated'`,
    )
      .bind(speaker.eventId, speaker.personId)
      .first<{ count: number }>();
    expect(auditCountAfterStale?.count).toBe(auditCountBeforeStale?.count);
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
