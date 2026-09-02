import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ScheduleNotFoundError,
  ScheduleRevisionConflictError,
} from "./schedule-errors";
import {
  conflictInsert,
  type SchedulePlacementWorkflowContext,
} from "./schedule-placement-workflow-support.server";
import { scheduleMutationSchema } from "./schedule-schema";
import type {
  ScheduleUnassignmentResult,
  ScheduleWorkspace,
} from "./schedule-service.server";
import { detectWorkspaceConflicts } from "./schedule-workspace.server";

export async function unassignScheduleEntry(
  context: SchedulePlacementWorkflowContext,
  viewer: Viewer,
  input: unknown,
): Promise<ScheduleUnassignmentResult> {
  const parsed = scheduleMutationSchema.parse(input);
  const workspace = await context.getWorkspace(viewer);
  if (
    !workspace.version ||
    workspace.version.id !== parsed.scheduleVersionId ||
    workspace.version.status !== "draft"
  ) {
    throw new ScheduleNotFoundError();
  }
  if (workspace.version.revision !== parsed.scheduleRevision)
    throw new ScheduleRevisionConflictError();
  const entry = workspace.entries.find((item) => item.id === parsed.entryId);
  if (!entry) throw new ScheduleNotFoundError("Schedule entry not found.");

  const versionOperationId = crypto.randomUUID();
  const undoExpiresAt = Math.floor(Date.now() / 1_000) + 30;
  const prospective: ScheduleWorkspace = {
    ...workspace,
    entries: workspace.entries.filter((item) => item.id !== entry.id),
  };
  const conflicts = detectWorkspaceConflicts(prospective);
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      `
      UPDATE schedule_versions
         SET revision = revision + 1, publication_operation_id = ?
       WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
         AND EXISTS (
           SELECT 1 FROM events current_event
            WHERE current_event.id = schedule_versions.event_id
              AND current_event.organisation_id = ?
              AND current_event.revision = ?
         )
         AND EXISTS (
           SELECT 1 FROM schedule_entries current_entry
            WHERE current_entry.id = ?
              AND current_entry.event_id = schedule_versions.event_id
              AND current_entry.schedule_version_id = schedule_versions.id
              AND current_entry.session_id = ? AND current_entry.room_id = ?
              AND current_entry.starts_at = ? AND current_entry.ends_at = ?
              AND current_entry.revision = ?
         )
    `,
    ).bind(
      versionOperationId,
      parsed.scheduleVersionId,
      viewer.eventId,
      parsed.scheduleRevision,
      viewer.organisationId,
      workspace.event.revision,
      entry.id,
      entry.sessionId,
      entry.roomId,
      entry.startsAt,
      entry.endsAt,
      entry.revision,
    ),
    context.env.DB.prepare(
      `
      DELETE FROM schedule_entries
       WHERE id = ? AND event_id = ? AND schedule_version_id = ?
         AND session_id = ? AND room_id = ? AND starts_at = ? AND ends_at = ?
         AND revision = ?
         AND EXISTS (
           SELECT 1 FROM schedule_versions
            WHERE id = ? AND event_id = ? AND publication_operation_id = ?
         )
    `,
    ).bind(
      entry.id,
      viewer.eventId,
      parsed.scheduleVersionId,
      entry.sessionId,
      entry.roomId,
      entry.startsAt,
      entry.endsAt,
      entry.revision,
      parsed.scheduleVersionId,
      viewer.eventId,
      versionOperationId,
    ),
    context.env.DB.prepare(
      `DELETE FROM schedule_conflicts
        WHERE event_id = ? AND schedule_version_id = ?
          AND EXISTS (
            SELECT 1 FROM schedule_versions
             WHERE id = ? AND event_id = ? AND publication_operation_id = ?
          )`,
    ).bind(
      viewer.eventId,
      parsed.scheduleVersionId,
      parsed.scheduleVersionId,
      viewer.eventId,
      versionOperationId,
    ),
    ...conflicts.map(({ entryId, conflict }) =>
      conflictInsert(
        context.env,
        viewer.eventId,
        parsed.scheduleVersionId,
        entryId,
        conflict,
        versionOperationId,
      ),
    ),
    context.env.DB.prepare(
      `
      UPDATE sessions
         SET status = 'unscheduled', revision = revision + 1, updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND status = 'scheduled'
         AND EXISTS (
           SELECT 1 FROM schedule_versions
            WHERE id = ? AND event_id = ? AND publication_operation_id = ?
         )
    `,
    ).bind(
      entry.sessionId,
      viewer.eventId,
      parsed.scheduleVersionId,
      viewer.eventId,
      versionOperationId,
    ),
    context.env.DB.prepare(
      `
      INSERT INTO audit_events (
        id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
        entity_type, entity_id, metadata_json, created_at
      )
      SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.entry.unassigned', 'schedule_entry', ?, ?, unixepoch()
       WHERE EXISTS (
         SELECT 1 FROM schedule_versions
          WHERE id = ? AND event_id = ? AND publication_operation_id = ?
       )
    `,
    ).bind(
      crypto.randomUUID(),
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      entry.id,
      JSON.stringify({
        undoToken: versionOperationId,
        expiresAt: undoExpiresAt,
        scheduleVersionId: parsed.scheduleVersionId,
        previous: entry,
        next: null,
      }),
      parsed.scheduleVersionId,
      viewer.eventId,
      versionOperationId,
    ),
  ];
  const [updated, deleted] = await context.env.DB.batch(statements);
  if ((updated.meta.changes ?? 0) !== 1 || (deleted.meta.changes ?? 0) !== 1) {
    throw new ScheduleRevisionConflictError();
  }
  return {
    entryId: entry.id,
    scheduleRevision: parsed.scheduleRevision + 1,
    undo: { token: versionOperationId, expiresAt: undoExpiresAt },
  };
}
