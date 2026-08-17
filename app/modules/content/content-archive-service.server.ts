import { z } from "zod";

import { safeDownloadName } from "~/modules/files/file-policy";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ContentManagementStateError } from "./content-management-errors";
import {
  contentZipConfirmSchema,
  contentZipPreviewSchema,
  contentZipQueueMessageSchema,
} from "./content-schema";
import {
  createStoredZipStream,
  type StoredZipEntry,
  storedZipByteLength,
} from "./zip-stream.server";

const MAX_ZIP_BYTES = 100 * 1024 * 1024;
export const ZIP_EXPORT_TTL_SECONDS = 24 * 60 * 60;
export const ZIP_EXPORT_STORAGE_CLEANUP_CLAIM_LEASE_SECONDS = 5 * 60;
const ZIP_EXPORT_EXPIRED_ERROR =
  "The ZIP export expired and is no longer available for download.";

const ZIP_EXPORT_PREFIX = "private/events";

class ZipSourceInvalidatedError extends ContentManagementStateError {
  constructor(message: string) {
    super(message, 410);
  }
}

type ZipOperationStatus = "queued" | "processing" | "ready" | "failed";

function publicZipOperationStatus(status: string): ZipOperationStatus {
  switch (status) {
    case "completed":
      return "ready";
    case "failed":
    case "queue_failed":
    case "partially_failed":
    case "cancelled":
      return "failed";
    case "running":
    case "received":
      return "processing";
    case "queued":
    case "retrying":
      return "queued";
    default:
      throw new Error(`Unknown ZIP export operation status: ${status}.`);
  }
}

const zipManifestEntrySchema = z.object({
  assetId: z.string().min(1).max(160),
  versionId: z.string().min(1).max(160),
  objectEtag: z.string().min(1).max(300),
  sizeBytes: z.number().int().nonnegative().max(MAX_ZIP_BYTES),
  filename: z.string().min(1).max(500),
  sessionName: z.string().min(1).max(300),
  speakerName: z.string().min(1).max(300),
  createdAt: z.number().int().positive(),
});

const zipManifestSchema = z.array(zipManifestEntrySchema).min(1).max(20);

const zipOperationResultFieldsSchema = z.object({
  objectKey: z.string().min(1),
  objectEtag: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  fileName: z.string().min(1),
});

const currentZipOperationResultSchema = zipOperationResultFieldsSchema.extend({
  claimToken: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
});

type ZipOperationResult = z.infer<typeof currentZipOperationResultSchema>;

type ZipSourceRow = z.infer<typeof zipManifestEntrySchema> & {
  objectKey: string;
  contentType: string | null;
};

function storageKeySegment(value: string, label: string) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error(
      `The ZIP export ${label} is not a safe storage identifier.`,
    );
  }
  return value;
}

export function zipExportObjectPrefix(eventId: string, operationId: string) {
  return `${ZIP_EXPORT_PREFIX}/${storageKeySegment(eventId, "event")}/exports/${storageKeySegment(operationId, "operation")}/`;
}

export function zipExportObjectKey(
  eventId: string,
  operationId: string,
  claimToken: string,
) {
  return `${zipExportObjectPrefix(eventId, operationId)}${storageKeySegment(claimToken, "claim")}.zip`;
}

function assertZipOperationObjectKey(
  eventId: string,
  operationId: string,
  result: ZipOperationResult,
) {
  const expected = zipExportObjectKey(eventId, operationId, result.claimToken);
  if (result.objectKey !== expected) {
    throw new Error(
      "The completed ZIP export object key does not match its operation identity.",
    );
  }
  return expected;
}

function zipExportExpired(completedAt: number | null) {
  return (
    completedAt === null ||
    completedAt + ZIP_EXPORT_TTL_SECONDS <= Math.floor(Date.now() / 1_000)
  );
}

function parseZipOperationResult(resultJson: string | null) {
  if (!resultJson) {
    throw new Error(
      "The completed ZIP export is missing its durable result JSON.",
    );
  }
  try {
    const parsed: unknown = JSON.parse(resultJson);
    const current = currentZipOperationResultSchema.safeParse(parsed);
    if (current.success) return current.data;
  } catch {
    // Fall through to the single explicit error below.
  }
  throw new Error("The completed ZIP export has invalid durable result JSON.");
}

