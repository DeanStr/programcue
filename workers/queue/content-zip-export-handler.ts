import { ContentArchiveService } from "../../app/modules/content/content-archive-service.server";
import { contentZipQueueMessageSchema } from "../../app/modules/content/content-schema";
import {
  errorDetails,
  loadOperationClaim,
  QUEUE_CLAIM_LEASE_SECONDS,
  QueueClaimLeaseBusyError,
} from "./claim-infrastructure";

export async function processContentZipExport(
  input: unknown,
  env: CloudflareEnvironment,
) {
  const message = contentZipQueueMessageSchema.parse(input);
  const operation = await env.DB.prepare(
    `SELECT status, payload_json AS payloadJson
       FROM operation_jobs
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'content.zip.export'
      LIMIT 1`,
  )
    .bind(message.operationId, message.eventId, message.organisationId)
    .first<{ status: string; payloadJson: string }>();
  if (!operation) throw new Error("The ZIP export operation does not exist.");
  if (operation.status === "completed" || operation.status === "failed") return;
  const saved = contentZipQueueMessageSchema.parse(
    JSON.parse(operation.payloadJson),
  );
  if (JSON.stringify(saved) !== JSON.stringify(message)) {
    throw new Error(
      "The ZIP Queue message does not match its durable operation payload.",
    );
  }

  const claimToken = crypto.randomUUID();
  const claim = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'running', started_at = COALESCE(started_at, unixepoch()),
            attempt_count = attempt_count + 1, completed_at = NULL,
            last_error = NULL, claim_token = ?,
            claim_expires_at = unixepoch() + ?, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND organisation_id = ?
        AND type = 'content.zip.export'
        AND (
          status IN ('queued','received','retrying','queue_failed')
          OR (status = 'running' AND COALESCE(claim_expires_at, 0) <= unixepoch())
        )`,
  )
    .bind(
      claimToken,
      QUEUE_CLAIM_LEASE_SECONDS,
      message.operationId,
      message.eventId,
      message.organisationId,
    )
    .run();
  if ((claim.meta.changes ?? 0) !== 1) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (current?.status === "completed" || current?.status === "failed") return;
    if (
      current?.status === "running" &&
      current.claimToken &&
      (current.claimExpiresAt ?? 0) > Math.floor(Date.now() / 1_000)
    ) {
      throw new QueueClaimLeaseBusyError();
    }
    throw new Error("The ZIP export could not claim its durable operation.");
  }

  try {
    if (!env.FILES) {
      throw new Error("Required private R2 binding FILES is unavailable.");
    }
    const viewer = {
      personId: "system-content-zip",
      name: "Program Cue worker",
      email: "",
      role: "administrator" as const,
      organisationId: message.organisationId,
      eventId: message.eventId,
      demo: false,
    };
    const response = await new ContentArchiveService(env).downloadZip(viewer, {
      manifest: message.manifest,
      groupBy: message.groupBy,
      confirmed: true,
    });
    if (!response.body) throw new Error("The ZIP archive has no stream body.");
    const contentLength = Number(response.headers.get("content-length"));
    if (!Number.isSafeInteger(contentLength) || contentLength < 1) {
      throw new Error(
        "The ZIP archive did not provide a valid content length.",
      );
    }
    const objectKey = `private/exports/${message.eventId}/${message.operationId}.zip`;
    const fixedLength = new FixedLengthStream(contentLength);
    const pump = response.body.pipeTo(fixedLength.writable);
    void pump.catch(() => undefined);
    try {
      await env.FILES.put(objectKey, fixedLength.readable, {
        httpMetadata: { contentType: "application/zip" },
      });
      await pump;
    } catch (error) {
      await pump.catch(() => undefined);
      throw error;
    }
    const object = await env.FILES.head(objectKey);
    if (!object?.httpEtag || object.size < 1) {
      throw new Error(
        "The completed ZIP archive could not be verified in private storage.",
      );
    }
    const resultJson = JSON.stringify({
      objectKey,
      objectEtag: object.httpEtag,
      sizeBytes: object.size,
      fileName: `programme-files-by-${message.groupBy}.zip`,
    });
    const completed = await env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'completed', progress_completed = 1,
              progress_failed = 0, result_json = ?, completed_at = unixepoch(),
              claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'content.zip.export' AND status = 'running'
          AND claim_token = ?`,
    )
      .bind(
        resultJson,
        message.operationId,
        message.eventId,
        message.organisationId,
        claimToken,
      )
      .run();
    if ((completed.meta.changes ?? 0) !== 1) {
      throw new Error(
        "The ZIP export claim changed before completion could be recorded.",
      );
    }
  } catch (error) {
    const details = errorDetails(error);
    await env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'failed', progress_completed = 1, progress_failed = 1,
              last_error = ?, completed_at = unixepoch(), claim_token = NULL,
              claim_expires_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'content.zip.export' AND status = 'running'
          AND claim_token = ?`,
    )
      .bind(
        details.message,
        message.operationId,
        message.eventId,
        message.organisationId,
        claimToken,
      )
      .run();
  }
}
