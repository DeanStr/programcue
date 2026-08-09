import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("speaker profile service", () => {
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

  it("keeps the released download available while reporting a failed replacement honestly", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const before = await service.listAdminSpeakers(admin);
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
    const after = await service.listAdminSpeakers(admin);
    expect(
      after.find((candidate) => candidate.id === speaker.personId)
        ?.quarantinedFiles,
    ).toBe(quarantinedBefore);
  });
});
