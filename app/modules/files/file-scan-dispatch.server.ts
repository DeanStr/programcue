import { z } from "zod";
import { readBoundedResponseText } from "~/platform/http/read-response";
import {
  QueueClaimLeaseBusyError,
  QueueClaimLeaseLostError,
} from "../../../workers/queue/claim-infrastructure";

// Covers the Workflow's roughly three-hour capacity window plus its bounded
// scan and callback retries without making a healthy in-flight scan retryable.
const FILE_SCAN_CALLBACK_LEASE_SECONDS = 6 * 60 * 60;

export const fileScanQueueMessageSchema = z.object({
  type: z.literal("file.scan.dispatch"),
  operationId: z.string().min(1).max(160),
  organisationId: z.string().min(1).max(160),
  eventId: z.string().min(1).max(160),
  versionId: z.string().min(1).max(160),
  assetId: z.string().min(1).max(160),
  objectKey: z.string().min(1).max(1_024),
  objectEtag: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive().max(1_073_741_824),
  idempotencyKey: z.string().min(1).max(200),
});

export type FileScanQueueMessage = z.infer<typeof fileScanQueueMessageSchema>;

export type FileScanDispatchConfigurationReason =
  | "scanner-endpoint"
  | "scanner-credentials"
  | "callback-endpoint"
  | "queue-binding"
  | "storage-binding";

export class FileScanDispatchConfigurationError extends Error {
  constructor(
    message: string,
    readonly reason: FileScanDispatchConfigurationReason,
  ) {
    super(message);
    this.name = "FileScanDispatchConfigurationError";
  }
}

export class FileScanDispatchQueueError extends Error {
  constructor(
    readonly operationId: string,
    options?: ErrorOptions,
  ) {
    super(
      "The upload is quarantined, but the malware scan could not be queued. Retry completion to dispatch it again.",
      options,
    );
    this.name = "FileScanDispatchQueueError";
  }
}

export class FileScanDispatchIntegrityError extends Error {
  constructor() {
    super(
      "The quarantined R2 object is missing or no longer matches the queued scan request.",
    );
    this.name = "FileScanDispatchIntegrityError";
  }
}

function requireScannerConfiguration(env: CloudflareEnvironment) {
  const rawUrl = env.FILE_SCANNER_API_URL?.trim();
  if (!rawUrl)
    throw new FileScanDispatchConfigurationError(
      "FILE_SCANNER_API_URL is required to dispatch malware scans.",
      "scanner-endpoint",
    );
  let endpoint: URL;
  try {
    endpoint = new URL(rawUrl);
  } catch {
    throw new FileScanDispatchConfigurationError(
      "FILE_SCANNER_API_URL must be a valid absolute URL.",
      "scanner-endpoint",
    );
  }
  if (endpoint.protocol !== "https:")
    throw new FileScanDispatchConfigurationError(
      "FILE_SCANNER_API_URL must use HTTPS.",
      "scanner-endpoint",
    );
  const dispatchSecret = env.FILE_SCANNER_DISPATCH_SECRET?.trim();
  if (!dispatchSecret || dispatchSecret.length < 32)
    throw new FileScanDispatchConfigurationError(
      "FILE_SCANNER_DISPATCH_SECRET must contain at least 32 characters.",
      "scanner-credentials",
    );
  const callbackBase = env.BETTER_AUTH_URL?.trim();
  if (!callbackBase)
    throw new FileScanDispatchConfigurationError(
      "BETTER_AUTH_URL is required to build the scanner callback URL.",
      "callback-endpoint",
    );
  let callback: URL;
  try {
    callback = new URL("/api/webhooks/file-scanner", callbackBase);
  } catch {
    throw new FileScanDispatchConfigurationError(
      "BETTER_AUTH_URL must be a valid absolute URL.",
      "callback-endpoint",
    );
  }
  const permitsLocalHttp =
    String(env.APP_ENV) !== "production" &&
    callback.protocol === "http:" &&
    ["localhost", "127.0.0.1"].includes(callback.hostname);
  if (callback.protocol !== "https:" && !permitsLocalHttp)
    throw new FileScanDispatchConfigurationError(
      "The scanner callback URL must use HTTPS outside local development.",
      "callback-endpoint",
    );
  return { endpoint, dispatchSecret, callback };
}

function base64(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < view.length; offset += 8_192) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

