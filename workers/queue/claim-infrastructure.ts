import { EventRealtimeService } from "../../app/platform/realtime/event-realtime.server";
import { sourceRevisionForLog } from "../../app/platform/observability/source-revision.server";

export const QUEUE_CLAIM_LEASE_SECONDS = 60;

export class QueueClaimLeaseBusyError extends Error {
  readonly retryAfterSeconds = QUEUE_CLAIM_LEASE_SECONDS;

  constructor() {
    super(
      "This operation is already being processed under an active Queue claim lease.",
    );
    this.name = "QueueClaimLeaseBusyError";
  }
}

export class QueueClaimLeaseLostError extends Error {
  constructor() {
    super(
      "The Queue claim lease changed before the provider result could be recorded.",
    );
    this.name = "QueueClaimLeaseLostError";
  }
}

export type OperationClaimState = {
  status: string;
  claimToken: string | null;
  claimExpiresAt: number | null;
};

export async function loadOperationClaim(
  env: CloudflareEnvironment,
  operationId: string,
  eventId: string,
) {
  return env.DB.prepare(
    `
    SELECT status, claim_token AS claimToken, claim_expires_at AS claimExpiresAt
      FROM operation_jobs WHERE id = ? AND event_id = ?
  `,
  )
    .bind(operationId, eventId)
    .first<OperationClaimState>();
}

export async function renewOperationClaim(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  operationId: string,
  claimToken: string,
) {
  const renewed = await env.DB.prepare(
    `
    UPDATE operation_jobs
       SET claim_expires_at = unixepoch() + ?, updated_at = unixepoch()
     WHERE id = ? AND event_id = ? AND organisation_id = ?
       AND status = 'running' AND claim_token = ?
  `,
  )
    .bind(
      QUEUE_CLAIM_LEASE_SECONDS,
      operationId,
      scope.eventId,
      scope.organisationId,
      claimToken,
    )
    .run();
  if ((renewed.meta.changes ?? 0) !== 1) throw new QueueClaimLeaseLostError();
}

export async function assertOperationClaim(
  env: CloudflareEnvironment,
  operationId: string,
  eventId: string,
  claimToken: string,
) {
  const claim = await loadOperationClaim(env, operationId, eventId);
  if (claim?.status !== "running" || claim.claimToken !== claimToken) {
    throw new QueueClaimLeaseLostError();
  }
}

export function errorDetails(error: unknown) {
  return {
    code:
      error instanceof Error
        ? error.name.slice(0, 120)
        : "UNKNOWN_PROVIDER_ERROR",
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      2_000,
    ),
  };
}

export function returnedChangeSequence(
  result: { results?: unknown[] } | undefined,
) {
  const row = result?.results?.[0] as { sequence?: unknown } | undefined;
  return typeof row?.sequence === "number" && Number.isSafeInteger(row.sequence)
    ? row.sequence
    : null;
}

/**
 * Provider and D1 results are already committed at this boundary. A realtime
 * failure is recorded as an operation warning and logged, while authoritative
 * cursor polling remains available; it must never turn a successful provider
 * call into another delivery attempt.
 */
export async function notifyRealtimeAfterCommit(
  env: CloudflareEnvironment,
  scope: { organisationId: string; eventId: string },
  sequence: number | null,
  operationId: string,
) {
  let warningKind: "missing-sequence" | "delivery-failed" | null =
    sequence === null ? "missing-sequence" : null;
  let warning: string | null =
    sequence === null
      ? "The committed event change did not return a sequence."
      : null;
  if (sequence !== null) {
    try {
      await new EventRealtimeService(env).notifyCommittedChange(
        scope,
        sequence,
      );
    } catch (error) {
      warningKind = "delivery-failed";
      warning = `Realtime invalidation failed after commit: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  if (!warning) return;
  const message = warning.slice(0, 2_000);
  try {
    await env.DB.prepare(
      `UPDATE operation_jobs
      SET result_json = json_set(COALESCE(result_json, '{}'), '$.realtimeWarning', ?), updated_at = unixepoch()
      WHERE id = ? AND event_id = ?`,
    )
      .bind(message, operationId, scope.eventId)
      .run();
  } catch (error) {
    console.error(
      JSON.stringify({
        level: "error",
        sourceRevision: sourceRevisionForLog(env),
        subsystem: "realtime-invalidation",
        event: "warning-persistence-failed",
        operationId,
        eventId: scope.eventId,
        errorName: error instanceof Error ? error.name : "UnknownError",
        message: "The committed realtime warning could not be persisted.",
      }),
    );
  }
  console.warn(
    JSON.stringify({
      level: "warning",
      sourceRevision: sourceRevisionForLog(env),
      subsystem: "realtime-invalidation",
      event: "delivery-degraded",
      operationId,
      eventId: scope.eventId,
      changeSequence: sequence,
      warningKind,
      message: "Realtime invalidation was degraded after commit.",
    }),
  );
}
