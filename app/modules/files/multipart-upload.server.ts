import type { z } from "zod";
import {
  type assetKindSchema,
  DIRECT_MULTIPART_PART_SIZE_BYTES,
  detectInspectionContentType,
  type FileInspectionSource,
  FilePolicyError,
  validateDirectFileDeclaration,
  validateFileSignature,
} from "./file-policy";
import {
  assertFileScanDispatchConfigured,
  enqueueFileScan,
  type FileScanQueueMessage,
} from "./file-scan-dispatch.server";
import {
  FileAccessError,
  isMissingR2MultipartUpload,
  stableLogicalAssetId,
  type UploadTarget,
} from "./file-service.server";
import { MultipartR2Provider } from "./multipart-r2-provider.server";
import {
  MultipartUploadAccessRepository,
  multipartIdempotencyKey,
} from "./multipart-upload-access.server";
import { MultipartUploadAuthorizer } from "./multipart-upload-authorizer.server";
import type {
  MultipartActor,
  MultipartRow,
} from "./multipart-upload-contracts";
import {
  FileMultipartConflictError,
  FileMultipartIncompleteError,
  FileMultipartStateError,
} from "./multipart-upload-errors";
import { requireR2S3Configuration } from "./r2-s3-signing.server";

export {
  multipartAbortSchema,
  multipartCompleteSchema,
  multipartInitiateSchema,
  multipartListPartsSchema,
  multipartPartUrlSchema,
  multipartResumeSchema,
} from "./multipart-upload-contract";
export type { ApplicantMultipartActor } from "./multipart-upload-contracts";
export {
  FileMultipartConflictError,
  FileMultipartIncompleteError,
  FileMultipartStateError,
} from "./multipart-upload-errors";

import {
  expectedPartCount,
  MULTIPART_EXPIRY_SECONDS,
  multipartAbortSchema,
  multipartAuditProvenance,
  multipartCompleteSchema,
  multipartInitiateSchema,
  multipartListPartsSchema,
  multipartPartUrlSchema,
  multipartResumeSchema,
  normalizedManifest,
  REQUEST_CLAIM_SECONDS,
  REVOKED_COMPLETION_REASON,
  sha256,
  type TaskEvidenceFilePolicy,
} from "./multipart-upload-contract";

