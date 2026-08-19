import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import type { CalendarProviderName } from "./calendar-schema";
import { hashCalendarPayload } from "./ics.server";

export async function publishedScheduleCalendarIdempotencyKey(input: {
  scheduleVersionId: string;
  method: "REQUEST" | "CANCEL";
  sessionId: string;
  personId: string;
  provider: CalendarProviderName;
}) {
  const digest = await hashCalendarPayload(
    JSON.stringify([
      input.scheduleVersionId,
      input.method,
      input.sessionId,
      input.personId,
      input.provider,
    ]),
  );
  return `schedule-calendar:${digest}`;
}

export type CalendarQueueActor = Pick<Viewer, "organisationId" | "eventId"> & {
  personId: string | null;
};

export type PublishedScheduleCalendarDispatch = {
  targetCount: number;
  processedCount: number;
  queuedCount: number;
  duplicateCount: number;
  nextTarget: string | null;
  dispatchError: string | null;
  failures: Array<{
    sessionId: string;
    personId: string;
    method: "REQUEST" | "CANCEL";
    provider: CalendarProviderName;
    message: string;
  }>;
};

export const SCHEDULE_CALENDAR_FANOUT_BATCH_SIZE = 10;

export const SCHEDULE_CALENDAR_FANOUT_SNAPSHOT_KEY =
  "schedule-calendar-targets";
export const SCHEDULE_CALENDAR_FANOUT_TARGET_TYPE = "schedule_calendar_target";

/** Live and snapshot fan-out must select the same public confirmed speakers. */
export const PUBLIC_CONFIRMED_SCHEDULE_CALENDAR_TARGET_SQL = `
  session.status = 'published'
  AND session.visibility = 'public'
  AND content.visibility = 'public'
  AND ss.participation_status = 'confirmed'
  AND ss.visibility = 'public'
`;

export type PublishedScheduleCalendarTarget = {
  key: string;
  sessionId: string;
  personId: string;
  method: "REQUEST" | "CANCEL";
  provider: CalendarProviderName;
  connectionId: string | null;
};

export const publishedScheduleCalendarTargetSchema = z.object({
  sessionId: z.string().min(1),
  personId: z.string().min(1),
  method: z.enum(["REQUEST", "CANCEL"]),
  provider: z.enum(["email_ics", "google", "microsoft"]),
  connectionId: z.string().min(1).nullable(),
});

/**
 * Captures the exact calendar work selected by a schedule publication. These
 * statements must run in the same D1 batch as the parent operation insert so
 * later Queue continuations never derive work from mutated invitation state.
 */
