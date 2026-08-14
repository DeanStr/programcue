import { z } from "zod";

import {
  FileScanConflictError,
  FileScanStateError,
  FileVersionNotFoundError,
} from "./file-service-errors";

export const scanResultSchema = z
  .object({
    jobId: z.string().min(1).max(200),
    attempt: z.number().int().positive(),
    organisationId: z.string().min(1).max(160),
    eventId: z.string().min(1).max(160),
    versionId: z.string().min(1).max(160),
    assetId: z.string().min(1).max(160),
    objectKey: z.string().min(1).max(1_024),
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

type ScanResultInput = z.infer<typeof scanResultSchema>;

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

function classifyScanReplay(
  candidate: ScanRow,
  input: ScanResultInput,
  scanResultJson: string,
) {
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
}

export class FileScanResultService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private requireBucket() {
    if (!this.env.FILES)
      throw new Error("Required private R2 binding FILES is unavailable.");
    return this.env.FILES;
  }

  private loadScanRow(eventId: string, versionId: string) {
    return this.env.DB.prepare(
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
      .bind(versionId, eventId)
      .first<ScanRow>();
  }

  private async commitScanVerdict(
    input: ScanResultInput,
    row: ScanRow,
    scanResultJson: string,
  ) {
    const scanOperationId = `file-scan:${row.id}:attempt:${input.attempt}`;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO audit_events (
          id, organisation_id, event_id, actor_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, event.organisation_id, version.event_id, ?, ?,
               'file_version', version.id, ?, ?, unixepoch()
          FROM file_versions version
          JOIN events event
            ON event.id = version.event_id AND event.organisation_id = ?
         WHERE version.id = ? AND version.event_id = ?
           AND version.asset_id = ? AND version.object_key = ?
           AND version.object_etag = ? AND version.size_bytes = ?
           AND version.scan_status = 'pending'
           AND version.upload_status = 'uploaded'
           AND version.signature_status = 'valid'
           AND version.deleted_at IS NULL
           AND EXISTS (
             SELECT 1 FROM operation_jobs operation
              WHERE operation.id = ?
                AND operation.organisation_id = event.organisation_id
                AND operation.event_id = version.event_id
                AND operation.type = 'file.scan.dispatch'
                AND operation.status = 'running'
                AND operation.attempt_count = ?
                AND json_extract(operation.result_json, '$.scanAttempt') = ?
                AND json_extract(operation.payload_json, '$.objectKey') = version.object_key
           )
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
        input.organisationId,
        row.id,
        input.eventId,
        row.assetId,
        input.objectKey,
        input.objectEtag,
        input.sizeBytes,
        input.jobId,
        input.attempt,
        input.attempt,
      ),
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
             SELECT 1 FROM audit_events verdict_audit
              WHERE verdict_audit.id = ?
                AND verdict_audit.organisation_id = ?
                AND verdict_audit.event_id = file_versions.event_id
                AND verdict_audit.action = ?
                AND verdict_audit.entity_type = 'file_version'
                AND verdict_audit.entity_id = file_versions.id
           )
           AND EXISTS (
             SELECT 1 FROM operation_jobs operation
              WHERE operation.id = ? AND operation.event_id = file_versions.event_id
                AND operation.organisation_id = ?
                AND operation.type = 'file.scan.dispatch'
                AND operation.status = 'running'
                AND operation.attempt_count = ?
                AND json_extract(operation.result_json, '$.scanAttempt') = ?
                AND (
                  (
                    operation.claim_token IS NULL
                    AND json_extract(operation.result_json, '$.accepted') = 1
                  )
                  OR json_extract(operation.result_json, '$.dispatchStarted') = 1
                )
                AND json_extract(operation.payload_json, '$.operationId') = ?
                AND json_extract(operation.payload_json, '$.organisationId') = ?
                AND json_extract(operation.payload_json, '$.eventId') = file_versions.event_id
                AND json_extract(operation.payload_json, '$.versionId') = file_versions.id
                AND json_extract(operation.payload_json, '$.assetId') = file_versions.asset_id
                AND json_extract(operation.payload_json, '$.objectKey') = file_versions.object_key
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
        scanOperationId,
        input.organisationId,
        `file.scan.${input.status}`,
        input.jobId,
        input.organisationId,
        input.attempt,
        input.attempt,
        input.jobId,
        input.organisationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE operation_jobs
           SET status = CASE WHEN ? = 'failed' THEN 'failed' ELSE 'completed' END,
               progress_completed = CASE WHEN ? = 'failed' THEN 0 ELSE 1 END,
               progress_failed = CASE WHEN ? = 'failed' THEN 1 ELSE 0 END,
               result_json = json_object(
                 'accepted', true,
                 'callbackReceived', true,
                 'scanStatus', ?,
                 'scanAttempt', ?
               ),
               last_error = CASE WHEN ? = 'failed' THEN ? ELSE NULL END,
               claim_token = NULL,
               claim_expires_at = NULL, completed_at = unixepoch(),
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND organisation_id = ?
           AND type = 'file.scan.dispatch'
           AND status = 'running'
           AND attempt_count = ?
           AND json_extract(result_json, '$.scanAttempt') = ?
           AND (
             (claim_token IS NULL AND json_extract(result_json, '$.accepted') = 1)
             OR json_extract(result_json, '$.dispatchStarted') = 1
           )
           AND json_extract(payload_json, '$.operationId') = ?
           AND json_extract(payload_json, '$.organisationId') = ?
           AND json_extract(payload_json, '$.versionId') = ?
           AND json_extract(payload_json, '$.assetId') = ?
           AND json_extract(payload_json, '$.objectKey') = ?
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
        input.status,
        input.status,
        input.status,
        input.attempt,
        input.status,
        input.error ?? null,
        input.jobId,
        input.eventId,
        input.organisationId,
        input.attempt,
        input.attempt,
        input.jobId,
        input.organisationId,
        row.id,
        row.assetId,
        input.objectKey,
        input.objectEtag,
        input.sizeBytes,
        row.id,
        row.assetId,
        input.status,
        input.provider,
        scanResultJson,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type,
           correlation_id, created_at
         )
         SELECT ?, 'file_version', ?, 'updated', ?, unixepoch()
          WHERE changes() = 1
            AND EXISTS (
              SELECT 1 FROM file_versions version
               WHERE version.id = ? AND version.event_id = ?
                 AND version.asset_id = ? AND version.scan_status = ?
                 AND version.scan_provider = ?
                 AND version.scan_result_json = ?
            )
         RETURNING sequence`,
      ).bind(
        input.eventId,
        row.id,
        scanOperationId,
        row.id,
        input.eventId,
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
           AND ? = 'infected'
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
           AND evidence.file_asset_id = ? AND ? = 'infected'
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
               status = CASE
                 WHEN ? = 'clean' THEN 'active'
                 WHEN ? = 'infected' AND current_version_id IS NULL THEN 'rejected'
                 ELSE status
               END,
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
        input.status,
        row.assetId,
        input.eventId,
        row.id,
        input.status,
        input.status,
      ),
    ]);
    if (
      (results[0]?.meta.changes ?? 0) === 1 &&
      (results[1]?.meta.changes ?? 0) === 1 &&
      (results[2]?.meta.changes ?? 0) === 1 &&
      (results[3]?.meta.changes ?? 0) === 1
    ) {
      return {
        applied: true,
        duplicate: false,
        status: input.status,
      } as const;
    }
    if (
      (results[0]?.meta.changes ?? 0) !== 0 ||
      (results[1]?.meta.changes ?? 0) !== 0 ||
      (results[2]?.meta.changes ?? 0) !== 0 ||
      (results[3]?.meta.changes ?? 0) !== 0
    ) {
      throw new FileScanStateError(
        "The scan result changed the file without completing its durable dispatch.",
      );
    }
    const current = await this.loadScanRow(input.eventId, input.versionId);
    if (!current) throw new FileVersionNotFoundError();
    return classifyScanReplay(current, input, scanResultJson);
  }
  async recordScanResult(rawInput: z.input<typeof scanResultSchema>) {
    const input = scanResultSchema.parse(rawInput);
    const scanResultJson = JSON.stringify({
      callbackId: input.callbackId,
      attempt: input.attempt,
      result: input.result,
    });
    if (!scanResultJson) {
      throw new FileScanStateError(
        "The scanner result could not be represented as JSON.",
      );
    }

    const row = await this.loadScanRow(input.eventId, input.versionId);
    if (!row) throw new FileVersionNotFoundError();
    if (
      input.jobId !== `file-scan-dispatch:${row.id}` ||
      input.assetId !== row.assetId ||
      input.objectKey !== row.objectKey ||
      input.objectEtag !== row.objectEtag ||
      input.sizeBytes !== row.sizeBytes
    ) {
      throw new FileScanStateError(
        "The scanner callback does not match the dispatched file object.",
      );
    }
    const dispatch = await this.env.DB.prepare(
      `SELECT status, attempt_count AS attemptCount,
              claim_token AS claimToken,
              json_extract(result_json, '$.accepted') AS accepted,
              json_extract(result_json, '$.dispatchStarted') AS dispatchStarted,
              json_extract(result_json, '$.scanAttempt') AS scanAttempt
         FROM operation_jobs
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'file.scan.dispatch'
          AND json_extract(payload_json, '$.operationId') = ?
          AND json_extract(payload_json, '$.organisationId') = ?
          AND json_extract(payload_json, '$.eventId') = ?
          AND json_extract(payload_json, '$.versionId') = ?
          AND json_extract(payload_json, '$.assetId') = ?
          AND json_extract(payload_json, '$.objectKey') = ?
          AND json_extract(payload_json, '$.objectEtag') = ?
          AND json_extract(payload_json, '$.sizeBytes') = ?`,
    )
      .bind(
        input.jobId,
        input.eventId,
        input.organisationId,
        input.jobId,
        input.organisationId,
        input.eventId,
        input.versionId,
        input.assetId,
        input.objectKey,
        input.objectEtag,
        input.sizeBytes,
      )
      .first<{
        status: string;
        attemptCount: number;
        claimToken: string | null;
        accepted: number | null;
        dispatchStarted: number | null;
        scanAttempt: number | null;
      }>();
    if (!dispatch) {
      throw new FileScanStateError(
        "The scanner callback does not match a durable dispatch.",
      );
    }
    if (
      dispatch.attemptCount !== input.attempt ||
      dispatch.scanAttempt !== input.attempt
    ) {
      throw new FileScanStateError(
        "The scanner callback belongs to a stale dispatch attempt.",
      );
    }
    if (row.scanStatus !== "pending") {
      const expectedDispatchStatus =
        row.scanStatus === "failed" ? "failed" : "completed";
      if (dispatch.status !== expectedDispatchStatus) {
        throw new FileScanStateError(
          "The settled scan is not linked to the matching dispatch outcome.",
        );
      }
      return classifyScanReplay(row, input, scanResultJson);
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

    return this.commitScanVerdict(input, row, scanResultJson);
  }
}
