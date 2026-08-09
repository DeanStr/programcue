import {
  EventRealtimeService,
  type RecordEventChangeInput,
} from "~/platform/realtime/event-realtime.server";

import type { ApiPrincipal } from "./api.server";

export type ApiRealtimeResult = {
  changeCursor: number | null;
  realtimeWarning: string | null;
};

function warning(error: unknown) {
  const cause = error instanceof Error ? error.message : String(error);
  return `The mutation committed, but live invalidation failed: ${cause} Poll the event change cursor before continuing.`;
}

export async function notifyApiChange(
  env: CloudflareEnvironment,
  principal: ApiPrincipal & { eventId: string },
  sequence: number,
  entityId: string,
): Promise<ApiRealtimeResult> {
  try {
    await new EventRealtimeService(env).notifyCommittedChange(
      principal,
      sequence,
    );
    return { changeCursor: sequence, realtimeWarning: null };
  } catch (error) {
    return {
      changeCursor: sequence,
      realtimeWarning: `${warning(error)} Committed entity: ${entityId}.`,
    };
  }
}

export async function recordApiChange(
  env: CloudflareEnvironment,
  principal: ApiPrincipal & { eventId: string },
  input: RecordEventChangeInput,
): Promise<ApiRealtimeResult> {
  const service = new EventRealtimeService(env);
  let change;
  try {
    change = await service.commitChange(principal, input);
  } catch (error) {
    return { changeCursor: null, realtimeWarning: warning(error) };
  }
  try {
    await service.notifyCommittedChange(principal, change.cursor);
    return { changeCursor: change.cursor, realtimeWarning: null };
  } catch (error) {
    return { changeCursor: change.cursor, realtimeWarning: warning(error) };
  }
}
