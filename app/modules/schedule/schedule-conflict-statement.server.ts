import {
  scheduleConflictDetailsJson,
  scheduleConflictFingerprint,
} from "./schedule-conflict-fingerprint";
import type { ScheduleConflict } from "./schedule-rules";

export function scheduleConflictInsert(
  env: CloudflareEnvironment,
  eventId: string,
  versionId: string,
  entryId: string,
  conflict: ScheduleConflict,
  operationId: string,
  conflictId: string = crypto.randomUUID(),
) {
  return env.DB.prepare(
    `
      INSERT INTO schedule_conflicts (
        id, event_id, schedule_version_id, conflict_type, severity, fingerprint,
        primary_entry_id, conflicting_entry_id, details_json, created_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch()
       WHERE EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
    `,
  ).bind(
    conflictId,
    eventId,
    versionId,
    conflict.type,
    conflict.severity,
    scheduleConflictFingerprint(entryId, conflict),
    entryId,
    conflict.conflictingEntryId ?? null,
    scheduleConflictDetailsJson(conflict),
    versionId,
    operationId,
  );
}

export function scheduleDraftConflictRebuildStatements(
  env: CloudflareEnvironment,
  input: {
    organisationId: string;
    eventId: string;
    operationId: string;
    draft: { id: string; revision: number };
    conflicts: ReadonlyArray<{ entryId: string; conflict: ScheduleConflict }>;
  },
): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `
      UPDATE schedule_versions
         SET revision = revision + 1, publication_operation_id = ?
       WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
         AND EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
    `,
    ).bind(
      input.operationId,
      input.draft.id,
      input.eventId,
      input.draft.revision,
      input.eventId,
      input.organisationId,
      input.operationId,
    ),
    env.DB.prepare(
      `DELETE FROM schedule_conflicts
        WHERE event_id = ? AND schedule_version_id = ?
          AND EXISTS (
            SELECT 1 FROM schedule_versions
             WHERE id = ? AND event_id = ? AND publication_operation_id = ?
          )`,
    ).bind(
      input.eventId,
      input.draft.id,
      input.draft.id,
      input.eventId,
      input.operationId,
    ),
    ...input.conflicts.map(({ entryId, conflict }) =>
      scheduleConflictInsert(
        env,
        input.eventId,
        input.draft.id,
        entryId,
        conflict,
        input.operationId,
      ),
    ),
  ];
}
