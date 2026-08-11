import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { assetKindSchema, safeDownloadName } from "./file-policy";

export const uploadTargetSchema = z.object({
  targetType: z.enum(["person", "submission", "session", "task", "resource"]),
  targetId: z.string().min(1).max(160),
  assetKind: assetKindSchema,
});

export type UploadTarget = z.infer<typeof uploadTargetSchema>;

export async function stableLogicalAssetId(
  viewer: { eventId: string; personId: string | null },
  target: UploadTarget,
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify([
        viewer.eventId,
        viewer.personId,
        target.targetType,
        target.targetId,
        target.assetKind,
      ]),
    ),
  );
  const encoded = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `file-asset-${encoded}`;
}

export class FileAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileAccessError";
  }
}

export class FileScanPendingError extends Error {
  constructor() {
    super(
      "The upload is safely stored in quarantine. It cannot be downloaded or approved until a malware scanner reports it clean.",
    );
    this.name = "FileScanPendingError";
  }
}

export class FileVersionNotFoundError extends Error {
  constructor() {
    super("File version not found.");
    this.name = "FileVersionNotFoundError";
  }
}

export class FileScanStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileScanStateError";
  }
}

export class FileScanConflictError extends Error {
  constructor() {
    super("This file version already has a different final scanner result.");
    this.name = "FileScanConflictError";
  }
}

export class FileErasureConfirmationError extends Error {
  constructor() {
    super("Confirm permanent deletion of every stored version of this file.");
    this.name = "FileErasureConfirmationError";
  }
}

export class FileErasureIncompleteError extends Error {
  constructor(
    public readonly operationId: string,
    options?: ErrorOptions,
  ) {
    super(
      "File access was revoked, but private-object erasure did not complete. Retry the same deletion.",
      options,
    );
    this.name = "FileErasureIncompleteError";
  }
}

export class FileDiscardIncompleteError extends Error {
  readonly committed = true;

  constructor(
    readonly operationId: string,
    options?: ErrorOptions,
  ) {
    super(
      "The unattached upload was revoked, but private-object cleanup did not complete. Retry attachment completion to finish cleanup.",
      options,
    );
    this.name = "FileDiscardIncompleteError";
  }
}

const R2_NO_SUCH_MULTIPART_UPLOAD_CODE = 10024;

export function isMissingR2MultipartUpload(error: unknown) {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === R2_NO_SUCH_MULTIPART_UPLOAD_CODE
  );
}

export class FileRetentionStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileRetentionStateError";
  }
}

const scanResultSchema = z
  .object({
    jobId: z.string().min(1).max(200),
    eventId: z.string().min(1).max(160),
    versionId: z.string().min(1).max(160),
    assetId: z.string().min(1).max(160),
    objectEtag: z.string().min(1).max(200),
    sizeBytes: z.number().int().positive().max(1_073_741_824),
    provider: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[a-zA-Z0-9._-]+$/),
    callbackId: z
      .string()
      .min(1)
      .max(160)
      .regex(/^[a-zA-Z0-9._:-]+$/),
    status: z.enum(["clean", "infected", "failed"]),
    result: z.unknown(),
    error: z.string().trim().min(1).max(500).optional(),
  })
  .superRefine((input, context) => {
    if (input.status === "failed" && !input.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "A failed scan requires an error description.",
      });
    }
    if (input.status !== "failed" && input.error) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Only a failed scan may include an error description.",
      });
    }
  });

export type StoredUpload = {
  assetId: string;
  versionId: string;
  versionNumber: number;
  scanStatus: "pending";
};

