import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ScheduleConfigurationError,
  SchedulePlacementBlockedError,
  ScheduleRevisionConflictError,
} from "./schedule-errors";
import type {
  ContentApprovalSource,
  ScheduleEntrySnapshot,
} from "./schedule-placement-evidence";
import {
  conflictInsert,
  replayPlacement,
  type SchedulePlacementWorkflowContext,
  sessionContentDurationStatements,
} from "./schedule-placement-workflow-support.server";
import { detectScheduleConflicts, type ScheduledItem } from "./schedule-rules";
import { schedulePlacementSchema } from "./schedule-schema";
import type {
  SchedulePlacementCommand,
  SchedulePlacementResult,
  SchedulePlacementSessionUpdate,
  SchedulePlacementWarning,
} from "./schedule-service.server";

export async function placeScheduleEntry(
  context: SchedulePlacementWorkflowContext,
  viewer: Viewer,
  input: unknown,
  command?: SchedulePlacementCommand,
): Promise<SchedulePlacementResult> {
  const parsed = schedulePlacementSchema.parse(input);
  if (command) {
    const replay = await replayPlacement(context.env, viewer, command);
    if (replay) return replay;
  }
  const workspace = await context.getWorkspace(viewer);
  if (
    !workspace.version ||
    workspace.version.id !== parsed.scheduleVersionId ||
    workspace.version.status !== "draft"
  ) {
    throw new Error("Choose an active draft schedule before placing sessions.");
  }
  if (workspace.version.revision !== parsed.scheduleRevision)
    throw new ScheduleRevisionConflictError();
  const session = workspace.sessions.find(
    (item) => item.id === parsed.sessionId,
  );
  if (!session) throw new Error("Session not found in this event.");
  const currentEntry = workspace.entries.find(
    (entry) => entry.sessionId === parsed.sessionId,
  );
  const sessionById = new Map(
    workspace.sessions.map((item) => [item.id, item]),
  );
  const existing: ScheduledItem[] = workspace.entries.map((entry) => {
    const item = sessionById.get(entry.sessionId);
    if (!item)
      throw new Error(
        `Schedule entry ${entry.id} references an unavailable session.`,
      );
    return {
      entryId: entry.id,
      sessionId: entry.sessionId,
      roomId: entry.roomId,
      startsAt: entry.startsAt,
      endsAt: entry.endsAt,
      trackId: item.trackId,
      trackExclusive: item.trackExclusive,
      speakerIds: item.speakerIds,
      speakerNames: item.speakerNames,
      requiredResources: item.requiredResources,
      expectedAttendance: item.expectedAttendance,
      title: item.title,
    };
  });
  const conflicts = detectScheduleConflicts({
    candidate: {
      sessionId: session.id,
      title: session.title,
      roomId: parsed.roomId,
      startsAt: parsed.startsAt,
      endsAt: parsed.endsAt,
      trackId: session.trackId,
      trackExclusive: session.trackExclusive,
      speakerIds: session.speakerIds,
      speakerNames: session.speakerNames,
      requiredResources: session.requiredResources,
      expectedAttendance: session.expectedAttendance,
    },
    existing,
    rooms: workspace.rooms,
    eventStartsAt: workspace.event.startsAt,
    eventEndsAt: workspace.event.endsAt,
    eventTimezone: workspace.event.timezone,
    policies: workspace.policies,
    speakerBlackouts: workspace.speakerBlackouts,
    excludeEntryId: currentEntry?.id,
  });
  const blockingConflicts = conflicts.filter(
    (conflict) => conflict.severity === "blocking",
  );
  if (blockingConflicts.length)
    throw new SchedulePlacementBlockedError(blockingConflicts);
  const warnings: SchedulePlacementWarning[] = conflicts.map((conflict) => ({
    ...conflict,
    id: crypto.randomUUID(),
    severity: "warning",
  }));
  const durationMinutes = (parsed.endsAt - parsed.startsAt) / 60;
  if (
    !Number.isInteger(durationMinutes) ||
    durationMinutes < 5 ||
    durationMinutes > 480
  ) {
    throw new ScheduleConfigurationError(
      "A placed session must last a whole number of minutes between 5 and 480.",
    );
  }
  const durationChanged = durationMinutes !== session.durationMinutes;
  const durationContentGuard = durationChanged
    ? `AND EXISTS (
         SELECT 1 FROM schedule_session_contents current_content
          WHERE current_content.schedule_version_id = schedule_versions.id
            AND current_content.event_id = schedule_versions.event_id
            AND current_content.session_id = ?
            AND current_content.content_revision = ?
       )`
    : "";
  const durationContentGuardBindings = durationChanged
    ? [parsed.sessionId, session.contentRevision]
    : [];
  const previousContentApproval = durationChanged
    ? ((await context.env.DB.prepare(
        `SELECT approved_by_person_id AS approvedByPersonId,
                approved_at AS approvedAt,
                approval_source AS approvalSource
           FROM schedule_session_contents
          WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?`,
      )
        .bind(parsed.scheduleVersionId, viewer.eventId, parsed.sessionId)
        .first<{
          approvedByPersonId: string | null;
          approvedAt: number | null;
          approvalSource: ContentApprovalSource | null;
        }>()) ?? {
        approvedByPersonId: null,
        approvedAt: null,
        approvalSource: null,
      })
    : null;

  const entryId = currentEntry?.id ?? crypto.randomUUID();
  const versionOperationId = crypto.randomUUID();
  const undoExpiresAt = Math.floor(Date.now() / 1_000) + 30;
  const nextEntry: ScheduleEntrySnapshot = {
    id: entryId,
    sessionId: parsed.sessionId,
    roomId: parsed.roomId,
    startsAt: parsed.startsAt,
    endsAt: parsed.endsAt,
    revision: currentEntry ? currentEntry.revision + 1 : 1,
  };
  const nextSession: SchedulePlacementSessionUpdate = {
    id: session.id,
    durationMinutes,
    contentStatus: durationChanged ? "draft" : session.contentStatus,
    contentRevision: session.contentRevision + (durationChanged ? 1 : 0),
    status: session.status === "published" ? "published" : "scheduled",
    revision: session.revision + 1,
  };
  const result: SchedulePlacementResult = {
    entryId,
    entry: nextEntry,
    session: nextSession,
    movedExistingEntry: currentEntry !== undefined,
    scheduleRevision: parsed.scheduleRevision + 1,
    warnings,
    undo: { token: versionOperationId, expiresAt: undoExpiresAt },
  };
  const commandRecordId = command ? crypto.randomUUID() : null;
  const commandGuard = command
    ? `AND EXISTS (
         SELECT 1 FROM idempotency_records placement_command
          WHERE placement_command.id = ?
            AND placement_command.organisation_id = ?
            AND placement_command.event_id = ?
            AND placement_command.actor_id = ?
            AND placement_command.scope = 'schedule.entry.place'
            AND placement_command.idempotency_key = ?
            AND placement_command.request_hash = ?
            AND placement_command.status = 'processing'
       )`
    : "";
  const commandGuardBindings = command
    ? [
        commandRecordId,
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
      context.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = 'schedule.entry.place' AND idempotency_key = ?
            AND expires_at <= unixepoch()`,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
      ),
      context.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, 'schedule.entry.place', ?, ?, 'processing',
                   unixepoch() + 2592000, unixepoch())`,
      ).bind(
        commandRecordId,
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
        command.requestHash,
      ),
    );
  }
  const updateIndex = statements.length;
  statements.push(
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
           SELECT 1 FROM sessions placeable_session
            WHERE placeable_session.id = ?
              AND placeable_session.event_id = schedule_versions.event_id
              AND placeable_session.status IN ('unscheduled','scheduled','published')
         )
         ${durationContentGuard}
         ${commandGuard}
    `,
    ).bind(
      versionOperationId,
      parsed.scheduleVersionId,
      viewer.eventId,
      parsed.scheduleRevision,
      viewer.organisationId,
      workspace.event.revision,
      parsed.sessionId,
      ...durationContentGuardBindings,
      ...commandGuardBindings,
    ),
    context.env.DB.prepare(
      `
      INSERT INTO schedule_entries (
        id, event_id, schedule_version_id, session_id, room_id, starts_at, ends_at, revision, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch()
       WHERE EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
      ON CONFLICT(schedule_version_id, session_id) DO UPDATE SET
        room_id = excluded.room_id, starts_at = excluded.starts_at, ends_at = excluded.ends_at,
        revision = schedule_entries.revision + 1, updated_at = unixepoch()
    `,
    ).bind(
      entryId,
      viewer.eventId,
      parsed.scheduleVersionId,
      parsed.sessionId,
      parsed.roomId,
      parsed.startsAt,
      parsed.endsAt,
      parsed.scheduleVersionId,
      versionOperationId,
    ),
    context.env.DB.prepare(
      `
      DELETE FROM schedule_conflicts
       WHERE event_id = ? AND schedule_version_id = ?
         AND (primary_entry_id = ? OR conflicting_entry_id = ?)
         AND EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
    `,
    ).bind(
      viewer.eventId,
      parsed.scheduleVersionId,
      entryId,
      entryId,
      parsed.scheduleVersionId,
      versionOperationId,
    ),
    ...warnings.map((conflict) =>
      conflictInsert(
        context.env,
        viewer.eventId,
        parsed.scheduleVersionId,
        entryId,
        conflict,
        versionOperationId,
        conflict.id,
      ),
    ),
    context.env.DB.prepare(
      `
      UPDATE sessions
         SET status = CASE
               WHEN status = 'published' THEN status
               ELSE 'scheduled'
             END,
             duration_minutes = ?,
             revision = revision + 1,
             updated_at = unixepoch()
       WHERE id = ? AND event_id = ?
         AND status IN ('unscheduled','scheduled','published')
         AND EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
    `,
    ).bind(
      durationMinutes,
      parsed.sessionId,
      viewer.eventId,
      parsed.scheduleVersionId,
      versionOperationId,
    ),
    ...sessionContentDurationStatements(context.env, {
      scheduleVersionId: parsed.scheduleVersionId,
      eventId: viewer.eventId,
      sessionId: parsed.sessionId,
      durationMinutes,
      expectedContentRevision: session.contentRevision,
      contentStatus: "draft",
      approvedByPersonId: null,
      approvedAt: null,
      approvalSource: null,
      operationId: versionOperationId,
      editorPersonId: viewer.personId,
      changeKind: "edit",
      include: durationChanged,
    }),
    context.env.DB.prepare(
      `
      INSERT INTO audit_events (
        id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
      )
      SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.entry.placed', 'schedule_entry', ?, ?, unixepoch()
       WHERE EXISTS (SELECT 1 FROM schedule_versions WHERE id = ? AND publication_operation_id = ?)
    `,
    ).bind(
      crypto.randomUUID(),
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      entryId,
      JSON.stringify({
        undoToken: versionOperationId,
        expiresAt: undoExpiresAt,
        scheduleVersionId: parsed.scheduleVersionId,
        previous: currentEntry ?? null,
        next: nextEntry,
        previousDurationMinutes: durationChanged
          ? session.durationMinutes
          : null,
        previousContentRevision: durationChanged
          ? session.contentRevision
          : null,
        previousContentStatus: durationChanged ? session.contentStatus : null,
        previousApprovedByPersonId: durationChanged
          ? (previousContentApproval?.approvedByPersonId ?? null)
          : null,
        previousApprovedAt: durationChanged
          ? (previousContentApproval?.approvedAt ?? null)
          : null,
        previousApprovalSource: durationChanged
          ? (previousContentApproval?.approvalSource ?? null)
          : null,
      }),
      parsed.scheduleVersionId,
      versionOperationId,
    ),
  );
  const completionIndex = command ? statements.length : null;
  if (command) {
    statements.push(
      context.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_json = ?, entity_type = 'schedule_entry',
                entity_id = ?, completed_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = 'schedule.entry.place'
            AND idempotency_key = ? AND request_hash = ?
            AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM schedule_versions version
               WHERE version.id = ? AND version.event_id = ?
                 AND version.status = 'draft'
                 AND version.publication_operation_id = ?
            )`,
      ).bind(
        JSON.stringify(result),
        entryId,
        commandRecordId,
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
        command.requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        versionOperationId,
      ),
      context.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = 'schedule.entry.place'
            AND idempotency_key = ? AND request_hash = ?
            AND status = 'processing'
            AND NOT EXISTS (
              SELECT 1 FROM schedule_versions version
               WHERE version.id = ? AND version.event_id = ?
                 AND version.status = 'draft'
                 AND version.publication_operation_id = ?
            )`,
      ).bind(
        commandRecordId,
        viewer.organisationId,
        viewer.eventId,
        command.actorId,
        command.idempotencyKey,
        command.requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        versionOperationId,
      ),
    );
  }
  const batch = await context.env.DB.batch(statements);
  const update = batch[updateIndex];
  if ((update?.meta.changes ?? 0) !== 1) {
    if (command) {
      const replay = await replayPlacement(context.env, viewer, command);
      if (replay) return replay;
    }
    throw new ScheduleRevisionConflictError();
  }
  if (
    completionIndex !== null &&
    (batch[completionIndex]?.meta.changes ?? 0) !== 1
  ) {
    throw new Error(
      "The schedule placement committed without its durable idempotency result.",
    );
  }
  return result;
}
