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
