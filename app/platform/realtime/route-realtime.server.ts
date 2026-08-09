import type {
  EventScope,
  RecordEventChangeInput,
} from "./event-realtime.server";
import { EventRealtimeService } from "./event-realtime.server";

export type CommittedRealtimeFailure = {
  ok: false;
  committed: true;
  entityId: string | null;
  message: string;
};

/**
 * Route mutations call this only after their authoritative D1/R2 work commits.
 * A failed invalidation must therefore be reported as degraded delivery, not as
 * a rolled-back mutation that would invite an unsafe retry. Callers return this
 * payload with a 2xx partial-success status, never a retryable 5xx status.
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
    const cause =
      error instanceof Error
        ? error.message
        : "Unknown realtime delivery error.";
    return {
      ok: false,
      committed: true,
      entityId: input.entityId ?? null,
      message: `Your change was saved, but live updates could not be broadcast: ${cause} Refresh other open views before continuing.`,
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
    const cause =
      error instanceof Error
        ? error.message
        : "Unknown realtime delivery error.";
    return {
      ok: false,
      committed: true,
      entityId,
      message: `Your change was saved, but live updates could not be broadcast: ${cause} Refresh other open views before continuing.`,
    };
  }
}
