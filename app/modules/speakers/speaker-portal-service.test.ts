import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoSpeakerData } from "./demo.server";
import { SpeakerService } from "./speaker-service.server";

const speaker: Viewer = {
  personId: "person-demo-speaker",
  name: "Priya Shah",
  email: "priya.speaker@example.com",
  role: "speaker",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("speaker portal file integrity", () => {
  it("derives a deliverable's session through its exact task", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const taskId = `session-deliverable-${suffix}`;
    const assetId = `session-deliverable-asset-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, owner_person_id, title,
           task_type, impact, evidence_mode, configuration_json,
           status, readiness_state, readiness_percent
         ) VALUES (?, ?, 'session', 'session-demo-speaker', ?,
                   'Upload the session handout', 'file_upload', 'high', 'file',
                   '{"fileScope":"session_deliverable"}', 'not_started', 'on_track', 0)`,
      ).bind(taskId, speaker.eventId, speaker.personId),
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status
         ) VALUES (?, ?, ?, 'task', ?, 'task_evidence', 'pending')`,
      ).bind(assetId, speaker.eventId, speaker.personId, taskId),
    ]);

    const portal = await new SpeakerService(testEnv).getPortal(speaker);
    expect(portal.files.find((file) => file.id === assetId)).toMatchObject({
      taskTitle: "Upload the session handout",
      sessionTitle: "Designing inclusive event technology",
    });
  });

  it("lists a shared session deliverable for every speaker on the exact session", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const suffix = crypto.randomUUID();
    const coSpeakerId = `portal-co-speaker-${suffix}`;
    const taskId = `shared-session-deliverable-${suffix}`;
    const sharedAssetId = `shared-session-asset-${suffix}`;
    const firstVersionId = `shared-session-version-1-${suffix}`;
    const secondVersionId = `shared-session-version-2-${suffix}`;
    const privateTaskId = `participant-document-${suffix}`;
    const privateAssetId = `participant-document-asset-${suffix}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, created_at, updated_at
         ) VALUES (?, ?, 'Portal co-speaker', 1, unixepoch(), unixepoch())`,
      ).bind(coSpeakerId, `${coSpeakerId}@example.test`),
      testEnv.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, accepted_at, created_at
         ) VALUES (?, ?, ?, ?, 'speaker', unixepoch(), unixepoch())`,
      ).bind(
        `portal-co-speaker-membership-${suffix}`,
        speaker.organisationId,
        speaker.eventId,
        coSpeakerId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO session_speakers (
           session_id, event_id, person_id, position, role_label,
           participation_status, participation_confirmed_at, visibility
         ) SELECT 'session-demo-speaker', ?, ?, COALESCE(MAX(position), -1) + 1,
                  'Co-speaker', 'confirmed', unixepoch(), 'public'
             FROM session_speakers
            WHERE session_id = 'session-demo-speaker' AND event_id = ?`,
      ).bind(speaker.eventId, coSpeakerId, speaker.eventId),
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, owner_person_id, title,
           task_type, impact, evidence_mode, configuration_json,
           status, readiness_state, readiness_percent
         ) VALUES (?, ?, 'session', 'session-demo-speaker', ?,
                   'Upload the shared session handout', 'file_upload', 'high',
                   'file', '{"fileScope":"session_deliverable"}',
                   'not_started', 'on_track', 0)`,
      ).bind(taskId, speaker.eventId, speaker.personId),
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status
         ) VALUES (?, ?, ?, 'task', ?, 'task_evidence', 'pending')`,
      ).bind(sharedAssetId, speaker.eventId, speaker.personId, taskId),
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, owner_person_id, title,
           task_type, impact, evidence_mode, configuration_json,
           status, readiness_state, readiness_percent
         ) VALUES (?, ?, 'speaker', ?, ?, 'Upload a private participant file',
                   'file_upload', 'medium', 'file',
                   '{"fileScope":"participant_document"}',
                   'not_started', 'on_track', 0)`,
      ).bind(
        privateTaskId,
        speaker.eventId,
        speaker.personId,
        speaker.personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status
         ) VALUES (?, ?, ?, 'task', ?, 'task_evidence', 'pending')`,
      ).bind(privateAssetId, speaker.eventId, speaker.personId, privateTaskId),
    ]);

    const coSpeaker = {
      personId: coSpeakerId,
      name: "Portal co-speaker",
      email: `${coSpeakerId}@example.test`,
      role: "speaker",
      organisationId: speaker.organisationId,
      eventId: speaker.eventId,
      demo: true,
    } satisfies Viewer;
    const service = new SpeakerService(testEnv);

    const beforeAttachment = await service.getPortal(coSpeaker);
    expect(
      beforeAttachment.files.some((file) => file.id === sharedAssetId),
    ).toBe(false);
    expect(
      beforeAttachment.files.some((file) => file.id === privateAssetId),
    ).toBe(false);

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status, scan_status,
           created_by_person_id, uploaded_at, scanned_at, released_at
         ) VALUES (?, ?, ?, 1, ?, 'shared-v1.pdf', 'application/pdf',
                   'application/pdf', 10, 'etag-v1', 'uploaded', 'valid', 'clean',
                   ?, unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        firstVersionId,
        speaker.eventId,
        sharedAssetId,
        `tests/${firstVersionId}`,
        speaker.personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO task_evidence (
           id, event_id, task_id, submitted_by_person_id, file_asset_id,
           evidence_json, status
         ) VALUES (?, ?, ?, ?, ?, ?, 'submitted')`,
      ).bind(
        `shared-session-evidence-1-${suffix}`,
        speaker.eventId,
        taskId,
        speaker.personId,
        sharedAssetId,
        JSON.stringify({ fileVersionId: firstVersionId, scanStatus: "clean" }),
      ),
      testEnv.DB.prepare(
        `UPDATE file_assets
            SET current_version_id = ?, status = 'active', updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(firstVersionId, sharedAssetId, speaker.eventId),
    ]);

    const attached = await service.getPortal(coSpeaker);
    expect(
      attached.files.find((file) => file.id === sharedAssetId),
    ).toMatchObject({
      filename: "shared-v1.pdf",
      currentVersionId: firstVersionId,
      taskTitle: "Upload the shared session handout",
      sessionTitle: "Designing inclusive event technology",
      versions: [expect.objectContaining({ id: firstVersionId })],
    });

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status, scan_status,
           created_by_person_id, uploaded_at, scanned_at, released_at
         ) VALUES (?, ?, ?, 2, ?, 'private-unattached-v2.pdf', 'application/pdf',
                   'application/pdf', 11, 'etag-v2', 'uploaded', 'valid', 'clean',
                   ?, unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        secondVersionId,
        speaker.eventId,
        sharedAssetId,
        `tests/${secondVersionId}`,
        speaker.personId,
      ),
      testEnv.DB.prepare(
        `UPDATE file_assets
            SET current_version_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(secondVersionId, sharedAssetId, speaker.eventId),
    ]);

    const replacementPendingAttachment = await service.getPortal(coSpeaker);
    expect(
      replacementPendingAttachment.files.find(
        (file) => file.id === sharedAssetId,
      ),
    ).toMatchObject({
      filename: "shared-v1.pdf",
      currentVersionId: firstVersionId,
      taskTitle: "Upload the shared session handout",
      sessionTitle: "Designing inclusive event technology",
      versions: [expect.objectContaining({ id: firstVersionId })],
    });
    expect(
      replacementPendingAttachment.files.some((file) =>
        file.versions.some((version) => version.id === secondVersionId),
      ),
    ).toBe(false);

    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `UPDATE task_evidence SET status = 'superseded'
          WHERE event_id = ? AND task_id = ? AND file_asset_id = ?`,
      ).bind(speaker.eventId, taskId, sharedAssetId),
      testEnv.DB.prepare(
        `INSERT INTO task_evidence (
           id, event_id, task_id, submitted_by_person_id, file_asset_id,
           evidence_json, status
         ) VALUES (?, ?, ?, ?, ?, ?, 'submitted')`,
      ).bind(
        `shared-session-evidence-2-${suffix}`,
        speaker.eventId,
        taskId,
        speaker.personId,
        sharedAssetId,
        JSON.stringify({ fileVersionId: secondVersionId, scanStatus: "clean" }),
      ),
    ]);

    const replacementAttached = await service.getPortal(coSpeaker);
    expect(
      replacementAttached.files.find((file) => file.id === sharedAssetId),
    ).toMatchObject({
      filename: "private-unattached-v2.pdf",
      currentVersionId: secondVersionId,
      versions: [
        expect.objectContaining({ id: secondVersionId }),
        expect.objectContaining({ id: firstVersionId }),
      ],
    });
  });

  it("fails when a current file version is dangling or deleted", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    const service = new SpeakerService(testEnv);
    const assetId = crypto.randomUUID();
    const missingVersionId = crypto.randomUUID();
    await testEnv.DB.prepare(
      `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
         current_version_id, status
       ) VALUES (?, ?, ?, 'task', 'task-demo-slides', 'task_evidence', ?,
                 'active')`,
    )
      .bind(assetId, speaker.eventId, speaker.personId, missingVersionId)
      .run();

    await expect(service.getPortal(speaker)).rejects.toThrow(
      new RegExp(
        `file asset ${assetId} references unavailable current version`,
        "i",
      ),
    );

    const deletedVersionId = crypto.randomUUID();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "UPDATE file_assets SET current_version_id = NULL WHERE id = ? AND event_id = ?",
      ).bind(assetId, speaker.eventId),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, upload_status, signature_status, scan_status,
           created_by_person_id, deleted_at
         ) VALUES (?, ?, ?, 1, ?, 'deleted.pdf', 'application/pdf',
                   'application/pdf', 10, 'uploaded', 'valid', 'clean', ?,
                   unixepoch())`,
      ).bind(
        deletedVersionId,
        speaker.eventId,
        assetId,
        `tests/${deletedVersionId}`,
        speaker.personId,
      ),
      testEnv.DB.prepare(
        "UPDATE file_assets SET current_version_id = ? WHERE id = ? AND event_id = ?",
      ).bind(deletedVersionId, assetId, speaker.eventId),
    ]);

    await expect(service.getPortal(speaker)).rejects.toThrow(
      new RegExp(
        `file asset ${assetId} references unavailable current version`,
        "i",
      ),
    );
  });

  it("suppresses the bundled programme portrait once any real headshot asset exists", async () => {
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      DEMO_MODE: "true",
    } as unknown as CloudflareEnvironment;
    await ensureDemoSpeakerData(testEnv);
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `DELETE FROM task_evidence
          WHERE event_id = ? AND file_asset_id IN (
            SELECT id FROM file_assets
             WHERE event_id = ? AND owner_person_id = ?
          )`,
      ).bind(speaker.eventId, speaker.eventId, speaker.personId),
      testEnv.DB.prepare(
        `DELETE FROM file_versions
          WHERE event_id = ? AND asset_id IN (
            SELECT id FROM file_assets
             WHERE event_id = ? AND owner_person_id = ?
          )`,
      ).bind(speaker.eventId, speaker.eventId, speaker.personId),
      testEnv.DB.prepare(
        `DELETE FROM file_assets
          WHERE event_id = ? AND owner_person_id = ?`,
      ).bind(speaker.eventId, speaker.personId),
    ]);
    const service = new SpeakerService(testEnv);
    await expect(service.getPortal(speaker)).resolves.toMatchObject({
      profile: {
        programmePortraitUrl: "/images/demo-speakers/priya-shah.webp",
      },
    });

    const pendingAssetId = crypto.randomUUID();
    await testEnv.DB.prepare(
      `INSERT INTO file_assets (
         id, event_id, owner_person_id, target_type, target_id, asset_kind,
         status
       ) VALUES (?, ?, ?, 'person', ?, 'headshot', 'active')`,
    )
      .bind(pendingAssetId, speaker.eventId, speaker.personId, speaker.personId)
      .run();
    await expect(service.getPortal(speaker)).resolves.toMatchObject({
      profile: { programmePortraitUrl: null },
    });

    const releasedVersionId = crypto.randomUUID();
    const pendingVersionId = crypto.randomUUID();
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, created_by_person_id, uploaded_at, released_at
         ) VALUES (?, ?, ?, 1, ?, 'headshot.png', 'image/png', 'image/png',
                   128, 'released-etag', 'uploaded', 'valid', 'clean', ?,
                   unixepoch() - 20, unixepoch() - 10)`,
      ).bind(
        releasedVersionId,
        speaker.eventId,
        pendingAssetId,
        `tests/${releasedVersionId}`,
        speaker.personId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, created_by_person_id, uploaded_at
         ) VALUES (?, ?, ?, 2, ?, 'replacement.png', 'image/png', 'image/png',
                   128, 'pending-etag', 'uploaded', 'valid', 'pending', ?,
                   unixepoch())`,
      ).bind(
        pendingVersionId,
        speaker.eventId,
        pendingAssetId,
        `tests/${pendingVersionId}`,
        speaker.personId,
      ),
      testEnv.DB.prepare(
        "UPDATE file_assets SET current_version_id = ? WHERE id = ? AND event_id = ?",
      ).bind(releasedVersionId, pendingAssetId, speaker.eventId),
    ]);
    await expect(service.getPortal(speaker)).resolves.toMatchObject({
      profile: { programmePortraitUrl: null },
    });
  });
});
