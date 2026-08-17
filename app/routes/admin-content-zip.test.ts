import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { ZIP_EXPORT_TTL_SECONDS } from "~/modules/content/content-archive-service.server";
import { ContentManagementService } from "~/modules/content/content-management-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
} from "~/platform/demo/demo-identities";
import { processContentZipExport } from "../../workers/queue/content-zip-export-handler";
import { action } from "./admin-content-zip";

const workerEnv = env as unknown as CloudflareEnvironment;
const viewer = {
  personId: DEMO_IDENTITIES.administrator.personId,
  name: DEMO_IDENTITIES.administrator.name,
  email: DEMO_IDENTITIES.administrator.email,
  organisationId: DEMO_ORGANISATION_ID,
  eventId: DEMO_EVENT_ID,
  role: "administrator" as const,
  demo: true,
};

function context(environment: CloudflareEnvironment = workerEnv) {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function queuedEnvironment(send: () => Promise<void> = async () => undefined) {
  return {
    ...workerEnv,
    OPERATIONS_QUEUE: { send },
  } as unknown as CloudflareEnvironment;
}

beforeEach(async () => {
  await ensureDemoSpeakerData(workerEnv);
});

describe("administrator content ZIP resource", () => {
  it("persists a ZIP operation and serves the verified stored archive", async () => {
    const suffix = crypto.randomUUID();
    const assetId = `route-zip-asset-${suffix}`;
    const versionId = `route-zip-version-${suffix}`;
    const taskId = `route-zip-task-${suffix}`;
    const secondAssetId = `route-zip-second-asset-${suffix}`;
    const secondVersionId = `route-zip-second-version-${suffix}`;
    const objectKey = `private/route-zip-tests/${versionId}`;
    const secondObjectKey = `private/route-zip-tests/${secondVersionId}`;
    const bytes = new TextEncoder().encode("route ZIP transport evidence");
    const secondBytes = new TextEncoder().encode(
      "second route ZIP transport evidence",
    );
    const stored = await workerEnv.FILES.put(objectKey, bytes);
    if (!stored) throw new Error("The route ZIP test object was not stored.");
    const secondStored = await workerEnv.FILES.put(
      secondObjectKey,
      secondBytes,
    );
    if (!secondStored)
      throw new Error("The second route ZIP test object was not stored.");
    const session = await workerEnv.DB.prepare(
      `SELECT session.id, speaker.person_id AS speakerId
         FROM sessions session
         JOIN session_speakers speaker
           ON speaker.event_id = session.event_id
          AND speaker.session_id = session.id
        WHERE session.event_id = ?
        LIMIT 1`,
    )
      .bind(DEMO_EVENT_ID)
      .first<{ id: string; speakerId: string }>();
    if (!session) throw new Error("The demo session fixture is unavailable.");
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, owner_person_id, title,
           task_type, impact, status, readiness_state, readiness_percent,
           revision, created_at, updated_at
         ) VALUES (?, ?, 'speaker', ?, ?, 'Upload session slides',
                   'file_upload', 'high', 'submitted', 'on_track', 100, 1,
                   unixepoch(), unixepoch())`,
      ).bind(taskId, DEMO_EVENT_ID, session.speakerId, session.speakerId),
      workerEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
        ) VALUES (?, ?, ?, 'task', ?, 'task_evidence', 'active',
                   unixepoch(), unixepoch())`,
      ).bind(assetId, DEMO_EVENT_ID, session.speakerId, taskId),
      workerEnv.DB.prepare(
        `INSERT INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) VALUES (?, ?, ?, 'task', ?, 'task_evidence', 'active',
                   unixepoch(), unixepoch())`,
      ).bind(secondAssetId, DEMO_EVENT_ID, session.speakerId, taskId),
      workerEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, created_by_person_id, created_at, uploaded_at,
           scanned_at, released_at
         ) VALUES (?, ?, ?, 1, ?, 'route-evidence.pdf', 'application/pdf',
                   'application/pdf', ?, ?, 'uploaded', 'valid', 'clean', ?,
                   unixepoch(), unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        versionId,
        DEMO_EVENT_ID,
        assetId,
        objectKey,
        bytes.byteLength,
        stored.httpEtag,
        session.speakerId,
      ),
      workerEnv.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, detected_content_type,
           size_bytes, object_etag, upload_status, signature_status,
           scan_status, created_by_person_id, created_at, uploaded_at,
           scanned_at, released_at
         ) VALUES (?, ?, ?, 1, ?, 'route-evidence-second.pdf', 'application/pdf',
                   'application/pdf', ?, ?, 'uploaded', 'valid', 'clean', ?,
                   unixepoch(), unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        secondVersionId,
        DEMO_EVENT_ID,
        secondAssetId,
        secondObjectKey,
        secondBytes.byteLength,
        secondStored.httpEtag,
        session.speakerId,
      ),
      workerEnv.DB.prepare(
        `UPDATE file_assets
            SET current_version_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(versionId, assetId, DEMO_EVENT_ID),
      workerEnv.DB.prepare(
        `UPDATE file_assets
            SET current_version_id = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?`,
      ).bind(secondVersionId, secondAssetId, DEMO_EVENT_ID),
    ]);

    const preview = await new ContentManagementService(workerEnv).previewZip(
      viewer,
      { assetIds: [assetId, secondAssetId], groupBy: "session" },
    );
    expect(preview.entries).toHaveLength(2);
    expect(
      preview.entries.every((entry) => entry.sessionName === "Unassigned"),
    ).toBe(true);
    const eventCookie = currentEventCookie(DEMO_EVENT_ID, workerEnv).split(
      ";",
      1,
    )[0];
    const form = new FormData();
    form.set("intent", "queue-zip");
    form.set("manifest", preview.manifest);
    form.set("groupBy", preview.groupBy);
    form.set("confirmed", "true");
    const response = await action({
      request: new Request("http://localhost/admin/content/export.zip", {
        method: "POST",
        headers: {
          cookie: `program_cue_demo_identity=administrator; ${eventCookie}`,
          origin: "http://localhost",
        },
        body: form,
      }),
      params: {},
      context: context(queuedEnvironment()),
    } as never);

    expect(response.data).toMatchObject({ ok: true, status: "queued" });
    const operationId = response.data.operationId;
    const operation = await workerEnv.DB.prepare(
      "SELECT payload_json AS payloadJson FROM operation_jobs WHERE id = ?",
    )
      .bind(operationId)
      .first<{ payloadJson: string }>();
    if (!operation) throw new Error("The ZIP operation was not persisted.");
    await processContentZipExport(JSON.parse(operation.payloadJson), workerEnv);
    const status = await new ContentManagementService(
      workerEnv,
    ).zipOperationStatus(viewer, operationId);
    expect(status).toMatchObject({ status: "ready" });
    const downloaded = await new ContentManagementService(
      workerEnv,
    ).downloadStoredZip(viewer, operationId);
    expect(downloaded.headers.get("content-type")).toBe("application/zip");
    expect(downloaded.headers.get("content-disposition")).toContain(
      'attachment; filename="',
    );
    const zip = new Uint8Array(await downloaded.arrayBuffer());
    expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
    expect(new TextDecoder().decode(zip)).toContain(
      "route ZIP transport evidence",
    );
    expect(new TextDecoder().decode(zip)).toContain(
      "second route ZIP transport evidence",
    );

    const storedResult = await workerEnv.DB.prepare(
      "SELECT result_json AS resultJson, completed_at AS completedAt FROM operation_jobs WHERE id = ?",
    )
      .bind(operationId)
      .first<{ resultJson: string; completedAt: number }>();
    if (!storedResult) throw new Error("The ZIP result was not persisted.");

    const currentResult = JSON.parse(storedResult.resultJson) as {
      objectEtag: string;
      sizeBytes: number;
      fileName: string;
    };
    const legacyObjectKey = `private/exports/${DEMO_EVENT_ID}/${operationId}.zip`;
    await workerEnv.FILES.put(legacyObjectKey, zip);
    await workerEnv.DB.prepare(
      "UPDATE operation_jobs SET result_json = ? WHERE id = ?",
    )
      .bind(
        JSON.stringify({
          objectKey: legacyObjectKey,
          objectEtag: currentResult.objectEtag,
          sizeBytes: currentResult.sizeBytes,
          fileName: currentResult.fileName,
        }),
        operationId,
      )
      .run();
    expect(
      await new ContentManagementService(workerEnv).zipOperationStatus(
        viewer,
        operationId,
      ),
    ).toMatchObject({ status: "ready" });
    const legacyDownloaded = await new ContentManagementService(
      workerEnv,
    ).downloadStoredZip(viewer, operationId);
    expect(new Uint8Array(await legacyDownloaded.arrayBuffer())).toEqual(zip);

    await workerEnv.DB.prepare(
      "UPDATE operation_jobs SET completed_at = ? WHERE id = ?",
    )
      .bind(
        Math.floor(Date.now() / 1_000) - ZIP_EXPORT_TTL_SECONDS - 1,
        operationId,
      )
      .run();
    const replacement = await new ContentManagementService(
      queuedEnvironment(),
    ).queueZip(viewer, {
      manifest: preview.manifest,
      groupBy: preview.groupBy,
      confirmed: true,
    });
    expect(replacement).toMatchObject({ status: "queued" });
    expect(replacement.operationId).not.toBe(operationId);
    const expiredObject = JSON.parse(storedResult.resultJson) as {
      objectKey: string;
    };
    expect(await workerEnv.FILES.head(expiredObject.objectKey)).toBeNull();
    const expired = await workerEnv.DB.prepare(
      "SELECT status FROM operation_jobs WHERE id = ?",
    )
      .bind(operationId)
      .first<{ status: string }>();
    expect(expired?.status).toBe("failed");

    const replacementOperation = await workerEnv.DB.prepare(
      "SELECT payload_json AS payloadJson FROM operation_jobs WHERE id = ?",
    )
      .bind(replacement.operationId)
      .first<{ payloadJson: string }>();
    if (!replacementOperation)
      throw new Error("The replacement ZIP operation was not persisted.");
    await processContentZipExport(
      JSON.parse(replacementOperation.payloadJson),
      workerEnv,
    );
    const replacementResult = await workerEnv.DB.prepare(
      "SELECT result_json AS resultJson FROM operation_jobs WHERE id = ?",
    )
      .bind(replacement.operationId)
      .first<{ resultJson: string }>();
    if (!replacementResult)
      throw new Error("The replacement ZIP result was not persisted.");

    await workerEnv.DB.prepare(
      "UPDATE operation_jobs SET result_json = ? WHERE id = ?",
    )
      .bind("{}", replacement.operationId)
      .run();
    await expect(
      new ContentManagementService(workerEnv).zipOperationStatus(
        viewer,
        replacement.operationId,
      ),
    ).rejects.toThrow("invalid durable result JSON");

    await workerEnv.DB.prepare(
      "UPDATE operation_jobs SET result_json = ? WHERE id = ?",
    )
      .bind(replacementResult.resultJson, replacement.operationId)
      .run();
    await workerEnv.DB.prepare(
      "UPDATE file_versions SET released_at = NULL WHERE id = ?",
    )
      .bind(versionId)
      .run();
    await expect(
      new ContentManagementService(workerEnv).downloadStoredZip(
        viewer,
        replacement.operationId,
      ),
    ).rejects.toMatchObject({ status: 410 });
    const revoked = await workerEnv.DB.prepare(
      "SELECT status FROM operation_jobs WHERE id = ?",
    )
      .bind(replacement.operationId)
      .first<{ status: string }>();
    expect(revoked?.status).toBe("failed");
    const storedObject = JSON.parse(replacementResult.resultJson) as {
      objectKey: string;
    };
    expect(await workerEnv.FILES.head(storedObject.objectKey)).toBeNull();
  });

  it("reports missing ZIP storage and queue configuration explicitly", async () => {
    const form = new FormData();
    form.set("intent", "queue-zip");
    form.set("manifest", "[]");
    form.set("groupBy", "session");
    form.set("confirmed", "true");

    const invoke = (environment: CloudflareEnvironment) =>
      action({
        request: new Request("http://localhost/admin/content/export.zip", {
          method: "POST",
          headers: {
            cookie:
              "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
            origin: "http://localhost",
          },
          body: form,
        }),
        params: {},
        context: context(environment),
      } as never);

    let queueError: unknown;
    try {
      await invoke({
        ...workerEnv,
        OPERATIONS_QUEUE: void 0,
      } as unknown as CloudflareEnvironment);
    } catch (error) {
      queueError = error;
    }
    expect(queueError).toBeInstanceOf(Response);
    expect(queueError).toMatchObject({ status: 503 });
    expect(await (queueError as Response).text()).toBe(
      "ZIP export queue is unavailable. Configure the OPERATIONS_QUEUE binding before retrying.",
    );

    let storageError: unknown;
    try {
      await invoke({
        ...queuedEnvironment(),
        FILES: void 0,
      } as unknown as CloudflareEnvironment);
    } catch (error) {
      storageError = error;
    }
    expect(storageError).toBeInstanceOf(Response);
    expect(storageError).toMatchObject({ status: 503 });
    expect(await (storageError as Response).text()).toBe(
      "Private ZIP export storage is unavailable. Configure the FILES binding before retrying.",
    );
  });
});