async function signScannerDispatch(
  rawBody: string,
  timestamp: number,
  secret: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestamp}.${rawBody}`),
  );
  return `v1,${base64(signature)}`;
}

/**
 * Read-only preflight for flows that are about to accept quarantined bytes.
 * Keep this separate from enqueueing so callers can fail before mutating R2 or
 * durable upload state while still treating a later queue send failure as a
 * recoverable post-intent failure.
 */
export function assertFileScanDispatchConfigured(env: CloudflareEnvironment) {
  const configuration = requireScannerConfiguration(env);
  if (!env.OPERATIONS_QUEUE)
    throw new FileScanDispatchConfigurationError(
      "Required OPERATIONS_QUEUE binding is unavailable.",
      "queue-binding",
    );
  return configuration;
}

export async function enqueueFileScan(
  env: CloudflareEnvironment,
  viewer: {
    organisationId: string;
    eventId: string;
    personId: string | null;
  },
  file: {
    versionId: string;
    assetId: string;
    objectKey: string;
    objectEtag: string;
    sizeBytes: number;
  },
) {
  assertFileScanDispatchConfigured(env);
  const operationId = `file-scan-dispatch:${file.versionId}`;
  const idempotencyKey = `file.scan.dispatch:${file.versionId}`;
  const message: FileScanQueueMessage = {
    type: "file.scan.dispatch",
    operationId,
    organisationId: viewer.organisationId,
    eventId: viewer.eventId,
    versionId: file.versionId,
    assetId: file.assetId,
    objectKey: file.objectKey,
    objectEtag: file.objectEtag,
    sizeBytes: file.sizeBytes,
    idempotencyKey,
  };
  const payload = JSON.stringify(message);
  const inserted = await env.DB.prepare(
    `
    INSERT OR IGNORE INTO operation_jobs (
      id, organisation_id, event_id, requested_by_person_id, type,
      idempotency_key, correlation_id, status, payload_json,
      progress_total, progress_completed, progress_failed, cancellable,
      created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'file.scan.dispatch', ?, ?, 'queued', ?, 1, 0, 0, 0,
              unixepoch(), unixepoch())
  `,
  )
    .bind(
      operationId,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      idempotencyKey,
      operationId,
      payload,
    )
    .run();
  let shouldSend = (inserted.meta.changes ?? 0) === 1;
  if (!shouldSend) {
    const existing = await env.DB.prepare(
      `SELECT operation.status, operation.payload_json AS payloadJson,
              operation.claim_expires_at AS claimExpiresAt,
              version.scan_status AS scanStatus
         FROM operation_jobs operation
         JOIN file_versions version
           ON version.id = ? AND version.event_id = operation.event_id
          AND version.asset_id = ?
        WHERE operation.id = ? AND operation.event_id = ?
          AND operation.organisation_id = ?
          AND operation.type = 'file.scan.dispatch'
          AND operation.idempotency_key = ?`,
    )
      .bind(
        file.versionId,
        file.assetId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        idempotencyKey,
      )
      .first<{
        status: string;
        payloadJson: string;
        claimExpiresAt: number | null;
        scanStatus: string;
      }>();
    if (!existing || existing.payloadJson !== payload)
      throw new Error(
        "The durable file-scan operation does not match this file.",
      );
    const now = Math.floor(Date.now() / 1_000);
    if (existing.status === "completed" && existing.scanStatus !== "pending")
      return { operationId, duplicate: true, status: existing.status };
    if (["queued", "received"].includes(existing.status))
      return { operationId, duplicate: true, status: existing.status };
    if (
      existing.status === "running" &&
      existing.claimExpiresAt !== null &&
      existing.claimExpiresAt > now
    )
      return { operationId, duplicate: true, status: existing.status };
    if (existing.status === "running" && existing.claimExpiresAt === null) {
      throw new Error(
        "The pending file-scan operation is missing its callback lease.",
      );
    }
    const reset = await env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'queued', last_error = NULL, claim_token = NULL,
              claim_expires_at = NULL, completed_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND (
            status IN ('queue_failed','failed','partially_failed')
            OR (status = 'running' AND claim_expires_at <= unixepoch())
            OR (
              status = 'completed'
              AND EXISTS (
                SELECT 1 FROM file_versions version
                 WHERE version.id = ? AND version.event_id = operation_jobs.event_id
                   AND version.asset_id = ? AND version.scan_status = 'pending'
              )
            )
          )`,
    )
      .bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        file.versionId,
        file.assetId,
      )
      .run();
    shouldSend = (reset.meta.changes ?? 0) === 1;
    if (!shouldSend)
      return { operationId, duplicate: true, status: existing.status };
  }
  try {
    await env.OPERATIONS_QUEUE.send(message);
  } catch (error) {
    await env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND status = 'queued'`,
    )
      .bind(
        (error instanceof Error ? error.message : String(error)).slice(
          0,
          2_000,
        ),
        operationId,
        viewer.eventId,
      )
      .run();
    throw new FileScanDispatchQueueError(operationId, { cause: error });
  }
  return { operationId, duplicate: false, status: "queued" };
}

export async function processFileScanDispatch(
  rawMessage: unknown,
  env: CloudflareEnvironment,
) {
  const message = fileScanQueueMessageSchema.parse(rawMessage);
  const claimToken = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'running', claim_token = ?, claim_expires_at = unixepoch() + 60,
            started_at = COALESCE(started_at, unixepoch()),
            attempt_count = attempt_count + 1, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'file.scan.dispatch' AND idempotency_key = ?
        AND payload_json = ?
        AND (
          status IN ('queued','queue_failed','retrying','failed')
          OR (status = 'running' AND claim_expires_at <= unixepoch())
        )
      RETURNING attempt_count AS attemptCount`,
  )
    .bind(
      claimToken,
      message.operationId,
      message.eventId,
      message.organisationId,
      message.idempotencyKey,
      JSON.stringify(message),
    )
    .first<{ attemptCount: number }>();
  if (!claimed) {
    const settled = await env.DB.prepare(
      `SELECT status, claim_expires_at AS claimExpiresAt FROM operation_jobs
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'file.scan.dispatch' AND idempotency_key = ?
          AND payload_json = ?`,
    )
      .bind(
        message.operationId,
        message.eventId,
        message.organisationId,
        message.idempotencyKey,
        JSON.stringify(message),
      )
      .first<{ status: string; claimExpiresAt: number | null }>();
    if (settled?.status === "completed" || settled?.status === "cancelled")
      return { duplicate: true };
    if (
      settled?.status === "running" &&
      settled.claimExpiresAt !== null &&
      settled.claimExpiresAt > Math.floor(Date.now() / 1_000)
    )
      throw new QueueClaimLeaseBusyError();
    throw new Error("The file scan operation is not available for processing.");
  }

  try {
    const eligible = await env.DB.prepare(
      `SELECT version.id, version.scan_status AS scanStatus
         FROM file_versions version
         JOIN file_assets asset
           ON asset.id = version.asset_id AND asset.event_id = version.event_id
         JOIN file_multipart_uploads upload
           ON upload.version_id = version.id
          AND upload.event_id = version.event_id
          AND upload.asset_id = asset.id
         JOIN events event
           ON event.id = version.event_id AND event.organisation_id = ?
        WHERE version.id = ? AND version.event_id = ? AND asset.id = ?
          AND version.object_key = ? AND version.object_etag = ?
          AND version.size_bytes = ?
          AND version.upload_status = 'uploaded'
          AND version.signature_status = 'valid'
          AND version.scan_status IN ('pending','failed')
          AND version.released_at IS NULL AND version.replaced_at IS NULL
          AND version.deleted_at IS NULL
          AND asset.status IN ('pending','active')
          AND upload.status = 'completed'
          AND NOT EXISTS (
            SELECT 1 FROM audit_events erasure
             WHERE erasure.id = 'file-erasure:' || asset.id
          )`,
    )
      .bind(
        message.organisationId,
        message.versionId,
        message.eventId,
        message.assetId,
        message.objectKey,
        message.objectEtag,
        message.sizeBytes,
      )
      .first<{ scanStatus: "pending" | "failed" }>();
    if (!eligible) {
      const result = JSON.stringify({
        accepted: false,
        skipped: true,
        reason: "file_unavailable",
      });
      const results = await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id, action, entity_type, entity_id,
             correlation_id, metadata_json, created_at
           )
           SELECT ?, 'system', 'queue', 1, ?, ?, 'file.scan.dispatch_skipped', 'file_version', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM operation_jobs
               WHERE id = ? AND event_id = ? AND organisation_id = ?
                 AND status = 'running' AND claim_token = ?
            )`,
        ).bind(
          `file-scan-dispatch-skipped:${message.versionId}`,
          message.organisationId,
          message.eventId,
          message.versionId,
          message.operationId,
          JSON.stringify({
            assetId: message.assetId,
            reason: "file_unavailable",
          }),
          message.operationId,
          message.eventId,
          message.organisationId,
          claimToken,
        ),
        env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'completed', progress_completed = 1,
                  progress_failed = 0, result_json = ?, last_error = NULL,
                  claim_token = NULL, claim_expires_at = NULL,
                  completed_at = unixepoch(), updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND organisation_id = ?
              AND claim_token = ? AND status = 'running'
              AND EXISTS (
                SELECT 1 FROM audit_events audit
                 WHERE audit.id = ?
                   AND audit.organisation_id = operation_jobs.organisation_id
                   AND audit.event_id = operation_jobs.event_id
                   AND audit.action = 'file.scan.dispatch_skipped'
                   AND audit.entity_type = 'file_version'
                   AND audit.entity_id = ?
              )`,
        ).bind(
          result,
          message.operationId,
          message.eventId,
          message.organisationId,
          claimToken,
          `file-scan-dispatch-skipped:${message.versionId}`,
          message.versionId,
        ),
      ]);
      if ((results[1].meta.changes ?? 0) !== 1) {
        const settled = await env.DB.prepare(
          `SELECT status FROM operation_jobs
            WHERE id = ? AND event_id = ? AND organisation_id = ?
              AND type = 'file.scan.dispatch' AND idempotency_key = ?`,
        )
          .bind(
            message.operationId,
            message.eventId,
            message.organisationId,
            message.idempotencyKey,
          )
          .first<{ status: string }>();
        if (["completed", "cancelled"].includes(settled?.status ?? ""))
          return { duplicate: true };
        throw new QueueClaimLeaseLostError();
      }
      return { duplicate: false, skipped: true };
    }
    if (!env.FILES)
      throw new FileScanDispatchConfigurationError(
        "Required private R2 binding FILES is unavailable.",
        "storage-binding",
      );
    const object = await env.FILES.head(message.objectKey);
    if (
      !object ||
      object.httpEtag !== message.objectEtag ||
      object.size !== message.sizeBytes ||
      !object.customMetadata ||
      object.customMetadata.eventId !== message.eventId ||
      object.customMetadata.assetId !== message.assetId ||
      object.customMetadata.versionId !== message.versionId ||
      object.customMetadata.quarantine !== "pending-scan"
    ) {
      throw new FileScanDispatchIntegrityError();
    }
    if (eligible.scanStatus === "failed") {
      const reset = await env.DB.prepare(
        `UPDATE file_versions
            SET scan_status = 'pending', scan_provider = NULL,
                scan_result_json = NULL, scan_error = NULL,
                scanned_at = NULL, released_at = NULL
          WHERE id = ? AND event_id = ? AND asset_id = ?
            AND object_key = ? AND object_etag = ? AND size_bytes = ?
            AND upload_status = 'uploaded' AND signature_status = 'valid'
            AND scan_status = 'failed' AND deleted_at IS NULL
            AND EXISTS (
              SELECT 1 FROM operation_jobs operation
               WHERE operation.id = ? AND operation.event_id = file_versions.event_id
                 AND operation.organisation_id = ?
                 AND operation.type = 'file.scan.dispatch'
                 AND operation.status = 'running' AND operation.claim_token = ?
                 AND operation.payload_json = ?
            )`,
      )
        .bind(
          message.versionId,
          message.eventId,
          message.assetId,
          message.objectKey,
          message.objectEtag,
          message.sizeBytes,
          message.operationId,
          message.organisationId,
          claimToken,
          JSON.stringify(message),
        )
        .run();
      if ((reset.meta.changes ?? 0) !== 1) {
        throw new Error(
          "The failed file scan changed before it could be retried.",
        );
      }
    }
    const configuration = requireScannerConfiguration(env);
    const dispatchStartedResult = JSON.stringify({
      dispatchStarted: true,
      scanAttempt: claimed.attemptCount,
    });
    const markedStarted = await env.DB.prepare(
      `UPDATE operation_jobs
          SET result_json = ?, last_error = NULL, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'file.scan.dispatch' AND status = 'running'
          AND claim_token = ?`,
    )
      .bind(
        dispatchStartedResult,
        message.operationId,
        message.eventId,
        message.organisationId,
        claimToken,
      )
      .run();
    if ((markedStarted.meta.changes ?? 0) !== 1) {
      const settled = await env.DB.prepare(
        `SELECT status FROM operation_jobs
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'file.scan.dispatch' AND idempotency_key = ?`,
      )
        .bind(
          message.operationId,
          message.eventId,
          message.organisationId,
          message.idempotencyKey,
        )
        .first<{ status: string }>();
      if (settled?.status === "completed") return { duplicate: true };
      throw new QueueClaimLeaseLostError();
    }
    const dispatchTimestamp = Math.floor(Date.now() / 1_000);
    const rawDispatch = JSON.stringify({
      jobId: message.operationId,
      attempt: claimed.attemptCount,
      organisationId: message.organisationId,
      eventId: message.eventId,
      versionId: message.versionId,
      assetId: message.assetId,
      expiresAt: dispatchTimestamp + 300,
      object: {
        key: message.objectKey,
        sizeBytes: message.sizeBytes,
        etag: message.objectEtag,
      },
      callback: {
        url: configuration.callback.toString(),
        authentication: "program-cue-hmac-sha256-v1",
      },
    });
    const dispatchSignature = await signScannerDispatch(
      rawDispatch,
      dispatchTimestamp,
      configuration.dispatchSecret,
    );
    const response = await fetch(configuration.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": `${message.operationId}:attempt:${claimed.attemptCount}`,
        "x-program-cue-dispatch-timestamp": String(dispatchTimestamp),
        "x-program-cue-dispatch-signature": dispatchSignature,
      },
      body: rawDispatch,
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const details = await readBoundedResponseText(response, 500);
      throw new Error(
        `Scanner dispatch failed with HTTP ${response.status}${details ? `: ${details}` : "."}`,
      );
    }
    const result = JSON.stringify({
      accepted: true,
      status: response.status,
      scanAttempt: claimed.attemptCount,
    });
    const dispatchAuditId = `file-scan-dispatched:${message.versionId}:attempt:${claimed.attemptCount}`;
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, action, entity_type, entity_id,
           correlation_id, metadata_json, created_at
         )
         SELECT ?, 'system', 'queue', 1, ?, ?, 'file.scan.dispatched', 'file_version', ?, ?, ?, unixepoch()
           WHERE EXISTS (
            SELECT 1 FROM operation_jobs
             WHERE id = ? AND event_id = ? AND organisation_id = ?
               AND (
                 (status = 'running' AND claim_token = ?)
                 OR (
                   status = 'completed'
                   AND json_extract(result_json, '$.callbackReceived') = 1
                 )
               )
          )`,
      ).bind(
        dispatchAuditId,
        message.organisationId,
        message.eventId,
        message.versionId,
        message.operationId,
        JSON.stringify({
          assetId: message.assetId,
          attempt: claimed.attemptCount,
        }),
        message.operationId,
        message.eventId,
        message.organisationId,
        claimToken,
      ),
      env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'running', progress_completed = 0,
                progress_failed = 0, result_json = ?, last_error = NULL,
                claim_token = NULL,
                claim_expires_at = unixepoch() + ${FILE_SCAN_CALLBACK_LEASE_SECONDS},
                completed_at = NULL, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND claim_token = ? AND status = 'running'
            AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ?
                 AND audit.organisation_id = operation_jobs.organisation_id
                 AND audit.event_id = operation_jobs.event_id
                 AND audit.action = 'file.scan.dispatched'
                 AND audit.entity_type = 'file_version'
                 AND audit.entity_id = ?
            )`,
      ).bind(
        result,
        message.operationId,
        message.eventId,
        message.organisationId,
        claimToken,
        dispatchAuditId,
        message.versionId,
      ),
    ]);
    if ((results[1].meta.changes ?? 0) !== 1) {
      const settled = await env.DB.prepare(
        `SELECT status, result_json AS resultJson, claim_token AS claimToken
           FROM operation_jobs
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'file.scan.dispatch' AND idempotency_key = ?`,
      )
        .bind(
          message.operationId,
          message.eventId,
          message.organisationId,
          message.idempotencyKey,
        )
        .first<{
          status: string;
          resultJson: string | null;
          claimToken: string | null;
        }>();
      if (
        settled?.status === "completed" ||
        (settled?.status === "running" &&
          settled.claimToken === null &&
          settled.resultJson === result)
      )
        return { duplicate: true };
      throw new QueueClaimLeaseLostError();
    }
    return { duplicate: false, awaitingCallback: true };
  } catch (error) {
    await env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'failed', progress_failed = 1,
              last_error = ?, claim_token = NULL, claim_expires_at = NULL,
              completed_at = unixepoch(), updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND claim_token = ? AND status = 'running'`,
    )
      .bind(
        (error instanceof Error ? error.message : String(error)).slice(
          0,
          2_000,
        ),
        message.operationId,
        message.eventId,
        claimToken,
      )
      .run();
    throw error;
  }
}
