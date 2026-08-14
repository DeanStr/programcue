import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { ensureDemoSpeakerData } from "./demo.server";
import {
  SpeakerAdminIntegrityError,
  SpeakerAdminStateError,
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
        linkedinUrl: "",
        xHandle: "",
        travelPreferences: "",
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

  it("returns exact current headshot filename, uploader and upload time to both profile surfaces", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    await testEnv.DB.prepare(
      `DELETE FROM file_assets
        WHERE event_id = ? AND owner_person_id = ?
          AND target_type = 'person' AND target_id = ?
          AND asset_kind = 'headshot'`,
    )
      .bind(speaker.eventId, speaker.personId, speaker.personId)
      .run();
    const assetId = crypto.randomUUID();
    const versionId = crypto.randomUUID();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status
         ) VALUES (?, ?, ?, 'person', ?, 'headshot', 'active')`,
      ).bind(assetId, speaker.eventId, speaker.personId, speaker.personId),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, created_by_person_id, uploaded_at, released_at
         ) VALUES (?, ?, ?, 1, ?, 'headshot.png', 'image/png', 'image/png',
                   128, 'headshot-etag', 'uploaded', 'valid', 'clean', ?,
                   unixepoch() - 10, unixepoch())`,
      ).bind(
        versionId,
        speaker.eventId,
        assetId,
        `tests/${versionId}`,
        speaker.personId,
      ),
      testEnv.DB.prepare(
        "UPDATE file_assets SET current_version_id = ? WHERE id = ? AND event_id = ?",
      ).bind(versionId, assetId, speaker.eventId),
    ]);

    const service = new SpeakerService(testEnv);
    const adminHeadshot = (
      await service.getAdminSpeakerDetail(admin, speaker.personId)
    ).files.find((file) => file.id === assetId);
    expect(adminHeadshot).toMatchObject({
      kind: "headshot",
      targetType: "person",
      targetId: speaker.personId,
      downloadFilename: "headshot.png",
      downloadUploaderName: speaker.name,
      downloadUploadedAt: expect.any(Number),
    });
    const participantHeadshot = (await service.getPortal(speaker)).files.find(
      (file) => file.id === assetId,
    );
    expect(participantHeadshot).toMatchObject({
      kind: "headshot",
      targetType: "person",
      targetId: speaker.personId,
      downloadFilename: "headshot.png",
      downloadUploaderName: speaker.name,
      downloadUploadedAt: expect.any(Number),
    });

    await testEnv.DB.prepare(
      "UPDATE file_versions SET created_by_person_id = NULL WHERE id = ? AND event_id = ?",
    )
      .bind(versionId, speaker.eventId)
      .run();
    await expect(
      service.getAdminSpeakerDetail(admin, speaker.personId),
    ).rejects.toThrow(/file .* missing upload provenance/i);
    await expect(service.getPortal(speaker)).rejects.toThrow(
      /file .* missing upload provenance/i,
    );
    await testEnv.DB.prepare(
      "UPDATE file_versions SET created_by_person_id = ? WHERE id = ? AND event_id = ?",
    )
      .bind(speaker.personId, versionId, speaker.eventId)
      .run();
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
        linkedinUrl: "",
        xHandle: "",
        travelPreferences: "",
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
        linkedinUrl: "https://www.linkedin.com/in/priya-shah",
        xHandle: "@priya_shah",
        travelPreferences: "Arrival May 11, aisle seat; dietary: Vegetarian",
        profileStatus: "published",
      },
    );
    expect(saved).toMatchObject({
      revision: before.profile.revision + 1,
      profileStatus: "published",
    });

    const after = await service.getAdminSpeakerDetail(admin, speaker.personId);
    expect(after.profile).toMatchObject({
      jobTitle: "Head of Experience Design",
      linkedinUrl: "https://www.linkedin.com/in/priya-shah",
      xHandle: "priya_shah",
      travelPreferences: "Arrival May 11, aisle seat; dietary: Vegetarian",
      profileStatus: "published",
    });
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
        linkedinUrl: "",
        xHandle: "",
        travelPreferences: "",
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
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         ) VALUES (?, ?, ?, 0, 'Speaker', 'confirmed', unixepoch(), 'public')`,
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
        linkedinUrl: "",
        xHandle: "",
        travelPreferences: "",
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

  it("treats a roster workflow in another event as a shared profile association", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const token = crypto.randomUUID();
    const otherEventId = `speaker-workflow-shared-event-${token}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           file_policy_json
         ) VALUES (?, ?, 'Other roster event', ?, 'UTC', 1800000000,
                   1800086400,
                   '{"headshotMaximumBytes":10485760,"slidesMaximumBytes":104857600,"supportingDocumentMaximumBytes":104857600,"videoMaximumBytes":1073741824}')`,
      ).bind(
        otherEventId,
        admin.organisationId,
        `speaker-workflow-shared-event-${token}`,
      ),
      testEnv.DB.prepare(
        `INSERT INTO event_speaker_workflows (
           event_id, person_id, status, source, last_operation_id,
           updated_by_person_id, created_at, updated_at
         ) VALUES (?, ?, 'prospect', 'manual', ?, ?, unixepoch(), unixepoch())`,
      ).bind(
        otherEventId,
        speaker.personId,
        `speaker-workflow-shared:${token}`,
        admin.personId,
      ),
    ]);
    try {
      const service = new SpeakerService(testEnv);
      const before = await service.getAdminSpeakerDetail(
        admin,
        speaker.personId,
      );
      expect(before.profileShared).toBe(true);
      await expect(
        service.updateAdminSpeakerProfile(admin, speaker.personId, {
          revision: before.profile.revision,
          name: "Cross-event overwrite",
          biography: "This must remain unchanged.",
          pronunciation: "",
          organisationName: "Wrong event",
          jobTitle: "Wrong title",
          linkedinUrl: "",
          xHandle: "",
          travelPreferences: "",
          profileStatus: "archived",
        }),
      ).rejects.toBeInstanceOf(SpeakerAdminStateError);
    } finally {
      await testEnv.DB.prepare("DELETE FROM events WHERE id = ?")
        .bind(otherEventId)
        .run();
    }
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
      linkedinUrl: portal.profile.linkedinUrl ?? "",
      xHandle: portal.profile.xHandle ?? "",
      travelPreferences: portal.profile.travelPreferences ?? "",
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
           signature_status, scan_status, created_by_person_id, uploaded_at,
           scanned_at, released_at
         ) VALUES (?, ?, ?, 1, ?, 'released.pdf', 'application/pdf',
                   'application/pdf', 100, 'uploaded', 'valid', 'clean',
                   ?, unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        releasedVersionId,
        speaker.eventId,
        downloadableAssetId,
        `tests/${releasedVersionId}`,
        speaker.personId,
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
