import {
  ContentArchiveService,
  markContentZipExportStorageCleanupRequired,
  zipExportObjectKey,
} from "../../app/modules/content/content-archive-service.server";
import { contentZipQueueMessageSchema } from "../../app/modules/content/content-schema";
import {
  assertOperationClaim,
  errorDetails,
  loadOperationClaim,
  QUEUE_CLAIM_LEASE_SECONDS,
  QueueClaimLeaseBusyError,
  QueueClaimLeaseLostError,
  renewOperationClaim,
} from "./claim-infrastructure";

async function writeZipWithClaimLease(input: {
  env: CloudflareEnvironment;
  response: Response;
  objectKey: string;
  contentLength: number;
  operationId: string;
  organisationId: string;
  eventId: string;
  claimToken: string;
}) {
  const {
    env,
    response,
    objectKey,
    contentLength,
    operationId,
    organisationId,
    eventId,
    claimToken,
  } = input;
  const bucket = env.FILES;
  if (!bucket) {
    throw new Error("Required private R2 binding FILES is unavailable.");
  }
  if (!response.body) throw new Error("The ZIP archive has no stream body.");
  const fixedLength = new FixedLengthStream(contentLength);
  const pump = response.body.pipeTo(fixedLength.writable);
  const put = bucket.put(objectKey, fixedLength.readable, {
    httpMetadata: { contentType: "application/zip" },
  });
  let renewalInFlight: Promise<void> | null = null;
  let rejectLease: ((reason: unknown) => void) | null = null;
  const leaseLost = new Promise<never>((_resolve, reject) => {
    rejectLease = reject;
  });
  const renew = () => {
    if (renewalInFlight) return;
    renewalInFlight = renewOperationClaim(
      env,
      { organisationId, eventId },
      operationId,
      claimToken,
    )
      .catch((error) => {
        rejectLease?.(error);
        throw error;
      })
      .finally(() => {
        renewalInFlight = null;
      });
  };
  const renewalTimer = setInterval(
    renew,
    Math.max(1_000, Math.floor((QUEUE_CLAIM_LEASE_SECONDS * 1_000) / 3)),
  );
  const transfer = Promise.all([pump, put]);
  try {
    await Promise.race([transfer, leaseLost]);
    await transfer;
  } catch (error) {
    await fixedLength.writable.abort(error).catch(() => undefined);
    await Promise.allSettled([pump, put]);
    throw error;
  } finally {
    clearInterval(renewalTimer);
    const pendingRenewal: Promise<void> | null = renewalInFlight;
    if (pendingRenewal !== null) {
      await Promise.allSettled([pendingRenewal]);
    }
  }
}

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

  let objectKey: string | null = null;
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
    await renewOperationClaim(
      env,
      {
        organisationId: message.organisationId,
        eventId: message.eventId,
      },
      message.operationId,
      claimToken,
    );
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
    objectKey = zipExportObjectKey(
      message.eventId,
      message.operationId,
      claimToken,
    );
    await writeZipWithClaimLease({
      env,
      response,
      objectKey,
      contentLength,
      operationId: message.operationId,
      organisationId: message.organisationId,
      eventId: message.eventId,
      claimToken,
    });
    await assertOperationClaim(
      env,
      message.operationId,
      message.eventId,
      claimToken,
    );
    if (!objectKey) throw new Error("The ZIP export object key was not set.");
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
      claimToken,
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
    let temporaryObjectCleanupFailed = false;
    if (objectKey && env.FILES) {
      try {
        await env.FILES.delete(objectKey);
      } catch (cleanupError) {
        console.error(
          JSON.stringify({
            level: "error",
            subsystem: "content-zip-export",
            event: "temporary-object-cleanup-failed",
            operationId: message.operationId,
            errorName:
              cleanupError instanceof Error
                ? cleanupError.name
                : "UnknownError",
            message:
              "The ZIP export failed, but its claim-specific temporary object could not be deleted.",
          }),
        );
        temporaryObjectCleanupFailed = true;
      }
    }
    const failed = await env.DB.prepare(
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
    if ((failed.meta.changes ?? 0) !== 1) {
      const current = await loadOperationClaim(
        env,
        message.operationId,
        message.eventId,
      );
      if (current?.status === "failed" || current?.status === "cancelled") {
        if (temporaryObjectCleanupFailed) {
          await markContentZipExportStorageCleanupRequired(
            env,
            {
              organisationId: message.organisationId,
              eventId: message.eventId,
            },
            message.operationId,
          );
        }
        return;
      }
      throw new QueueClaimLeaseLostError();
    }
    if (temporaryObjectCleanupFailed) {
      await markContentZipExportStorageCleanupRequired(
        env,
        {
          organisationId: message.organisationId,
          eventId: message.eventId,
        },
        message.operationId,
      );
    }
  }
}
