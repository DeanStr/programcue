import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { loader } from "./speaker-tasks";

const workerEnv = env as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";
const speakerId = "person-demo-speaker";

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function speakerRequest() {
  const eventCookie = currentEventCookie(eventId, workerEnv).split(";", 1)[0];
  return new Request("http://localhost/participant/tasks", {
    headers: {
      cookie: `program_cue_demo_identity=speaker; ${eventCookie}`,
    },
  });
}

describe("participant task route", () => {
  it("loads task evidence history when the participant has more than 200 tasks", async () => {
    await ensureDemoSpeakerData(workerEnv);
    const taskPrefix = `task-scale-${crypto.randomUUID()}-`;
    const evidenceTaskId = `${taskPrefix}201`;
    const assetId = `asset-scale-${crypto.randomUUID()}`;
    const versionId = `version-scale-${crypto.randomUUID()}`;
    await workerEnv.DB.prepare(
      `WITH RECURSIVE task_number(value) AS (
         SELECT 1
         UNION ALL
         SELECT value + 1 FROM task_number WHERE value < 201
       )
       INSERT INTO task_instances (
         id, event_id, target_type, target_id, owner_person_id, title,
         task_type, impact, status, readiness_state, readiness_percent,
         revision, created_at, updated_at
       )
       SELECT ? || value, ?, 'speaker', ?, ?,
              CASE WHEN value = 201 THEN 'zzzz Evidence scale task'
                   ELSE 'Scale task ' || value END,
              CASE WHEN value = 201 THEN 'file_upload' ELSE 'checklist' END,
              'low', 'not_started', 'on_track', 0,
              1, unixepoch(), unixepoch()
         FROM task_number`,
    )
      .bind(taskPrefix, eventId, speakerId, speakerId)
      .run();
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           current_version_id, status, created_at, updated_at
         ) VALUES (?, ?, ?, 'task', ?, 'task_evidence', ?, 'active',
                   unixepoch(), unixepoch())`,
      ).bind(assetId, eventId, speakerId, evidenceTaskId, versionId),
      workerEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, created_by_person_id, created_at, uploaded_at,
           scanned_at, released_at
         ) VALUES (?, ?, ?, 1, ?, 'scale-evidence.pdf', 'application/pdf',
                   'application/pdf', 20, 'scale-evidence-etag', 'uploaded',
                   'valid', 'clean', ?, unixepoch(), unixepoch(), unixepoch(),
                   unixepoch())`,
      ).bind(
        versionId,
        eventId,
        assetId,
        `events/${eventId}/tasks/${evidenceTaskId}/${versionId}`,
        speakerId,
      ),
      workerEnv.DB.prepare(
        `INSERT INTO task_evidence (
           id, event_id, task_id, submitted_by_person_id, file_asset_id,
           evidence_json, status, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, 'submitted', unixepoch())`,
      ).bind(
        `evidence-scale-${crypto.randomUUID()}`,
        eventId,
        evidenceTaskId,
        speakerId,
        assetId,
        JSON.stringify({ fileVersionId: versionId }),
      ),
    ]);

    const result = await loader({
      request: speakerRequest(),
      params: {},
      context: context(),
    } as never);
    const scaleTasks = result.tasks.filter((task) =>
      task.id.startsWith(taskPrefix),
    );

    expect(scaleTasks).toHaveLength(201);
    expect(
      result.tasks.findIndex((task) => task.id === evidenceTaskId),
    ).toBeGreaterThanOrEqual(200);
    expect(
      scaleTasks.find((task) => task.id === evidenceTaskId)?.fileVersions,
    ).toEqual([
      expect.objectContaining({
        taskId: evidenceTaskId,
        assetId,
        versionId,
        filename: "scale-evidence.pdf",
        current: true,
        latest: true,
        downloadAvailable: true,
      }),
    ]);
  });
});
