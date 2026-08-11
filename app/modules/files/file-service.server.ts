import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { assetKindSchema, safeDownloadName } from "./file-policy";
import {
  FileLifecycleService,
  type FileErasureInput,
} from "./file-lifecycle-service.server";
import {
  FileScanResultService,
  scanResultSchema,
} from "./file-scan-result-service.server";
import {
  FileAccessError,
  FileDiscardIncompleteError,
  FileErasureConfirmationError,
  FileErasureIncompleteError,
  FileRetentionStateError,
  FileScanConflictError,
  FileScanPendingError,
  FileScanStateError,
  FileVersionNotFoundError,
  isMissingR2MultipartUpload,
} from "./file-service-errors";

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

export {
  FileAccessError,
  FileDiscardIncompleteError,
  FileErasureConfirmationError,
  FileErasureIncompleteError,
  FileRetentionStateError,
  FileScanConflictError,
  FileScanPendingError,
  FileScanStateError,
  FileVersionNotFoundError,
  isMissingR2MultipartUpload,
} from "./file-service-errors";

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
    return new FileScanResultService(this.env).recordScanResult(rawInput);
  }

  async previewAssetErasure(viewer: Viewer, assetId: string) {
    return new FileLifecycleService(this.env).previewAssetErasure(
      viewer,
      assetId,
    );
  }

  async eraseAsset(viewer: Viewer, input: FileErasureInput) {
    return new FileLifecycleService(this.env).eraseAsset(viewer, input);
  }

  async getFileRetentionState(viewer: Viewer) {
    return new FileLifecycleService(this.env).getFileRetentionState(viewer);
  }

  async setFileRetentionHold(
    viewer: Viewer,
    input: { hold: boolean; confirmed: boolean; reason: string },
  ) {
    return new FileLifecycleService(this.env).setFileRetentionHold(
      viewer,
      input,
    );
  }

  async eraseExpiredEventFiles(
    viewer: Viewer,
    input: { confirmed: boolean; limit?: number },
  ) {
    return new FileLifecycleService(this.env).eraseExpiredEventFiles(
      viewer,
      input,
    );
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
