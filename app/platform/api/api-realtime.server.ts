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
  console.error("Failed to complete API live invalidation", {
    errorName: error instanceof Error ? error.name : "UnknownError",
  });
  return "The mutation committed, but live invalidation failed. Poll the event change cursor before continuing.";
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
  let change: Awaited<ReturnType<EventRealtimeService["commitChange"]>>;
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

/**
 * Records one stable change for an exact-replay API command. D1 has a single
 * writer, so the guarded insert makes a retry reuse the original cursor even
 * when the request stopped after the domain mutation committed.
 */
export async function recordIdempotentApiChange(
  env: CloudflareEnvironment,
  principal: ApiPrincipal & { eventId: string },
  input: RecordEventChangeInput & { correlationId: string },
): Promise<ApiRealtimeResult> {
  try {
    await env.DB.prepare(
      `
      INSERT INTO event_changes (
        event_id, entity_type, entity_id, change_type, correlation_id, created_at
      )
      SELECT event.id, ?, ?, ?, ?, unixepoch()
        FROM events event
       WHERE event.id = ? AND event.organisation_id = ?
         AND NOT EXISTS (
           SELECT 1
             FROM event_changes existing
            WHERE existing.event_id = event.id
              AND existing.entity_type = ?
              AND existing.entity_id IS ?
              AND existing.change_type = ?
              AND existing.correlation_id = ?
         )
    `,
    )
      .bind(
        input.entityType,
        input.entityId ?? null,
        input.changeType,
        input.correlationId,
        principal.eventId,
        principal.organisationId,
        input.entityType,
        input.entityId ?? null,
        input.changeType,
        input.correlationId,
      )
      .run();
    const row = await env.DB.prepare(
      `
      SELECT change.sequence
        FROM event_changes change
        JOIN events event ON event.id = change.event_id
       WHERE change.event_id = ? AND event.organisation_id = ?
         AND change.entity_type = ? AND change.entity_id IS ?
         AND change.change_type = ? AND change.correlation_id = ?
       ORDER BY change.sequence
       LIMIT 1
    `,
    )
      .bind(
        principal.eventId,
        principal.organisationId,
        input.entityType,
        input.entityId ?? null,
        input.changeType,
        input.correlationId,
      )
      .first<{ sequence: number }>();
    if (!row) {
      throw new Error("The durable event change was not recorded.");
    }
    return notifyApiChange(env, principal, row.sequence, input.entityId ?? "");
  } catch (error) {
    return { changeCursor: null, realtimeWarning: warning(error) };
  }
}
