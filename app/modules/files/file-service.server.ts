import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  assetKindSchema,
  detectContentType,
  safeDownloadName,
  validateFileDeclaration,
  validateFileSignature,
  type AssetKind,
} from "./file-policy";

const uploadTargetSchema = z.object({
  targetType: z.enum(["person", "session", "task", "resource"]),
  targetId: z.string().min(1).max(160),
  assetKind: assetKindSchema,
});

type UploadTarget = z.infer<typeof uploadTargetSchema>;

async function stableLogicalAssetId(
  viewer: Pick<Viewer, "eventId" | "personId">,
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

  private async assertParticipantTarget(viewer: Viewer, target: UploadTarget) {
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
    if (target.targetType === "task") {
      const owned = await this.env.DB.prepare(
        `
        SELECT ti.status FROM task_instances ti
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
        .first<{ status: string }>();
      if (!owned)
        throw new FileAccessError("The task does not belong to this speaker.");
      if (["completed", "waived"].includes(owned.status))
        throw new FileAccessError(
          "Files cannot be uploaded to a completed or waived task.",
        );
      return;
    }
    throw new FileAccessError("Speakers cannot upload resource attachments.");
  }

  private async assertAdminTarget(viewer: Viewer, target: UploadTarget) {
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

  private async store(
    viewer: Viewer,
    target: UploadTarget,
    file: File,
  ): Promise<StoredUpload> {
    validateFileDeclaration(target.assetKind, file);
    const bucket = this.requireBucket();
    const existing = ["task", "resource"].includes(target.targetType)
      ? null
      : await this.env.DB.prepare(
          `
          SELECT id FROM file_assets
           WHERE event_id = ? AND owner_person_id IS ? AND target_type = ? AND target_id = ? AND asset_kind = ? AND status <> 'deleted'
           ORDER BY created_at DESC LIMIT 1
        `,
        )
          .bind(
            viewer.eventId,
            viewer.personId,
            target.targetType,
            target.targetId,
            target.assetKind,
          )
          .first<{ id: string }>();
    const assetId =
      existing?.id ??
      (["task", "resource"].includes(target.targetType)
        ? crypto.randomUUID()
        : await stableLogicalAssetId(viewer, target));
    const versionId = crypto.randomUUID();
    const objectKey = `private/events/${viewer.eventId}/${target.targetType}/${target.targetId}/${assetId}/${versionId}`;

    const allocation = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO file_assets (
          id, event_id, owner_person_id, target_type, target_id, asset_kind, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', unixepoch(), unixepoch())
      `,
      ).bind(
        assetId,
        viewer.eventId,
        target.targetType === "resource" ? null : viewer.personId,
        target.targetType,
        target.targetId,
        target.assetKind,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO file_versions (
          id, event_id, asset_id, version_number, object_key, original_filename,
          declared_content_type, size_bytes, upload_status, signature_status, scan_status,
          created_by_person_id, created_at
        )
        SELECT ?, ?, ?, COALESCE(MAX(version_number), 0) + 1, ?, ?, ?, ?,
               'requested', 'pending', 'pending', ?, unixepoch()
          FROM file_versions
         WHERE asset_id = ?
        RETURNING version_number AS versionNumber
      `,
      ).bind(
        versionId,
        viewer.eventId,
        assetId,
        objectKey,
        file.name,
        file.type.toLowerCase(),
        file.size,
        viewer.personId,
        assetId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'file.upload.requested', 'file_version', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM file_versions
            WHERE id = ? AND event_id = ? AND asset_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        versionId,
        JSON.stringify({
          assetId,
          assetKind: target.assetKind,
          sizeBytes: file.size,
        }),
        versionId,
        viewer.eventId,
        assetId,
      ),
    ]);
    const allocatedVersion = allocation[1]?.results?.[0] as
      { versionNumber?: number } | undefined;
    const versionNumber = Number(allocatedVersion?.versionNumber);
    if (!Number.isSafeInteger(versionNumber) || versionNumber < 1) {
      throw new Error("The file version could not be allocated atomically.");
    }

    let detected: string | null = null;
    try {
      detected = await detectContentType(file);
      validateFileSignature(target.assetKind, file, detected);
    } catch (error) {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `
          UPDATE file_versions
             SET upload_status = 'failed', signature_status = 'invalid', scan_status = 'failed',
                 scan_error = 'Signature validation failed before quarantine.', detected_content_type = ?
           WHERE id = ? AND event_id = ?
        `,
        ).bind(detected, versionId, viewer.eventId),
        this.env.DB.prepare(
          "UPDATE file_assets SET status = CASE WHEN current_version_id IS NULL THEN 'rejected' ELSE status END, updated_at = unixepoch() WHERE id = ? AND event_id = ?",
        ).bind(assetId, viewer.eventId),
      ]);
      throw error;
    }

    let object: R2Object;
    try {
      object = await bucket.put(objectKey, file.stream(), {
        httpMetadata: { contentType: detected ?? file.type },
        customMetadata: {
          eventId: viewer.eventId,
          assetId,
          versionId,
          quarantine: "pending-scan",
        },
      });
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE file_versions
            SET upload_status = 'failed', signature_status = 'valid', scan_status = 'failed',
                scan_error = 'Private R2 upload failed before quarantine.'
          WHERE id = ? AND event_id = ?`,
      )
        .bind(versionId, viewer.eventId)
        .run();
      throw new Error(
        `Private R2 upload failed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }

    try {
      const [recorded] = await this.env.DB.batch([
        this.env.DB.prepare(
          `
          UPDATE file_versions
             SET upload_status = 'uploaded', signature_status = 'valid', detected_content_type = ?,
                 object_etag = ?, uploaded_at = unixepoch()
           WHERE id = ? AND event_id = ? AND upload_status = 'requested'
        `,
        ).bind(detected, object.httpEtag, versionId, viewer.eventId),
        this.env.DB.prepare(
          "UPDATE file_assets SET updated_at = unixepoch() WHERE id = ? AND event_id = ?",
        ).bind(assetId, viewer.eventId),
        this.env.DB.prepare(
          `
          INSERT INTO audit_events (
            id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, 'file.upload.quarantined', 'file_version', ?, ?, unixepoch())
        `,
        ).bind(
          crypto.randomUUID(),
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          versionId,
          JSON.stringify({ assetId, scanStatus: "pending" }),
        ),
      ]);
      if ((recorded.meta.changes ?? 0) !== 1) {
        throw new Error(
          "The quarantined file metadata changed before it was recorded.",
        );
      }
    } catch (error) {
      const failures: unknown[] = [error];
      try {
        await bucket.delete(objectKey);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      try {
        await this.env.DB.prepare(
          `UPDATE file_versions
              SET upload_status = 'failed', signature_status = 'valid', scan_status = 'failed',
                  scan_error = 'Quarantined R2 object removed after metadata commit failure.'
            WHERE id = ? AND event_id = ?`,
        )
          .bind(versionId, viewer.eventId)
          .run();
      } catch (stateError) {
        failures.push(stateError);
      }
      if (failures.length > 1) {
        throw new AggregateError(
          failures,
          "File metadata commit failed and upload cleanup did not complete.",
        );
      }
      throw new Error(
        `File metadata commit failed after the stored R2 object was removed: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
    return { assetId, versionId, versionNumber, scanStatus: "pending" };
  }

  async uploadParticipantFile(viewer: Viewer, rawTarget: unknown, file: File) {
    const target = uploadTargetSchema.parse(rawTarget);
    await this.assertParticipantTarget(viewer, target);
    return this.store(viewer, target, file);
  }

  async uploadAdminFile(viewer: Viewer, rawTarget: unknown, file: File) {
    const target = uploadTargetSchema.parse(rawTarget);
    await this.assertAdminTarget(viewer, target);
    return this.store(viewer, target, file);
  }

  private async discardUnattachedUpload(
    viewer: Viewer,
    upload: Pick<StoredUpload, "assetId" | "versionId">,
    targetType: "resource" | "task",
  ) {
    const row = await this.env.DB.prepare(
      `
      SELECT fv.object_key AS objectKey
        FROM file_assets fa
        JOIN file_versions fv
          ON fv.id = ? AND fv.asset_id = fa.id AND fv.event_id = fa.event_id
       WHERE fa.id = ? AND fa.event_id = ? AND fa.target_type = ?
         AND fv.created_by_person_id = ?
    `,
    )
      .bind(
        upload.versionId,
        upload.assetId,
        viewer.eventId,
        targetType,
        viewer.personId,
      )
      .first<{ objectKey: string }>();
    if (!row)
      throw new FileAccessError(
        `The unlinked ${targetType} upload could not be identified for cleanup.`,
      );

    const cleanupOperationId = crypto.randomUUID();
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
        targetType === "resource"
          ? "Resource draft changed before attachment."
          : "Task changed before evidence submission.",
        upload.versionId,
        viewer.eventId,
        upload.assetId,
        upload.assetId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'file.upload.discarded', 'file_version', ?, ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM file_assets
            WHERE id = ? AND event_id = ? AND status = 'deleted'
         )
      `,
      ).bind(
        crypto.randomUUID(),
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
        upload.assetId,
        viewer.eventId,
      ),
    ]);
    if ((assetDeleted.meta.changes ?? 0) !== 1) {
      throw new FileAccessError(
        `The ${targetType} upload was linked or changed before cleanup.`,
      );
    }
    await this.requireBucket().delete(row.objectKey);
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
  ) {
    return this.discardUnattachedUpload(viewer, upload, "task");
  }

  async recordScanResult(input: {
    eventId: string;
    versionId: string;
    provider: string;
    clean: boolean;
    result: unknown;
  }) {
    const row = await this.env.DB.prepare(
      `
      SELECT fv.id, fv.asset_id AS assetId, fv.upload_status AS uploadStatus,
             fv.signature_status AS signatureStatus
        FROM file_versions fv JOIN file_assets fa ON fa.id = fv.asset_id AND fa.event_id = fv.event_id
       WHERE fv.id = ? AND fv.event_id = ?
    `,
    )
      .bind(input.versionId, input.eventId)
      .first<{
        id: string;
        assetId: string;
        uploadStatus: string;
        signatureStatus: string;
      }>();
    if (!row) throw new Error("File version not found.");
    if (row.uploadStatus !== "uploaded" || row.signatureStatus !== "valid")
      throw new Error(
        "Only a completely uploaded, signature-valid version can be scanned.",
      );
    const nowClean = input.clean ? "clean" : "infected";
    const scanOperationId = crypto.randomUUID();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE file_versions SET scan_status = ?, scan_provider = ?, scan_result_json = ?, scanned_at = unixepoch(),
          released_at = CASE WHEN ? = 'clean' THEN unixepoch() ELSE NULL END
         WHERE id = ? AND event_id = ? AND scan_status = 'pending'
      `,
      ).bind(
        nowClean,
        input.provider,
        JSON.stringify(input.result),
        nowClean,
        row.id,
        input.eventId,
      ),
      this.env.DB.prepare(
        `
        UPDATE task_instances AS task
           SET status = 'in_progress', readiness_state = 'at_risk', readiness_percent = 40,
               evidence_json = json_set(task.evidence_json, '$.scanStatus', 'infected'),
               submitted_at = NULL, completed_at = NULL, completed_by_person_id = NULL,
               revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE task.event_id = ? AND task.status = 'submitted' AND ? = 'infected'
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
                AND version.id = ? AND version.scan_status = 'infected'
           )
      `,
      ).bind(scanOperationId, input.eventId, nowClean, row.assetId, row.id),
      this.env.DB.prepare(
        `
        UPDATE task_evidence AS evidence
           SET status = 'rejected', reviewed_at = unixepoch()
         WHERE evidence.event_id = ? AND evidence.status = 'submitted'
           AND evidence.file_asset_id = ? AND ? = 'infected'
           AND json_extract(evidence.evidence_json, '$.fileVersionId') = ?
           AND EXISTS (
             SELECT 1 FROM file_versions version
              WHERE version.id = ? AND version.event_id = evidence.event_id
                AND version.asset_id = evidence.file_asset_id
                AND version.scan_status = 'infected'
           )
      `,
      ).bind(input.eventId, row.assetId, nowClean, row.id, row.id),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, event.organisation_id, task.event_id, ?, 'task.file.rejected',
               'task_instance', task.id, ?, ?, unixepoch()
          FROM task_instances task
          JOIN events event ON event.id = task.event_id
         WHERE task.event_id = ? AND task.last_operation_id = ?
      `,
      ).bind(
        crypto.randomUUID(),
        `scanner:${input.provider}`,
        scanOperationId,
        JSON.stringify({
          assetId: row.assetId,
          versionId: row.id,
          verdict: "infected",
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
        nowClean,
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
        nowClean,
        row.id,
        nowClean,
        row.assetId,
        input.eventId,
        row.id,
        nowClean,
        nowClean,
      ),
    ]);
  }

  async participantDownload(viewer: Viewer, assetId: string) {
    const version = await this.env.DB.prepare(
      `
      SELECT fv.object_key AS objectKey, fv.original_filename AS filename,
             fv.detected_content_type AS contentType
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
        filename: string;
        contentType: string | null;
      }>();
    if (!version) throw new FileScanPendingError();
    const object = await this.requireBucket().get(version.objectKey);
    if (!object) throw new Error("The released R2 object is missing.");
    return new Response(object.body, {
      headers: {
        "content-type": version.contentType ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${safeDownloadName(version.filename)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
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
        filename: string;
        contentType: string | null;
      }>();
    if (!version)
      throw new FileAccessError(
        "The task evidence is unavailable, quarantined or outside this event.",
      );
    const object = await this.requireBucket().get(version.objectKey);
    if (!object) throw new Error("The released R2 object is missing.");
    return new Response(object.body, {
      headers: {
        "content-type": version.contentType ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${safeDownloadName(version.filename)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async participantResourceDownload(viewer: Viewer, assetId: string) {
    const version = await this.env.DB.prepare(
      `
      SELECT fv.object_key AS objectKey, fv.original_filename AS filename,
             fv.detected_content_type AS contentType
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
        filename: string;
        contentType: string | null;
      }>();
    if (!version)
      throw new FileAccessError(
        "The resource attachment is unavailable or outside your audience.",
      );
    const object = await this.requireBucket().get(version.objectKey);
    if (!object) throw new Error("The released R2 object is missing.");
    return new Response(object.body, {
      headers: {
        "content-type": version.contentType ?? "application/octet-stream",
        "content-disposition": `attachment; filename="${safeDownloadName(version.filename)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
