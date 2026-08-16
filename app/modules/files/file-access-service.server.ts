import { z } from "zod";
import {
  participantAudienceSql,
  participantSpeakerAccessSql,
} from "~/modules/resources/resource-service-shared";
import type { Viewer } from "~/platform/auth/authorize.server";
import { assetKindSchema, safeDownloadName } from "./file-policy";
import { FileAccessError, FileScanPendingError } from "./file-service-errors";
import { FileUploadCleanupService } from "./file-upload-cleanup-service.server";

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

export type StoredUpload = {
  assetId: string;
  versionId: string;
  versionNumber: number;
  scanStatus: "pending";
};

export type ParticipantTaskEvidenceVersion = {
  taskId: string;
  assetId: string;
  versionId: string;
  versionNumber: number;
  filename: string;
  createdAt: number;
  uploadStatus: "requested" | "uploading" | "uploaded" | "failed" | "aborted";
  signatureStatus: "pending" | "valid" | "invalid" | "failed";
  scanStatus: "pending" | "clean" | "infected" | "failed";
  releasedAt: number | null;
  current: boolean;
  latest: boolean;
  downloadAvailable: boolean;
};

const PARTICIPANT_TASK_EVIDENCE_BATCH_SIZE = 200;

export class FileAccessService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private requireBucket() {
    if (!this.env.FILES)
      throw new Error("Required private R2 binding FILES is unavailable.");
    return this.env.FILES;
  }

  private async releasedDownload(
    version: {
      objectKey: string;
      objectEtag: string | null;
      filename: string;
      contentType: string | null;
      assetKind?: string;
    },
    options: { inlineHeadshot?: boolean } = {},
  ) {
    if (!version.contentType?.trim()) {
      throw new Error(
        "The released private file is missing its detected content type.",
      );
    }
    if (
      options.inlineHeadshot &&
      (version.assetKind !== "headshot" ||
        !["image/jpeg", "image/png", "image/webp"].includes(
          version.contentType,
        ))
    ) {
      throw new FileAccessError(
        "Only a validated headshot image can be displayed inline.",
      );
    }
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
        "content-type": version.contentType,
        "content-disposition": `${options.inlineHeadshot ? "inline" : "attachment"}; filename="${safeDownloadName(version.filename)}"`,
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
      return null;
    }
    if (target.targetType === "session") {
      if (target.assetKind === "headshot") {
        throw new FileAccessError(
          "Headshots must be uploaded to the participant profile.",
        );
      }
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
      return null;
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
      return null;
    }
    if (target.targetType === "task") {
      if (target.assetKind !== "task_evidence")
        throw new FileAccessError(
          "Task uploads must be declared as task evidence.",
        );
      const owned = await this.env.DB.prepare(
        `
        SELECT ti.status, ti.task_type AS taskType,
               CASE WHEN json_valid(ti.evidence_json)
                 THEN json_extract(ti.evidence_json, '$.fileAssetId')
               END AS evidenceAssetId,
               CASE WHEN json_valid(ti.evidence_json)
                 THEN json_extract(ti.evidence_json, '$.fileVersionId')
               END AS evidenceVersionId,
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
          evidenceAssetId: string | null;
          evidenceVersionId: string | null;
        }>();
      if (!owned)
        throw new FileAccessError("The task does not belong to this speaker.");
      if (owned.taskType !== "file_upload")
        throw new FileAccessError("This task does not accept file evidence.");
      if (["completed", "waived"].includes(owned.status))
        throw new FileAccessError(
          "Files cannot be uploaded to a completed or waived task.",
        );
      if (!owned.dependenciesComplete)
        throw new FileAccessError(
          "Complete the prerequisite tasks before uploading evidence.",
        );
      if (owned.status !== "submitted") return null;
      if (!owned.evidenceAssetId || !owned.evidenceVersionId) {
        throw new FileAccessError(
          "The submitted file task has missing canonical evidence metadata.",
        );
      }
      const canonical = await this.env.DB.prepare(
        `SELECT asset.id
           FROM file_assets asset
           JOIN file_versions version
             ON version.id = ? AND version.asset_id = asset.id
            AND version.event_id = asset.event_id
           JOIN task_evidence evidence
             ON evidence.event_id = asset.event_id
            AND evidence.task_id = asset.target_id
            AND evidence.file_asset_id = asset.id
            AND evidence.submitted_by_person_id = ?
            AND evidence.status = 'submitted'
            AND CASE WHEN json_valid(evidence.evidence_json)
                  THEN json_extract(evidence.evidence_json, '$.fileVersionId')
                END = version.id
          WHERE asset.id = ? AND asset.event_id = ?
            AND asset.owner_person_id = ? AND asset.target_type = 'task'
            AND asset.target_id = ? AND asset.asset_kind = 'task_evidence'
            AND asset.status <> 'deleted' AND version.deleted_at IS NULL
            AND version.created_by_person_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = 'file-erasure:' || asset.id
            )`,
      )
        .bind(
          owned.evidenceVersionId,
          viewer.personId,
          owned.evidenceAssetId,
          viewer.eventId,
          viewer.personId,
          target.targetId,
          viewer.personId,
        )
        .first<{ id: string }>();
      if (!canonical) {
        throw new FileAccessError(
          "The submitted file task has inconsistent canonical evidence.",
        );
      }
      return canonical.id;
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
    if (target.targetType === "person") {
      if (target.assetKind !== "headshot") {
        throw new FileAccessError(
          "Administrator profile uploads are limited to speaker headshots.",
        );
      }
      const targetExists = await this.env.DB.prepare(
        `SELECT 1
           FROM people person
           JOIN events event ON event.id = ? AND event.organisation_id = ?
          WHERE person.id = ?
            AND (
              EXISTS (
                SELECT 1 FROM session_speakers speaker
                 WHERE speaker.event_id = event.id
                   AND speaker.person_id = person.id
              )
              OR EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.event_id = event.id
                   AND membership.person_id = person.id
                   AND membership.role = 'speaker'
                   AND membership.accepted_at IS NOT NULL
                   AND membership.revoked_at IS NULL
              )
              OR EXISTS (
                SELECT 1 FROM event_speaker_workflows workflow
                 WHERE workflow.event_id = event.id
                   AND workflow.person_id = person.id
                   AND workflow.status IN ('prospect','invited','confirmed')
              )
            )`,
      )
        .bind(viewer.eventId, viewer.organisationId, target.targetId)
        .first();
      if (!targetExists) {
        throw new FileAccessError(
          "Speaker upload target not found in this event.",
        );
      }
      return;
    }
    const table =
      target.targetType === "resource"
        ? "resource_pages"
        : target.targetType === "submission"
          ? "submissions"
          : target.targetType === "session"
            ? "sessions"
            : "task_instances";
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

  async discardUnattachedResourceUpload(
    viewer: Viewer,
    upload: Pick<StoredUpload, "assetId" | "versionId">,
  ) {
    return new FileUploadCleanupService(
      this.env,
    ).discardUnattachedResourceUpload(viewer, upload);
  }

  async discardUnattachedTaskUpload(
    viewer: Viewer,
    upload: Pick<StoredUpload, "assetId" | "versionId">,
    taskId: string,
  ) {
    return new FileUploadCleanupService(this.env).discardUnattachedTaskUpload(
      viewer,
      upload,
      taskId,
    );
  }

  async participantDownload(
    viewer: Viewer,
    assetId: string,
    options: { inlineHeadshot?: boolean } = {},
  ) {
    const version = await this.env.DB.prepare(
      `
      SELECT fv.object_key AS objectKey, fv.original_filename AS filename,
             fv.detected_content_type AS contentType,
             fv.object_etag AS objectEtag, fa.asset_kind AS assetKind
        FROM file_assets fa
        JOIN file_versions fv ON fv.id = fa.current_version_id
         AND fv.event_id = fa.event_id AND fv.asset_id = fa.id
       WHERE fa.id = ? AND fa.event_id = ? AND fa.owner_person_id = ?
         AND (? = 0 OR (fa.target_type = 'person' AND fa.target_id = ?))
         AND fa.status = 'active'
         AND fv.upload_status = 'uploaded' AND fv.signature_status = 'valid'
         AND fv.scan_status = 'clean' AND fv.released_at IS NOT NULL AND fv.deleted_at IS NULL
    `,
    )
      .bind(
        assetId,
        viewer.eventId,
        viewer.personId,
        options.inlineHeadshot ? 1 : 0,
        viewer.personId,
      )
      .first<{
        objectKey: string;
        objectEtag: string | null;
        filename: string;
        contentType: string | null;
        assetKind: string;
      }>();
    if (!version) throw new FileScanPendingError();
    return this.releasedDownload(version, options);
  }

  async administratorSpeakerFileDownload(
    viewer: Viewer,
    personId: string,
    assetId: string,
    options: { inlineHeadshot?: boolean } = {},
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
             version.detected_content_type AS contentType,
             asset.asset_kind AS assetKind
        FROM file_assets asset
        JOIN events event
          ON event.id = asset.event_id AND event.organisation_id = ?
        JOIN file_versions version
          ON version.id = asset.current_version_id
         AND version.event_id = asset.event_id
         AND version.asset_id = asset.id
       WHERE asset.id = ? AND asset.event_id = ?
         AND asset.owner_person_id = ?
         AND (? = 0 OR (asset.target_type = 'person' AND asset.target_id = ?))
         AND asset.status = 'active'
         AND version.upload_status = 'uploaded'
         AND version.signature_status = 'valid'
         AND version.scan_status = 'clean'
         AND version.released_at IS NOT NULL AND version.deleted_at IS NULL
         AND (
           EXISTS (
             SELECT 1 FROM session_speakers link
              WHERE link.event_id = asset.event_id
                AND link.person_id = asset.owner_person_id
           )
           OR EXISTS (
             SELECT 1 FROM memberships membership
              WHERE membership.event_id = asset.event_id
                AND membership.person_id = asset.owner_person_id
                AND membership.role = 'speaker'
                AND membership.accepted_at IS NOT NULL
                AND membership.revoked_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM event_speaker_workflows workflow
              WHERE workflow.event_id = event.id
                AND workflow.person_id = asset.owner_person_id
                AND workflow.status IN ('prospect','invited','confirmed')
           )
         )
       LIMIT 1
    `,
    )
      .bind(
        viewer.organisationId,
        assetId,
        viewer.eventId,
        personId,
        options.inlineHeadshot ? 1 : 0,
        personId,
      )
      .first<{
        objectKey: string;
        objectEtag: string | null;
        filename: string;
        contentType: string | null;
        assetKind: string;
      }>();
    if (!version) {
      throw new FileAccessError(
        "The speaker file is unavailable, quarantined or outside this event.",
      );
    }
    return this.releasedDownload(version, options);
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
         AND CASE WHEN json_valid(evidence.evidence_json)
               THEN json_extract(evidence.evidence_json, '$.fileVersionId')
             END = version.id
        JOIN task_instances task
          ON task.id = evidence.task_id AND task.event_id = evidence.event_id
         AND asset.target_type = 'task' AND asset.target_id = task.id
       WHERE asset.id = ? AND asset.event_id = ? AND asset.status = 'active'
         AND evidence.status IN ('submitted','approved','superseded')
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

  async participantTaskEvidenceDownload(
    viewer: Viewer,
    assetId: string,
    versionId: string,
  ) {
    const version = await this.env.DB.prepare(
      `SELECT version.object_key AS objectKey,
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
           ON evidence.file_asset_id = asset.id
          AND evidence.event_id = asset.event_id
          AND evidence.task_id = asset.target_id
          AND evidence.submitted_by_person_id = ?
          AND evidence.status IN ('submitted','approved','superseded')
          AND CASE WHEN json_valid(evidence.evidence_json)
                THEN json_extract(evidence.evidence_json, '$.fileVersionId')
              END = version.id
         JOIN task_instances task
           ON task.id = evidence.task_id AND task.event_id = evidence.event_id
        WHERE asset.id = ? AND asset.event_id = ?
          AND asset.owner_person_id = ? AND asset.status = 'active'
          AND asset.target_type = 'task' AND asset.target_id = task.id
          AND asset.asset_kind = 'task_evidence'
          AND version.created_by_person_id = ?
          AND version.upload_status = 'uploaded'
          AND version.signature_status = 'valid'
          AND version.scan_status = 'clean'
          AND version.released_at IS NOT NULL AND version.deleted_at IS NULL
          AND (
            task.owner_person_id = ?
            OR (task.target_type = 'speaker' AND task.target_id = ?)
            OR (task.target_type = 'session' AND EXISTS (
              SELECT 1 FROM session_speakers relation
               WHERE relation.event_id = task.event_id
                 AND relation.session_id = task.target_id
                 AND relation.person_id = ?
            ))
          )
        LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        versionId,
        viewer.personId,
        assetId,
        viewer.eventId,
        viewer.personId,
        viewer.personId,
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
    if (!version) {
      throw new FileAccessError(
        "The task evidence version is unavailable, quarantined or outside your tasks.",
      );
    }
    return this.releasedDownload(version);
  }

  async listParticipantTaskEvidenceVersions(
    viewer: Viewer,
    taskIds: string[],
  ): Promise<ParticipantTaskEvidenceVersion[]> {
    if (!taskIds.length) return [];
    if (taskIds.some((taskId) => !taskId || taskId.length > 160)) {
      throw new FileAccessError("The requested task evidence list is invalid.");
    }
    const uniqueTaskIds = [...new Set(taskIds)];
    const versions: Array<
      Omit<
        ParticipantTaskEvidenceVersion,
        "current" | "latest" | "downloadAvailable"
      > & {
        current: number;
        latest: number;
        downloadAvailable: number;
      }
    > = [];
    for (
      let offset = 0;
      offset < uniqueTaskIds.length;
      offset += PARTICIPANT_TASK_EVIDENCE_BATCH_SIZE
    ) {
      const taskIdBatch = uniqueTaskIds.slice(
        offset,
        offset + PARTICIPANT_TASK_EVIDENCE_BATCH_SIZE,
      );
      const batch = await this.env.DB.prepare(
        `WITH ranked_versions AS (
        SELECT asset.target_id AS taskId, asset.id AS assetId,
               version.id AS versionId, version.version_number AS versionNumber,
               version.original_filename AS filename,
               version.created_at AS createdAt,
               version.upload_status AS uploadStatus,
               version.signature_status AS signatureStatus,
               version.scan_status AS scanStatus,
               version.released_at AS releasedAt,
               version.id = asset.current_version_id AS current,
               ROW_NUMBER() OVER (
                 PARTITION BY asset.id ORDER BY version.version_number DESC, version.id
               ) AS position
          FROM file_assets asset
          JOIN file_versions version
            ON version.asset_id = asset.id AND version.event_id = asset.event_id
         WHERE asset.event_id = ? AND asset.owner_person_id = ?
           AND asset.target_type = 'task' AND asset.asset_kind = 'task_evidence'
           AND asset.status <> 'deleted' AND version.deleted_at IS NULL
           AND asset.target_id IN (
             SELECT CAST(value AS TEXT) FROM json_each(?)
           )
           AND EXISTS (
             SELECT 1 FROM task_evidence evidence
              WHERE evidence.event_id = asset.event_id
                AND evidence.task_id = asset.target_id
                AND evidence.file_asset_id = asset.id
                AND evidence.submitted_by_person_id = ?
                AND CASE WHEN json_valid(evidence.evidence_json)
                      THEN json_extract(evidence.evidence_json, '$.fileVersionId')
                    END = version.id
           )
      )
      SELECT taskId, assetId, versionId, versionNumber, filename, createdAt,
             uploadStatus, signatureStatus, scanStatus, releasedAt,
             current, position = 1 AS latest,
             EXISTS (
               SELECT 1 FROM file_versions downloadable
                WHERE downloadable.id = ranked_versions.versionId
                  AND downloadable.event_id = ?
                  AND downloadable.asset_id = ranked_versions.assetId
                  AND downloadable.upload_status = 'uploaded'
                  AND downloadable.signature_status = 'valid'
                  AND downloadable.scan_status = 'clean'
                  AND downloadable.released_at IS NOT NULL
                  AND downloadable.deleted_at IS NULL
             ) AS downloadAvailable
       FROM ranked_versions
       ORDER BY taskId, versionNumber DESC, versionId`,
      )
        .bind(
          viewer.eventId,
          viewer.personId,
          JSON.stringify(taskIdBatch),
          viewer.personId,
          viewer.eventId,
        )
        .all<(typeof versions)[number]>();
      versions.push(...batch.results);
    }
    versions.sort((left, right) => {
      if (left.taskId !== right.taskId)
        return left.taskId < right.taskId ? -1 : 1;
      if (left.versionNumber !== right.versionNumber)
        return right.versionNumber - left.versionNumber;
      if (left.versionId === right.versionId) return 0;
      return left.versionId < right.versionId ? -1 : 1;
    });
    return versions.map((version) => ({
      ...version,
      current: version.current === 1,
      latest: version.latest === 1,
      downloadAvailable: version.downloadAvailable === 1,
    }));
  }

  async participantResourceDownload(viewer: Viewer, assetId: string) {
    const audienceSql = participantAudienceSql(
      "participant.person_id",
      "rv",
      participantSpeakerAccessSql("participant.person_id", "participant.role"),
    );
    const version = await this.env.DB.prepare(
      `
      SELECT fv.object_key AS objectKey, fv.original_filename AS filename,
             fv.detected_content_type AS contentType,
             fv.object_etag AS objectEtag
        FROM resource_attachments ra
        JOIN resource_page_versions rv ON rv.id = ra.resource_page_version_id AND rv.event_id = ra.event_id AND rv.status = 'published'
        JOIN resource_pages rp ON rp.id = rv.resource_page_id AND rp.event_id = rv.event_id AND rp.status = 'published'
        CROSS JOIN (SELECT ? AS person_id, ? AS role) participant
        JOIN file_assets fa ON fa.id = ra.file_asset_id AND fa.event_id = ra.event_id AND fa.status = 'active'
        JOIN file_versions fv ON fv.id = fa.current_version_id
         AND fv.event_id = fa.event_id AND fv.asset_id = fa.id
       WHERE fa.id = ? AND fa.event_id = ?
         AND fv.upload_status = 'uploaded' AND fv.signature_status = 'valid'
         AND fv.scan_status = 'clean' AND fv.released_at IS NOT NULL AND fv.deleted_at IS NULL
         AND ${audienceSql}
       LIMIT 1
    `,
    )
      .bind(viewer.personId, viewer.role, assetId, viewer.eventId)
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
