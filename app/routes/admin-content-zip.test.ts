import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import {
  cleanupExpiredContentZipExports,
  invalidateContentZipExportsForAsset,
  ZIP_EXPORT_STORAGE_CLEANUP_CLAIM_LEASE_SECONDS,
  ZIP_EXPORT_TTL_SECONDS,
  zipExportObjectKey,
} from "~/modules/content/content-archive-service.server";
import { ContentManagementService } from "~/modules/content/content-management-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
} from "~/platform/demo/demo-identities";
import { OperationService } from "~/platform/operations/operation-service.server";
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

    await workerEnv.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'failed', result_json = NULL,
              content_zip_storage_cleaned_at = NULL, completed_at = unixepoch()
        WHERE id = ?`,
    )
      .bind(operationId)
      .run();
    const retriedMessages: unknown[] = [];
    const retryEnvironment = {
      ...workerEnv,
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => retriedMessages.push(message),
      },
    } as unknown as CloudflareEnvironment;
    await workerEnv.DB.prepare(
      `UPDATE operation_jobs
          SET content_zip_storage_cleanup_claim = 'active-cleanup',
              content_zip_storage_cleanup_claimed_at = unixepoch()
        WHERE id = ?`,
    )
      .bind(operationId)
      .run();
    await expect(
      new OperationService(retryEnvironment).retry(viewer, operationId),
    ).rejects.toThrow("changed before it could be retried");
    await workerEnv.DB.prepare(
      `UPDATE operation_jobs
          SET content_zip_storage_cleanup_claimed_at =
                unixepoch() - ? - 1
        WHERE id = ?`,
    )
      .bind(ZIP_EXPORT_STORAGE_CLEANUP_CLAIM_LEASE_SECONDS, operationId)
      .run();
    await cleanupExpiredContentZipExports(workerEnv);
    const cleaned = await workerEnv.DB.prepare(
      `SELECT content_zip_storage_cleaned_at AS cleanedAt
         FROM operation_jobs WHERE id = ?`,
    )
      .bind(operationId)
      .first<{ cleanedAt: number | null }>();
    expect(cleaned?.cleanedAt).toEqual(expect.any(Number));

    await new OperationService(retryEnvironment).retry(viewer, operationId);
    expect(retriedMessages).toHaveLength(1);
    await expect(
      workerEnv.DB.prepare(
        `SELECT status, content_zip_storage_cleaned_at AS cleanedAt
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({ status: "queued", cleanedAt: null });

    await processContentZipExport(retriedMessages[0], workerEnv);
    const replacementResult = await workerEnv.DB.prepare(
      "SELECT result_json AS resultJson FROM operation_jobs WHERE id = ?",
    )
      .bind(operationId)
      .first<{ resultJson: string }>();
    if (!replacementResult)
      throw new Error("The replacement ZIP result was not persisted.");
    await workerEnv.DB.prepare(
      "UPDATE operation_jobs SET completed_at = ? WHERE id = ?",
    )
      .bind(
        Math.floor(Date.now() / 1_000) - ZIP_EXPORT_TTL_SECONDS - 1,
        operationId,
      )
      .run();
    await cleanupExpiredContentZipExports(workerEnv);
    const storedObject = JSON.parse(replacementResult.resultJson) as {
      objectKey: string;
    };
    expect(await workerEnv.FILES.head(storedObject.objectKey)).toBeNull();
    await expect(
      workerEnv.DB.prepare(
        `SELECT status, content_zip_storage_cleaned_at AS cleanedAt
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({ status: "failed", cleanedAt: expect.any(Number) });
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

  it("revokes an uninspectable event ZIP during file erasure", async () => {
    const operationId = crypto.randomUUID();
    const claimToken = crypto.randomUUID();
    const objectKey = zipExportObjectKey(
      viewer.eventId,
      operationId,
      claimToken,
    );
    const stored = await workerEnv.FILES.put(
      objectKey,
      new TextEncoder().encode("archive that must be erased"),
    );
    if (!stored) throw new Error("The ZIP test archive was not stored.");
    await workerEnv.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json, result_json,
         progress_total, progress_completed, progress_failed, cancellable,
         completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'content.zip.export', ?, ?, 'completed', ?, ?,
                 1, 1, 0, 0, unixepoch(), unixepoch(), unixepoch())`,
    )
      .bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `malformed-content-zip:${operationId}`,
        crypto.randomUUID(),
        JSON.stringify({}),
        JSON.stringify({
          objectKey,
          objectEtag: stored.httpEtag,
          sizeBytes: stored.size,
          fileName: "programme-files-by-session.zip",
          claimToken,
        }),
      )
      .run();

    await invalidateContentZipExportsForAsset(workerEnv, {
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      assetId: crypto.randomUUID(),
    });

    expect(await workerEnv.FILES.head(objectKey)).toBeNull();
    await expect(
      workerEnv.DB.prepare(
        `SELECT status, content_zip_storage_cleaned_at AS cleanedAt
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({ status: "failed", cleanedAt: expect.any(Number) });
  });
});
