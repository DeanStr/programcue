import type {
  EventScope,
  RecordEventChangeInput,
} from "./event-realtime.server";
import {
  EventRealtimeConfigurationError,
  EventRealtimeDeliveryError,
  EventRealtimeService,
} from "./event-realtime.server";

export type CommittedRealtimeFailure = {
  ok: false;
  committed: true;
  entityId: string | null;
  message: string;
};

/**
 * The only thing a broadcast failure asks of the reader: their change is safe,
 * and other open tabs are stale. The cause names nothing they can act on.
 */
const BROADCAST_FAILURE_MESSAGE =
  "Your change was saved, but other open views could not be updated automatically. Refresh them before continuing.";

/**
 * Records the error class and the scope it failed for, which is what narrows a
 * report to a tenant and a failure mode. The message itself is not logged:
 * these causes name configuration variables, and this project keeps those out
 * of logs.
 */
function logBroadcastFailure(
  event: string,
  scope: EventScope,
  error: unknown,
) {
  const diagnostics =
    error instanceof EventRealtimeConfigurationError
      ? { reason: error.reason }
      : error instanceof EventRealtimeDeliveryError
        ? { reason: error.reason, providerStatus: error.status }
        : { reason: "unexpected" };
  console.error(
    JSON.stringify({
      level: "error",
      subsystem: "route-realtime",
      event,
      organisationId: scope.organisationId,
      eventId: scope.eventId,
      errorName: error instanceof Error ? error.name : "UnknownError",
      ...diagnostics,
      message: "A committed change could not be broadcast to open views.",
    }),
  );
}

/**
 * Route mutations call this only after their authoritative storage work
 * commits. A failed invalidation must therefore be reported as degraded
 * delivery, not as a rolled-back mutation that would invite an unsafe retry.
 * Callers return this payload with a 2xx partial-success status, never a
 * retryable 5xx status.
 */
export async function recordRouteChange(
  env: CloudflareEnvironment,
  scope: EventScope,
  input: RecordEventChangeInput,
): Promise<CommittedRealtimeFailure | null> {
  try {
    await new EventRealtimeService(env).recordChange(scope, input);
    return null;
  } catch (error) {
    logBroadcastFailure("record-change-failed", scope, error);
    return {
      ok: false,
      committed: true,
      entityId: input.entityId ?? null,
      message: BROADCAST_FAILURE_MESSAGE,
    };
  }
}

export async function notifyRouteChange(
  env: CloudflareEnvironment,
  scope: EventScope,
  sequence: number,
  entityId: string | null,
): Promise<CommittedRealtimeFailure | null> {
  try {
    await new EventRealtimeService(env).notifyCommittedChange(scope, sequence);
    return null;
  } catch (error) {
    logBroadcastFailure("notify-change-failed", scope, error);
    return {
      ok: false,
      committed: true,
      entityId,
      message: BROADCAST_FAILURE_MESSAGE,
    };
  }
}
