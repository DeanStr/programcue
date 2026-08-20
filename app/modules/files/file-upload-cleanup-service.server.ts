import type { AuditOrigin } from "~/platform/audit/audit-contract";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import {
  FileAccessError,
  FileDiscardIncompleteError,
} from "./file-service-errors";

type StoredUploadReference = {
  assetId: string;
  versionId: string;
};

type FileCleanupOrigin = Extract<AuditOrigin, "admin_ui" | "participant_ui">;

export class FileUploadCleanupService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private requireBucket() {
    if (!this.env.FILES) {
      throw new Error("Required private R2 binding FILES is unavailable.");
    }
    return this.env.FILES;
  }

  private async discardUnattachedUpload(
    viewer: Viewer,
    upload: StoredUploadReference,
    targetType: "resource" | "task",
    origin: FileCleanupOrigin,
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
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, 'person', ?, 1, ?, ?, ?, 'file.upload.discarded', 'file_version', ?, ?, ?, unixepoch()
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
        origin,
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
      atomicBatchGuardStatement(
        this.env,
        `(EXISTS (
            SELECT 1 FROM file_assets asset
             WHERE asset.id = ? AND asset.event_id = ?
               AND asset.status = 'deleted'
          ) OR EXISTS (
            SELECT 1 FROM file_versions version
             WHERE version.id = ? AND version.event_id = ?
               AND version.deleted_at IS NOT NULL
          ) OR EXISTS (
            SELECT 1 FROM audit_events audit WHERE audit.id = ?
          )) AND NOT (
            EXISTS (
              SELECT 1 FROM file_assets asset
               WHERE asset.id = ? AND asset.event_id = ?
                 AND asset.target_type = ? AND asset.status = 'deleted'
                 AND asset.current_version_id IS NULL
            ) AND EXISTS (
              SELECT 1 FROM file_versions version
               WHERE version.id = ? AND version.event_id = ?
                 AND version.asset_id = ?
                 AND version.upload_status = 'failed'
                 AND version.scan_status = 'failed'
                 AND version.scan_error = ?
                 AND version.released_at IS NULL
                 AND version.deleted_at IS NOT NULL
            ) AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.organisation_id = ?
                 AND audit.event_id = ? AND audit.actor_person_id = ?
                 AND audit.origin = ?
                 AND audit.action = 'file.upload.discarded'
                 AND audit.entity_type = 'file_version'
                 AND audit.entity_id = ? AND audit.correlation_id = ?
            )
          )`,
        [
          upload.assetId,
          viewer.eventId,
          upload.versionId,
          viewer.eventId,
          cleanupAuditId,
          upload.assetId,
          viewer.eventId,
          targetType,
          upload.versionId,
          viewer.eventId,
          upload.assetId,
          cleanupError,
          cleanupAuditId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          origin,
          upload.versionId,
          cleanupOperationId,
        ],
      ),
    ]).catch((error: unknown) => {
      if (isAtomicBatchGuardError(error)) {
        throw new FileAccessError(
          `The ${targetType} upload cleanup could not record its complete discarded state and audit evidence.`,
        );
      }
      throw error;
    });
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

  private async discardUnattachedTaskUploadVersion(
    viewer: Viewer,
    upload: StoredUploadReference,
    taskId: string,
    origin: FileCleanupOrigin,
  ) {
    const cleanupOperationId = `file-upload-discard:${upload.versionId}`;
    const cleanupAuditId = `file-upload-discarded:${upload.versionId}`;
    const cleanupError = "Task changed before evidence submission.";
    const sessionDeliverable = Boolean(
      await this.env.DB.prepare(
        `SELECT 1
           FROM task_instances task
          WHERE task.id = ? AND task.event_id = ?
            AND task.target_type = 'session'
            AND task.task_type = 'file_upload'
            AND json_valid(task.configuration_json)
            AND json_extract(task.configuration_json, '$.fileScope') = 'session_deliverable'`,
      )
        .bind(taskId, viewer.eventId)
        .first(),
    );
    const row = await this.env.DB.prepare(
      `SELECT version.object_key AS objectKey
         FROM file_assets asset
         JOIN file_versions version
           ON version.id = ? AND version.asset_id = asset.id
          AND version.event_id = asset.event_id
        WHERE asset.id = ? AND asset.event_id = ?
          AND asset.target_type = 'task' AND asset.target_id = ?
          AND asset.asset_kind = 'task_evidence'
          AND (? = 1 OR asset.owner_person_id = ?)
          AND version.created_by_person_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM audit_events erasure
             WHERE erasure.id = 'file-erasure:' || asset.id
          )`,
    )
      .bind(
        upload.versionId,
        upload.assetId,
        viewer.eventId,
        taskId,
        sessionDeliverable ? 1 : 0,
        viewer.personId,
        viewer.personId,
      )
      .first<{ objectKey: string }>();
    if (!row) {
      throw new FileAccessError(
        "The unlinked task upload could not be identified for cleanup.",
      );
    }

    const [versionDiscarded] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE file_versions AS version
            SET upload_status = 'failed', scan_status = 'failed',
                scan_error = ?, released_at = NULL, deleted_at = unixepoch()
          WHERE version.id = ? AND version.event_id = ? AND version.asset_id = ?
            AND version.created_by_person_id = ? AND version.deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM file_assets asset
               WHERE asset.id = version.asset_id
                 AND asset.event_id = version.event_id
                 AND asset.target_type = 'task' AND asset.target_id = ?
                 AND (? = 1 OR asset.owner_person_id = ?)
            )
            AND NOT EXISTS (
              SELECT 1 FROM task_evidence evidence
               WHERE evidence.event_id = version.event_id
                 AND evidence.file_asset_id = version.asset_id
                 AND evidence.task_id = ?
                 AND CASE WHEN json_valid(evidence.evidence_json)
                       THEN json_extract(evidence.evidence_json, '$.fileVersionId')
                     END = version.id
            )
            AND NOT EXISTS (
              SELECT 1 FROM task_instances task
               WHERE task.id = ? AND task.event_id = version.event_id
                 AND CASE WHEN json_valid(task.evidence_json)
                       THEN json_extract(task.evidence_json, '$.fileAssetId')
                     END = version.asset_id
                 AND CASE WHEN json_valid(task.evidence_json)
                       THEN json_extract(task.evidence_json, '$.fileVersionId')
                     END = version.id
            )`,
      ).bind(
        cleanupError,
        upload.versionId,
        viewer.eventId,
        upload.assetId,
        viewer.personId,
        taskId,
        sessionDeliverable ? 1 : 0,
        viewer.personId,
        taskId,
        taskId,
      ),
      this.env.DB.prepare(
        `UPDATE file_assets AS asset
            SET current_version_id = CASE
                  WHEN current_version_id = ? THEN (
                    SELECT retained.id
                      FROM file_versions retained
                     WHERE retained.event_id = asset.event_id
                       AND retained.asset_id = asset.id
                       AND retained.id <> ? AND retained.deleted_at IS NULL
                       AND retained.upload_status = 'uploaded'
                       AND retained.signature_status = 'valid'
                       AND retained.scan_status = 'clean'
                       AND retained.released_at IS NOT NULL
                       AND (
                         EXISTS (
                           SELECT 1 FROM task_evidence evidence
                            WHERE evidence.event_id = retained.event_id
                              AND evidence.task_id = asset.target_id
                              AND evidence.file_asset_id = asset.id
                            AND CASE WHEN json_valid(evidence.evidence_json)
                                  THEN json_extract(evidence.evidence_json, '$.fileVersionId')
                                END = retained.id
                         )
                         OR EXISTS (
                           SELECT 1 FROM task_instances task
                            WHERE task.id = asset.target_id
                              AND task.event_id = retained.event_id
                              AND CASE WHEN json_valid(task.evidence_json)
                                    THEN json_extract(task.evidence_json, '$.fileAssetId')
                                  END = asset.id
                              AND CASE WHEN json_valid(task.evidence_json)
                                    THEN json_extract(task.evidence_json, '$.fileVersionId')
                                  END = retained.id
                         )
                       )
                     ORDER BY retained.version_number DESC LIMIT 1
                  )
                  ELSE current_version_id
                END,
                status = CASE
                  WHEN NOT EXISTS (
                    SELECT 1 FROM task_evidence evidence
                     WHERE evidence.event_id = asset.event_id
                       AND evidence.task_id = asset.target_id
                       AND evidence.file_asset_id = asset.id
                  ) AND NOT EXISTS (
                    SELECT 1 FROM task_instances task
                     WHERE task.id = asset.target_id
                       AND task.event_id = asset.event_id
                       AND CASE WHEN json_valid(task.evidence_json)
                             THEN json_extract(task.evidence_json, '$.fileAssetId')
                           END = asset.id
                  ) THEN 'deleted'
                  WHEN current_version_id = ? THEN CASE
                    WHEN EXISTS (
                      SELECT 1 FROM file_versions retained
                       WHERE retained.event_id = asset.event_id
                         AND retained.asset_id = asset.id
                         AND retained.id <> ? AND retained.deleted_at IS NULL
                         AND retained.upload_status = 'uploaded'
                         AND retained.signature_status = 'valid'
                         AND retained.scan_status = 'clean'
                         AND retained.released_at IS NOT NULL
                         AND (
                           EXISTS (
                             SELECT 1 FROM task_evidence evidence
                              WHERE evidence.event_id = retained.event_id
                                AND evidence.task_id = asset.target_id
                                AND evidence.file_asset_id = asset.id
                              AND CASE WHEN json_valid(evidence.evidence_json)
                                    THEN json_extract(evidence.evidence_json, '$.fileVersionId')
                                  END = retained.id
                           )
                           OR EXISTS (
                             SELECT 1 FROM task_instances task
                              WHERE task.id = asset.target_id
                                AND task.event_id = retained.event_id
                                AND CASE WHEN json_valid(task.evidence_json)
                                      THEN json_extract(task.evidence_json, '$.fileAssetId')
                                    END = asset.id
                                AND CASE WHEN json_valid(task.evidence_json)
                                      THEN json_extract(task.evidence_json, '$.fileVersionId')
                                    END = retained.id
                           )
                         )
                    ) THEN 'active' ELSE 'pending' END
                  ELSE status
                END,
                updated_at = unixepoch()
          WHERE asset.id = ? AND asset.event_id = ?
            AND asset.target_type = 'task' AND asset.target_id = ?
            AND (? = 1 OR asset.owner_person_id = ?)
            AND EXISTS (
              SELECT 1 FROM file_versions discarded
               WHERE discarded.id = ? AND discarded.event_id = asset.event_id
                 AND discarded.asset_id = asset.id
                 AND discarded.deleted_at IS NOT NULL
                 AND discarded.scan_error = ?
            )`,
      ).bind(
        upload.versionId,
        upload.versionId,
        upload.versionId,
        upload.versionId,
        upload.assetId,
        viewer.eventId,
        taskId,
        sessionDeliverable ? 1 : 0,
        viewer.personId,
        upload.versionId,
        cleanupError,
      ),
      this.env.DB.prepare(
        `UPDATE file_versions
            SET replaced_at = NULL
          WHERE id = (
            SELECT current_version_id FROM file_assets
             WHERE id = ? AND event_id = ?
          ) AND event_id = ? AND asset_id = ?
            AND EXISTS (
              SELECT 1 FROM file_versions discarded
               WHERE discarded.id = ? AND discarded.event_id = file_versions.event_id
                 AND discarded.asset_id = file_versions.asset_id
                 AND discarded.deleted_at IS NOT NULL
                 AND discarded.scan_error = ?
            )`,
      ).bind(
        upload.assetId,
        viewer.eventId,
        viewer.eventId,
        upload.assetId,
        upload.versionId,
        cleanupError,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', ?, 1, ?, ?, ?, 'file.upload.discarded', 'file_version', ?, ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1
              FROM file_assets asset
              JOIN file_versions version
                ON version.id = ? AND version.asset_id = asset.id
               AND version.event_id = asset.event_id
             WHERE asset.id = ? AND asset.event_id = ?
               AND asset.target_type = 'task' AND asset.target_id = ?
               AND version.deleted_at IS NOT NULL
               AND version.scan_error = ?
          )`,
      ).bind(
        cleanupAuditId,
        origin,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        upload.versionId,
        cleanupOperationId,
        JSON.stringify({
          assetId: upload.assetId,
          taskId,
          reason: "task_submission_changed",
        }),
        upload.versionId,
        upload.assetId,
        viewer.eventId,
        taskId,
        cleanupError,
      ),
      atomicBatchGuardStatement(
        this.env,
        `(EXISTS (
            SELECT 1 FROM file_versions version
             WHERE version.id = ? AND version.event_id = ?
               AND version.deleted_at IS NOT NULL
          ) OR EXISTS (
            SELECT 1 FROM audit_events audit WHERE audit.id = ?
          )) AND NOT (
            EXISTS (
              SELECT 1 FROM file_versions version
               WHERE version.id = ? AND version.event_id = ?
                 AND version.asset_id = ?
                 AND version.upload_status = 'failed'
                 AND version.scan_status = 'failed'
                 AND version.scan_error = ?
                 AND version.released_at IS NULL
                 AND version.deleted_at IS NOT NULL
            ) AND EXISTS (
              SELECT 1 FROM file_assets asset
               WHERE asset.id = ? AND asset.event_id = ?
                 AND asset.target_type = 'task' AND asset.target_id = ?
                 AND (? = 1 OR asset.owner_person_id = ?)
                 AND asset.current_version_id IS NOT ?
            ) AND NOT EXISTS (
              SELECT 1 FROM file_versions current_version
               JOIN file_assets asset
                 ON asset.current_version_id = current_version.id
                AND asset.event_id = current_version.event_id
                AND asset.id = current_version.asset_id
              WHERE asset.id = ? AND asset.event_id = ?
                AND current_version.replaced_at IS NOT NULL
            ) AND (
              EXISTS (
                SELECT 1 FROM task_evidence evidence
                 WHERE evidence.event_id = ? AND evidence.task_id = ?
                   AND evidence.file_asset_id = ?
              ) OR EXISTS (
                SELECT 1 FROM task_instances task
                 WHERE task.id = ? AND task.event_id = ?
                   AND CASE WHEN json_valid(task.evidence_json)
                         THEN json_extract(task.evidence_json, '$.fileAssetId')
                       END = ?
              ) OR EXISTS (
                SELECT 1 FROM file_assets asset
                 WHERE asset.id = ? AND asset.event_id = ?
                   AND asset.status = 'deleted'
              )
            ) AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.organisation_id = ?
                 AND audit.event_id = ? AND audit.actor_person_id = ?
                 AND audit.origin = ?
                 AND audit.action = 'file.upload.discarded'
                 AND audit.entity_type = 'file_version'
                 AND audit.entity_id = ? AND audit.correlation_id = ?
            )
          )`,
        [
          upload.versionId,
          viewer.eventId,
          cleanupAuditId,
          upload.versionId,
          viewer.eventId,
          upload.assetId,
          cleanupError,
          upload.assetId,
          viewer.eventId,
          taskId,
          sessionDeliverable ? 1 : 0,
          viewer.personId,
          upload.versionId,
          upload.assetId,
          viewer.eventId,
          viewer.eventId,
          taskId,
          upload.assetId,
          taskId,
          viewer.eventId,
          upload.assetId,
          upload.assetId,
          viewer.eventId,
          cleanupAuditId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          origin,
          upload.versionId,
          cleanupOperationId,
        ],
      ),
    ]).catch((error: unknown) => {
      if (isAtomicBatchGuardError(error)) {
        throw new FileAccessError(
          "The task upload cleanup could not record its complete discarded state and audit evidence.",
        );
      }
      throw error;
    });
    if ((versionDiscarded.meta.changes ?? 0) !== 1) {
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
      if (!retryable) {
        throw new FileAccessError(
          "The task upload was attached or changed before cleanup.",
        );
      }
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
    upload: StoredUploadReference,
  ) {
    return this.discardUnattachedUpload(viewer, upload, "resource", "admin_ui");
  }

  async discardUnattachedTaskUpload(
    viewer: Viewer,
    upload: StoredUploadReference,
    taskId: string,
  ) {
    return this.discardUnattachedTaskUploadVersion(
      viewer,
      upload,
      taskId,
      "participant_ui",
    );
  }
}
