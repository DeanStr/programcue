import { z } from "zod";
import { invalidateContentZipExportsForAsset } from "~/modules/content/content-archive-service.server";
import {
  headshotProfileRevisionGuardStatement,
  headshotProfileRevisionStatement,
} from "~/modules/speakers/speaker-profile-revision.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  FileAccessError,
  FileErasureConfirmationError,
  FileErasureIncompleteError,
  FileRetentionStateError,
  isMissingR2MultipartUpload,
} from "./file-service-errors";

export type FileErasureInput = {
  assetId: string;
  confirmed: boolean;
  reason?: string;
  enforceEventRetentionBoundary?: boolean;
};

type FileErasurePreview = {
  id: string;
  targetType: string;
  targetId: string;
  assetKind: string;
  releasedHeadshotVersionId: string | null;
  versionCount: number;
  resourceAttachmentCount: number;
  taskEvidenceCount: number;
};

type ErasureVersion = {
  objectKey: string;
  uploadId: string | null;
  multipartStatus: string | null;
};

export class FileLifecycleService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private requireBucket() {
    if (!this.env.FILES)
      throw new Error("Required private R2 binding FILES is unavailable.");
    return this.env.FILES;
  }

  private async fileErasurePreview(viewer: Viewer, assetId: string) {
    const preview = await this.env.DB.prepare(
      `
      SELECT asset.id, asset.target_type AS targetType,
             asset.target_id AS targetId, asset.asset_kind AS assetKind,
             asset.owner_person_id AS ownerPersonId, asset.status,
             (
               SELECT version.id FROM file_versions version
                WHERE asset.target_type = 'person'
                  AND asset.asset_kind = 'headshot'
                  AND version.id = asset.current_version_id
                  AND version.event_id = asset.event_id
                  AND version.asset_id = asset.id
                  AND version.upload_status = 'uploaded'
                  AND version.signature_status = 'valid'
                  AND version.scan_status = 'clean'
                  AND version.released_at IS NOT NULL
                  AND version.deleted_at IS NULL
             ) AS releasedHeadshotVersionId,
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
        releasedHeadshotVersionId: string | null;
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

  private async revokeAssetForErasure(
    viewer: Viewer,
    input: FileErasureInput,
    preview: FileErasurePreview,
    operationId: string,
  ) {
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
    const results = await this.env.DB.batch([
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
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'file.erasure.requested',
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
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type,
           correlation_id, created_at
         )
         SELECT ?, 'file_asset', ?, 'deleted', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM audit_events audit
             WHERE audit.id = ? AND audit.organisation_id = ?
               AND audit.event_id = ?
               AND audit.action = 'file.erasure.requested'
               AND audit.entity_id = ?
          )
            AND NOT EXISTS (
              SELECT 1 FROM event_changes change
               WHERE change.event_id = ?
                 AND change.entity_type = 'file_asset'
                 AND change.entity_id = ?
                 AND change.correlation_id = ?
            )
         RETURNING sequence`,
      ).bind(
        viewer.eventId,
        preview.id,
        operationId,
        operationId,
        viewer.organisationId,
        viewer.eventId,
        preview.id,
        viewer.eventId,
        preview.id,
        operationId,
      ),
      this.env.DB.prepare(
        `SELECT change.sequence
           FROM event_changes change
           JOIN events event
             ON event.id = change.event_id AND event.organisation_id = ?
          WHERE change.event_id = ?
            AND change.entity_type = 'file_asset'
            AND change.entity_id = ?
            AND change.correlation_id = ?
          ORDER BY change.sequence DESC
          LIMIT 1`,
      ).bind(viewer.organisationId, viewer.eventId, preview.id, operationId),
    ]);
    const [assetRevoked] = results;
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
    const change = results.at(-1)?.results[0] as
      | { sequence: number }
      | undefined;
    if (!change || !Number.isSafeInteger(change.sequence)) {
      throw new Error(
        "The committed file erasure change cursor was not recorded.",
      );
    }
    return change.sequence;
  }

  private async eraseAssetProviderState(
    viewer: Viewer,
    preview: FileErasurePreview,
    operationId: string,
    versions: { results: ErasureVersion[] },
  ) {
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
          "One or more incomplete uploads could not be cleared.",
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
             id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           ) VALUES (?, 'person', ?, 1, ?, ?, ?, 'file.erasure.completed',
                     'file_asset', ?, ?, ?, unixepoch())`,
        ).bind(
          `file-erasure-complete:${preview.id}`,
          ["owner", "administrator"].includes(viewer.role)
            ? "admin_ui"
            : "participant_ui",
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          preview.id,
          operationId,
          JSON.stringify({ erasedVersions: versions.results.length }),
        ),
        headshotProfileRevisionStatement(this.env, {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          assetId: preview.id,
          headshotFileVersionId: null,
          recordedByPersonId: viewer.personId,
          correlationId: operationId,
          enabled: preview.releasedHeadshotVersionId !== null,
        }),
        headshotProfileRevisionGuardStatement(this.env, {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          assetId: preview.id,
          headshotFileVersionId: null,
          recordedByPersonId: viewer.personId,
          correlationId: operationId,
          enabled: preview.releasedHeadshotVersionId !== null,
        }),
      ]);
      await invalidateContentZipExportsForAsset(this.env, {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        assetId: preview.id,
      });
    } catch (error) {
      throw new FileErasureIncompleteError(operationId, { cause: error });
    }
  }

  async eraseAsset(viewer: Viewer, input: FileErasureInput) {
    if (!input.confirmed) throw new FileErasureConfirmationError();
    const preview = await this.fileErasurePreview(viewer, input.assetId);
    const operationId = `file-erasure:${preview.id}`;
    if (preview.erasureComplete) {
      await invalidateContentZipExportsForAsset(this.env, {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        assetId: preview.id,
      });
      return {
        operationId,
        duplicate: true,
        erasedVersions: preview.versionCount,
        affected: preview,
        changeSequence: null,
      };
    }
    const changeSequence = await this.revokeAssetForErasure(
      viewer,
      input,
      preview,
      operationId,
    );
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
      .all<ErasureVersion>();
    await this.eraseAssetProviderState(viewer, preview, operationId, versions);
    return {
      operationId,
      duplicate: false,
      erasedVersions: versions.results.length,
      affected: preview,
      changeSequence,
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
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, ?, 'event', ?, ?, unixepoch()
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
}