export class MultipartUploadService {
  private readonly provider: MultipartR2Provider;
  private readonly access: MultipartUploadAccessRepository;
  private readonly authorizer: MultipartUploadAuthorizer;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies?: { fetch?: typeof fetch },
  ) {
    this.provider = new MultipartR2Provider(env, dependencies);
    this.access = new MultipartUploadAccessRepository(env);
    this.authorizer = new MultipartUploadAuthorizer(env);
  }

  private requireBucket() {
    return this.provider.requireBucket();
  }

  private participantTaskGuard(actor: MultipartActor) {
    return this.authorizer.participantTaskGuard(actor);
  }

  private async assertTarget(actor: MultipartActor, target: UploadTarget) {
    return this.authorizer.assertTarget(actor, target);
  }

  private assertSameRequest(
    row: MultipartRow,
    input: z.infer<typeof multipartInitiateSchema>,
  ) {
    this.authorizer.assertSameRequest(row, input);
  }

  private assertAuthorisedTaskAsset(
    target: UploadTarget,
    authorisedAssetId: string | null,
    row: MultipartRow,
  ) {
    this.authorizer.assertAuthorisedTaskAsset(target, authorisedAssetId, row);
  }

  private uploadTarget(row: MultipartRow) {
    return this.authorizer.uploadTarget(row);
  }

  private async taskEvidenceFilePolicy(
    actor: MultipartActor,
    target: UploadTarget,
  ): Promise<TaskEvidenceFilePolicy | undefined> {
    return this.authorizer.taskEvidenceFilePolicy(actor, target);
  }

  private assertCurrentDeclaration(
    row: MultipartRow,
    taskFilePolicy?: TaskEvidenceFilePolicy,
  ) {
    this.authorizer.assertCurrentDeclaration(row, taskFilePolicy);
  }

  private async assertCurrentUploadAllowed(
    actor: MultipartActor,
    row: MultipartRow,
  ) {
    await this.authorizer.assertCurrentUploadAllowed(actor, row);
  }

  private response(row: MultipartRow, duplicate: boolean) {
    if (!row.uploadId || row.status !== "initiated")
      throw new FileMultipartStateError(
        `Multipart upload is ${row.status}; it cannot accept parts.`,
      );
    return {
      assetId: row.assetId,
      versionId: row.versionId,
      partSizeBytes: row.partSizeBytes,
      partCount: expectedPartCount(row),
      expiresAt: row.expiresAt,
      duplicate,
    };
  }

  private resumableResponse(row: MultipartRow) {
    if (
      !row.uploadId ||
      !["initiated", "completing", "completed"].includes(row.status)
    )
      throw new FileMultipartStateError(
        `Multipart upload is ${row.status}; it cannot be resumed.`,
      );
    if (
      row.status === "initiated" &&
      row.expiresAt <= Math.floor(Date.now() / 1_000)
    )
      throw new FileMultipartStateError(
        "This multipart upload has expired. Abort it and begin a new upload.",
      );
    return {
      assetId: row.assetId,
      versionId: row.versionId,
      partSizeBytes: row.partSizeBytes,
      partCount: expectedPartCount(row),
      expiresAt: row.expiresAt,
      duplicate: true,
      state: row.status as "initiated" | "completing" | "completed",
    };
  }

  private async allocateIntent(
    actor: MultipartActor,
    input: z.infer<typeof multipartInitiateSchema>,
    storedIdempotencyKey: string,
    authorisedAssetId: string | null,
  ) {
    const target = input.target;
    const participantTaskGuard = this.participantTaskGuard(actor);
    const allocationGuardSql =
      target.targetType === "task" && participantTaskGuard
        ? `EXISTS (
             SELECT 1 FROM task_instances task
              WHERE task.id = ? AND task.event_id = ?
                AND ${participantTaskGuard.sql}
           )`
        : "1 = 1";
    const allocationGuardBindings =
      target.targetType === "task" && participantTaskGuard
        ? [target.targetId, actor.eventId, ...participantTaskGuard.bindings]
        : [];
    const auditProvenance = multipartAuditProvenance(actor);
    const reusable = !["task", "resource"].includes(target.targetType);
    const ownerPersonId =
      target.targetType === "resource"
        ? null
        : target.targetType === "person"
          ? target.targetId
          : actor.personId;
    const existing = reusable
      ? await this.env.DB.prepare(
          `SELECT id FROM file_assets
            WHERE event_id = ? AND owner_person_id IS ?
              AND target_type = ? AND target_id = ? AND asset_kind = ?
              AND status <> 'deleted'
              AND NOT EXISTS (
                SELECT 1 FROM audit_events audit
                 WHERE audit.id = 'file-erasure:' || file_assets.id
              )
            ORDER BY created_at DESC LIMIT 1`,
        )
          .bind(
            actor.eventId,
            ownerPersonId,
            target.targetType,
            target.targetId,
            target.assetKind,
          )
          .first<{ id: string }>()
      : null;
    let assetId = authorisedAssetId ?? existing?.id;
    if (!assetId) {
      if (!reusable) {
        assetId = crypto.randomUUID();
      } else {
        const logicalId = await stableLogicalAssetId(
          { eventId: actor.eventId, personId: ownerPersonId },
          target,
        );
        const generationPrefix = `${logicalId}-generation-`;
        const erasureAuditPrefix = "file-erasure:";
        const prior = await this.env.DB.prepare(
          `SELECT asset.id
             FROM file_assets asset
             JOIN events event
               ON event.id = asset.event_id AND event.organisation_id = ?
            WHERE asset.event_id = ?
              AND (asset.id = ? OR instr(asset.id, ?) = 1)
            UNION
           SELECT substr(id, length(?) + 1) AS id
             FROM audit_events
            WHERE organisation_id = ? AND event_id = ?
              AND (id = ? OR instr(id, ?) = 1)`,
        )
          .bind(
            actor.organisationId,
            actor.eventId,
            logicalId,
            generationPrefix,
            erasureAuditPrefix,
            actor.organisationId,
            actor.eventId,
            `${erasureAuditPrefix}${logicalId}`,
            `${erasureAuditPrefix}${generationPrefix}`,
          )
          .all<{ id: string }>();
        let latestGeneration = 0;
        for (const candidate of prior.results) {
          if (candidate.id === logicalId) {
            latestGeneration = Math.max(latestGeneration, 1);
            continue;
          }
          if (!candidate.id.startsWith(generationPrefix)) continue;
          const generation = Number(
            candidate.id.slice(generationPrefix.length),
          );
          if (Number.isSafeInteger(generation) && generation > 1) {
            latestGeneration = Math.max(latestGeneration, generation);
          }
        }
        assetId = latestGeneration
          ? `${generationPrefix}${latestGeneration + 1}`
          : logicalId;
      }
    }
    const versionId = crypto.randomUUID();
    const objectKey = `private/events/${actor.eventId}/${target.targetType}/${target.targetId}/${assetId}/${versionId}`;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO file_assets (
           id, event_id, owner_person_id, target_type, target_id, asset_kind,
           status, created_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, 'pending', unixepoch(), unixepoch()
          WHERE ${allocationGuardSql}`,
      ).bind(
        assetId,
        actor.eventId,
        ownerPersonId,
        target.targetType,
        target.targetId,
        target.assetKind,
        ...allocationGuardBindings,
      ),
      this.env.DB.prepare(
        `INSERT INTO file_versions (
           id, event_id, asset_id, version_number, object_key,
           original_filename, declared_content_type, size_bytes,
           upload_status, signature_status, scan_status,
           created_by_person_id, created_at
         )
         SELECT ?, ?, ?, COALESCE(MAX(version_number), 0) + 1, ?, ?, ?, ?,
                'requested', 'pending', 'pending', ?, unixepoch()
           FROM file_versions
          WHERE asset_id = ?
            AND EXISTS (
              SELECT 1 FROM file_assets
               WHERE id = ? AND event_id = ? AND status <> 'deleted'
                 AND NOT EXISTS (
                   SELECT 1 FROM audit_events audit
                    WHERE audit.id = 'file-erasure:' || file_assets.id
                 )
            )
         HAVING EXISTS (
           SELECT 1 FROM file_assets
            WHERE id = ? AND event_id = ? AND status <> 'deleted'
              AND NOT EXISTS (
                SELECT 1 FROM audit_events audit
                 WHERE audit.id = 'file-erasure:' || file_assets.id
              )
         )
           AND ${allocationGuardSql}
         RETURNING version_number AS versionNumber`,
      ).bind(
        versionId,
        actor.eventId,
        assetId,
        objectKey,
        input.filename,
        input.contentType,
        input.sizeBytes,
        actor.personId,
        assetId,
        assetId,
        actor.eventId,
        assetId,
        actor.eventId,
        ...allocationGuardBindings,
      ),
      this.env.DB.prepare(
        `INSERT INTO file_multipart_uploads (
           version_id, event_id, asset_id, upload_id, idempotency_key,
           status, part_size_bytes, expires_at, created_at, updated_at
         )
         SELECT ?, ?, ?, NULL, ?, 'requested', ?,
                unixepoch() + ?, unixepoch(), unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM file_versions
             WHERE id = ? AND event_id = ? AND asset_id = ?
          )`,
      ).bind(
        versionId,
        actor.eventId,
        assetId,
        storedIdempotencyKey,
        DIRECT_MULTIPART_PART_SIZE_BYTES,
        MULTIPART_EXPIRY_SECONDS,
        versionId,
        actor.eventId,
        assetId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, 1, ?, ?, ?, 'file.multipart.requested', 'file_version', ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM file_multipart_uploads
             WHERE version_id = ? AND event_id = ? AND asset_id = ?
          )`,
      ).bind(
        crypto.randomUUID(),
        auditProvenance.actorKind,
        auditProvenance.origin,
        actor.organisationId,
        actor.eventId,
        actor.personId,
        versionId,
        JSON.stringify({
          assetId,
          assetKind: target.assetKind,
          sizeBytes: input.sizeBytes,
        }),
        versionId,
        actor.eventId,
        assetId,
      ),
    ]);
    const version = results[1]?.results?.[0] as
      | { versionNumber?: number }
      | undefined;
    if (!Number.isSafeInteger(Number(version?.versionNumber)))
      throw new Error(
        "The multipart file version could not be allocated atomically.",
      );
    const row = await this.access.loadByVersion(actor, versionId);
    return row;
  }

  private async createProviderUpload(actor: MultipartActor, row: MultipartRow) {
    const participantTaskGuard = this.participantTaskGuard(actor);
    const assetAccessSql = participantTaskGuard
      ? `AND (
           asset.target_type <> 'task'
           OR EXISTS (
             SELECT 1 FROM task_instances task
              WHERE task.id = asset.target_id AND task.event_id = asset.event_id
                AND ${participantTaskGuard.sql}
           )
         )`
      : "";
    const assetAccessBindings = participantTaskGuard?.bindings ?? [];
    let multipart: R2MultipartUpload;
    try {
      multipart = await this.provider.createUpload(row);
    } catch (error) {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE file_multipart_uploads
              SET status = 'failed', last_error = ?, updated_at = unixepoch()
            WHERE version_id = ? AND event_id = ? AND status = 'requested'`,
        ).bind(
          (error instanceof Error ? error.message : String(error)).slice(
            0,
            2_000,
          ),
          row.versionId,
          actor.eventId,
        ),
        this.env.DB.prepare(
          `UPDATE file_versions
              SET upload_status = 'failed', scan_status = 'failed',
                  scan_error = 'R2 multipart initialization failed.'
            WHERE id = ? AND event_id = ? AND upload_status = 'requested'`,
        ).bind(row.versionId, actor.eventId),
      ]);
      throw new FileMultipartIncompleteError(
        "The upload could not be started. Try again.",
        true,
        { cause: error },
      );
    }
    try {
      const [uploadUpdated, versionUpdated] = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE file_multipart_uploads
              SET upload_id = ?, status = 'initiated', last_error = NULL,
                  updated_at = unixepoch()
            WHERE version_id = ? AND event_id = ? AND status = 'requested'
              AND upload_id IS NULL
              AND EXISTS (
                SELECT 1 FROM file_assets asset
                 WHERE asset.id = file_multipart_uploads.asset_id
                   AND asset.event_id = file_multipart_uploads.event_id
                   AND asset.status <> 'deleted'
                   AND NOT EXISTS (
                     SELECT 1 FROM audit_events audit
                      WHERE audit.id = 'file-erasure:' || asset.id
                   )
                   ${assetAccessSql}
              )`,
        ).bind(
          multipart.uploadId,
          row.versionId,
          actor.eventId,
          ...assetAccessBindings,
        ),
        this.env.DB.prepare(
          `UPDATE file_versions
              SET multipart_upload_id = ?, upload_status = 'uploading'
            WHERE id = ? AND event_id = ? AND upload_status = 'requested'
              AND deleted_at IS NULL
              AND EXISTS (
                SELECT 1 FROM file_assets asset
                 WHERE asset.id = file_versions.asset_id
                   AND asset.event_id = file_versions.event_id
                   AND asset.status <> 'deleted'
                   AND NOT EXISTS (
                     SELECT 1 FROM audit_events audit
                      WHERE audit.id = 'file-erasure:' || asset.id
                   )
                   ${assetAccessSql}
              )`,
        ).bind(
          multipart.uploadId,
          row.versionId,
          actor.eventId,
          ...assetAccessBindings,
        ),
      ]);
      if (
        (uploadUpdated.meta.changes ?? 0) !== 1 ||
        (versionUpdated.meta.changes ?? 0) !== 1
      )
        throw new Error(
          "The multipart intent changed before R2 initialization committed.",
        );
    } catch (error) {
      const failures: unknown[] = [error];
      let providerAborted = false;
      try {
        await multipart.abort();
        providerAborted = true;
      } catch (abortError) {
        if (isMissingR2MultipartUpload(abortError)) providerAborted = true;
        else failures.push(abortError);
      }
      try {
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE file_multipart_uploads
                SET upload_id = ?, status = 'failed', last_error = ?,
                    updated_at = unixepoch()
              WHERE version_id = ? AND event_id = ?
                AND status IN ('requested','initiated')`,
          ).bind(
            providerAborted ? null : multipart.uploadId,
            providerAborted
              ? "The upload could not be recorded, so it was cancelled. Try again."
              : "The upload could not be recorded and its partial file was left behind. Try again.",
            row.versionId,
            actor.eventId,
          ),
          this.env.DB.prepare(
            `UPDATE file_versions
                SET multipart_upload_id = ?, upload_status = 'failed',
                    scan_status = 'failed',
                    scan_error = 'R2 multipart initialization metadata did not commit.'
              WHERE id = ? AND event_id = ?
                AND upload_status IN ('requested','uploading')
                AND deleted_at IS NULL`,
          ).bind(
            providerAborted ? null : multipart.uploadId,
            row.versionId,
            actor.eventId,
          ),
        ]);
      } catch (cleanupError) {
        failures.push(cleanupError);
      }
      throw new FileMultipartIncompleteError(
        providerAborted
          ? "The upload was cancelled because it could not be recorded."
          : "The upload was cancelled, but its partial file could not be cleared. Try cancelling again.",
        true,
        {
          cause:
            failures.length === 1
              ? error
              : new AggregateError(
                  failures,
                  "Multipart initialization compensation was incomplete.",
                ),
        },
      );
    }
    return this.access.loadByVersion(actor, row.versionId);
  }

  async initiate(actor: MultipartActor, rawInput: unknown) {
    requireR2S3Configuration(this.env);
    this.requireBucket();
    const input = multipartInitiateSchema.parse(rawInput);
    const declaration = {
      name: input.filename,
      type: input.contentType,
      size: input.sizeBytes,
    };
    const authorisedAssetId = await this.assertTarget(actor, input.target);
    const taskFilePolicy = await this.taskEvidenceFilePolicy(
      actor,
      input.target,
    );
    assertFileScanDispatchConfigured(this.env);
    validateDirectFileDeclaration(
      input.target.assetKind,
      declaration,
      await this.access.loadEventFilePolicy(actor),
      {
        taskFileScope: taskFilePolicy?.fileScope,
        taskFileKind: taskFilePolicy?.fileKind,
      },
    );
    const storedKey = multipartIdempotencyKey(actor, input.idempotencyKey);
    let row = await this.access.loadByIdempotency(actor, storedKey);
    if (row) {
      this.assertSameRequest(row, input);
      this.assertAuthorisedTaskAsset(input.target, authorisedAssetId, row);
      if (row.status === "initiated") return this.response(row, true);
      if (["completed", "completing", "aborted", "failed"].includes(row.status))
        throw new FileMultipartStateError(
          `This idempotent multipart upload is already ${row.status}.`,
        );
      const claimed = await this.env.DB.prepare(
        `UPDATE file_multipart_uploads
            SET updated_at = unixepoch()
          WHERE version_id = ? AND event_id = ? AND status = 'requested'
            AND upload_id IS NULL AND updated_at <= unixepoch() - ?`,
      )
        .bind(row.versionId, actor.eventId, REQUEST_CLAIM_SECONDS)
        .run();
      if ((claimed.meta.changes ?? 0) !== 1)
        throw new FileMultipartStateError(
          "Multipart initialization is already in progress. Retry shortly.",
        );
    } else {
      try {
        row = await this.allocateIntent(
          actor,
          input,
          storedKey,
          authorisedAssetId,
        );
      } catch (error) {
        row = await this.access.loadByIdempotency(actor, storedKey);
        if (!row) throw error;
        this.assertSameRequest(row, input);
        this.assertAuthorisedTaskAsset(input.target, authorisedAssetId, row);
        if (row.status === "initiated") return this.response(row, true);
        throw new FileMultipartStateError(
          "Multipart initialization is already in progress. Retry shortly.",
        );
      }
    }
    return this.response(await this.createProviderUpload(actor, row), false);
  }

  async resume(actor: MultipartActor, rawInput: unknown) {
    requireR2S3Configuration(this.env);
    this.requireBucket();
    const input = multipartResumeSchema.parse(rawInput);
    const authorisedAssetId = await this.assertTarget(actor, input.target);
    const taskFilePolicy = await this.taskEvidenceFilePolicy(
      actor,
      input.target,
    );
    validateDirectFileDeclaration(
      input.target.assetKind,
      {
        name: input.filename,
        type: input.contentType,
        size: input.sizeBytes,
      },
      await this.access.loadEventFilePolicy(actor),
      {
        taskFileScope: taskFilePolicy?.fileScope,
        taskFileKind: taskFilePolicy?.fileKind,
      },
    );
    const row = await this.access.loadByIdempotency(
      actor,
      multipartIdempotencyKey(actor, input.idempotencyKey),
    );
    if (!row) return null;
    this.assertSameRequest(row, input);
    this.assertAuthorisedTaskAsset(input.target, authorisedAssetId, row);
    return this.resumableResponse(row);
  }

  async listParts(actor: MultipartActor, rawInput: unknown) {
    requireR2S3Configuration(this.env);
    this.requireBucket();
    const input = multipartListPartsSchema.parse(rawInput);
    const row = await this.access.loadByVersion(actor, input.versionId);
    await this.assertCurrentUploadAllowed(actor, row);
    if (["completing", "completed"].includes(row.status)) {
      if (!row.manifestJson)
        throw new FileMultipartStateError(
          "Multipart completion metadata is unavailable for recovery.",
        );
      let storedParts: unknown;
      try {
        storedParts = JSON.parse(row.manifestJson);
      } catch (error) {
        throw new FileMultipartStateError(
          "Multipart completion metadata is invalid.",
          { cause: error },
        );
      }
      const parts = normalizedManifest(
        multipartCompleteSchema.shape.parts.parse(storedParts),
        expectedPartCount(row),
      );
      return {
        versionId: row.versionId,
        state: row.status as "completing" | "completed",
        parts: parts.map((part) => ({
          PartNumber: part.partNumber,
          Size: Math.min(
            row.partSizeBytes,
            row.sizeBytes - (part.partNumber - 1) * row.partSizeBytes,
          ),
          ETag: part.etag,
        })),
      };
    }
    if (row.status !== "initiated" || !row.uploadId)
      throw new FileMultipartStateError(
        `Multipart upload is ${row.status}; its parts cannot be listed.`,
      );
    if (row.expiresAt <= Math.floor(Date.now() / 1_000))
      throw new FileMultipartStateError(
        "This multipart upload has expired. Abort it and begin a new upload.",
      );
    const parts = await this.provider.listParts({
      ...row,
      uploadId: row.uploadId,
    });
    return {
      versionId: row.versionId,
      state: "initiated" as const,
      parts,
    };
  }

  async createPartUrl(actor: MultipartActor, rawInput: unknown) {
    requireR2S3Configuration(this.env);
    this.requireBucket();
    const input = multipartPartUrlSchema.parse(rawInput);
    const row = await this.access.loadByVersion(actor, input.versionId);
    if (row.status !== "initiated" || !row.uploadId)
      throw new FileMultipartStateError(
        `Multipart upload is ${row.status}; no more part URLs can be issued.`,
      );
    await this.assertCurrentUploadAllowed(actor, row);
    if (row.expiresAt <= Math.floor(Date.now() / 1_000))
      throw new FileMultipartStateError(
        "This multipart upload has expired. Abort it and begin a new upload.",
      );
    const partCount = expectedPartCount(row);
    if (input.partNumber > partCount)
      throw new FileMultipartStateError(
        `Part number must be between 1 and ${partCount}.`,
      );
    return {
      versionId: row.versionId,
      partNumber: input.partNumber,
      url: await this.provider.createPartUrl(
        { ...row, uploadId: row.uploadId },
        input.partNumber,
      ),
      expiresInSeconds: 900,
    };
  }

  private inspectionSource(row: MultipartRow): FileInspectionSource {
    const bucket = this.requireBucket();
    return {
      name: row.filename,
      type: row.contentType,
      size: row.sizeBytes,
      readRange: async (start, end) => {
        const boundedEnd = Math.min(end, row.sizeBytes);
        const expected = boundedEnd - start;
        if (start < 0 || end < start || start > row.sizeBytes || expected < 1)
          throw new FileMultipartStateError(
            "The uploaded file could not be checked. Upload it again.",
          );
        const object = await bucket.get(row.objectKey, {
          range: { offset: start, length: expected },
        });
        if (!object)
          throw new FileMultipartStateError(
            "The uploaded file was no longer available when it was checked. Upload it again.",
          );
        const bytes = await object.arrayBuffer();
        if (bytes.byteLength !== expected)
          throw new FileMultipartStateError(
            "The uploaded file could not be read for checking. Upload it again.",
          );
        return bytes;
      },
    };
  }

  private async failInvalidObject(
    actor: MultipartActor,
    row: MultipartRow,
    detected: string | null,
    error: unknown,
  ): Promise<never> {
    const failures: unknown[] = [error];
    try {
      await this.requireBucket().delete(row.objectKey);
    } catch (deleteError) {
      failures.push(deleteError);
    }
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE file_multipart_uploads
              SET status = 'failed', last_error = ?, updated_at = unixepoch()
            WHERE version_id = ? AND event_id = ? AND status = 'completing'`,
        ).bind(
          "Completed object failed signature validation.",
          row.versionId,
          actor.eventId,
        ),
        this.env.DB.prepare(
          `UPDATE file_versions
              SET upload_status = 'failed', signature_status = 'invalid',
                  scan_status = 'failed', detected_content_type = ?,
                  scan_error = 'Completed object failed signature validation.'
            WHERE id = ? AND event_id = ?`,
        ).bind(detected, row.versionId, actor.eventId),
        this.env.DB.prepare(
          `UPDATE file_assets
              SET status = CASE WHEN current_version_id IS NULL THEN 'rejected' ELSE status END,
                  updated_at = unixepoch()
            WHERE id = ? AND event_id = ?`,
        ).bind(row.assetId, actor.eventId),
      ]);
    } catch (stateError) {
      failures.push(stateError);
    }
    if (failures.length > 1)
      throw new AggregateError(
        failures,
        "Invalid multipart content could not be fully removed and recorded.",
      );
    throw error;
  }

  private async removeRevokedProviderState(
    row: MultipartRow & { uploadId: string },
  ) {
    const failures: unknown[] = [];
    try {
      await this.provider.abort(row);
    } catch (abortError) {
      failures.push(abortError);
    }
    try {
      await this.provider.delete(row.objectKey);
    } catch (deleteError) {
      failures.push(deleteError);
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        "Revoked multipart provider state could not be fully removed.",
      );
  }

  private async failRevokedCompletion(
    actor: MultipartActor,
    row: MultipartRow & { uploadId: string },
    error: FileAccessError | FilePolicyError,
  ): Promise<never> {
    try {
      const [revoked] = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE file_multipart_uploads
              SET status = 'failed', last_error = ?, updated_at = unixepoch()
            WHERE version_id = ? AND event_id = ? AND status = 'completing'`,
        ).bind(REVOKED_COMPLETION_REASON, row.versionId, actor.eventId),
        this.env.DB.prepare(
          `UPDATE file_versions
              SET upload_status = 'failed', signature_status = 'invalid',
                  scan_status = 'failed', object_etag = NULL, scan_error = ?
            WHERE id = ? AND event_id = ? AND deleted_at IS NULL
              AND upload_status = 'uploading' AND scan_status = 'pending'
              AND EXISTS (
                SELECT 1 FROM file_multipart_uploads upload
                 WHERE upload.version_id = file_versions.id
                   AND upload.event_id = file_versions.event_id
                   AND upload.status = 'failed' AND upload.last_error = ?
              )`,
        ).bind(
          REVOKED_COMPLETION_REASON,
          row.versionId,
          actor.eventId,
          REVOKED_COMPLETION_REASON,
        ),
        this.env.DB.prepare(
          `UPDATE file_assets
              SET status = CASE WHEN current_version_id IS NULL THEN 'rejected' ELSE status END,
                  updated_at = unixepoch()
            WHERE id = ? AND event_id = ?
              AND EXISTS (
                SELECT 1 FROM file_versions version
                 WHERE version.id = ? AND version.event_id = ?
                   AND version.asset_id = file_assets.id
                   AND version.upload_status = 'failed'
                   AND version.scan_error = ?
              )`,
        ).bind(
          row.assetId,
          actor.eventId,
          row.versionId,
          actor.eventId,
          REVOKED_COMPLETION_REASON,
        ),
      ]);
      if ((revoked.meta.changes ?? 0) !== 1) {
        const current = await this.access.loadByVersion(actor, row.versionId);
        if (
          current.status !== "failed" ||
          current.lastError !== REVOKED_COMPLETION_REASON
        )
          throw error;
      }
    } catch (stateError) {
      if (stateError === error) throw error;
      throw new AggregateError(
        [error, stateError],
        "Revoked multipart completion could not be durably recorded.",
      );
    }
    try {
      await this.removeRevokedProviderState(row);
    } catch (providerError) {
      throw new AggregateError(
        [error, providerError],
        "Revoked multipart completion was recorded, but provider cleanup was incomplete.",
      );
    }
    throw error;
  }

  private async ensureScan(actor: MultipartActor, row: MultipartRow) {
    if (!row.objectEtag)
      throw new FileMultipartStateError(
        "This upload is missing the record of what was stored. Upload the file again.",
      );
    return enqueueFileScan(this.env, actor, {
      versionId: row.versionId,
      assetId: row.assetId,
      objectKey: row.objectKey,
      objectEtag: row.objectEtag,
      sizeBytes: row.sizeBytes,
    });
  }

  async complete(actor: MultipartActor, rawInput: unknown) {
    requireR2S3Configuration(this.env);
    this.requireBucket();
    const input = multipartCompleteSchema.parse(rawInput);
    assertFileScanDispatchConfigured(this.env);
    let row = await this.access.loadByVersion(actor, input.versionId);
    const parts = normalizedManifest(input.parts, expectedPartCount(row));
    const manifestJson = JSON.stringify(parts);
    const manifestHash = await sha256(manifestJson);
    if (
      row.status === "failed" &&
      row.lastError === REVOKED_COMPLETION_REASON
    ) {
      if (!row.uploadId)
        throw new FileMultipartStateError(
          "This cancelled upload is missing its storage record, so it cannot be cleared.",
        );
      await this.removeRevokedProviderState({ ...row, uploadId: row.uploadId });
      throw new FileMultipartStateError(
        "This multipart upload was revoked before completion.",
      );
    }
    if (row.status === "completed") {
      await this.assertCurrentUploadAllowed(actor, row);
      if (row.manifestHash !== manifestHash)
        throw new FileMultipartConflictError(
          "This upload was already completed with a different part manifest.",
        );
      const scan = await this.ensureScan(actor, row);
      return {
        assetId: row.assetId,
        versionId: row.versionId,
        scanStatus: "pending" as const,
        scanOperationId: scan.operationId,
        duplicate: true,
      };
    }
    if (row.status === "initiated")
      await this.assertCurrentUploadAllowed(actor, row);
    else if (row.status === "completing") {
      if (!row.uploadId)
        throw new FileMultipartStateError(
          "This upload is missing its storage record, so it cannot be completed.",
        );
      try {
        await this.assertCurrentUploadAllowed(actor, row);
      } catch (error) {
        if (
          error instanceof FileAccessError ||
          error instanceof FilePolicyError
        )
          return this.failRevokedCompletion(
            actor,
            { ...row, uploadId: row.uploadId },
            error,
          );
        throw error;
      }
    }
    if (row.status === "initiated") {
      if (row.expiresAt <= Math.floor(Date.now() / 1_000))
        throw new FileMultipartStateError(
          "This multipart upload expired before completion. Abort it and begin a new upload.",
        );
      const participantTaskGuard = this.participantTaskGuard(actor);
      const started = await this.env.DB.prepare(
        `UPDATE file_multipart_uploads
            SET status = 'completing', manifest_json = ?, manifest_hash = ?,
                last_error = NULL, updated_at = unixepoch()
          WHERE version_id = ? AND event_id = ? AND status = 'initiated'
            AND upload_id IS NOT NULL
            AND EXISTS (
              SELECT 1
                FROM file_versions version
                JOIN file_assets asset
                  ON asset.id = version.asset_id
                 AND asset.event_id = version.event_id
               WHERE version.id = file_multipart_uploads.version_id
                 AND version.event_id = file_multipart_uploads.event_id
                 AND version.deleted_at IS NULL
                 AND asset.status <> 'deleted'
                 AND NOT EXISTS (
                   SELECT 1 FROM audit_events audit
                   WHERE audit.id = 'file-erasure:' || asset.id
                 )
                 ${
                   participantTaskGuard
                     ? `AND (
                          asset.target_type <> 'task'
                          OR EXISTS (
                            SELECT 1 FROM task_instances task
                             WHERE task.id = asset.target_id
                               AND task.event_id = asset.event_id
                               AND ${participantTaskGuard.sql}
                          )
                        )`
                     : ""
}
            )`,
      )
        .bind(
          manifestJson,
          manifestHash,
          row.versionId,
          actor.eventId,
          ...(participantTaskGuard?.bindings ?? []),
        )
        .run();
      if ((started.meta.changes ?? 0) !== 1) {
        await this.assertCurrentUploadAllowed(actor, row);
        row = await this.access.loadByVersion(actor, row.versionId);
      } else row = { ...row, status: "completing", manifestJson, manifestHash };
    }
    if (row.status !== "completing" || !row.uploadId)
      throw new FileMultipartStateError(
        `Multipart upload is ${row.status}; it cannot be completed.`,
      );
    if (row.manifestHash !== manifestHash || row.manifestJson !== manifestJson)
      throw new FileMultipartConflictError(
        "Multipart completion is already using a different part manifest.",
      );

    const completingRow = { ...row, uploadId: row.uploadId };
    const object = await this.completeProviderObject(
      actor,
      completingRow,
      parts,
    );
    const detected = await this.validateCompletedObject(
      actor,
      completingRow,
      object,
    );
    row = await this.commitCompletedObject(
      actor,
      completingRow,
      manifestHash,
      object,
      detected,
    );
    const scan = await this.ensureScan(actor, row);
    return {
      assetId: row.assetId,
      versionId: row.versionId,
      scanStatus: "pending" as const,
      scanOperationId: scan.operationId,
      duplicate: false,
    };
  }

  private async completeProviderObject(
    actor: MultipartActor,
    row: MultipartRow & { uploadId: string },
    parts: ReturnType<typeof normalizedManifest>,
  ): Promise<R2Object> {
    try {
      return await this.provider.complete(row, parts);
    } catch (error) {
      await this.env.DB.prepare(
        `UPDATE file_multipart_uploads
            SET last_error = ?, updated_at = unixepoch()
          WHERE version_id = ? AND event_id = ? AND status = 'completing'`,
      )
        .bind(
          (error instanceof Error ? error.message : String(error)).slice(
            0,
            2_000,
          ),
          row.versionId,
          actor.eventId,
        )
        .run();
      throw new FileMultipartIncompleteError(
        "The upload did not finish. Try again with the same file.",
        true,
        { cause: error },
      );
    }
  }

  private async validateCompletedObject(
    actor: MultipartActor,
    row: MultipartRow & { uploadId: string },
    object: R2Object,
  ) {
    if (
      object.size !== row.sizeBytes ||
      object.customMetadata?.eventId !== row.eventId ||
      object.customMetadata.assetId !== row.assetId ||
      object.customMetadata.versionId !== row.versionId ||
      object.customMetadata.quarantine !== "pending-scan"
    ) {
      return this.failInvalidObject(
        actor,
        row,
        null,
        new FilePolicyError(
          "The stored file does not match the upload it was meant to complete.",
        ),
      );
    }
    let detected: string | null = null;
    try {
      const source = this.inspectionSource(row);
      detected = await detectInspectionContentType(source);
      validateFileSignature(
        row.assetKind as z.infer<typeof assetKindSchema>,
        source,
        detected,
      );
    } catch (error) {
      return this.failInvalidObject(actor, row, detected, error);
    }
    return detected;
  }

  private async commitCompletedObject(
    actor: MultipartActor,
    row: MultipartRow,
    manifestHash: string,
    object: R2Object,
    detected: string | null,
  ) {
    const auditProvenance = multipartAuditProvenance(actor);
    const participantTaskGuard = this.participantTaskGuard(actor);
    const assetAccessSql = participantTaskGuard
      ? `AND (
           asset.target_type <> 'task'
           OR EXISTS (
             SELECT 1 FROM task_instances task
              WHERE task.id = asset.target_id AND task.event_id = asset.event_id
                AND ${participantTaskGuard.sql}
           )
         )`
      : "";
    const assetAccessBindings = participantTaskGuard?.bindings ?? [];
    const commitResults = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE file_versions
            SET upload_status = 'uploaded', signature_status = 'valid',
                detected_content_type = ?, object_etag = ?, uploaded_at = unixepoch()
          WHERE id = ? AND event_id = ?
            AND upload_status IN ('uploading','uploaded')
            AND signature_status IN ('pending','valid') AND scan_status = 'pending'
            AND deleted_at IS NULL
            AND EXISTS (
              SELECT 1
                FROM file_assets asset
                JOIN events policy_event
                  ON policy_event.id = asset.event_id
               WHERE asset.id = file_versions.asset_id
                 AND asset.event_id = file_versions.event_id
                 AND asset.status <> 'deleted'
                 AND file_versions.size_bytes <= CASE asset.asset_kind
                   WHEN 'headshot' THEN json_extract(
                     policy_event.file_policy_json,
                     '$.headshotMaximumBytes'
                   )
                   WHEN 'slides' THEN json_extract(
                     policy_event.file_policy_json,
                     '$.slidesMaximumBytes'
                   )
                   WHEN 'video' THEN json_extract(
                     policy_event.file_policy_json,
                     '$.videoMaximumBytes'
                   )
                   WHEN 'supporting_document' THEN json_extract(
                     policy_event.file_policy_json,
                     '$.supportingDocumentMaximumBytes'
                   )
                   WHEN 'resource_attachment' THEN json_extract(
                     policy_event.file_policy_json,
                     '$.supportingDocumentMaximumBytes'
                   )
                   WHEN 'task_evidence' THEN CASE
                     WHEN EXISTS (
                       SELECT 1 FROM task_instances task
                        WHERE task.id = asset.target_id
                          AND task.event_id = asset.event_id
                          AND json_valid(task.configuration_json)
                          AND json_extract(
                            task.configuration_json,
                            '$.fileKind'
                          ) = 'slides'
                     ) THEN json_extract(
                       policy_event.file_policy_json,
                       '$.slidesMaximumBytes'
                     )
                     WHEN EXISTS (
                       SELECT 1 FROM task_instances task
                        WHERE task.id = asset.target_id
                          AND task.event_id = asset.event_id
                          AND json_valid(task.configuration_json)
                          AND json_extract(
                            task.configuration_json,
                            '$.fileKind'
                          ) = 'video'
                     ) THEN json_extract(
                       policy_event.file_policy_json,
                       '$.videoMaximumBytes'
                     )
                     WHEN file_versions.declared_content_type IN (
                       'video/mp4', 'video/webm'
                     ) AND EXISTS (
                       SELECT 1 FROM task_instances task
                        WHERE task.id = asset.target_id
                          AND task.event_id = asset.event_id
                          AND task.task_type = 'file_upload'
                          AND task.target_type = 'session'
                          AND json_valid(task.configuration_json)
                          AND json_extract(
                            task.configuration_json,
                            '$.fileScope'
                          ) = 'session_deliverable'
                     ) THEN json_extract(
                       policy_event.file_policy_json,
                       '$.videoMaximumBytes'
                     )
                     ELSE json_extract(
                       policy_event.file_policy_json,
                       '$.supportingDocumentMaximumBytes'
                     )
                   END
                   WHEN 'other' THEN json_extract(
                     policy_event.file_policy_json,
                     '$.supportingDocumentMaximumBytes'
                   )
                 END
                 AND (
                   asset.asset_kind <> 'task_evidence'
                   OR EXISTS (
                     SELECT 1 FROM task_instances task
                      WHERE task.id = asset.target_id
                        AND task.event_id = asset.event_id
                        AND task.task_type = 'file_upload'
                        AND json_valid(task.configuration_json)
                        AND (
                          (
                            task.target_type = 'speaker'
                            AND json_extract(
                              task.configuration_json,
                              '$.fileScope'
                            ) = 'participant_document'
                          )
                          OR (
                            task.target_type = 'session'
                            AND json_extract(
                              task.configuration_json,
                              '$.fileScope'
                            ) = 'session_deliverable'
                          )
                        )
                   )
                 )
                 AND NOT EXISTS (
                   SELECT 1 FROM audit_events audit
                    WHERE audit.id = 'file-erasure:' || asset.id
                 )
                 ${assetAccessSql}
            )`,
      ).bind(
        detected,
        object.httpEtag,
        row.versionId,
        actor.eventId,
        ...assetAccessBindings,
      ),
      this.env.DB.prepare(
        `UPDATE file_multipart_uploads
            SET status = 'completed', last_error = NULL, updated_at = unixepoch()
          WHERE version_id = ? AND event_id = ?
            AND status IN ('completing','completed') AND manifest_hash = ?
            AND EXISTS (
              SELECT 1 FROM file_versions version
               WHERE version.id = file_multipart_uploads.version_id
                 AND version.event_id = file_multipart_uploads.event_id
                 AND version.upload_status = 'uploaded'
                 AND version.signature_status = 'valid'
                 AND version.scan_status = 'pending'
                 AND version.object_etag = ?
                 AND version.deleted_at IS NULL
                 AND EXISTS (
                   SELECT 1 FROM file_assets asset
                    WHERE asset.id = version.asset_id
                      AND asset.event_id = version.event_id
                      AND asset.status <> 'deleted'
                      AND NOT EXISTS (
                        SELECT 1 FROM audit_events audit
                         WHERE audit.id = 'file-erasure:' || asset.id
                      )
                      ${assetAccessSql}
                 )
            )`,
      ).bind(
        row.versionId,
        actor.eventId,
        manifestHash,
        object.httpEtag,
        ...assetAccessBindings,
      ),
      this.env.DB.prepare(
        `UPDATE file_assets
            SET status = CASE
                  WHEN status = 'rejected' AND current_version_id IS NULL
                    THEN 'pending'
                  ELSE status
                END,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND status <> 'deleted'
            AND NOT EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = 'file-erasure:' || file_assets.id
            )
            AND EXISTS (
              SELECT 1
                FROM file_versions version
                JOIN file_multipart_uploads upload
                  ON upload.version_id = version.id
                 AND upload.event_id = version.event_id
                 AND upload.asset_id = version.asset_id
               WHERE version.id = ? AND version.event_id = file_assets.event_id
                 AND version.asset_id = file_assets.id
                 AND version.upload_status = 'uploaded'
                 AND version.signature_status = 'valid'
                 AND version.scan_status = 'pending'
                 AND version.deleted_at IS NULL
                 AND upload.status = 'completed'
            )`,
      ).bind(row.assetId, actor.eventId, row.versionId),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, 1, ?, ?, ?, 'file.upload.quarantined', 'file_version', ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM file_versions version
             WHERE version.id = ? AND version.event_id = ?
               AND version.upload_status = 'uploaded'
               AND version.signature_status = 'valid'
               AND version.scan_status = 'pending'
               AND version.deleted_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM file_multipart_uploads upload
                  WHERE upload.version_id = version.id
                    AND upload.event_id = version.event_id
                    AND upload.status = 'completed'
               )
               AND NOT EXISTS (
                 SELECT 1 FROM audit_events erasure
                  WHERE erasure.id = 'file-erasure:' || version.asset_id
               )
          )`,
      ).bind(
        `file-multipart-complete:${row.versionId}`,
        auditProvenance.actorKind,
        auditProvenance.origin,
        actor.organisationId,
        actor.eventId,
        actor.personId,
        row.versionId,
        JSON.stringify({ assetId: row.assetId, scanStatus: "pending" }),
        row.versionId,
        actor.eventId,
      ),
    ]);
    const [versionCommitted, uploadCommitted, assetCommitted] = commitResults;
    if (
      (versionCommitted.meta.changes ?? 0) !== 1 ||
      (uploadCommitted.meta.changes ?? 0) !== 1 ||
      (assetCommitted.meta.changes ?? 0) !== 1
    ) {
      const failures: unknown[] = [];
      try {
        await this.requireBucket().delete(row.objectKey);
      } catch (error) {
        failures.push(error);
      }
      try {
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE file_multipart_uploads
                SET status = 'failed',
                    last_error = 'Completed object metadata did not commit.',
                    updated_at = unixepoch()
              WHERE version_id = ? AND event_id = ?
                AND status IN ('completing','completed')
                AND NOT EXISTS (
                  SELECT 1 FROM audit_events audit
                   WHERE audit.id = 'file-erasure:' || file_multipart_uploads.asset_id
                )`,
          ).bind(row.versionId, actor.eventId),
          this.env.DB.prepare(
            `UPDATE file_versions
                SET upload_status = 'failed', signature_status = 'invalid',
                    scan_status = 'failed', object_etag = NULL,
                    scan_error = 'Completed object metadata did not commit.'
              WHERE id = ? AND event_id = ? AND deleted_at IS NULL
                AND upload_status IN ('uploading','uploaded')
                AND NOT EXISTS (
                  SELECT 1 FROM audit_events audit
                   WHERE audit.id = 'file-erasure:' || file_versions.asset_id
                )`,
          ).bind(row.versionId, actor.eventId),
        ]);
      } catch (error) {
        failures.push(error);
      }
      throw new FileMultipartIncompleteError(
        "The stored file was cancelled before the upload could be recorded. Upload it again.",
        true,
        failures.length
          ? {
              cause: new AggregateError(
                failures,
                "Completed multipart compensation was incomplete.",
              ),
            }
          : undefined,
      );
    }
    row = await this.access.loadByVersion(actor, row.versionId);
    if (
      row.status !== "completed" ||
      row.uploadStatus !== "uploaded" ||
      row.signatureStatus !== "valid" ||
      row.objectEtag !== object.httpEtag
    )
      throw new FileMultipartIncompleteError(
        "The file was stored, but the upload could not be recorded. Try finishing it again.",
        true,
      );
    return row;
  }

  async abort(actor: MultipartActor, rawInput: unknown) {
    const auditProvenance = multipartAuditProvenance(actor);
    const input = multipartAbortSchema.parse(rawInput);
    let row = await this.access.loadByVersion(actor, input.versionId);
    if (row.status === "completed" || row.status === "completing")
      throw new FileMultipartStateError(
        "A completing or completed upload cannot be aborted.",
      );
    if (row.status !== "aborted") {
      const [aborted] = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE file_multipart_uploads
              SET status = 'aborted', last_error = NULL, updated_at = unixepoch()
            WHERE version_id = ? AND event_id = ?
              AND status IN ('requested','initiated','failed')`,
        ).bind(row.versionId, actor.eventId),
        this.env.DB.prepare(
          `UPDATE file_versions
              SET upload_status = 'aborted', scan_status = 'failed',
                  scan_error = 'Multipart upload aborted before completion.'
            WHERE id = ? AND event_id = ? AND upload_status IN ('requested','uploading','failed')`,
        ).bind(row.versionId, actor.eventId),
        this.env.DB.prepare(
          `UPDATE file_assets
              SET status = CASE WHEN current_version_id IS NULL THEN 'rejected' ELSE status END,
                  updated_at = unixepoch()
            WHERE id = ? AND event_id = ?`,
        ).bind(row.assetId, actor.eventId),
      ]);
      if ((aborted.meta.changes ?? 0) !== 1)
        throw new FileMultipartStateError(
          "The multipart upload changed before it could be aborted.",
        );
      row = { ...row, status: "aborted" };
    }
    if (row.uploadId) {
      try {
        await this.provider.abort({ ...row, uploadId: row.uploadId });
      } catch (error) {
        await this.env.DB.prepare(
          `UPDATE file_multipart_uploads SET last_error = ?, updated_at = unixepoch()
          WHERE version_id = ? AND event_id = ? AND status = 'aborted'`,
        )
          .bind(
            (error instanceof Error ? error.message : String(error)).slice(
              0,
              2_000,
            ),
            row.versionId,
            actor.eventId,
          )
          .run();
        throw new FileMultipartIncompleteError(
          "File access was revoked, but the incomplete R2 multipart upload could not be aborted. Retry abort.",
          true,
          { cause: error },
        );
      }
      await this.env.DB.prepare(
        `UPDATE file_multipart_uploads
            SET last_error = NULL, updated_at = unixepoch()
          WHERE version_id = ? AND event_id = ? AND status = 'aborted'`,
      )
        .bind(row.versionId, actor.eventId)
        .run();
    }
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, metadata_json, created_at
       ) VALUES (?, ?, ?, 1, ?, ?, ?, 'file.multipart.aborted', 'file_version', ?, ?, unixepoch())`,
    )
      .bind(
        `file-multipart-abort:${row.versionId}`,
        auditProvenance.actorKind,
        auditProvenance.origin,
        actor.organisationId,
        actor.eventId,
        actor.personId,
        row.versionId,
        JSON.stringify({ assetId: row.assetId }),
      )
      .run();
    return { versionId: row.versionId, aborted: true };
  }
}

export type { FileScanQueueMessage };