export function scheduleCalendarFanoutSnapshotStatements(
  env: CloudflareEnvironment,
  viewer: CalendarQueueActor,
  scheduleVersionId: string,
  operationId: string,
) {
  const operationGuard = `EXISTS (
    SELECT 1 FROM operation_jobs operation
     WHERE operation.id = ? AND operation.event_id = ?
       AND operation.organisation_id = ?
       AND operation.type = 'schedule.calendar_fanout'
  )`;
  return [
    env.DB.prepare(
      `
      WITH requested_targets AS (
        SELECT se.session_id AS session_id, ss.person_id AS person_id,
               COALESCE(
                 (SELECT csa.provider FROM calendar_sync_attempts csa
                   WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id),
                 (SELECT cc.provider FROM calendar_connections cc
                   WHERE cc.organisation_id = ? AND cc.person_id = ss.person_id
                     AND cc.status = 'connected' AND (cc.event_id IS NULL OR cc.event_id = ?)
                   ORDER BY CASE cc.provider WHEN 'google' THEN 0 ELSE 1 END,
                            cc.updated_at DESC LIMIT 1),
                 'email_ics'
               ) AS provider,
               COALESCE(
                 ci.connection_id,
                 (SELECT cc.id FROM calendar_connections cc
                   WHERE cc.organisation_id = ? AND cc.person_id = ss.person_id
                     AND cc.status = 'connected' AND (cc.event_id IS NULL OR cc.event_id = ?)
                   ORDER BY CASE cc.provider WHEN 'google' THEN 0 ELSE 1 END,
                            cc.updated_at DESC LIMIT 1)
               ) AS connection_id
          FROM schedule_entries se
          JOIN schedule_versions sv
            ON sv.id = se.schedule_version_id AND sv.event_id = se.event_id
          JOIN schedule_session_contents content
            ON content.schedule_version_id = se.schedule_version_id
           AND content.event_id = se.event_id
           AND content.session_id = se.session_id
          JOIN sessions session
            ON session.id = se.session_id AND session.event_id = se.event_id
          JOIN session_speakers ss
            ON ss.session_id = se.session_id AND ss.event_id = se.event_id
          LEFT JOIN calendar_invitations ci
            ON ci.event_id = se.event_id AND ci.session_id = se.session_id
           AND ci.person_id = ss.person_id
         WHERE se.event_id = ? AND sv.id = ? AND sv.status = 'published'
           AND ${PUBLIC_CONFIRMED_SCHEDULE_CALENDAR_TARGET_SQL}
      )
      INSERT INTO operation_items (
        id, operation_id, item_key, entity_type, entity_id, status, result_json, updated_at
      )
      SELECT lower(hex(randomblob(16))), ?,
             json_array('REQUEST', session_id, person_id, provider),
             ?, session_id, 'pending',
             json_object(
               'sessionId', session_id, 'personId', person_id,
               'method', 'REQUEST', 'provider', provider,
               'connectionId', connection_id
             ), unixepoch()
        FROM requested_targets
       WHERE ${operationGuard}
    `,
    ).bind(
      viewer.organisationId,
      viewer.eventId,
      viewer.organisationId,
      viewer.eventId,
      viewer.eventId,
      scheduleVersionId,
      operationId,
      SCHEDULE_CALENDAR_FANOUT_TARGET_TYPE,
      operationId,
      viewer.eventId,
      viewer.organisationId,
    ),
    env.DB.prepare(
      `
      WITH cancelled_targets AS (
        SELECT ci.session_id AS session_id, ci.person_id AS person_id,
               ci.connection_id AS connection_id,
               COALESCE(
                 (SELECT csa.provider FROM calendar_sync_attempts csa
                   WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id),
                 'email_ics'
               ) AS provider
          FROM calendar_invitations ci
          JOIN events e ON e.id = ci.event_id AND e.organisation_id = ?
         WHERE ci.event_id = ?
           AND (
             ci.status IN ('queued','sent','confirmed')
             OR (
               ci.status = 'failed'
               AND EXISTS (
                 SELECT 1 FROM calendar_sync_attempts delivered_request
                  WHERE delivered_request.invitation_id = ci.id
                    AND delivered_request.method = 'REQUEST'
                    AND delivered_request.status = 'succeeded'
               )
             )
           )
           AND NOT EXISTS (
             SELECT 1
               FROM schedule_entries se
               JOIN schedule_versions sv
                 ON sv.id = se.schedule_version_id AND sv.event_id = se.event_id
               JOIN schedule_session_contents content
                 ON content.schedule_version_id = se.schedule_version_id
                AND content.event_id = se.event_id
                AND content.session_id = se.session_id
               JOIN sessions session
                 ON session.id = se.session_id AND session.event_id = se.event_id
               JOIN session_speakers ss
                 ON ss.session_id = se.session_id AND ss.event_id = se.event_id
              WHERE sv.id = ? AND sv.status = 'published'
                AND se.session_id = ci.session_id AND ss.person_id = ci.person_id
                AND ${PUBLIC_CONFIRMED_SCHEDULE_CALENDAR_TARGET_SQL}
           )
      )
      INSERT INTO operation_items (
        id, operation_id, item_key, entity_type, entity_id, status, result_json, updated_at
      )
      SELECT lower(hex(randomblob(16))), ?,
             json_array('CANCEL', session_id, person_id, provider),
             ?, session_id, 'pending',
             json_object(
               'sessionId', session_id, 'personId', person_id,
               'method', 'CANCEL', 'provider', provider,
               'connectionId', connection_id
             ), unixepoch()
        FROM cancelled_targets
       WHERE ${operationGuard}
    `,
    ).bind(
      viewer.organisationId,
      viewer.eventId,
      scheduleVersionId,
      operationId,
      SCHEDULE_CALENDAR_FANOUT_TARGET_TYPE,
      operationId,
      viewer.eventId,
      viewer.organisationId,
    ),
    env.DB.prepare(
      `
      INSERT INTO operation_items (
        id, operation_id, item_key, entity_type, entity_id, status, result_json,
        completed_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), ?, ?, 'schedule_calendar_snapshot', ?,
             'completed', json_object('scheduleVersionId', ?), unixepoch(), unixepoch()
       WHERE ${operationGuard}
    `,
    ).bind(
      operationId,
      SCHEDULE_CALENDAR_FANOUT_SNAPSHOT_KEY,
      scheduleVersionId,
      scheduleVersionId,
      operationId,
      viewer.eventId,
      viewer.organisationId,
    ),
  ];
}
