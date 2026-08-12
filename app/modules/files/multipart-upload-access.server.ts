import { FileMultipartStateError } from "./multipart-upload-errors";
import { parseEventFilePolicy } from "./file-policy";
import { FileAccessError } from "./file-service-errors";
import type {
  ApplicantMultipartActor,
  MultipartActor,
  MultipartRow,
} from "./multipart-upload-contracts";

export type { ApplicantMultipartActor } from "./multipart-upload-contracts";

export function isApplicantActor(
  actor: MultipartActor,
): actor is ApplicantMultipartActor {
  return "kind" in actor && actor.kind === "applicant";
}

export function multipartIdempotencyKey(actor: MultipartActor, key: string) {
  const identity = isApplicantActor(actor)
    ? `applicant:${actor.submissionId}`
    : actor.personId;
  return `${identity}:${key}`;
}

export class MultipartUploadAccessRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

  async loadEventFilePolicy(actor: MultipartActor) {
    const event = await this.env.DB.prepare(
      `SELECT file_policy_json AS filePolicyJson
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(actor.eventId, actor.organisationId)
      .first<{ filePolicyJson: string }>();
    if (!event) throw new FileAccessError("Event file policy not found.");
    return parseEventFilePolicy(event.filePolicyJson);
  }

  async loadByIdempotency(actor: MultipartActor, idempotencyKey: string) {
    const row = await this.env.DB.prepare(
      `
    SELECT upload.version_id AS versionId, upload.event_id AS eventId,
           event.organisation_id AS organisationId,
           upload.asset_id AS assetId, asset.asset_kind AS assetKind,
           asset.target_type AS targetType, asset.target_id AS targetId,
           asset.owner_person_id AS ownerPersonId,
           asset.status AS assetStatus,
           EXISTS (
             SELECT 1 FROM audit_events audit
              WHERE audit.id = 'file-erasure:' || asset.id
           ) AS erasureRequested,
           version.created_by_person_id AS createdByPersonId,
           version.object_key AS objectKey,
           version.original_filename AS filename,
           version.declared_content_type AS contentType,
           version.detected_content_type AS detectedContentType,
           version.size_bytes AS sizeBytes, version.object_etag AS objectEtag,
           version.upload_status AS uploadStatus,
           version.signature_status AS signatureStatus,
           version.scan_status AS scanStatus,
           version.deleted_at AS versionDeletedAt,
           upload.upload_id AS uploadId,
           upload.idempotency_key AS idempotencyKey,
           upload.status, upload.part_size_bytes AS partSizeBytes,
           upload.manifest_json AS manifestJson,
           upload.manifest_hash AS manifestHash,
           upload.last_error AS lastError,
           upload.expires_at AS expiresAt, upload.created_at AS createdAt,
           upload.updated_at AS updatedAt,
           event.file_policy_json AS filePolicyJson
      FROM file_multipart_uploads upload
      JOIN file_versions version
        ON version.id = upload.version_id AND version.event_id = upload.event_id
      JOIN file_assets asset
        ON asset.id = upload.asset_id AND asset.event_id = upload.event_id
      JOIN events event ON event.id = upload.event_id
     WHERE upload.event_id = ? AND upload.idempotency_key = ?
       AND event.organisation_id = ?
  `,
    )
      .bind(actor.eventId, idempotencyKey, actor.organisationId)
      .first<MultipartRow>();
    if (row) this.assertRowAccess(actor, row);
    return row;
  }

  async loadByVersion(actor: MultipartActor, versionId: string) {
    const row = await this.env.DB.prepare(
      `
    SELECT upload.version_id AS versionId, upload.event_id AS eventId,
           event.organisation_id AS organisationId,
           upload.asset_id AS assetId, asset.asset_kind AS assetKind,
           asset.target_type AS targetType, asset.target_id AS targetId,
           asset.owner_person_id AS ownerPersonId,
           asset.status AS assetStatus,
           EXISTS (
             SELECT 1 FROM audit_events audit
              WHERE audit.id = 'file-erasure:' || asset.id
           ) AS erasureRequested,
           version.created_by_person_id AS createdByPersonId,
           version.object_key AS objectKey,
           version.original_filename AS filename,
           version.declared_content_type AS contentType,
           version.detected_content_type AS detectedContentType,
           version.size_bytes AS sizeBytes, version.object_etag AS objectEtag,
           version.upload_status AS uploadStatus,
           version.signature_status AS signatureStatus,
           version.scan_status AS scanStatus,
           version.deleted_at AS versionDeletedAt,
           upload.upload_id AS uploadId,
           upload.idempotency_key AS idempotencyKey,
           upload.status, upload.part_size_bytes AS partSizeBytes,
           upload.manifest_json AS manifestJson,
           upload.manifest_hash AS manifestHash,
           upload.last_error AS lastError,
           upload.expires_at AS expiresAt, upload.created_at AS createdAt,
           upload.updated_at AS updatedAt,
           event.file_policy_json AS filePolicyJson
      FROM file_multipart_uploads upload
      JOIN file_versions version
        ON version.id = upload.version_id AND version.event_id = upload.event_id
      JOIN file_assets asset
        ON asset.id = upload.asset_id AND asset.event_id = upload.event_id
      JOIN events event ON event.id = upload.event_id
     WHERE upload.version_id = ? AND upload.event_id = ?
       AND event.organisation_id = ?
  `,
    )
      .bind(versionId, actor.eventId, actor.organisationId)
      .first<MultipartRow>();
    if (!row)
      throw new FileAccessError("Multipart upload not found in this event.");
    this.assertRowAccess(actor, row);
    return row;
  }

  private assertRowAccess(actor: MultipartActor, row: MultipartRow) {
    if (
      row.eventId !== actor.eventId ||
      row.organisationId !== actor.organisationId
    )
      throw new FileAccessError("Multipart upload not found in this event.");
    if (
      row.assetStatus === "deleted" ||
      row.versionDeletedAt !== null ||
      row.erasureRequested === 1
    )
      throw new FileMultipartStateError(
        "This multipart upload was revoked by permanent file erasure.",
      );
    if (isApplicantActor(actor)) {
      const ownedByApplicant = actor.personId
        ? row.ownerPersonId === actor.personId &&
          row.createdByPersonId === actor.personId
        : row.ownerPersonId === null && row.createdByPersonId === null;
      if (
        row.targetType !== "submission" ||
        row.targetId !== actor.submissionId ||
        row.assetKind !== "video" ||
        !ownedByApplicant
      )
        throw new FileAccessError(
          "This multipart upload belongs to another application draft.",
        );
      return;
    }
    if (
      !["owner", "administrator"].includes(actor.role) &&
      row.createdByPersonId !== actor.personId &&
      row.ownerPersonId !== actor.personId
    )
      throw new FileAccessError(
        "This multipart upload belongs to another person.",
      );
  }
}
