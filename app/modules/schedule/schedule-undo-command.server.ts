import { requireValue } from "~/lib/required-value";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  ScheduleRevisionConflictError,
  ScheduleUndoUnavailableError,
} from "./schedule-errors";
import { parseUndoMetadata } from "./schedule-placement-evidence";
import {
  conflictInsert,
  type SchedulePlacementWorkflowContext,
  sessionContentDurationStatements,
} from "./schedule-placement-workflow-support.server";
import { scheduleUndoSchema } from "./schedule-schema";
import type { ScheduleWorkspace } from "./schedule-service.server";
import { detectWorkspaceConflicts } from "./schedule-workspace.server";

export async function undoSchedulePlacement(
  context: SchedulePlacementWorkflowContext,
  viewer: Viewer,
  input: unknown,
) {
  const parsed = scheduleUndoSchema.parse(input);
  const audit = await context.env.DB.prepare(
    `
    SELECT action, metadata_json AS metadataJson
      FROM audit_events
     WHERE organisation_id = ? AND event_id = ? AND actor_person_id = ?
       AND entity_type = 'schedule_entry'
       AND action IN ('schedule.entry.placed','schedule.entry.unassigned')
       AND json_extract(metadata_json, '$.undoToken') = ?
       AND created_at >= unixepoch() - 30
     ORDER BY created_at DESC LIMIT 1
  `,
  )
    .bind(
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      parsed.undoToken,
    )
    .first<{ action: string; metadataJson: string }>();
  if (!audit) throw new ScheduleUndoUnavailableError();
  const metadata = parseUndoMetadata(audit.metadataJson);
  if (
    metadata.undoToken !== parsed.undoToken ||
    metadata.scheduleVersionId !== parsed.scheduleVersionId ||
    metadata.expiresAt < Math.floor(Date.now() / 1_000) ||
    (!metadata.previous && !metadata.next) ||
    (audit.action === "schedule.entry.placed" && !metadata.next) ||
    (audit.action === "schedule.entry.unassigned" && !metadata.previous)
  ) {
    throw new ScheduleUndoUnavailableError();
  }

  const workspace = await context.getWorkspace(viewer);
  if (
    !workspace.version ||
    workspace.version.id !== parsed.scheduleVersionId ||
    workspace.version.status !== "draft"
  ) {
    throw new ScheduleUndoUnavailableError();
  }
  if (workspace.version.revision !== parsed.scheduleRevision)
    throw new ScheduleRevisionConflictError();
  const durationSessionId = (metadata.previous ?? metadata.next)?.sessionId;
  const durationSession = durationSessionId
    ? workspace.sessions.find((item) => item.id === durationSessionId)
    : undefined;
  if (
    metadata.next &&
    (metadata.previousDurationMinutes === null) !==
      (metadata.previousContentRevision === null)
  ) {
    throw new ScheduleUndoUnavailableError();
  }
  if (
    metadata.next &&
    metadata.previousContentStatus === "approved" &&
    (metadata.previousApprovedAt === null ||
      metadata.previousApprovalSource === null ||
      (metadata.previousApprovalSource === "editorial" &&
        metadata.previousApprovedByPersonId === null) ||
      (metadata.previousApprovalSource === "legacy_publication" &&
        metadata.previousApprovedByPersonId !== null))
  ) {
    throw new ScheduleUndoUnavailableError();
  }
  if (
    metadata.next &&
    metadata.previousDurationMinutes !== null &&
    metadata.previousContentRevision !== null &&
    (!durationSession ||
      durationSession.contentRevision !== metadata.previousContentRevision + 1)
  ) {
    throw new ScheduleUndoUnavailableError();
  }

  const current = metadata.next
    ? workspace.entries.find(
        (entry) =>
          entry.id ===
          requireValue(metadata.next, "Required metadata.next is unavailable.")
            .id,
      )
    : null;
  if (
    metadata.next &&
    (!current ||
      current.sessionId !== metadata.next.sessionId ||
      current.roomId !== metadata.next.roomId ||
      current.startsAt !== metadata.next.startsAt ||
      current.endsAt !== metadata.next.endsAt ||
      current.revision !== metadata.next.revision)
  ) {
    throw new ScheduleUndoUnavailableError();
  }
  if (
    !metadata.next &&
    workspace.entries.some(
      (entry) =>
        entry.id ===
          requireValue(
            metadata.previous,
            "Required metadata.previous is unavailable.",
          ).id ||
        entry.sessionId ===
          requireValue(
            metadata.previous,
            "Required metadata.previous is unavailable.",
          ).sessionId,
    )
  ) {
    throw new ScheduleUndoUnavailableError();
  }

  const restoredEntries = metadata.previous
    ? metadata.next
      ? workspace.entries.map((entry) =>
          entry.id ===
          requireValue(metadata.next, "Required metadata.next is unavailable.")
            .id
            ? {
                ...requireValue(
                  metadata.previous,
                  "Required metadata.previous is unavailable.",
                ),
                revision: entry.revision + 1,
              }
            : entry,
        )
      : [
          ...workspace.entries,
          { ...metadata.previous, revision: metadata.previous.revision + 1 },
        ]
    : workspace.entries.filter(
        (entry) =>
          entry.id !==
          requireValue(metadata.next, "Required metadata.next is unavailable.")
            .id,
      );
  const prospective: ScheduleWorkspace = {
    ...workspace,
    entries: restoredEntries,
  };
  const conflicts = detectWorkspaceConflicts(prospective);
  const restoredEntryId = metadata.previous?.id ?? null;
  if (
    restoredEntryId &&
    conflicts.some(
      ({ entryId, conflict }) =>
        conflict.severity === "blocking" &&
        (entryId === restoredEntryId ||
          conflict.conflictingEntryId === restoredEntryId),
    )
  ) {
    throw new ScheduleUndoUnavailableError(
      "The schedule configuration changed and this undo would now create a blocking conflict.",
    );
  }

  const operationId = crypto.randomUUID();
  const stateGuard = metadata.next
    ? `EXISTS (
         SELECT 1 FROM schedule_entries current_entry
          WHERE current_entry.id = ? AND current_entry.event_id = schedule_versions.event_id
            AND current_entry.schedule_version_id = schedule_versions.id
            AND current_entry.session_id = ? AND current_entry.room_id = ?
            AND current_entry.starts_at = ? AND current_entry.ends_at = ?
            AND current_entry.revision = ?
       )`
    : `NOT EXISTS (
         SELECT 1 FROM schedule_entries current_entry
          WHERE current_entry.schedule_version_id = schedule_versions.id
            AND (current_entry.id = ? OR current_entry.session_id = ?)
       )`;
  const stateBindings = metadata.next
    ? [
        metadata.next.id,
        metadata.next.sessionId,
        metadata.next.roomId,
        metadata.next.startsAt,
        metadata.next.endsAt,
        metadata.next.revision,
      ]
    : [
        requireValue(
          metadata.previous,
          "Required metadata.previous is unavailable.",
        ).id,
        requireValue(
          metadata.previous,
          "Required metadata.previous is unavailable.",
        ).sessionId,
      ];
  const durationContentGuard =
    metadata.next && metadata.previousContentRevision !== null
      ? `AND EXISTS (
           SELECT 1 FROM schedule_session_contents current_content
            WHERE current_content.schedule_version_id = schedule_versions.id
              AND current_content.event_id = schedule_versions.event_id
              AND current_content.session_id = ?
              AND current_content.content_revision = ?
         )`
      : "";
  const durationContentGuardBindings =
    metadata.next && metadata.previousContentRevision !== null
      ? [metadata.next.sessionId, metadata.previousContentRevision + 1]
      : [];
  const statements: D1PreparedStatement[] = [
    context.env.DB.prepare(
      `
      UPDATE schedule_versions
         SET revision = revision + 1, publication_operation_id = ?
       WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
         AND publication_operation_id = ?
         AND EXISTS (
           SELECT 1 FROM events current_event
            WHERE current_event.id = schedule_versions.event_id
              AND current_event.organisation_id = ?
              AND current_event.revision = ?
         )
         AND ${stateGuard}
         ${durationContentGuard}
    `,
    ).bind(
      operationId,
      parsed.scheduleVersionId,
      viewer.eventId,
      parsed.scheduleRevision,
      parsed.undoToken,
      viewer.organisationId,
      workspace.event.revision,
      ...stateBindings,
      ...durationContentGuardBindings,
    ),
  ];

  if (metadata.previous && metadata.next) {
    statements.push(
      context.env.DB.prepare(
        `
        UPDATE schedule_entries
           SET room_id = ?, starts_at = ?, ends_at = ?,
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND schedule_version_id = ?
           AND session_id = ? AND room_id = ? AND starts_at = ? AND ends_at = ?
           AND revision = ?
           AND EXISTS (
             SELECT 1 FROM schedule_versions
              WHERE id = ? AND event_id = ? AND publication_operation_id = ?
           )
      `,
      ).bind(
        metadata.previous.roomId,
        metadata.previous.startsAt,
        metadata.previous.endsAt,
        metadata.next.id,
        viewer.eventId,
        parsed.scheduleVersionId,
        metadata.next.sessionId,
        metadata.next.roomId,
        metadata.next.startsAt,
        metadata.next.endsAt,
        metadata.next.revision,
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
    );
  } else if (metadata.previous) {
    statements.push(
      context.env.DB.prepare(
        `
        INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at, revision, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM schedule_versions
            WHERE id = ? AND event_id = ? AND publication_operation_id = ?
         )
      `,
      ).bind(
        metadata.previous.id,
        viewer.eventId,
        parsed.scheduleVersionId,
        metadata.previous.sessionId,
        metadata.previous.roomId,
        metadata.previous.startsAt,
        metadata.previous.endsAt,
        metadata.previous.revision + 1,
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
    );
  } else {
    statements.push(
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
        requireValue(metadata.next, "Required metadata.next is unavailable.")
          .id,
        viewer.eventId,
        parsed.scheduleVersionId,
        requireValue(metadata.next, "Required metadata.next is unavailable.")
          .sessionId,
        requireValue(metadata.next, "Required metadata.next is unavailable.")
          .roomId,
        requireValue(metadata.next, "Required metadata.next is unavailable.")
          .startsAt,
        requireValue(metadata.next, "Required metadata.next is unavailable.")
          .endsAt,
        requireValue(metadata.next, "Required metadata.next is unavailable.")
          .revision,
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
    );
  }

  statements.push(
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
      operationId,
    ),
    ...conflicts.map(({ entryId, conflict }) =>
      conflictInsert(
        context.env,
        viewer.eventId,
        parsed.scheduleVersionId,
        entryId,
        conflict,
        operationId,
      ),
    ),
    context.env.DB.prepare(
      `
      UPDATE sessions
         SET status = ?, revision = revision + 1, updated_at = unixepoch()
       WHERE id = ? AND event_id = ? AND status <> 'published'
         AND EXISTS (
           SELECT 1 FROM schedule_versions
            WHERE id = ? AND event_id = ? AND publication_operation_id = ?
         )
    `,
    ).bind(
      metadata.previous ? "scheduled" : "unscheduled",
      requireValue(
        metadata.previous ?? metadata.next,
        "Required (metadata.previous ?? metadata.next) is unavailable.",
      ).sessionId,
      viewer.eventId,
      parsed.scheduleVersionId,
      viewer.eventId,
      operationId,
    ),
    ...(metadata.next && metadata.previousDurationMinutes !== null
      ? [
          context.env.DB.prepare(
            `
            UPDATE sessions
               SET duration_minutes = ?,
                   revision = revision + 1,
                   updated_at = unixepoch()
             WHERE id = ? AND event_id = ?
               AND EXISTS (
                 SELECT 1 FROM schedule_versions
                  WHERE id = ? AND event_id = ? AND publication_operation_id = ?
               )
          `,
          ).bind(
            metadata.previousDurationMinutes,
            metadata.next.sessionId,
            viewer.eventId,
            parsed.scheduleVersionId,
            viewer.eventId,
            operationId,
          ),
          ...sessionContentDurationStatements(context.env, {
            scheduleVersionId: parsed.scheduleVersionId,
            eventId: viewer.eventId,
            sessionId: metadata.next.sessionId,
            durationMinutes: metadata.previousDurationMinutes,
            expectedContentRevision:
              metadata.previousContentRevision === null
                ? requireValue(
                    durationSession,
                    "Required duration session is unavailable.",
                  ).contentRevision
                : metadata.previousContentRevision + 1,
            contentStatus: metadata.previousContentStatus ?? "draft",
            approvedByPersonId: metadata.previousApprovedByPersonId,
            approvedAt: metadata.previousApprovedAt,
            approvalSource: metadata.previousApprovalSource,
            operationId,
            editorPersonId: viewer.personId,
            changeKind: "restore",
            include: true,
          }),
        ]
      : []),
    context.env.DB.prepare(
      `
      INSERT INTO audit_events (
        id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
        entity_type, entity_id, metadata_json, created_at
      )
      SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.entry.undo', 'schedule_entry', ?, ?, unixepoch()
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
      requireValue(
        metadata.previous ?? metadata.next,
        "Required (metadata.previous ?? metadata.next) is unavailable.",
      ).id,
      JSON.stringify({ undoneToken: parsed.undoToken }),
      parsed.scheduleVersionId,
      viewer.eventId,
      operationId,
    ),
  );

  const [updated, changedEntry] = await context.env.DB.batch(statements);
  if (
    (updated.meta.changes ?? 0) !== 1 ||
    (changedEntry.meta.changes ?? 0) !== 1
  ) {
    throw new ScheduleUndoUnavailableError();
  }
  const restoredPlacement = metadata.previous
    ? {
        roomId: metadata.previous.roomId,
        startsAt: metadata.previous.startsAt,
        endsAt: metadata.previous.endsAt,
      }
    : null;
  return {
    entryId: requireValue(
      metadata.previous ?? metadata.next,
      "Required (metadata.previous ?? metadata.next) is unavailable.",
    ).id,
    scheduleRevision: parsed.scheduleRevision + 1,
    sessionId: requireValue(
      metadata.previous ?? metadata.next,
      "Required (metadata.previous ?? metadata.next) is unavailable.",
    ).sessionId,
    restoredPlacement,
  };
}
