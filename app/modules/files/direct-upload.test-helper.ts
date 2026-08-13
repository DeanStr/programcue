import type { Viewer } from "~/platform/auth/authorize.server";
import type { UploadTarget } from "./file-service.server";
import { MultipartUploadService } from "./multipart-upload.server";

/**
 * Exercises the production direct-upload protocol without making signed HTTP
 * requests from a Workers test. Tests upload each part through the Miniflare R2
 * binding, then ask the real service to validate and commit the object.
 */
export async function completeTestDirectUpload(
  env: CloudflareEnvironment,
  actor: Viewer,
  target: UploadTarget,
  file: File,
) {
  const directEnv = {
    ...env,
    DB: env.DB,
    FILES: env.FILES,
    OPERATIONS_QUEUE: { send: async () => undefined },
  } as unknown as CloudflareEnvironment;
  const service = new MultipartUploadService(directEnv);
  const initiated = await service.initiate(actor, {
    target,
    filename: file.name,
    contentType: file.type,
    sizeBytes: file.size,
    idempotencyKey: crypto.randomUUID(),
  });
  const providerRow = await env.DB.prepare(
    `SELECT version.object_key AS objectKey, upload.upload_id AS uploadId
       FROM file_multipart_uploads upload
       JOIN file_versions version
         ON version.id = upload.version_id AND version.event_id = upload.event_id
      WHERE upload.version_id = ? AND upload.event_id = ?
        AND upload.status = 'initiated'`,
  )
    .bind(initiated.versionId, actor.eventId)
    .first<{ objectKey: string; uploadId: string }>();
  if (!providerRow)
    throw new Error("Direct-upload test intent did not reach initiated state.");
  const provider = env.FILES.resumeMultipartUpload(
    providerRow.objectKey,
    providerRow.uploadId,
  );
  const parts: Array<{ partNumber: number; etag: string }> = [];
  for (let partNumber = 1; partNumber <= initiated.partCount; partNumber += 1) {
    const start = (partNumber - 1) * initiated.partSizeBytes;
    const uploaded = await provider.uploadPart(
      partNumber,
      await file
        .slice(start, Math.min(file.size, start + initiated.partSizeBytes))
        .arrayBuffer(),
    );
    parts.push({ partNumber, etag: uploaded.etag });
  }
  const completed = await service.complete(actor, {
    versionId: initiated.versionId,
    parts,
  });
  const version = await env.DB.prepare(
    `SELECT version_number AS versionNumber
       FROM file_versions WHERE id = ? AND event_id = ?`,
  )
    .bind(initiated.versionId, actor.eventId)
    .first<{ versionNumber: number }>();
  if (!version)
    throw new Error("Completed direct-upload test version is missing.");
  return { ...completed, versionNumber: version.versionNumber };
}

/**
 * Returns the exact durable identity a scanner must echo with its verdict.
 * Tests which exercise the callback boundary can choose whether to leave the
 * dispatch queued (to prove fail-closed behaviour) or mark it accepted first.
 */
export async function testFileScanCallbackIdentity(
  env: CloudflareEnvironment,
  eventId: string,
  versionId: string,
) {
  const row = await env.DB.prepare(
    `SELECT operation.id AS jobId, operation.attempt_count AS attemptCount,
            version.asset_id AS assetId,
            version.object_etag AS objectEtag,
            version.size_bytes AS sizeBytes
       FROM file_versions version
       JOIN operation_jobs operation
         ON operation.id = 'file-scan-dispatch:' || version.id
        AND operation.event_id = version.event_id
        AND operation.type = 'file.scan.dispatch'
      WHERE version.id = ? AND version.event_id = ?`,
  )
    .bind(versionId, eventId)
    .first<{
      jobId: string;
      attemptCount: number;
      assetId: string;
      objectEtag: string | null;
      sizeBytes: number;
    }>();
  if (!row?.objectEtag) {
    throw new Error("The direct-upload test scan identity is incomplete.");
  }
  return {
    jobId: row.jobId,
    attempt: Math.max(1, row.attemptCount),
    assetId: row.assetId,
    objectEtag: row.objectEtag,
    sizeBytes: row.sizeBytes,
  };
}

export async function acceptTestFileScanDispatch(
  env: CloudflareEnvironment,
  eventId: string,
  versionId: string,
) {
  const identity = await testFileScanCallbackIdentity(env, eventId, versionId);
  const accepted = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'running', attempt_count = attempt_count + 1,
            result_json = json_object(
              'accepted', true,
              'scanAttempt', attempt_count + 1
            ),
            claim_token = NULL, claim_expires_at = unixepoch() + 900,
            started_at = COALESCE(started_at, unixepoch()),
            updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND type = 'file.scan.dispatch'
        AND status IN ('queued','queue_failed','failed')`,
  )
    .bind(identity.jobId, eventId)
    .run();
  if ((accepted.meta.changes ?? 0) !== 1) {
    throw new Error("The direct-upload test scan dispatch was not accepted.");
  }
  return testFileScanCallbackIdentity(env, eventId, versionId);
}
