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
});