export class FileService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private requireBucket() {
    if (!this.env.FILES)
      throw new Error("Required private R2 binding FILES is unavailable.");
    return this.env.FILES;
  }

  private async releasedDownload(version: {
    objectKey: string;
    objectEtag: string | null;
    filename: string;
    contentType: string | null;
  }) {
    if (!version.objectEtag) {
      throw new Error(
        "The released private file is missing its scanned R2 object ETag.",
      );
    }
    const object = await this.requireBucket().get(version.objectKey);
    if (!object || object.httpEtag !== version.objectEtag) {
      throw new Error(
        "The released private R2 object is missing or no longer matches its scanned version.",
      );
    }
    return new Response(object.body, {
      headers: {
        "content-type": version.contentType ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${safeDownloadName(version.filename)}"`,
        "content-length": String(object.size),
        etag: version.objectEtag,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async assertParticipantTarget(viewer: Viewer, target: UploadTarget) {
    if (target.targetType === "person") {
      if (target.targetId !== viewer.personId)
        throw new FileAccessError("You can upload only to your own profile.");
      return;
    }
    if (target.targetType === "session") {
      const owned = await this.env.DB.prepare(
        `
        SELECT 1 FROM session_speakers WHERE event_id = ? AND session_id = ? AND person_id = ?
      `,
      )
        .bind(viewer.eventId, target.targetId, viewer.personId)
        .first();
      if (!owned)
        throw new FileAccessError(
          "The session does not belong to this speaker.",
        );
      return;
    }
    if (target.targetType === "submission") {
      const owned = await this.env.DB.prepare(
        `
        SELECT 1 FROM submissions
         WHERE id = ? AND event_id = ? AND submitter_person_id = ?
           AND status = 'draft'
      `,
      )
        .bind(target.targetId, viewer.eventId, viewer.personId)
        .first();
      if (!owned)
        throw new FileAccessError(
          "The draft submission does not belong to this applicant.",
        );
      return;
    }
    if (target.targetType === "task") {
      if (target.assetKind !== "task_evidence")
        throw new FileAccessError(
          "Task uploads must be declared as task evidence.",
        );
      const owned = await this.env.DB.prepare(
        `
        SELECT ti.status, ti.task_type AS taskType,
               NOT EXISTS (
                 SELECT 1
                   FROM task_instance_dependencies dependency
                   JOIN task_instances prerequisite
                     ON prerequisite.id = dependency.depends_on_task_id
                  WHERE dependency.task_id = ti.id
                    AND prerequisite.status NOT IN ('completed','waived')
               ) AS dependenciesComplete
          FROM task_instances ti
         WHERE ti.id = ? AND ti.event_id = ?
           AND (
             ti.owner_person_id = ?
             OR (ti.target_type = 'speaker' AND ti.target_id = ?)
             OR (ti.target_type = 'session' AND EXISTS (
               SELECT 1 FROM session_speakers ss
                WHERE ss.event_id = ti.event_id AND ss.session_id = ti.target_id AND ss.person_id = ?
             ))
           )
      `,
      )
        .bind(
          target.targetId,
          viewer.eventId,
          viewer.personId,
          viewer.personId,
          viewer.personId,
        )
        .first<{
          status: string;
          taskType: string;
          dependenciesComplete: number;
        }>();
      if (!owned)
        throw new FileAccessError("The task does not belong to this speaker.");
      if (owned.taskType !== "file_upload")
        throw new FileAccessError("This task does not accept file evidence.");
      if (["completed", "waived", "submitted"].includes(owned.status))
        throw new FileAccessError(
          owned.status === "submitted"
            ? "This file task is already awaiting administrator review."
            : "Files cannot be uploaded to a completed or waived task.",
        );
      if (!owned.dependenciesComplete)
        throw new FileAccessError(
          "Complete the prerequisite tasks before uploading evidence.",
        );
      return;
    }
    throw new FileAccessError("Speakers cannot upload resource attachments.");
  }

  async assertAdminTarget(viewer: Viewer, target: UploadTarget) {
    if (
      !(["owner", "administrator"] as const).includes(
        viewer.role as "owner" | "administrator",
      )
    ) {
      throw new FileAccessError("Administrator access is required.");
    }
    const table =
      target.targetType === "resource"
        ? "resource_pages"
        : target.targetType === "submission"
          ? "submissions"
          : target.targetType === "session"
            ? "sessions"
            : target.targetType === "task"
              ? "task_instances"
              : "people";
    if (table === "people")
      throw new FileAccessError(
        "Administrator person uploads require an explicit speaker workflow.",
      );
    const eventColumn =
      table === "resource_pages" ||
      table === "submissions" ||
      table === "sessions" ||
      table === "task_instances"
        ? "event_id"
        : null;
    if (!eventColumn) throw new FileAccessError("Unsupported upload target.");
    const targetExists = await this.env.DB.prepare(
      `SELECT 1 FROM ${table} WHERE id = ? AND ${eventColumn} = ?`,
    )
      .bind(target.targetId, viewer.eventId)
      .first();
    if (!targetExists)
      throw new FileAccessError("Upload target not found in this event.");
  }

  private async discardUnattachedUpload(
    viewer: Viewer,
    upload: Pick<StoredUpload, "assetId" | "versionId">,
    targetType: "resource" | "task",
    targetId?: string,
  ) {
    const cleanupOperationId = `file-upload-discard:${upload.versionId}`;
    const cleanupAuditId = `file-upload-discarded:${upload.versionId}`;
    const cleanupError =
      targetType === "resource"
        ? "Resource draft changed before attachment."
        : "Task changed before evidence submission.";
    const row = await this.env.DB.prepare(
      `
      SELECT fv.object_key AS objectKey
        FROM file_assets fa
        JOIN file_versions fv
          ON fv.id = ? AND fv.asset_id = fa.id AND fv.event_id = fa.event_id
       WHERE fa.id = ? AND fa.event_id = ? AND fa.target_type = ?
         AND (? IS NULL OR fa.target_id = ?)
         AND fv.created_by_person_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM audit_events erasure
            WHERE erasure.id = 'file-erasure:' || fa.id
         )
    `,
    )
      .bind(
        upload.versionId,
        upload.assetId,
        viewer.eventId,
        targetType,
        targetId ?? null,
        targetId ?? null,
        viewer.personId,
      )
      .first<{ objectKey: string }>();
    if (!row)
      throw new FileAccessError(
        `The unlinked ${targetType} upload could not be identified for cleanup.`,
      );

    const [assetDeleted] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE file_assets
           SET status = 'deleted', current_version_id = NULL,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND target_type = ?
           AND status <> 'deleted'
           AND EXISTS (
             SELECT 1 FROM file_versions
              WHERE id = ? AND event_id = file_assets.event_id
                AND asset_id = file_assets.id AND created_by_person_id = ?
           )
           AND (
             (? = 'resource' AND NOT EXISTS (
               SELECT 1 FROM resource_attachments
                WHERE file_asset_id = file_assets.id
             ))
             OR
             (? = 'task' AND NOT EXISTS (
               SELECT 1 FROM task_evidence
                WHERE file_asset_id = file_assets.id
             ))
           )
      `,
      ).bind(
        upload.assetId,
        viewer.eventId,
        targetType,
        upload.versionId,
        viewer.personId,
        targetType,
        targetType,
      ),
      this.env.DB.prepare(
        `
        UPDATE file_versions
           SET upload_status = 'failed', scan_status = 'failed',
               scan_error = ?,
               released_at = NULL, deleted_at = unixepoch()
         WHERE id = ? AND event_id = ? AND asset_id = ?
           AND EXISTS (
             SELECT 1 FROM file_assets
              WHERE id = ? AND event_id = ? AND status = 'deleted'
           )
      `,
      ).bind(
        cleanupError,
        upload.versionId,
        viewer.eventId,
        upload.assetId,
        upload.assetId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'file.upload.discarded', 'file_version', ?, ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1
             FROM file_assets asset
             JOIN file_versions version
               ON version.id = ? AND version.asset_id = asset.id
              AND version.event_id = asset.event_id
            WHERE asset.id = ? AND asset.event_id = ?
              AND asset.status = 'deleted'
              AND version.deleted_at IS NOT NULL
              AND version.scan_error = ?
              AND NOT EXISTS (
                SELECT 1 FROM audit_events erasure
                 WHERE erasure.id = 'file-erasure:' || asset.id
              )
         )
      `,
      ).bind(
        cleanupAuditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        upload.versionId,
        cleanupOperationId,
        JSON.stringify({
          assetId: upload.assetId,
          reason:
            targetType === "resource"
              ? "resource_draft_changed"
              : "task_submission_changed",
        }),
        upload.versionId,
        upload.assetId,
        viewer.eventId,
        cleanupError,
      ),
    ]);
    if ((assetDeleted.meta.changes ?? 0) !== 1) {
      const retryable = await this.env.DB.prepare(
        `SELECT 1 FROM audit_events
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND action = 'file.upload.discarded'
            AND entity_type = 'file_version' AND entity_id = ?
            AND correlation_id = ?`,
      )
        .bind(
          cleanupAuditId,
          viewer.organisationId,
          viewer.eventId,
          upload.versionId,
          cleanupOperationId,
        )
        .first();
      if (!retryable)
        throw new FileAccessError(
          `The ${targetType} upload was linked or changed before cleanup.`,
        );
    }
    try {
      await this.requireBucket().delete(row.objectKey);
    } catch (error) {
      throw new FileDiscardIncompleteError(cleanupOperationId, {
        cause: error,
      });
    }
  }

  async discardUnattachedResourceUpload(
    viewer: Viewer,
    upload: Pick<StoredUpload, "assetId" | "versionId">,
  ) {
    return this.discardUnattachedUpload(viewer, upload, "resource");
  }

  async discardUnattachedTaskUpload(
    viewer: Viewer,
    upload: Pick<StoredUpload, "assetId" | "versionId">,
    taskId: string,
  ) {
    return this.discardUnattachedUpload(viewer, upload, "task", taskId);
  }

  async recordScanResult(rawInput: z.input<typeof scanResultSchema>) {
    const input = scanResultSchema.parse(rawInput);
    const scanResultJson = JSON.stringify({
      callbackId: input.callbackId,
      result: input.result,
    });
    if (!scanResultJson) {
      throw new FileScanStateError(
        "The scanner result could not be represented as JSON.",
      );
    }

    type ScanRow = {
      id: string;
      assetId: string;
      assetStatus: string;
      uploadStatus: string;
      signatureStatus: string;
      scanStatus: string;
      scanProvider: string | null;
      scanResultJson: string | null;
      objectKey: string;
      objectEtag: string | null;
      sizeBytes: number;
      deletedAt: number | null;
    };
    const load = () =>
      this.env.DB.prepare(
        `
      SELECT fv.id, fv.asset_id AS assetId, fv.upload_status AS uploadStatus,
             fv.signature_status AS signatureStatus,
             fv.scan_status AS scanStatus, fv.scan_provider AS scanProvider,
             fv.scan_result_json AS scanResultJson,
             fv.object_key AS objectKey, fv.object_etag AS objectEtag,
             fv.size_bytes AS sizeBytes,
             fv.deleted_at AS deletedAt, fa.status AS assetStatus
        FROM file_versions fv JOIN file_assets fa ON fa.id = fv.asset_id AND fa.event_id = fv.event_id
       WHERE fv.id = ? AND fv.event_id = ?
    `,
      )
        .bind(input.versionId, input.eventId)
        .first<ScanRow>();
    const classifyReplay = (candidate: ScanRow) => {
      if (candidate.scanStatus === "pending") {
        throw new FileScanStateError(
          "The file changed or was deleted before the scan result was committed.",
        );
      }
      if (
        candidate.scanStatus === input.status &&
        candidate.scanProvider === input.provider &&
        candidate.scanResultJson === scanResultJson
      ) {
        return {
          applied: false,
          duplicate: true,
          status: input.status,
        } as const;
      }
      throw new FileScanConflictError();
    };

    const row = await load();
    if (!row) throw new FileVersionNotFoundError();
    if (
      input.jobId !== `file-scan-dispatch:${row.id}` ||
      input.assetId !== row.assetId ||
      input.objectEtag !== row.objectEtag ||
      input.sizeBytes !== row.sizeBytes
    ) {
      throw new FileScanStateError(
        "The scanner callback does not match the dispatched file object.",
      );
    }
    const dispatch = await this.env.DB.prepare(
      `SELECT status, claim_token AS claimToken,
              json_extract(result_json, '$.accepted') AS accepted,
              json_extract(result_json, '$.dispatchStarted') AS dispatchStarted
         FROM operation_jobs
        WHERE id = ? AND event_id = ? AND type = 'file.scan.dispatch'
          AND json_extract(payload_json, '$.operationId') = ?
          AND json_extract(payload_json, '$.eventId') = ?
          AND json_extract(payload_json, '$.versionId') = ?
          AND json_extract(payload_json, '$.assetId') = ?
          AND json_extract(payload_json, '$.objectEtag') = ?
          AND json_extract(payload_json, '$.sizeBytes') = ?`,
    )
      .bind(
        input.jobId,
        input.eventId,
        input.jobId,
        input.eventId,
        input.versionId,
        input.assetId,
        input.objectEtag,
        input.sizeBytes,
      )
      .first<{
        status: string;
        claimToken: string | null;
        accepted: number | null;
        dispatchStarted: number | null;
      }>();
    if (!dispatch) {
      throw new FileScanStateError(
        "The scanner callback does not match a durable dispatch.",
      );
    }
    if (row.scanStatus !== "pending") {
      if (dispatch.status !== "completed") {
        throw new FileScanStateError(
          "The completed scan is not linked to a completed dispatch.",
        );
      }
      return classifyReplay(row);
    }
    if (
      dispatch.status !== "running" ||
      !(
        (dispatch.claimToken === null && dispatch.accepted === 1) ||
        dispatch.dispatchStarted === 1
      )
    ) {
      throw new FileScanStateError(
        "The scanner verdict arrived before the durable dispatch was accepted.",
      );
    }
    if (
      row.uploadStatus !== "uploaded" ||
      row.signatureStatus !== "valid" ||
      row.deletedAt !== null ||
      row.assetStatus === "deleted"
    ) {
      throw new FileScanStateError(
        "Only a completely uploaded, signature-valid version can be scanned.",
      );
    }
    const object = await this.requireBucket().head(row.objectKey);
    if (
      !object ||
      !row.objectEtag ||
      object.httpEtag !== row.objectEtag ||
      object.size !== row.sizeBytes
    ) {
      throw new FileScanStateError(
        "The quarantined R2 object is missing or no longer matches the dispatched version.",
      );
    }

    const scanOperationId = `file-scan:${row.id}`;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE file_versions
           SET scan_status = ?, scan_provider = ?, scan_result_json = ?,
               scan_error = ?, scanned_at = unixepoch(),
               released_at = CASE WHEN ? = 'clean' THEN unixepoch() ELSE NULL END
         WHERE id = ? AND event_id = ? AND asset_id = ?
           AND object_etag = ? AND size_bytes = ? AND scan_status = 'pending'
           AND upload_status = 'uploaded' AND signature_status = 'valid'
           AND deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM operation_jobs operation
              WHERE operation.id = ? AND operation.event_id = file_versions.event_id
                AND operation.type = 'file.scan.dispatch'
                AND operation.status = 'running'
                AND (
                  (
                    operation.claim_token IS NULL
                    AND json_extract(operation.result_json, '$.accepted') = 1
                  )
                  OR json_extract(operation.result_json, '$.dispatchStarted') = 1
                )
                AND json_extract(operation.payload_json, '$.operationId') = ?
                AND json_extract(operation.payload_json, '$.eventId') = file_versions.event_id
                AND json_extract(operation.payload_json, '$.versionId') = file_versions.id
                AND json_extract(operation.payload_json, '$.assetId') = file_versions.asset_id
                AND json_extract(operation.payload_json, '$.objectEtag') = file_versions.object_etag
                AND json_extract(operation.payload_json, '$.sizeBytes') = file_versions.size_bytes
           )
           AND EXISTS (
             SELECT 1 FROM file_assets asset
              WHERE asset.id = file_versions.asset_id
                AND asset.event_id = file_versions.event_id
                AND asset.status <> 'deleted'
                AND NOT EXISTS (
                  SELECT 1 FROM audit_events audit
                   WHERE audit.id = 'file-erasure:' || asset.id
                )
           )
      `,
      ).bind(
        input.status,
        input.provider,
        scanResultJson,
        input.error ?? null,
        input.status,
        row.id,
        input.eventId,
        row.assetId,
        input.objectEtag,
        input.sizeBytes,
        input.jobId,
        input.jobId,
      ),
      this.env.DB.prepare(
        `
        UPDATE operation_jobs
           SET status = 'completed', progress_completed = 1,
               progress_failed = 0,
               result_json = json_object(
                 'accepted', true,
                 'callbackReceived', true,
                 'scanStatus', ?
               ),
               last_error = NULL, claim_token = NULL,
               claim_expires_at = NULL, completed_at = unixepoch(),
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND type = 'file.scan.dispatch'
           AND status = 'running'
           AND (
             (claim_token IS NULL AND json_extract(result_json, '$.accepted') = 1)
             OR json_extract(result_json, '$.dispatchStarted') = 1
           )
           AND json_extract(payload_json, '$.operationId') = ?
           AND json_extract(payload_json, '$.versionId') = ?
           AND json_extract(payload_json, '$.assetId') = ?
           AND json_extract(payload_json, '$.objectEtag') = ?
           AND json_extract(payload_json, '$.sizeBytes') = ?
           AND EXISTS (
             SELECT 1 FROM file_versions version
              WHERE version.id = ? AND version.event_id = operation_jobs.event_id
                AND version.asset_id = ? AND version.scan_status = ?
                AND version.scan_provider = ? AND version.scan_result_json = ?
           )
      `,
      ).bind(
        input.status,
        input.jobId,
        input.eventId,
        input.jobId,
        row.id,
        row.assetId,
        input.objectEtag,
        input.sizeBytes,
        row.id,
        row.assetId,
        input.status,
        input.provider,
        scanResultJson,
      ),
      this.env.DB.prepare(
        `
        UPDATE task_instances AS task
           SET status = 'in_progress', readiness_state = 'at_risk', readiness_percent = 40,
               evidence_json = json_set(task.evidence_json, '$.scanStatus', ?),
               submitted_at = NULL, completed_at = NULL, completed_by_person_id = NULL,
               revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE task.event_id = ? AND task.status = 'submitted'
           AND ? IN ('infected', 'failed')
           AND EXISTS (
             SELECT 1
               FROM task_evidence evidence
               JOIN file_assets asset
                 ON asset.id = evidence.file_asset_id AND asset.event_id = evidence.event_id
               JOIN file_versions version
                 ON version.id = json_extract(evidence.evidence_json, '$.fileVersionId')
                AND version.asset_id = asset.id AND version.event_id = asset.event_id
              WHERE evidence.task_id = task.id AND evidence.event_id = task.event_id
                AND evidence.status = 'submitted' AND asset.id = ?
                AND asset.target_type = 'task' AND asset.target_id = task.id
                AND version.id = ? AND version.scan_status = ?
                AND version.scan_provider = ? AND version.scan_result_json = ?
           )
      `,
      ).bind(
        input.status,
        scanOperationId,
        input.eventId,
        input.status,
        row.assetId,
        row.id,
        input.status,
        input.provider,
        scanResultJson,
      ),
      this.env.DB.prepare(
        `
        UPDATE task_evidence AS evidence
           SET status = 'rejected', reviewed_at = unixepoch()
         WHERE evidence.event_id = ? AND evidence.status = 'submitted'
           AND evidence.file_asset_id = ? AND ? IN ('infected', 'failed')
           AND json_extract(evidence.evidence_json, '$.fileVersionId') = ?
           AND EXISTS (
             SELECT 1 FROM file_versions version
              WHERE version.id = ? AND version.event_id = evidence.event_id
                AND version.asset_id = evidence.file_asset_id
                AND version.scan_status = ?
                AND version.scan_provider = ? AND version.scan_result_json = ?
           )
      `,
      ).bind(
        input.eventId,
        row.assetId,
        input.status,
        row.id,
        row.id,
        input.status,
        input.provider,
        scanResultJson,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO audit_events (
          id, organisation_id, event_id, actor_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ? || ':' || task.id, event.organisation_id, task.event_id, ?, 'task.file.rejected',
               'task_instance', task.id, ?, ?, unixepoch()
          FROM task_instances task
          JOIN events event ON event.id = task.event_id
         WHERE task.event_id = ? AND task.last_operation_id = ?
      `,
      ).bind(
        scanOperationId,
        `scanner:${input.provider}`,
        scanOperationId,
        JSON.stringify({
          assetId: row.assetId,
          versionId: row.id,
          verdict: input.status,
        }),
        input.eventId,
        scanOperationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE file_versions AS current SET replaced_at = unixepoch()
         WHERE current.id = (
           SELECT asset.current_version_id FROM file_assets AS asset
            WHERE asset.id = ? AND asset.event_id = ?
         )
           AND ? = 'clean'
           AND EXISTS (
             SELECT 1 FROM file_versions AS candidate
              WHERE candidate.id = ? AND candidate.event_id = ? AND candidate.asset_id = ?
                AND candidate.scan_status = 'clean' AND candidate.released_at IS NOT NULL
                AND candidate.version_number > current.version_number
           )
      `,
      ).bind(
        row.assetId,
        input.eventId,
        input.status,
        row.id,
        input.eventId,
        row.assetId,
      ),
      this.env.DB.prepare(
        `
        UPDATE file_assets AS asset
           SET current_version_id = CASE WHEN ? = 'clean' THEN ? ELSE current_version_id END,
               status = CASE WHEN ? = 'clean' THEN 'active' WHEN current_version_id IS NULL THEN 'rejected' ELSE status END,
               updated_at = unixepoch()
         WHERE asset.id = ? AND asset.event_id = ?
           AND EXISTS (
             SELECT 1
               FROM file_versions AS candidate
               LEFT JOIN file_versions AS current
                 ON current.id = asset.current_version_id AND current.event_id = asset.event_id
              WHERE candidate.id = ? AND candidate.event_id = asset.event_id AND candidate.asset_id = asset.id
                AND candidate.scan_status = ?
                AND (
                  ? <> 'clean'
                  OR (
                    candidate.released_at IS NOT NULL
                    AND (current.id IS NULL OR candidate.version_number > current.version_number)
                  )
                )
           )
      `,
      ).bind(
        input.status,
        row.id,
        input.status,
        row.assetId,
        input.eventId,
        row.id,
        input.status,
        input.status,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO audit_events (
          id, organisation_id, event_id, actor_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, event.organisation_id, asset.event_id, ?, ?,
               'file_version', version.id, ?, ?, unixepoch()
          FROM file_versions version
          JOIN file_assets asset
            ON asset.id = version.asset_id AND asset.event_id = version.event_id
          JOIN events event ON event.id = asset.event_id
         WHERE version.id = ? AND version.event_id = ?
           AND version.scan_status = ? AND version.scan_provider = ?
           AND version.scan_result_json = ?
      `,
      ).bind(
        scanOperationId,
        `scanner:${input.provider}`,
        `file.scan.${input.status}`,
        scanOperationId,
        JSON.stringify({
          assetId: row.assetId,
          callbackId: input.callbackId,
          verdict: input.status,
        }),
        row.id,
        input.eventId,
        input.status,
        input.provider,
        scanResultJson,
      ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) === 1 &&
      (results[1]?.meta.changes ?? 0) === 1
    ) {
      return {
        applied: true,
        duplicate: false,
        status: input.status,
      } as const;
    }
    if ((results[0]?.meta.changes ?? 0) === 1) {
      throw new FileScanStateError(
        "The scan result changed the file without completing its durable dispatch.",
      );
    }
    const current = await load();
    if (!current) throw new FileVersionNotFoundError();
    return classifyReplay(current);
  }

  private async fileErasurePreview(viewer: Viewer, assetId: string) {
    const preview = await this.env.DB.prepare(
      `
      SELECT asset.id, asset.target_type AS targetType,
             asset.target_id AS targetId, asset.asset_kind AS assetKind,
             asset.owner_person_id AS ownerPersonId, asset.status,
             (
               SELECT version.original_filename FROM file_versions version
                WHERE version.asset_id = asset.id AND version.event_id = asset.event_id
                ORDER BY version.version_number DESC LIMIT 1
             ) AS latestFilename,
             (
               SELECT COUNT(*) FROM file_versions version
                WHERE version.asset_id = asset.id AND version.event_id = asset.event_id
             ) AS versionCount,
             (
               SELECT COUNT(*) FROM resource_attachments attachment
                WHERE attachment.file_asset_id = asset.id
                  AND attachment.event_id = asset.event_id
             ) AS resourceAttachmentCount,
             (
               SELECT COUNT(*) FROM task_evidence evidence
                WHERE evidence.file_asset_id = asset.id
                  AND evidence.event_id = asset.event_id
             ) AS taskEvidenceCount,
             EXISTS (
               SELECT 1 FROM audit_events audit
                WHERE audit.id = 'file-erasure-complete:' || asset.id
             ) AS erasureComplete
        FROM file_assets asset
        JOIN events event
          ON event.id = asset.event_id AND event.organisation_id = ?
       WHERE asset.id = ? AND asset.event_id = ?
    `,
    )
      .bind(viewer.organisationId, assetId, viewer.eventId)
      .first<{
        id: string;
        targetType: string;
        targetId: string;
        assetKind: string;
        ownerPersonId: string | null;
        status: string;
        latestFilename: string | null;
        versionCount: number;
        resourceAttachmentCount: number;
        taskEvidenceCount: number;
        erasureComplete: number;
      }>();
    if (!preview) {
      throw new FileAccessError(
        "The file is unavailable or outside this event.",
      );
    }
    const administrator = ["owner", "administrator"].includes(viewer.role);
    const participantOwned =
      preview.ownerPersonId === viewer.personId &&
      ["person", "session", "submission"].includes(preview.targetType);
    if (!administrator && !participantOwned) {
      throw new FileAccessError(
        "You do not have permission to erase this file.",
      );
    }
    return {
      ...preview,
      versionCount: Number(preview.versionCount),
      resourceAttachmentCount: Number(preview.resourceAttachmentCount),
      taskEvidenceCount: Number(preview.taskEvidenceCount),
      erasureComplete: Boolean(preview.erasureComplete),
    };
  }

  async previewAssetErasure(viewer: Viewer, assetId: string) {
    return this.fileErasurePreview(viewer, assetId);
  }

  async eraseAsset(
    viewer: Viewer,
    input: {
      assetId: string;
      confirmed: boolean;
      reason?: string;
      enforceEventRetentionBoundary?: boolean;
    },
  ) {
    if (!input.confirmed) throw new FileErasureConfirmationError();
    const preview = await this.fileErasurePreview(viewer, input.assetId);
    const operationId = `file-erasure:${preview.id}`;
    if (preview.erasureComplete) {
      return {
        operationId,
        duplicate: true,
        erasedVersions: preview.versionCount,
        affected: preview,
      };
    }
    const metadata = JSON.stringify({
      reason: input.reason?.trim().slice(0, 240) || "explicit_file_deletion",
      versionCount: preview.versionCount,
      resourceAttachmentCount: preview.resourceAttachmentCount,
      taskEvidenceCount: preview.taskEvidenceCount,
    });
    const retentionGuard = input.enforceEventRetentionBoundary
      ? `AND EXISTS (
           SELECT 1 FROM events retention_event
            WHERE retention_event.id = ?
              AND retention_event.organisation_id = ?
              AND retention_event.file_retention_hold_at IS NULL
              AND unixepoch(datetime(
                    retention_event.ends_at,
                    'unixepoch',
                    '+' || retention_event.retention_months || ' months'
                  )) <= unixepoch()
         )`
      : "";
    const retentionBindings = input.enforceEventRetentionBoundary
      ? [viewer.eventId, viewer.organisationId]
      : [];
    const [assetRevoked] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE file_assets
            SET status = 'rejected', current_version_id = NULL,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ?
            ${retentionGuard}`,
      ).bind(preview.id, viewer.eventId, ...retentionBindings),
      this.env.DB.prepare(
        `UPDATE file_versions
            SET released_at = NULL,
                upload_status = CASE
                  WHEN upload_status IN ('requested','uploading','failed')
                    THEN 'aborted'
                  ELSE upload_status
                END,
                scan_status = CASE
                  WHEN upload_status IN ('requested','uploading','failed')
                    THEN 'failed'
                  ELSE scan_status
                END,
                scan_error = CASE
                  WHEN upload_status IN ('requested','uploading','failed')
                    THEN 'File erased before multipart completion.'
                  ELSE scan_error
                END
          WHERE asset_id = ? AND event_id = ?
            ${retentionGuard}`,
      ).bind(preview.id, viewer.eventId, ...retentionBindings),
      this.env.DB.prepare(
        `UPDATE file_multipart_uploads
            SET status = 'aborted',
                last_error = 'File erased before multipart completion.',
                updated_at = unixepoch()
          WHERE asset_id = ? AND event_id = ?
            AND status IN ('requested','initiated','completing','failed')
            ${retentionGuard}`,
      ).bind(preview.id, viewer.eventId, ...retentionBindings),
      this.env.DB.prepare(
        `UPDATE task_instances AS task
            SET status = 'in_progress', readiness_state = 'at_risk',
                readiness_percent = 40, submitted_at = NULL,
                completed_at = NULL, completed_by_person_id = NULL,
                revision = revision + 1, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE task.event_id = ?
            AND task.status IN ('submitted', 'completed')
            AND EXISTS (
              SELECT 1 FROM task_evidence evidence
               WHERE evidence.event_id = task.event_id
                 AND evidence.task_id = task.id
                 AND evidence.file_asset_id = ?
                 AND evidence.status IN ('submitted', 'approved')
            )
            ${retentionGuard}`,
      ).bind(operationId, viewer.eventId, preview.id, ...retentionBindings),
      this.env.DB.prepare(
        `UPDATE task_evidence
            SET status = 'rejected', reviewed_at = unixepoch(),
                reviewed_by_person_id = ?
          WHERE event_id = ? AND file_asset_id = ?
            AND status IN ('submitted', 'approved')
            ${retentionGuard}`,
      ).bind(viewer.personId, viewer.eventId, preview.id, ...retentionBindings),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'file.erasure.requested',
                'file_asset', ?, ?, ?, unixepoch()
          WHERE 1 = 1
            ${retentionGuard}`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        preview.id,
        operationId,
        metadata,
        ...retentionBindings,
      ),
    ]);
    if (
      input.enforceEventRetentionBoundary &&
      (assetRevoked.meta.changes ?? 0) !== 1
    ) {
      const current = await this.getFileRetentionState(viewer);
      if (current.holdAt !== null) {
        throw new FileRetentionStateError(
          "File retention was placed on hold before the erasure intent committed.",
        );
      }
      if (!current.eligible) {
        throw new FileRetentionStateError(
          "The event no longer satisfies its configured file-retention date.",
        );
      }
      throw new FileRetentionStateError(
        "File retention changed concurrently before the erasure intent committed.",
      );
    }

    const versions = await this.env.DB.prepare(
      `SELECT version.object_key AS objectKey,
              upload.upload_id AS uploadId,
              upload.status AS multipartStatus
         FROM file_versions version
         LEFT JOIN file_multipart_uploads upload
           ON upload.version_id = version.id
          AND upload.event_id = version.event_id
        WHERE version.asset_id = ? AND version.event_id = ?
        ORDER BY version.version_number`,
    )
      .bind(preview.id, viewer.eventId)
      .all<{
        objectKey: string;
        uploadId: string | null;
        multipartStatus: string | null;
      }>();
    try {
      const providerAbortFailures: unknown[] = [];
      for (const version of versions.results) {
        if (!version.uploadId || version.multipartStatus !== "aborted")
          continue;
        try {
          await this.requireBucket()
            .resumeMultipartUpload(version.objectKey, version.uploadId)
            .abort();
        } catch (error) {
          // R2 may have committed an earlier abort whose response was lost.
          // The exact missing-upload code proves the desired terminal state;
          // every other provider failure remains retryable and fail-closed.
          if (!isMissingR2MultipartUpload(error)) {
            providerAbortFailures.push(error);
          }
        }
      }
      for (let offset = 0; offset < versions.results.length; offset += 1_000) {
        await this.requireBucket().delete(
          versions.results
            .slice(offset, offset + 1_000)
            .map((version) => version.objectKey),
        );
      }
      if (providerAbortFailures.length > 0)
        throw new AggregateError(
          providerAbortFailures,
          "One or more incomplete R2 multipart uploads could not be aborted.",
        );
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE file_versions
              SET deleted_at = COALESCE(deleted_at, unixepoch()),
                  released_at = NULL
            WHERE asset_id = ? AND event_id = ?`,
        ).bind(preview.id, viewer.eventId),
        this.env.DB.prepare(
          `UPDATE file_assets
              SET status = 'deleted', current_version_id = NULL,
                  updated_at = unixepoch()
            WHERE id = ? AND event_id = ?`,
        ).bind(preview.id, viewer.eventId),
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           ) VALUES (?, ?, ?, ?, 'file.erasure.completed',
                     'file_asset', ?, ?, ?, unixepoch())`,
        ).bind(
          `file-erasure-complete:${preview.id}`,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          preview.id,
          operationId,
          JSON.stringify({ erasedVersions: versions.results.length }),
        ),
      ]);
    } catch (error) {
      throw new FileErasureIncompleteError(operationId, { cause: error });
    }
    return {
      operationId,
      duplicate: false,
      erasedVersions: versions.results.length,
      affected: preview,
    };
  }

  private requireRetentionOwner(viewer: Viewer) {
    if (viewer.role !== "owner") {
      throw new FileAccessError(
        "Organisation owner access is required for file retention controls.",
      );
    }
  }

  async getFileRetentionState(viewer: Viewer) {
    this.requireRetentionOwner(viewer);
    const state = await this.env.DB.prepare(
      `
      SELECT event.name, event.ends_at AS endsAt,
             event.retention_months AS retentionMonths,
             event.file_retention_hold_at AS holdAt,
             unixepoch(
               datetime(
                 event.ends_at,
                 'unixepoch',
                 '+' || event.retention_months || ' months'
               )
             ) AS eligibleAt,
             (
               SELECT COUNT(*) FROM file_assets asset
                WHERE asset.event_id = event.id
                  AND NOT EXISTS (
                    SELECT 1 FROM audit_events audit
                     WHERE audit.id = 'file-erasure-complete:' || asset.id
                  )
             ) AS pendingAssetCount,
             (
               SELECT COUNT(*) FROM file_versions version
                WHERE version.event_id = event.id
                  AND NOT EXISTS (
                    SELECT 1 FROM audit_events audit
                     WHERE audit.id = 'file-erasure-complete:' || version.asset_id
                  )
             ) AS pendingVersionCount
        FROM events event
       WHERE event.id = ? AND event.organisation_id = ?
    `,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{
        name: string;
        endsAt: number;
        retentionMonths: number;
        holdAt: number | null;
        eligibleAt: number;
        pendingAssetCount: number;
        pendingVersionCount: number;
      }>();
    if (!state) {
      throw new FileAccessError("The retention event is unavailable.");
    }
    const now = Math.floor(Date.now() / 1_000);
    return {
      ...state,
      pendingAssetCount: Number(state.pendingAssetCount),
      pendingVersionCount: Number(state.pendingVersionCount),
      eligible: state.eligibleAt <= now,
    };
  }

  async setFileRetentionHold(
    viewer: Viewer,
    input: { hold: boolean; confirmed: boolean; reason: string },
  ) {
    this.requireRetentionOwner(viewer);
    if (!input.confirmed) {
      throw new FileRetentionStateError(
        "Confirm the event-wide file-retention hold change.",
      );
    }
    const reason = input.reason.trim();
    if (reason.length < 3 || reason.length > 500) {
      throw new FileRetentionStateError(
        "Give a retention-hold reason between 3 and 500 characters.",
      );
    }
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE events
            SET file_retention_hold_at = CASE WHEN ? = 1 THEN unixepoch() ELSE NULL END,
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND ((? = 1 AND file_retention_hold_at IS NULL)
              OR (? = 0 AND file_retention_hold_at IS NOT NULL))`,
      ).bind(
        input.hold ? 1 : 0,
        viewer.eventId,
        viewer.organisationId,
        input.hold ? 1 : 0,
        input.hold ? 1 : 0,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, ?, 'event', ?, ?, unixepoch()
          WHERE changes() = 1`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        input.hold
          ? "event.file_retention_hold.placed"
          : "event.file_retention_hold.released",
        viewer.eventId,
        JSON.stringify({ reason }),
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new FileRetentionStateError(
        input.hold
          ? "File retention is already on hold."
          : "File retention is not currently on hold.",
      );
    }
    return this.getFileRetentionState(viewer);
  }

  async eraseExpiredEventFiles(
    viewer: Viewer,
    input: { confirmed: boolean; limit?: number },
  ) {
    this.requireRetentionOwner(viewer);
    if (!input.confirmed) throw new FileErasureConfirmationError();
    const state = await this.getFileRetentionState(viewer);
    if (state.holdAt !== null) {
      throw new FileRetentionStateError(
        "Release the event's file-retention hold before erasure.",
      );
    }
    if (!state.eligible) {
      throw new FileRetentionStateError(
        "This event has not reached its configured file-retention date.",
      );
    }
    const limit = z
      .number()
      .int()
      .min(1)
      .max(100)
      .parse(input.limit ?? 50);
    const candidates = await this.env.DB.prepare(
      `SELECT asset.id FROM file_assets asset
        WHERE asset.event_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM audit_events audit
             WHERE audit.id = 'file-erasure-complete:' || asset.id
          )
        ORDER BY asset.created_at, asset.id
        LIMIT ?`,
    )
      .bind(viewer.eventId, limit)
      .all<{ id: string }>();
    let erasedVersions = 0;
    for (const candidate of candidates.results) {
      const result = await this.eraseAsset(viewer, {
        assetId: candidate.id,
        confirmed: true,
        reason: "event_retention_period_elapsed",
        enforceEventRetentionBoundary: true,
      });
      erasedVersions += result.erasedVersions;
    }
    const remaining = await this.getFileRetentionState(viewer);
    return {
      erasedAssets: candidates.results.length,
      erasedVersions,
      remainingAssets: remaining.pendingAssetCount,
    };
  }

  async participantDownload(viewer: Viewer, assetId: string) {
    const version = await this.env.DB.prepare(
      `
      SELECT fv.object_key AS objectKey, fv.original_filename AS filename,
             fv.detected_content_type AS contentType,
             fv.object_etag AS objectEtag
        FROM file_assets fa
        JOIN file_versions fv ON fv.id = fa.current_version_id AND fv.event_id = fa.event_id
       WHERE fa.id = ? AND fa.event_id = ? AND fa.owner_person_id = ? AND fa.status = 'active'
         AND fv.upload_status = 'uploaded' AND fv.signature_status = 'valid'
         AND fv.scan_status = 'clean' AND fv.released_at IS NOT NULL AND fv.deleted_at IS NULL
    `,
    )
      .bind(assetId, viewer.eventId, viewer.personId)
      .first<{
        objectKey: string;
        objectEtag: string | null;
        filename: string;
        contentType: string | null;
      }>();
    if (!version) throw new FileScanPendingError();
    return this.releasedDownload(version);
  }

  async administratorTaskEvidenceDownload(
    viewer: Viewer,
    assetId: string,
    versionId: string,
  ) {
    if (
      !(["owner", "administrator"] as const).includes(
        viewer.role as "owner" | "administrator",
      )
    ) {
      throw new FileAccessError("Administrator access is required.");
    }
    const version = await this.env.DB.prepare(
      `
      SELECT version.object_key AS objectKey,
             version.object_etag AS objectEtag,
             version.original_filename AS filename,
             version.detected_content_type AS contentType
        FROM file_assets asset
        JOIN events event
          ON event.id = asset.event_id AND event.organisation_id = ?
        JOIN file_versions version
          ON version.id = ? AND version.asset_id = asset.id
         AND version.event_id = asset.event_id
        JOIN task_evidence evidence
          ON evidence.file_asset_id = asset.id AND evidence.event_id = asset.event_id
         AND json_extract(evidence.evidence_json, '$.fileVersionId') = version.id
        JOIN task_instances task
          ON task.id = evidence.task_id AND task.event_id = evidence.event_id
         AND asset.target_type = 'task' AND asset.target_id = task.id
       WHERE asset.id = ? AND asset.event_id = ? AND asset.status = 'active'
         AND evidence.status IN ('submitted','approved')
         AND version.upload_status = 'uploaded'
         AND version.signature_status = 'valid'
         AND version.scan_status = 'clean'
         AND version.released_at IS NOT NULL AND version.deleted_at IS NULL
       LIMIT 1
    `,
    )
      .bind(viewer.organisationId, versionId, assetId, viewer.eventId)
      .first<{
        objectKey: string;
        objectEtag: string | null;
        filename: string;
        contentType: string | null;
      }>();
    if (!version)
      throw new FileAccessError(
        "The task evidence is unavailable, quarantined or outside this event.",
      );
    return this.releasedDownload(version);
  }

  async participantResourceDownload(viewer: Viewer, assetId: string) {
    const version = await this.env.DB.prepare(
      `
      SELECT fv.object_key AS objectKey, fv.original_filename AS filename,
             fv.detected_content_type AS contentType,
             fv.object_etag AS objectEtag
        FROM resource_attachments ra
        JOIN resource_page_versions rv ON rv.id = ra.resource_page_version_id AND rv.event_id = ra.event_id AND rv.status = 'published'
        JOIN resource_pages rp ON rp.id = rv.resource_page_id AND rp.event_id = rv.event_id AND rp.status = 'published'
        JOIN file_assets fa ON fa.id = ra.file_asset_id AND fa.event_id = ra.event_id AND fa.status = 'active'
        JOIN file_versions fv ON fv.id = fa.current_version_id AND fv.event_id = fa.event_id
       WHERE fa.id = ? AND fa.event_id = ?
         AND fv.upload_status = 'uploaded' AND fv.signature_status = 'valid'
         AND fv.scan_status = 'clean' AND fv.released_at IS NOT NULL AND fv.deleted_at IS NULL
         AND (
           rv.audience_scope = 'all_speakers'
           OR (rv.audience_scope = 'accepted_speakers' AND EXISTS (
             SELECT 1 FROM session_speakers ss WHERE ss.event_id = rp.event_id AND ss.person_id = ?
           ))
           OR (rv.audience_scope = 'custom' AND EXISTS (
             SELECT 1 FROM resource_audiences audience
              WHERE audience.resource_page_version_id = rv.id AND audience.event_id = rp.event_id
                AND (
                  (audience.target_type = 'person' AND audience.target_id = ?)
                  OR (audience.target_type = 'role' AND audience.target_id = 'speaker')
                  OR (audience.target_type = 'session' AND EXISTS (
                    SELECT 1 FROM session_speakers ss
                     WHERE ss.event_id = rp.event_id AND ss.session_id = audience.target_id AND ss.person_id = ?
                  ))
                )
           ))
         )
       LIMIT 1
    `,
    )
      .bind(
        assetId,
        viewer.eventId,
        viewer.personId,
        viewer.personId,
        viewer.personId,
      )
      .first<{
        objectKey: string;
        objectEtag: string | null;
        filename: string;
        contentType: string | null;
      }>();
    if (!version)
      throw new FileAccessError(
        "The resource attachment is unavailable or outside your audience.",
      );
    return this.releasedDownload(version);
  }
}
