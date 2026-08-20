import {
  parseZipQueuePayload,
  zipManifestSchema,
} from "./content-zip-export-parse.server";
import {
  ZIP_EXPORT_STORAGE_CLEANUP_CLAIM_LEASE_SECONDS,
  ZIP_EXPORT_TTL_SECONDS,
  zipExportObjectPrefix,
} from "./content-zip-export-storage.server";

const ZIP_EXPORT_EXPIRED_ERROR =
  "The ZIP export expired and is no longer available for download.";

async function deleteZipExportObjects(
  env: CloudflareEnvironment,
  eventId: string,
  operationId: string,
  assertCleanupClaim?: () => Promise<void>,
) {
  if (!env.FILES) {
    throw new Error("Required private R2 binding FILES is unavailable.");
  }
  const prefix = zipExportObjectPrefix(eventId, operationId);
  let cursor: string | undefined;
  do {
    await assertCleanupClaim?.();
    const page = await env.FILES.list(
      cursor ? { prefix, limit: 1_000, cursor } : { prefix, limit: 1_000 },
    );
    if (page.objects.length > 0) {
      await assertCleanupClaim?.();
      await env.FILES.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

async function renewZipExportStorageCleanupClaim(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  operationId: string,
  claim: string,
) {
  const result = await env.DB.prepare(
    `UPDATE operation_jobs
        SET content_zip_storage_cleanup_claimed_at = unixepoch(),
            updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'content.zip.export'
        AND content_zip_storage_cleanup_claim = ?`,
  )
    .bind(operationId, scope.eventId, scope.organisationId, claim)
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error("The ZIP export storage cleanup claim was lost.");
  }
}

async function claimZipExportStorageCleanup(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  operationId: string,
  options: { expiredOnly: boolean },
) {
  const claim = crypto.randomUUID();
  const result = await env.DB.prepare(
    `UPDATE operation_jobs
        SET content_zip_storage_cleanup_claim = ?,
            content_zip_storage_cleanup_claimed_at = unixepoch(),
            updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'content.zip.export'
        AND content_zip_storage_cleaned_at IS NULL
        AND (
          claim_token IS NULL
          OR claim_expires_at IS NULL
          OR claim_expires_at <= unixepoch()
        )
        AND (
          content_zip_storage_cleanup_claim IS NULL
          OR content_zip_storage_cleanup_claimed_at IS NULL
          OR content_zip_storage_cleanup_claimed_at <= unixepoch() - ?
        )
        AND (
          status IN ('failed', 'cancelled')
          OR (
            ? AND status = 'completed' AND completed_at IS NOT NULL
            AND completed_at <= unixepoch() - ?
          )
        )`,
  )
    .bind(
      claim,
      operationId,
      scope.eventId,
      scope.organisationId,
      ZIP_EXPORT_STORAGE_CLEANUP_CLAIM_LEASE_SECONDS,
      options.expiredOnly,
      ZIP_EXPORT_TTL_SECONDS,
    )
    .run();
  return (result.meta.changes ?? 0) === 1 ? claim : null;
}

async function markZipExportStorageCleaned(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  operationId: string,
  claim: string,
) {
  const result = await env.DB.prepare(
    `UPDATE operation_jobs
        SET content_zip_storage_cleaned_at = unixepoch(),
            content_zip_storage_cleanup_claim = NULL,
            content_zip_storage_cleanup_claimed_at = NULL,
            claim_token = NULL, claim_expires_at = NULL,
            updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'content.zip.export'
        AND content_zip_storage_cleanup_claim = ?`,
  )
    .bind(operationId, scope.eventId, scope.organisationId, claim)
    .run();
  if ((result.meta.changes ?? 0) !== 1)
    throw new Error(
      "The ZIP export storage cleanup marker could not be recorded.",
    );
}

async function releaseZipExportStorageCleanupClaim(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  operationId: string,
  claim: string,
  failure: string,
) {
  await env.DB.prepare(
    `UPDATE operation_jobs
        SET content_zip_storage_cleanup_claim = NULL,
            content_zip_storage_cleanup_claimed_at = NULL, last_error = ?,
            updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'content.zip.export'
        AND content_zip_storage_cleanup_claim = ?`,
  )
    .bind(
      failure.slice(0, 2_000),
      operationId,
      scope.eventId,
      scope.organisationId,
      claim,
    )
    .run();
}

async function cleanupZipExportStorage(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  operationId: string,
  options: { expiredOnly: boolean },
) {
  const claim = await claimZipExportStorageCleanup(
    env,
    scope,
    operationId,
    options,
  );
  if (!claim) return false;
  try {
    await deleteZipExportObjects(env, scope.eventId, operationId, () =>
      renewZipExportStorageCleanupClaim(env, scope, operationId, claim),
    );
    await markZipExportStorageCleaned(env, scope, operationId, claim);
    return true;
  } catch (error) {
    await releaseZipExportStorageCleanupClaim(
      env,
      scope,
      operationId,
      claim,
      `ZIP storage cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    throw error;
  }
}

export async function markContentZipExportStorageCleanupRequired(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  operationId: string,
) {
  await env.DB.prepare(
    `UPDATE operation_jobs
        SET content_zip_storage_cleaned_at = NULL,
            updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'content.zip.export'
        AND status IN ('failed', 'cancelled')`,
  )
    .bind(operationId, scope.eventId, scope.organisationId)
    .run();
}

export async function revokeContentZipExport(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  operationId: string,
  reason: string,
) {
  await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'failed', progress_completed = 1, progress_failed = 1,
            result_json = NULL, last_error = ?, completed_at = COALESCE(completed_at, unixepoch()),
            claim_token = CASE WHEN status = 'running' THEN claim_token ELSE NULL END,
            claim_expires_at = CASE WHEN status = 'running' THEN claim_expires_at ELSE NULL END,
            content_zip_storage_cleaned_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'content.zip.export'
        AND status NOT IN ('failed', 'cancelled')`,
  )
    .bind(
      reason.slice(0, 2_000),
      operationId,
      scope.eventId,
      scope.organisationId,
    )
    .run();
  const cleaned = await cleanupZipExportStorage(env, scope, operationId, {
    expiredOnly: false,
  });
  if (!cleaned) {
    throw new Error(
      "The ZIP export storage cleanup is pending; file erasure must be retried.",
    );
  }
}

export async function expireContentZipExport(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  operationId: string,
) {
  // Retire the deterministic idempotency key as part of expiry. A fresh
  // request for the same unchanged manifest must be able to create a new
  // operation, while the old terminal row remains available for audit.
  await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'failed', progress_completed = 1, progress_failed = 1,
            result_json = NULL, last_error = ?,
            idempotency_key = ?, completed_at = COALESCE(completed_at, unixepoch()),
            claim_token = NULL, claim_expires_at = NULL,
            content_zip_storage_cleaned_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'content.zip.export' AND status = 'completed'
        AND (completed_at IS NULL OR completed_at <= unixepoch() - ?)`,
  )
    .bind(
      ZIP_EXPORT_EXPIRED_ERROR,
      `content-zip:expired:${operationId}`,
      operationId,
      scope.eventId,
      scope.organisationId,
      ZIP_EXPORT_TTL_SECONDS,
    )
    .run();
  await cleanupZipExportStorage(env, scope, operationId, {
    expiredOnly: false,
  });
}

export async function invalidateContentZipExportsForAsset(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string; assetId: string },
) {
  const operations = await env.DB.prepare(
    `SELECT id, payload_json AS payloadJson
       FROM operation_jobs
      WHERE event_id = ? AND organisation_id = ?
        AND type = 'content.zip.export'
        AND (
          status NOT IN ('failed', 'cancelled')
          OR content_zip_storage_cleaned_at IS NULL
        )
      ORDER BY created_at, id`,
  )
    .bind(scope.eventId, scope.organisationId)
    .all<{ id: string; payloadJson: string }>();

  for (const operation of operations.results) {
    let message: ReturnType<typeof parseZipQueuePayload>;
    try {
      message = parseZipQueuePayload(operation.payloadJson, {
        id: operation.id,
        eventId: scope.eventId,
        organisationId: scope.organisationId,
      });
    } catch {
      await revokeContentZipExport(
        env,
        { organisationId: scope.organisationId, eventId: scope.eventId },
        operation.id,
        "The ZIP export was revoked because its durable payload could not be inspected during file erasure.",
      );
      continue;
    }
    let manifest: unknown;
    try {
      manifest = JSON.parse(message.manifest);
    } catch {
      await revokeContentZipExport(
        env,
        { organisationId: scope.organisationId, eventId: scope.eventId },
        operation.id,
        "The ZIP export was revoked because its manifest could not be inspected during file erasure.",
      );
      continue;
    }
    const parsedManifest = zipManifestSchema.safeParse(manifest);
    if (!parsedManifest.success) {
      await revokeContentZipExport(
        env,
        { organisationId: scope.organisationId, eventId: scope.eventId },
        operation.id,
        "The ZIP export was revoked because its manifest was invalid during file erasure.",
      );
      continue;
    }
    if (!parsedManifest.data.some((entry) => entry.assetId === scope.assetId)) {
      continue;
    }
    await revokeContentZipExport(
      env,
      { organisationId: scope.organisationId, eventId: scope.eventId },
      operation.id,
      "The ZIP export was revoked because a referenced file was erased or released from retention.",
    );
  }
}

export async function cleanupExpiredContentZipExports(
  env: CloudflareEnvironment,
  limit = 100,
) {
  const cutoff = Math.floor(Date.now() / 1_000) - ZIP_EXPORT_TTL_SECONDS;
  const operations = await env.DB.prepare(
    `SELECT id, organisation_id AS organisationId, event_id AS eventId,
            status, completed_at AS completedAt
       FROM operation_jobs
      WHERE type = 'content.zip.export'
        AND content_zip_storage_cleaned_at IS NULL
        AND (
          (status = 'completed' AND completed_at IS NOT NULL AND completed_at <= ?)
          OR status IN ('failed', 'cancelled')
        )
      ORDER BY CASE WHEN status = 'completed' THEN 0 ELSE 1 END,
               CASE WHEN status = 'completed' THEN completed_at ELSE updated_at END,
               id
      LIMIT ?`,
  )
    .bind(cutoff, limit)
    .all<{
      id: string;
      organisationId: string;
      eventId: string;
      status: string;
      completedAt: number | null;
    }>();

  let failedCount = 0;
  for (const operation of operations.results) {
    try {
      const scope = {
        organisationId: operation.organisationId,
        eventId: operation.eventId,
      };
      if (operation.status === "completed") {
        await expireContentZipExport(env, scope, operation.id);
      } else {
        await cleanupZipExportStorage(env, scope, operation.id, {
          expiredOnly: false,
        });
      }
    } catch (error) {
      failedCount += 1;
      const failure = (
        error instanceof Error ? error.message : String(error)
      ).slice(0, 2_000);
      console.error(
        JSON.stringify({
          level: "error",
          subsystem: "content-zip-export-cleanup",
          event: "storage-cleanup-failed",
          operationId: operation.id,
          errorName: error instanceof Error ? error.name : "UnknownError",
          message: failure,
        }),
      );
    }
  }
  if (failedCount > 0) {
    throw new Error(
      `${failedCount} expired ZIP export${failedCount === 1 ? "" : "s"} could not be cleaned up.`,
    );
  }
  return operations.results.length;
}
