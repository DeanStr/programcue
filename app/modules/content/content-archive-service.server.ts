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

const zipOperationResultSchema = z.object({
  objectKey: z.string().min(1),
  objectEtag: z.string().min(1),
  sizeBytes: z.number().int().positive(),
  fileName: z.string().min(1),
});

function parseZipOperationResult(resultJson: string | null) {
  if (!resultJson) {
    throw new Error(
      "The completed ZIP export is missing its durable result JSON.",
    );
  }
  try {
    return zipOperationResultSchema.parse(JSON.parse(resultJson));
  } catch {
    throw new Error(
      "The completed ZIP export has invalid durable result JSON.",
    );
  }
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
      .all<
        z.infer<typeof zipManifestEntrySchema> & {
          objectKey: string;
          contentType: string | null;
        }
      >();
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
      throw new ContentManagementStateError(
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
    const existing = await this.env.DB.prepare(
      `SELECT id, status, result_json AS resultJson, last_error AS lastError
         FROM operation_jobs
        WHERE event_id = ? AND organisation_id = ? AND type = ?
          AND idempotency_key = ?
        LIMIT 1`,
    )
      .bind(
        viewer.eventId,
        viewer.organisationId,
        "content.zip.export",
        idempotencyKey,
      )
      .first<{
        id: string;
        status: string;
        resultJson: string | null;
        lastError: string | null;
      }>();
    if (existing) {
      return {
        operationId: existing.id,
        status: publicZipOperationStatus(existing.status),
        error: existing.lastError,
        selectedCount: expected.length,
      };
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
      const raced = await this.env.DB.prepare(
        `SELECT id, status, last_error AS lastError
           FROM operation_jobs
          WHERE event_id = ? AND organisation_id = ? AND type = ?
            AND idempotency_key = ?
          LIMIT 1`,
      )
        .bind(
          viewer.eventId,
          viewer.organisationId,
          "content.zip.export",
          idempotencyKey,
        )
        .first<{ id: string; status: string; lastError: string | null }>();
      if (!raced) {
        throw new Error(
          "The ZIP export idempotency record could not be recovered after a concurrent request.",
        );
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

  async zipOperationStatus(viewer: Viewer, operationId: string) {
    requireAdministrator(viewer);
    const operation = await this.env.DB.prepare(
      `SELECT id, status, result_json AS resultJson, last_error AS lastError
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
      }>();
    if (!operation) {
      throw new ContentManagementStateError("ZIP export not found.", 404);
    }
    const status = publicZipOperationStatus(operation.status);
    const result =
      operation.status === "completed"
        ? parseZipOperationResult(operation.resultJson)
        : null;
    return {
      operationId: operation.id,
      status,
      error: operation.lastError,
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
      `SELECT result_json AS resultJson, status
         FROM operation_jobs
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'content.zip.export'
        LIMIT 1`,
    )
      .bind(operationId, viewer.eventId, viewer.organisationId)
      .first<{ resultJson: string | null; status: string }>();
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
    const result = parseZipOperationResult(operation.resultJson);
    const object = await this.requireBucket().get(result.objectKey);
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
      throw new ContentManagementStateError(
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
