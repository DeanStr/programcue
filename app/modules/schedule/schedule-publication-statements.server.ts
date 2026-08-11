import { type ScheduleCalendarFanoutMessage } from "~/modules/calendars/calendar-schema";
import { scheduleCalendarFanoutSnapshotStatements } from "~/modules/calendars/calendar-service.server";
import type {
  ScheduleAuditActor,
  ScheduleEventScope,
  SchedulePublicationCommand,
  ScheduleWorkspace,
} from "./schedule-service.server";
import type { ScheduleConflict } from "./schedule-rules";
import { schedulePublishSchema } from "./schedule-schema";

export function buildSchedulePublicationStatements(input: {
  env: CloudflareEnvironment;
  viewer: ScheduleEventScope;
  actor: ScheduleAuditActor;
  command?: SchedulePublicationCommand;
  parsed: ReturnType<typeof schedulePublishSchema.parse>;
  workspace: ScheduleWorkspace;
  detectedConflicts: Array<{ entryId: string; conflict: ScheduleConflict }>;
  publishOperationId: string;
  calendarOperationId: string;
  calendarIdempotencyKey: string;
  calendarMessage: ScheduleCalendarFanoutMessage;
  auditEventId: string;
  conflictInsert: (
    entryId: string,
    conflict: ScheduleConflict,
    operationId: string,
  ) => D1PreparedStatement;
}) {
  const {
    env,
    viewer,
    actor,
    command,
    parsed,
    workspace,
    detectedConflicts,
    publishOperationId,
    calendarOperationId,
    calendarIdempotencyKey,
    calendarMessage,
    auditEventId,
    conflictInsert,
  } = input;
  const idempotencyRecordId = command ? crypto.randomUUID() : null;
  const commandGuard = command
    ? `AND EXISTS (
           SELECT 1 FROM idempotency_records command
            WHERE command.id = ? AND command.organisation_id = ?
              AND command.event_id = ? AND command.actor_id = ?
              AND command.scope = 'schedule.publish'
              AND command.idempotency_key = ?
              AND command.request_hash = ? AND command.status = 'processing'
         )`
    : "";
  const commandGuardBindings = command
    ? [
        idempotencyRecordId,
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
        command.requestHash,
      ]
    : [];
  const statements: D1PreparedStatement[] = [];
  if (command) {
    statements.push(
      env.DB.prepare(
        `
          DELETE FROM idempotency_records
           WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
             AND scope = 'schedule.publish' AND idempotency_key = ?
             AND expires_at <= unixepoch()
        `,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
      ),
      env.DB.prepare(
        `
          INSERT OR IGNORE INTO idempotency_records (
            id, organisation_id, event_id, actor_id, scope, idempotency_key,
            request_hash, status, expires_at, created_at
          ) VALUES (?, ?, ?, ?, 'schedule.publish', ?, ?, 'processing',
                    unixepoch() + 2592000, unixepoch())
        `,
      ).bind(
        idempotencyRecordId,
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
        command.requestHash,
      ),
    );
  }
  const publishingIndex = statements.length;
  statements.push(
    env.DB.prepare(
      `
        UPDATE schedule_versions
           SET status = 'publishing', revision = revision + 1, publication_operation_id = ?
         WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND revision = ?
           )
           AND NOT EXISTS (
             SELECT 1
               FROM schedule_entries entry
               LEFT JOIN schedule_session_contents content
                 ON content.schedule_version_id = entry.schedule_version_id
                AND content.event_id = entry.event_id
                AND content.session_id = entry.session_id
              WHERE entry.schedule_version_id = ? AND entry.event_id = ?
                AND content.session_id IS NULL
           )
           ${commandGuard}
      `,
    ).bind(
      publishOperationId,
      parsed.scheduleVersionId,
      viewer.eventId,
      parsed.scheduleRevision,
      viewer.eventId,
      viewer.organisationId,
      workspace.event.revision,
      parsed.scheduleVersionId,
      viewer.eventId,
      ...commandGuardBindings,
    ),
    env.DB.prepare(
      `
        UPDATE schedule_versions SET status = 'archived'
         WHERE event_id = ? AND status = 'published' AND id <> ?
           AND EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
    ).bind(
      viewer.eventId,
      parsed.scheduleVersionId,
      parsed.scheduleVersionId,
      publishOperationId,
    ),
    env.DB.prepare(
      `
        UPDATE schedule_versions
           SET status = 'published', published_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status = 'publishing' AND publication_operation_id = ?
      `,
    ).bind(parsed.scheduleVersionId, viewer.eventId, publishOperationId),
    env.DB.prepare(
      `
        UPDATE sessions SET status = 'published', revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND id IN (SELECT session_id FROM schedule_entries WHERE schedule_version_id = ?)
           AND EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
    ).bind(
      viewer.eventId,
      parsed.scheduleVersionId,
      parsed.scheduleVersionId,
      publishOperationId,
    ),
    env.DB.prepare(
      `
        DELETE FROM schedule_conflicts
         WHERE event_id = ? AND schedule_version_id = ?
           AND EXISTS (
             SELECT 1 FROM schedule_versions
              WHERE id = ? AND publication_operation_id = ?
           )
      `,
    ).bind(
      viewer.eventId,
      parsed.scheduleVersionId,
      parsed.scheduleVersionId,
      publishOperationId,
    ),
    ...detectedConflicts.map(({ entryId, conflict }) =>
      conflictInsert(entryId, conflict, publishOperationId),
    ),
    env.DB.prepare(
      `
        UPDATE events
           SET programme_published_at = unixepoch(), revision = revision + 1,
               last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ? AND revision = ?
           AND EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
    ).bind(
      publishOperationId,
      viewer.eventId,
      viewer.organisationId,
      workspace.event.revision,
      parsed.scheduleVersionId,
      publishOperationId,
    ),
    env.DB.prepare(
      `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, actor_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'schedule.published', 'schedule_version', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      `,
    ).bind(
      auditEventId,
      viewer.organisationId,
      viewer.eventId,
      actor.personId ?? null,
      actor.actorId ?? null,
      parsed.scheduleVersionId,
      JSON.stringify({ entryCount: workspace.entries.length }),
      parsed.scheduleVersionId,
      publishOperationId,
    ),
    env.DB.prepare(
      `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type, idempotency_key,
          correlation_id, status, payload_json, progress_total, progress_completed,
          progress_failed, cancellable, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'schedule.calendar_fanout', ?, ?, 'queued', ?, 0, 0, 0, 0,
               unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM schedule_versions
            WHERE id = ? AND event_id = ? AND status = 'published'
              AND publication_operation_id = ?
         )
      `,
    ).bind(
      calendarOperationId,
      viewer.organisationId,
      viewer.eventId,
      actor.personId ?? null,
      calendarIdempotencyKey,
      crypto.randomUUID(),
      JSON.stringify(calendarMessage),
      parsed.scheduleVersionId,
      viewer.eventId,
      publishOperationId,
    ),
    ...scheduleCalendarFanoutSnapshotStatements(
      env,
      {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId: actor.personId ?? null,
      },
      parsed.scheduleVersionId,
      calendarOperationId,
    ),
  );
  const changeIndex = statements.length;
  statements.push(
    env.DB.prepare(
      `
        INSERT INTO event_changes (
          event_id, entity_type, entity_id, change_type, correlation_id, created_at
        )
        SELECT ?, 'schedule_version', ?, 'published', ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM schedule_versions
            WHERE id = ? AND event_id = ? AND status = 'published'
              AND publication_operation_id = ?
         )
        RETURNING sequence
      `,
    ).bind(
      viewer.eventId,
      parsed.scheduleVersionId,
      publishOperationId,
      parsed.scheduleVersionId,
      viewer.eventId,
      publishOperationId,
    ),
  );
  if (command) {
    statements.push(
      env.DB.prepare(
        `
          UPDATE idempotency_records
             SET status = 'completed',
                 response_status = 200,
                 response_json = json_object(
                   'calendarOperationId', ?,
                   'changeSequence', (
                     SELECT sequence FROM event_changes
                      WHERE event_id = ? AND entity_type = 'schedule_version'
                        AND entity_id = ? AND change_type = 'published'
                        AND correlation_id = ?
                      ORDER BY sequence DESC LIMIT 1
                   )
                 ),
                 entity_type = 'schedule_version', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'schedule.publish'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND EXISTS (
               SELECT 1
                 FROM schedule_versions published_version
                 JOIN event_changes committed_change
                   ON committed_change.event_id = published_version.event_id
                  AND committed_change.entity_type = 'schedule_version'
                  AND committed_change.entity_id = published_version.id
                  AND committed_change.change_type = 'published'
                  AND committed_change.correlation_id = ?
                WHERE published_version.id = ?
                  AND published_version.event_id = ?
                  AND published_version.status = 'published'
                  AND published_version.publication_operation_id = ?
             )
        `,
      ).bind(
        calendarOperationId,
        viewer.eventId,
        parsed.scheduleVersionId,
        publishOperationId,
        parsed.scheduleVersionId,
        idempotencyRecordId,
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
        command.requestHash,
        publishOperationId,
        parsed.scheduleVersionId,
        viewer.eventId,
        publishOperationId,
      ),
    );
    statements.push(
      env.DB.prepare(
        `
          DELETE FROM idempotency_records
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'schedule.publish'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND NOT EXISTS (
               SELECT 1 FROM schedule_versions
                WHERE id = ? AND event_id = ? AND status = 'published'
                  AND publication_operation_id = ?
             )
        `,
      ).bind(
        idempotencyRecordId,
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
        command.requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        publishOperationId,
      ),
    );
  }

  return { statements, publishingIndex, changeIndex };
}
