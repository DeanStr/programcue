import { requireValue } from "~/lib/required-value";
import type { Viewer } from "~/platform/auth/authorize.server";
import { scheduleConflictInsert } from "./schedule-conflict-statement.server";
import { ScheduleRevisionConflictError } from "./schedule-errors";
import type {
  ScheduleEventScope,
  ScheduleWorkspace,
} from "./schedule-service.server";
import { detectWorkspaceConflicts } from "./schedule-workspace.server";

export class ScheduleDraftWorkflow {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly dependencies: {
      getWorkspace: (viewer: ScheduleEventScope) => Promise<ScheduleWorkspace>;
    },
  ) {}

  private getWorkspace(viewer: ScheduleEventScope) {
    return this.dependencies.getWorkspace(viewer);
  }

  async createDraftD1(viewer: Viewer) {
    const existing = await this.env.DB.prepare(
      "SELECT id FROM schedule_versions WHERE event_id = ? AND status = 'draft'",
    )
      .bind(viewer.eventId)
      .first<{ id: string }>();
    if (existing) return existing.id;
    const workspace = await this.getWorkspace(viewer);
    if (workspace.version?.status === "draft") return workspace.version.id;
    const sourceId =
      workspace.version?.status === "published" ? workspace.version.id : null;
    const state = await this.env.DB.prepare(
      "SELECT COALESCE(MAX(version_number), 0) + 1 AS nextVersion FROM schedule_versions WHERE event_id = ?",
    )
      .bind(viewer.eventId)
      .first<{ nextVersion: number }>();
    if (!state || !Number.isSafeInteger(state.nextVersion)) {
      throw new Error("The next schedule version could not be determined.");
    }
    const id = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const nextVersion = state.nextVersion;
    const clonedEntryIds = new Map(
      workspace.entries.map((entry) => [entry.id, crypto.randomUUID()]),
    );
    const conflicts = sourceId ? detectWorkspaceConflicts(workspace) : [];
    const [inserted] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO schedule_versions (
          id, event_id, version_number, name, notes, status, revision,
          publication_operation_id, created_by_person_id, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'draft', 1, ?, ?, unixepoch()
         WHERE NOT EXISTS (
           SELECT 1 FROM schedule_versions WHERE event_id = ? AND status = 'draft'
         )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND revision = ?
           )
        ON CONFLICT(event_id, version_number) DO NOTHING
      `,
      ).bind(
        id,
        viewer.eventId,
        nextVersion,
        `Version ${nextVersion}`,
        workspace.version?.notes ?? "",
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.eventId,
        viewer.organisationId,
        workspace.event.revision,
      ),
      ...workspace.entries.map((entry) =>
        this.env.DB.prepare(
          `
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id, starts_at, ends_at, revision, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM schedule_versions target
            WHERE target.id = ? AND target.event_id = ? AND target.status = 'draft'
              AND target.publication_operation_id = ?
         )
      `,
        ).bind(
          clonedEntryIds.get(entry.id),
          viewer.eventId,
          id,
          entry.sessionId,
          entry.roomId,
          entry.startsAt,
          entry.endsAt,
          id,
          viewer.eventId,
          operationId,
        ),
      ),
      ...conflicts.map(({ entryId, conflict }) =>
        scheduleConflictInsert(
          this.env,
          viewer.eventId,
          id,
          requireValue(
            clonedEntryIds.get(entryId),
            "Required clonedEntryIds.get(entryId) is unavailable.",
          ),
          {
            ...conflict,
            conflictingEntryId: conflict.conflictingEntryId
              ? clonedEntryIds.get(conflict.conflictingEntryId)
              : undefined,
          },
          operationId,
        ),
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.draft.created', 'schedule_version', ?, ?, unixepoch()
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
        id,
        JSON.stringify({ versionNumber: nextVersion }),
        id,
        viewer.eventId,
        operationId,
      ),
    ]);
    if ((inserted.meta.changes ?? 0) === 1) return id;
    const winner = await this.env.DB.prepare(
      "SELECT id FROM schedule_versions WHERE event_id = ? AND status = 'draft' ORDER BY version_number DESC LIMIT 1",
    )
      .bind(viewer.eventId)
      .first<{ id: string }>();
    if (winner) return winner.id;
    throw new ScheduleRevisionConflictError();
  }
}
