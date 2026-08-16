import { requireValue } from "~/lib/required-value";
import { CalendarStateError } from "./calendar-errors";
import {
  type CalendarQueueActor,
  type PublishedScheduleCalendarDispatch,
  type PublishedScheduleCalendarTarget,
  publishedScheduleCalendarIdempotencyKey,
  publishedScheduleCalendarTargetSchema,
  SCHEDULE_CALENDAR_FANOUT_BATCH_SIZE,
  SCHEDULE_CALENDAR_FANOUT_SNAPSHOT_KEY,
  SCHEDULE_CALENDAR_FANOUT_TARGET_TYPE,
} from "./calendar-fanout";
import { CalendarLifecycleService } from "./calendar-lifecycle-service.server";
import type { CalendarProviderName } from "./calendar-schema";

export class PublishedScheduleCalendarService {
  private readonly lifecycle: CalendarLifecycleService;

  constructor(private readonly env: CloudflareEnvironment) {
    this.lifecycle = new CalendarLifecycleService(env);
  }

  /**
   * Fans out calendar lifecycle work only after a schedule version is durably
   * published. Existing invitations retain their provider; new invitations
   * prefer an active direct connection and otherwise use universal email ICS.
   */
  async queuePublishedSchedule(
    viewer: CalendarQueueActor,
    scheduleVersionId: string,
    options: {
      beforeTarget?: () => Promise<void>;
      afterTarget?: string;
      operationId?: string;
    } = {},
  ): Promise<PublishedScheduleCalendarDispatch> {
    let snapshotTargets: PublishedScheduleCalendarTarget[] | null = null;
    if (options.operationId) {
      const marker = await this.env.DB.prepare(
        `
        SELECT 1
          FROM operation_items marker
          JOIN operation_jobs operation ON operation.id = marker.operation_id
         WHERE marker.operation_id = ? AND marker.item_key = ?
           AND marker.entity_type = 'schedule_calendar_snapshot'
           AND marker.entity_id = ? AND marker.status = 'completed'
           AND operation.event_id = ? AND operation.organisation_id = ?
           AND operation.type = 'schedule.calendar_fanout'
      `,
      )
        .bind(
          options.operationId,
          SCHEDULE_CALENDAR_FANOUT_SNAPSHOT_KEY,
          scheduleVersionId,
          viewer.eventId,
          viewer.organisationId,
        )
        .first();
      if (!marker)
        throw new CalendarStateError(
          "The durable calendar fan-out target snapshot is missing.",
        );
      const snapshot = await this.env.DB.prepare(
        `
        SELECT item_key AS itemKey, result_json AS resultJson
          FROM operation_items
         WHERE operation_id = ? AND entity_type = ?
         ORDER BY item_key
      `,
      )
        .bind(options.operationId, SCHEDULE_CALENDAR_FANOUT_TARGET_TYPE)
        .all<{ itemKey: string; resultJson: string }>();
      snapshotTargets = snapshot.results.map((row) => {
        const target = publishedScheduleCalendarTargetSchema.parse(
          JSON.parse(row.resultJson),
        );
        if (
          row.itemKey !==
          JSON.stringify([
            target.method,
            target.sessionId,
            target.personId,
            target.provider,
          ])
        ) {
          throw new CalendarStateError(
            "A durable calendar fan-out target does not match its snapshot key.",
          );
        }
        return { key: row.itemKey, ...target };
      });
    } else {
      const published = await this.env.DB.prepare(
        `
        SELECT sv.id
          FROM schedule_versions sv
          JOIN events e ON e.id = sv.event_id AND e.organisation_id = ?
         WHERE sv.id = ? AND sv.event_id = ? AND sv.status = 'published'
      `,
      )
        .bind(viewer.organisationId, scheduleVersionId, viewer.eventId)
        .first<{ id: string }>();
      if (!published)
        throw new CalendarStateError(
          "Calendar dispatch requires the committed published schedule version.",
        );
    }

    const requested = snapshotTargets
      ? { results: [] }
      : await this.env.DB.prepare(
          `
      SELECT se.session_id AS sessionId, ss.person_id AS personId,
             ci.connection_id AS existingConnectionId,
             (SELECT csa.provider FROM calendar_sync_attempts csa
               WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id) AS existingProvider,
             (SELECT cc.id FROM calendar_connections cc
               WHERE cc.organisation_id = ? AND cc.person_id = ss.person_id
                 AND cc.status = 'connected' AND (cc.event_id IS NULL OR cc.event_id = ?)
               ORDER BY CASE cc.provider WHEN 'google' THEN 0 ELSE 1 END, cc.updated_at DESC LIMIT 1) AS activeConnectionId,
             (SELECT cc.provider FROM calendar_connections cc
               WHERE cc.organisation_id = ? AND cc.person_id = ss.person_id
                 AND cc.status = 'connected' AND (cc.event_id IS NULL OR cc.event_id = ?)
               ORDER BY CASE cc.provider WHEN 'google' THEN 0 ELSE 1 END, cc.updated_at DESC LIMIT 1) AS activeProvider
        FROM schedule_entries se
        JOIN schedule_versions sv ON sv.id = se.schedule_version_id AND sv.event_id = se.event_id
        JOIN schedule_session_contents content
          ON content.schedule_version_id = se.schedule_version_id
         AND content.event_id = se.event_id
         AND content.session_id = se.session_id
        JOIN session_speakers ss ON ss.session_id = se.session_id AND ss.event_id = se.event_id
        LEFT JOIN calendar_invitations ci
          ON ci.event_id = se.event_id AND ci.session_id = se.session_id AND ci.person_id = ss.person_id
       WHERE se.event_id = ? AND sv.id = ? AND sv.status = 'published'
       ORDER BY se.starts_at, se.session_id, ss.position
    `,
        )
          .bind(
            viewer.organisationId,
            viewer.eventId,
            viewer.organisationId,
            viewer.eventId,
            viewer.eventId,
            scheduleVersionId,
          )
          .all<{
            sessionId: string;
            personId: string;
            existingConnectionId: string | null;
            existingProvider: CalendarProviderName | null;
            activeConnectionId: string | null;
            activeProvider: Exclude<CalendarProviderName, "email_ics"> | null;
          }>();
    const cancelled = snapshotTargets
      ? { results: [] }
      : await this.env.DB.prepare(
          `
      SELECT ci.session_id AS sessionId, ci.person_id AS personId,
             ci.connection_id AS existingConnectionId,
             COALESCE((SELECT csa.provider FROM calendar_sync_attempts csa
               WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id), 'email_ics') AS existingProvider
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
             JOIN schedule_versions sv ON sv.id = se.schedule_version_id AND sv.event_id = se.event_id
             JOIN schedule_session_contents content
               ON content.schedule_version_id = se.schedule_version_id
              AND content.event_id = se.event_id
              AND content.session_id = se.session_id
             JOIN session_speakers ss ON ss.session_id = se.session_id AND ss.event_id = se.event_id
            WHERE sv.id = ? AND sv.status = 'published'
              AND se.session_id = ci.session_id AND ss.person_id = ci.person_id
         )
       ORDER BY ci.updated_at
    `,
        )
          .bind(viewer.organisationId, viewer.eventId, scheduleVersionId)
          .all<{
            sessionId: string;
            personId: string;
            existingConnectionId: string | null;
            existingProvider: CalendarProviderName;
          }>();

    const targets =
      snapshotTargets ??
      [
        ...requested.results.map((target) => ({
          sessionId: target.sessionId,
          personId: target.personId,
          method: "REQUEST" as const,
          provider:
            target.existingProvider ??
            target.activeProvider ??
            ("email_ics" as CalendarProviderName),
          connectionId:
            target.existingConnectionId ?? target.activeConnectionId,
        })),
        ...cancelled.results.map((target) => ({
          sessionId: target.sessionId,
          personId: target.personId,
          method: "CANCEL" as const,
          provider: target.existingProvider,
          connectionId: target.existingConnectionId,
        })),
      ]
        .map((target) => ({
          ...target,
          key: JSON.stringify([
            target.method,
            target.sessionId,
            target.personId,
            target.provider,
          ]),
        }))
        .sort((left, right) =>
          left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
        );
    const remainingTargets = options.afterTarget
      ? targets.filter(
          (target) =>
            target.key >
            requireValue(
              options.afterTarget,
              "Required options.afterTarget is unavailable.",
            ),
        )
      : targets;
    const batchTargets = remainingTargets.slice(
      0,
      SCHEDULE_CALENDAR_FANOUT_BATCH_SIZE,
    );
    const result: PublishedScheduleCalendarDispatch = {
      targetCount: targets.length,
      processedCount: batchTargets.length,
      queuedCount: 0,
      duplicateCount: 0,
      nextTarget:
        remainingTargets.length > batchTargets.length
          ? (batchTargets.at(-1)?.key ?? null)
          : null,
      dispatchError: null,
      failures: [],
    };
    for (const target of batchTargets) {
      await options.beforeTarget?.();
      let failureMessage: string | null = null;
      try {
        const idempotencyKey = await publishedScheduleCalendarIdempotencyKey({
          scheduleVersionId,
          method: target.method,
          sessionId: target.sessionId,
          personId: target.personId,
          provider: target.provider,
        });
        const queued = await this.lifecycle.queueLifecycle(viewer, {
          sessionId: target.sessionId,
          personId: target.personId,
          method: target.method,
          provider: target.provider,
          ...(target.provider !== "email_ics" && target.connectionId
            ? { connectionId: target.connectionId }
            : {}),
          idempotencyKey,
        });
        if (
          queued.duplicate &&
          ["queue_failed", "failed", "partially_failed", "cancelled"].includes(
            queued.status,
          )
        ) {
          failureMessage = `Existing calendar operation ${queued.operationId} is ${queued.status} and must be retried from the Operation Centre.`;
        } else if (queued.duplicate) result.duplicateCount += 1;
        else result.queuedCount += 1;
      } catch (error) {
        failureMessage = error instanceof Error ? error.message : String(error);
      }
      if (options.operationId) {
        const recorded = await this.env.DB.prepare(
          `UPDATE operation_items
              SET status = ?, error_code = ?, error_message = ?,
                  completed_at = unixepoch(), updated_at = unixepoch()
            WHERE operation_id = ? AND item_key = ? AND entity_type = ?
              AND entity_id = ?
              AND EXISTS (
                SELECT 1 FROM operation_jobs operation
                 WHERE operation.id = operation_items.operation_id
                   AND operation.event_id = ? AND operation.organisation_id = ?
                   AND operation.type = 'schedule.calendar_fanout'
                   AND operation.status = 'running'
              )`,
        )
          .bind(
            failureMessage ? "failed" : "completed",
            failureMessage ? "CALENDAR_FANOUT_FAILED" : null,
            failureMessage?.slice(0, 2_000) ?? null,
            options.operationId,
            target.key,
            SCHEDULE_CALENDAR_FANOUT_TARGET_TYPE,
            target.sessionId,
            viewer.eventId,
            viewer.organisationId,
          )
          .run();
        if ((recorded.meta.changes ?? 0) !== 1) {
          throw new CalendarStateError(
            "The durable calendar fan-out target changed before its outcome could be recorded.",
          );
        }
      }
      if (failureMessage) {
        result.failures.push({
          sessionId: target.sessionId,
          personId: target.personId,
          method: target.method,
          provider: target.provider,
          message: failureMessage,
        });
      }
    }
    return result;
  }
}