function parseZipQueuePayload(
  payloadJson: string,
  operation: { id: string; eventId: string; organisationId: string },
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(payloadJson);
  } catch {
    throw new Error("The ZIP export has invalid durable payload JSON.");
  }
  const message = contentZipQueueMessageSchema.parse(parsed);
  if (
    message.operationId !== operation.id ||
    message.eventId !== operation.eventId ||
    message.organisationId !== operation.organisationId
  ) {
    throw new Error(
      "The ZIP export payload does not match its durable operation identity.",
    );
  }
  return message;
}

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

async function expireContentZipExport(
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

type ExistingZipOperation = {
  id: string;
  status: string;
  resultJson: string | null;
  lastError: string | null;
  completedAt: number | null;
};

async function loadZipOperationByIdempotency(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  idempotencyKey: string,
) {
  return env.DB.prepare(
    `SELECT id, status, result_json AS resultJson, last_error AS lastError,
            completed_at AS completedAt
       FROM operation_jobs
      WHERE event_id = ? AND organisation_id = ? AND type = ?
        AND idempotency_key = ?
      LIMIT 1`,
  )
    .bind(
      scope.eventId,
      scope.organisationId,
      "content.zip.export",
      idempotencyKey,
    )
    .first<ExistingZipOperation>();
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
    let message: ReturnType<typeof contentZipQueueMessageSchema.parse>;
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

function requireAdministrator(viewer: Viewer) {
  if (viewer.role !== "owner" && viewer.role !== "administrator") {
    throw new ContentManagementStateError(
      "Administrator access is required.",
      403,
    );
  }
}

function safeZipSegment(value: string) {
  return (
    value
      .normalize("NFKC")
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Archive filenames intentionally reject ASCII control characters.
      .replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, "_")
      .replace(/\.{2,}/g, ".")
      .trim()
      .slice(0, 100) || "Unassigned"
  );
}

function duplicateZipPath(group: string, filename: string, suffix: string) {
  const extensionIndex = filename.lastIndexOf(".");
  const suffixedFilename =
    extensionIndex > 0 && extensionIndex < filename.length - 1
      ? `${filename.slice(0, extensionIndex)}-${suffix}${filename.slice(extensionIndex)}`
      : `${filename}-${suffix}`;
  return `${group}/${suffixedFilename}`;
}

function uniqueZipPath(
  paths: ReadonlySet<string>,
  group: string,
  filename: string,
  assetSuffix: string,
) {
  const base = `${group}/${filename}`;
  if (!paths.has(base)) return base;
  let candidate = duplicateZipPath(group, filename, assetSuffix);
  let collision = 2;
  while (paths.has(candidate)) {
    candidate = duplicateZipPath(
      group,
      filename,
      `${assetSuffix}-${collision}`,
    );
    collision += 1;
  }
  return candidate;
}

export class ContentArchiveService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private requireBucket() {
    if (!this.env.FILES) {
      throw new Error("Required private R2 binding FILES is unavailable.");
    }
    return this.env.FILES;
  }

  private async zipRows(viewer: Viewer, assetIds: string[]) {
    const placeholders = assetIds.map(() => "?").join(", ");
    return this.env.DB.prepare(
      `SELECT asset.id AS assetId, version.id AS versionId,
              version.object_key AS objectKey,
              version.object_etag AS objectEtag,
              version.detected_content_type AS contentType,
              version.size_bytes AS sizeBytes,
              version.original_filename AS filename,
              version.created_at AS createdAt,
              COALESCE(owner.display_name, 'Unknown speaker') AS speakerName,
              COALESCE(
                (SELECT session.title FROM sessions session
                  WHERE asset.target_type = 'session'
                    AND session.id = asset.target_id
                    AND session.event_id = asset.event_id),
                (SELECT session.title
                   FROM task_instances task
                   JOIN sessions session
                     ON task.target_type = 'session'
                    AND session.id = task.target_id
                    AND session.event_id = task.event_id
                  WHERE asset.target_type = 'task' AND task.id = asset.target_id
                    AND task.event_id = asset.event_id),
                (SELECT session.title FROM sessions session
                  WHERE asset.target_type = 'submission'
                    AND session.source_submission_id = asset.target_id
                    AND session.event_id = asset.event_id
                  ORDER BY session.created_at LIMIT 1),
                'Unassigned'
              ) AS sessionName
         FROM file_assets asset
         JOIN events event
           ON event.id = asset.event_id AND event.organisation_id = ?
         JOIN file_versions version
           ON version.id = asset.current_version_id
          AND version.event_id = asset.event_id AND version.asset_id = asset.id
         LEFT JOIN people owner ON owner.id = asset.owner_person_id
        WHERE asset.event_id = ? AND asset.id IN (${placeholders})
          AND asset.status = 'active'
          AND version.upload_status = 'uploaded'
          AND version.signature_status = 'valid'
          AND version.scan_status = 'clean'
          AND version.released_at IS NOT NULL
          AND version.deleted_at IS NULL AND version.object_etag IS NOT NULL
        ORDER BY asset.id`,
    )
      .bind(viewer.organisationId, viewer.eventId, ...assetIds)
      .all<ZipSourceRow>();
  }

  private async assertZipSourceObjects(rows: readonly ZipSourceRow[]) {
    const bucket = this.requireBucket();
    for (const row of rows) {
      const object = await bucket.head(row.objectKey);
      if (
        !object ||
        object.httpEtag !== row.objectEtag ||
        object.size !== row.sizeBytes
      ) {
        throw new ZipSourceInvalidatedError(
          `Private file ${row.filename} is missing or no longer matches its released version.`,
        );
      }
    }
  }

  private async validateZipManifest(viewer: Viewer, rawInput: unknown) {
    const input = contentZipConfirmSchema.parse(rawInput);
    let decoded: unknown;
    try {
      decoded = JSON.parse(input.manifest);
    } catch {
      throw new ContentManagementStateError("The ZIP preview is invalid.", 422);
    }
    const expected = zipManifestSchema.parse(decoded);
    const rows = await this.zipRows(
      viewer,
      expected.map((entry) => entry.assetId),
    );
    const current = rows.results.map(
      ({ objectKey: _objectKey, contentType: _contentType, ...row }) => row,
    );
    const unchanged =
      current.length === expected.length &&
      current.every((row, index) => {
        const prior = expected[index];
        return (
          prior !== undefined &&
          row.assetId === prior.assetId &&
          row.versionId === prior.versionId &&
          row.objectEtag === prior.objectEtag &&
          row.sizeBytes === prior.sizeBytes &&
          row.filename === prior.filename &&
          row.sessionName === prior.sessionName &&
          row.speakerName === prior.speakerName &&
          row.createdAt === prior.createdAt
        );
      });
    if (!unchanged) {
      throw new ZipSourceInvalidatedError(
        "One or more selected files changed after preview. Prepare a fresh ZIP preview.",
      );
    }
    const totalBytes = expected.reduce((sum, row) => sum + row.sizeBytes, 0);
    if (totalBytes > MAX_ZIP_BYTES) {
      throw new ContentManagementStateError(
        "The selected current versions exceed the 100 MB ZIP export limit.",
        422,
      );
    }
    return { input, expected, rows, totalBytes };
  }

  async previewZip(viewer: Viewer, rawInput: unknown) {
    requireAdministrator(viewer);
    const input = contentZipPreviewSchema.parse(rawInput);
    if (new Set(input.assetIds).size !== input.assetIds.length) {
      throw new ContentManagementStateError(
        "Choose each file only once before preparing an export.",
        422,
      );
    }
    const rows = await this.zipRows(viewer, input.assetIds);
    if (rows.results.length !== input.assetIds.length) {
      throw new ContentManagementStateError(
        "Every selected file must have a current released, clean version before export.",
        422,
      );
    }
    const totalBytes = rows.results.reduce(
      (sum, row) => sum + row.sizeBytes,
      0,
    );
    if (totalBytes > MAX_ZIP_BYTES) {
      throw new ContentManagementStateError(
        "The selected current versions exceed the 100 MB ZIP export limit.",
        422,
      );
    }
    const manifest = rows.results.map(
      ({ objectKey: _objectKey, contentType: _contentType, ...row }) => row,
    );
    return {
      groupBy: input.groupBy,
      entries: manifest,
      totalBytes,
      manifest: JSON.stringify(manifest),
    };
  }

  async queueZip(viewer: Viewer, rawInput: unknown) {
    requireAdministrator(viewer);
    if (!this.env.FILES) {
      throw new ContentManagementStateError(
        "Private ZIP export storage is unavailable. Configure the FILES binding before retrying.",
        503,
      );
    }
    if (!this.env.OPERATIONS_QUEUE) {
      throw new ContentManagementStateError(
        "ZIP export queue is unavailable. Configure the OPERATIONS_QUEUE binding before retrying.",
        503,
      );
    }
    const { input, expected } = await this.validateZipManifest(
      viewer,
      rawInput,
    );
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${input.groupBy}:${input.manifest}`),
    );
    const digestHex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const idempotencyKey = `content-zip:${input.groupBy}:${digestHex}`;
    const scope = {
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
    };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const existing = await loadZipOperationByIdempotency(
        this.env,
        scope,
        idempotencyKey,
      );
      if (existing) {
        if (
          existing.status !== "completed" ||
          !zipExportExpired(existing.completedAt)
        ) {
          return {
            operationId: existing.id,
            status: publicZipOperationStatus(existing.status),
            error: existing.lastError,
            selectedCount: expected.length,
          };
        }
        await expireContentZipExport(this.env, scope, existing.id);
        continue;
      }

      const operationId = crypto.randomUUID();
      const message = contentZipQueueMessageSchema.parse({
        type: "content.zip.export",
        operationId,
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        idempotencyKey,
        manifest: input.manifest,
        groupBy: input.groupBy,
      });
      const inserted = await this.env.DB.prepare(
        `INSERT OR IGNORE INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total, progress_completed, progress_failed, cancellable,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'content.zip.export', ?, ?, 'queued', ?, 1, 0, 0, 0,
                   unixepoch(), unixepoch())`,
      )
        .bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          idempotencyKey,
          crypto.randomUUID(),
          JSON.stringify(message),
        )
        .run();
      if ((inserted.meta.changes ?? 0) !== 1) {
        const raced = await loadZipOperationByIdempotency(
          this.env,
          scope,
          idempotencyKey,
        );
        if (!raced) continue;
        if (
          raced.status === "completed" &&
          zipExportExpired(raced.completedAt)
        ) {
          await expireContentZipExport(this.env, scope, raced.id);
          continue;
        }
        return {
          operationId: raced.id,
          status: publicZipOperationStatus(raced.status),
          error: raced.lastError,
          selectedCount: expected.length,
        };
      }
      try {
        await this.env.OPERATIONS_QUEUE.send(message);
      } catch (error) {
        const failure = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 2_000);
        await this.env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND organisation_id = ? AND status = 'queued'`,
        )
          .bind(failure, operationId, viewer.eventId, viewer.organisationId)
          .run();
        return {
          operationId,
          status: "failed" as const,
          error: `The ZIP export could not be queued: ${failure}`,
        };
      }
      return {
        operationId,
        status: "queued" as const,
        selectedCount: expected.length,
      };
    }
    throw new Error(
      "The ZIP export could not establish an idempotent operation after concurrent expiry handling.",
    );
  }

  async zipOperationStatus(viewer: Viewer, operationId: string) {
    requireAdministrator(viewer);
    const operation = await this.env.DB.prepare(
      `SELECT id, status, result_json AS resultJson, last_error AS lastError,
              completed_at AS completedAt
         FROM operation_jobs
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'content.zip.export'
        LIMIT 1`,
    )
      .bind(operationId, viewer.eventId, viewer.organisationId)
      .first<{
        id: string;
        status: string;
        resultJson: string | null;
        lastError: string | null;
        completedAt: number | null;
      }>();
    if (!operation) {
      throw new ContentManagementStateError("ZIP export not found.", 404);
    }
    let status = publicZipOperationStatus(operation.status);
    let error = operation.lastError;
    if (
      operation.status === "completed" &&
      zipExportExpired(operation.completedAt)
    ) {
      await expireContentZipExport(
        this.env,
        { organisationId: viewer.organisationId, eventId: viewer.eventId },
        operation.id,
      );
      status = "failed";
      error = "The ZIP export expired and must be prepared again.";
    }
    const result =
      status === "ready" ? parseZipOperationResult(operation.resultJson) : null;
    if (result) {
      assertZipOperationObjectKey(viewer.eventId, operation.id, result);
    }
    return {
      operationId: operation.id,
      status,
      error,
      fileName: result?.fileName ?? null,
      sizeBytes: result?.sizeBytes ?? null,
      downloadUrl:
        status === "ready"
          ? `/admin/content/export.zip?operation=${encodeURIComponent(operation.id)}&download=1`
          : null,
    } as const;
  }

  async downloadStoredZip(viewer: Viewer, operationId: string) {
    requireAdministrator(viewer);
    const operation = await this.env.DB.prepare(
      `SELECT result_json AS resultJson, status, payload_json AS payloadJson,
              completed_at AS completedAt
         FROM operation_jobs
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'content.zip.export'
        LIMIT 1`,
    )
      .bind(operationId, viewer.eventId, viewer.organisationId)
      .first<{
        resultJson: string | null;
        status: string;
        payloadJson: string;
        completedAt: number | null;
      }>();
    if (!operation) {
      throw new ContentManagementStateError("ZIP export not found.", 404);
    }
    const status = publicZipOperationStatus(operation.status);
    if (status !== "ready") {
      throw new ContentManagementStateError(
        "This ZIP export is not ready to download yet.",
        409,
      );
    }
    if (zipExportExpired(operation.completedAt)) {
      await expireContentZipExport(
        this.env,
        { organisationId: viewer.organisationId, eventId: viewer.eventId },
        operationId,
      );
      throw new ContentManagementStateError(
        "This ZIP export has expired and must be prepared again.",
        410,
      );
    }
    const result = parseZipOperationResult(operation.resultJson);
    const objectKey = assertZipOperationObjectKey(
      viewer.eventId,
      operationId,
      result,
    );
    const message = parseZipQueuePayload(operation.payloadJson, {
      id: operationId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
    });
    try {
      const { rows } = await this.validateZipManifest(viewer, {
        manifest: message.manifest,
        groupBy: message.groupBy,
        confirmed: true,
      });
      await this.assertZipSourceObjects(rows.results);
    } catch (error) {
      if (!(error instanceof ZipSourceInvalidatedError)) throw error;
      await revokeContentZipExport(
        this.env,
        { organisationId: viewer.organisationId, eventId: viewer.eventId },
        operationId,
        "The ZIP export was revoked because a referenced file changed or was removed.",
      );
      throw new ContentManagementStateError(
        "This ZIP export is no longer available because one or more source files changed or were removed.",
        410,
      );
    }
    const object = await this.requireBucket().get(objectKey);
    if (
      !object ||
      object.httpEtag !== result.objectEtag ||
      object.size !== result.sizeBytes
    ) {
      throw new Error(
        "The completed ZIP export is missing or no longer matches its stored result.",
      );
    }
    return new Response(object.body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="${safeDownloadName(result.fileName)}"`,
        "content-length": String(object.size),
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async downloadZip(viewer: Viewer, rawInput: unknown) {
    requireAdministrator(viewer);
    const { input, rows } = await this.validateZipManifest(viewer, rawInput);
    const bucket = this.requireBucket();
    const paths = new Set<string>();
    const entries: StoredZipEntry[] = [];
    for (const row of rows.results) {
      const object = await bucket.head(row.objectKey);
      if (
        !object ||
        object.httpEtag !== row.objectEtag ||
        object.size !== row.sizeBytes
      ) {
        throw new ContentManagementStateError(
          `Private file ${row.filename} is missing or no longer matches its released version.`,
        );
      }
      const group = safeZipSegment(
        input.groupBy === "session" ? row.sessionName : row.speakerName,
      );
      const filename = safeZipSegment(row.filename);
      const path = uniqueZipPath(paths, group, filename, row.assetId.slice(-8));
      paths.add(path);
      entries.push({
        path,
        expectedSize: row.sizeBytes,
        modifiedAt: row.createdAt,
        open: async () => {
          const candidate = await bucket.get(row.objectKey, {
            onlyIf: new Headers({ "if-match": row.objectEtag }),
          });
          if (
            !candidate ||
            !("body" in candidate) ||
            candidate.httpEtag !== row.objectEtag ||
            candidate.size !== row.sizeBytes
          ) {
            if (candidate && "body" in candidate) {
              await candidate.body.cancel().catch(() => undefined);
            }
            throw new ContentManagementStateError(
              `Private file ${row.filename} is missing or no longer matches its released version.`,
            );
          }
          return candidate;
        },
      });
    }
    return new Response(createStoredZipStream(entries), {
      headers: {
        "content-type": "application/zip",
        "content-length": String(storedZipByteLength(entries)),
        "content-disposition": `attachment; filename="${safeDownloadName(`programme-files-by-${input.groupBy}.zip`)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async downloadCurrentFile(viewer: Viewer, assetId: string) {
    requireAdministrator(viewer);
    const rows = await this.zipRows(viewer, [assetId]);
    const row = rows.results[0];
    if (!row) {
      throw new ContentManagementStateError(
        "The current file is unavailable, quarantined or outside this event.",
        404,
      );
    }
    if (!row.contentType?.trim()) {
      throw new Error(
        "The released private file is missing its detected content type.",
      );
    }
    const object = await this.requireBucket().get(row.objectKey);
    if (
      !object ||
      object.httpEtag !== row.objectEtag ||
      object.size !== row.sizeBytes
    ) {
      throw new Error(
        "The released private R2 object is missing or no longer matches its scanned version.",
      );
    }
    return new Response(object.body, {
      headers: {
        "content-type": row.contentType,
        "content-disposition": `attachment; filename="${safeDownloadName(row.filename)}"`,
        "content-length": String(object.size),
        etag: row.objectEtag,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async downloadFileVersion(
    viewer: Viewer,
    assetId: string,
    versionId: string,
  ) {
    requireAdministrator(viewer);
    const version = await this.env.DB.prepare(
      `SELECT version.object_key AS objectKey,
              version.object_etag AS objectEtag,
              version.original_filename AS filename,
              version.detected_content_type AS contentType,
              version.size_bytes AS sizeBytes
         FROM file_assets asset
         JOIN events event
           ON event.id = asset.event_id AND event.organisation_id = ?
         JOIN file_versions version
           ON version.id = ? AND version.asset_id = asset.id
          AND version.event_id = asset.event_id
        WHERE asset.id = ? AND asset.event_id = ?
          AND asset.status = 'active'
          AND version.upload_status = 'uploaded'
          AND version.signature_status = 'valid'
          AND version.scan_status = 'clean'
          AND version.released_at IS NOT NULL
          AND version.deleted_at IS NULL
          AND version.object_etag IS NOT NULL
        LIMIT 1`,
    )
      .bind(viewer.organisationId, versionId, assetId, viewer.eventId)
      .first<{
        objectKey: string;
        objectEtag: string;
        filename: string;
        contentType: string | null;
        sizeBytes: number;
      }>();
    if (!version) {
      throw new ContentManagementStateError(
        "The requested file version is unavailable, quarantined or outside this event.",
        404,
      );
    }
    if (!version.contentType?.trim()) {
      throw new Error(
        "The released private file is missing its detected content type.",
      );
    }
    const object = await this.requireBucket().get(version.objectKey);
    if (
      !object ||
      object.httpEtag !== version.objectEtag ||
      object.size !== version.sizeBytes
    ) {
      throw new Error(
        "The released private R2 object is missing or no longer matches its scanned version.",
      );
    }
    return new Response(object.body, {
      headers: {
        "content-type": version.contentType,
        "content-disposition": `attachment; filename="${safeDownloadName(version.filename)}"`,
        "content-length": String(object.size),
        etag: version.objectEtag,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
