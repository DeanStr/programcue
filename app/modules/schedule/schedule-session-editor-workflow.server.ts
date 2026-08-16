import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  ScheduleConfigurationError,
  ScheduleNotFoundError,
  SchedulePlacementBlockedError,
  ScheduleRevisionConflictError,
} from "./schedule-errors";
import { detectWorkspaceConflicts } from "./schedule-workspace.server";
import type { ScheduleConflict } from "./schedule-rules";
import type { scheduleSessionContentSchema } from "./schedule-schema";
import type {
  ScheduleSession,
  ScheduleWorkspace,
} from "./schedule-service.server";
import { ScheduleSessionResourcesWorkflow } from "./schedule-session-resources-workflow.server";

export abstract class ScheduleSessionEditorWorkflow extends ScheduleSessionResourcesWorkflow {
  async updateSessionContentD1(
    viewer: Viewer,
    parsed: ReturnType<typeof scheduleSessionContentSchema.parse>,
    requestHash: string,
    history: {
      changeKind: "edit" | "restore";
      restoredFromRevisionId: string | null;
    },
  ) {
    type Result = {
      sessionId: string;
      revision: number;
      scheduleRevision: number;
      contentRevision: number;
      contentStatus: "draft";
      warnings: ScheduleConflict[];
    };
    const parseResult = (value: unknown): Result => {
      if (!value || typeof value !== "object")
        throw new Error("The saved session-content response is invalid.");
      const result = value as Partial<Result>;
      if (
        typeof result.sessionId !== "string" ||
        !Number.isSafeInteger(result.revision) ||
        !Number.isSafeInteger(result.scheduleRevision) ||
        !Number.isSafeInteger(result.contentRevision) ||
        result.contentStatus !== "draft" ||
        !Array.isArray(result.warnings)
      ) {
        throw new Error("The saved session-content response is invalid.");
      }
      return result as Result;
    };
    const replay = await this.replayEditorCommand(
      viewer,
      "schedule.session_content.save",
      parsed.idempotencyKey,
      requestHash,
      parseResult,
    );
    if (replay) return replay;

    const workspace = await this.getWorkspace(viewer);
    if (
      !workspace.version ||
      workspace.version.id !== parsed.scheduleVersionId ||
      workspace.version.status !== "draft"
    ) {
      throw new ScheduleNotFoundError(
        "Create an active draft before editing session content.",
      );
    }
    if (workspace.version.revision !== parsed.scheduleRevision)
      throw new ScheduleRevisionConflictError();
    const session = workspace.sessions.find(
      (candidate) => candidate.id === parsed.sessionId,
    );
    if (!session) throw new ScheduleNotFoundError("Session not found.");
    if (session.revision !== parsed.sessionRevision)
      throw new ScheduleRevisionConflictError();
    if (
      !workspace.sessionFormats.some((format) => format.key === parsed.format)
    ) {
      throw new ScheduleConfigurationError(
        `Session format “${parsed.format}” is not configured for this event.`,
      );
    }
    const selectedTrack = parsed.trackId
      ? workspace.tracks.find((track) => track.id === parsed.trackId)
      : null;
    if (parsed.trackId && !selectedTrack) {
      throw new ScheduleConfigurationError(
        "The selected track is not available in this event.",
      );
    }
    const configuredResources = new Set(
      workspace.rooms.flatMap((room) => room.resources),
    );
    const unconfigured = parsed.requiredResources.find(
      (resource) => !configuredResources.has(resource),
    );
    if (unconfigured) {
      throw new ScheduleConfigurationError(
        `Required resource “${unconfigured}” is not configured in any active room.`,
      );
    }

    const scheduledEntry = workspace.entries.find(
      (entry) => entry.sessionId === session.id,
    );
    const prospectiveSession: ScheduleSession = {
      ...session,
      title: parsed.title,
      description: parsed.description,
      trackId: parsed.trackId,
      trackName: selectedTrack ? selectedTrack.name : null,
      trackExclusive: selectedTrack ? selectedTrack.exclusive : false,
      format: parsed.format,
      durationMinutes: parsed.durationMinutes,
      requiredResources: parsed.requiredResources,
      visibility: parsed.visibility,
    };
    const prospective: ScheduleWorkspace = {
      ...workspace,
      sessions: workspace.sessions.map((candidate) =>
        candidate.id === session.id ? prospectiveSession : candidate,
      ),
      entries: workspace.entries.map((entry) =>
        entry.sessionId === session.id
          ? {
              ...entry,
              endsAt: entry.startsAt + parsed.durationMinutes * 60,
            }
          : entry,
      ),
    };
    const conflicts = detectWorkspaceConflicts(prospective);
    const relatedConflicts = scheduledEntry
      ? conflicts
          .filter(
            ({ entryId, conflict }) =>
              entryId === scheduledEntry.id ||
              conflict.conflictingEntryId === scheduledEntry.id,
          )
          .map(({ conflict }) => conflict)
      : [];
    const blockers = relatedConflicts.filter(
      (conflict) => conflict.severity === "blocking",
    );
    if (blockers.length) throw new SchedulePlacementBlockedError(blockers);
    const warnings = relatedConflicts.filter(
      (conflict) => conflict.severity === "warning",
    );

    const commandId = crypto.randomUUID();
    const nextRevision = session.revision + 1;
    const nextScheduleRevision = workspace.version.revision + 1;
    const nextContentRevision = session.contentRevision + 1;
    const result: Result = {
      sessionId: session.id,
      revision: nextRevision,
      scheduleRevision: nextScheduleRevision,
      contentRevision: nextContentRevision,
      contentStatus: "draft",
      warnings,
    };
    const auditEventId = crypto.randomUUID();
    const historyRevisionId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "session.updated",
        entityType: "session",
        entityId: session.id,
        idempotencyKey: `session.updated:${session.id}:${nextRevision}`,
        correlationId: `${session.id}:${nextRevision}`,
        data: {
          revision: nextRevision,
          changedFields: [
            "title",
            "description",
            "format",
            "durationMinutes",
            "trackId",
            "visibility",
            "requiredResources",
          ],
        },
      },
      auditEventId,
    );
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
            AND scope = 'schedule.session_content.save'
            AND idempotency_key = ? AND expires_at <= unixepoch()`,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO idempotency_records (
           id, organisation_id, event_id, actor_id, scope, idempotency_key,
           request_hash, status, expires_at, created_at
         ) VALUES (?, ?, ?, ?, 'schedule.session_content.save', ?, ?,
                   'processing', unixepoch() + 604800, unixepoch())`,
      ).bind(
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
      ),
      this.env.DB.prepare(
        `UPDATE events
            SET revision = revision + 1, last_operation_id = ?,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM idempotency_records command
               WHERE command.id = ? AND command.organisation_id = ?
                 AND command.event_id = ? AND command.actor_id = ?
                 AND command.scope = 'schedule.session_content.save'
                 AND command.idempotency_key = ?
                 AND command.request_hash = ? AND command.status = 'processing'
            )
            AND EXISTS (
              SELECT 1 FROM schedule_versions version
               WHERE version.id = ? AND version.event_id = events.id
                 AND version.status = 'draft' AND version.revision = ?
            )
            AND EXISTS (
              SELECT 1 FROM sessions current_session
               WHERE current_session.id = ?
                 AND current_session.event_id = events.id
                 AND current_session.revision = ?
            )`,
      ).bind(
        commandId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        workspace.event.revision,
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        parsed.scheduleRevision,
        session.id,
        parsed.sessionRevision,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_versions
            SET revision = revision + 1, publication_operation_id = ?
          WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        commandId,
        parsed.scheduleVersionId,
        viewer.eventId,
        parsed.scheduleRevision,
        viewer.eventId,
        viewer.organisationId,
        commandId,
      ),
      this.env.DB.prepare(
        `UPDATE sessions
            SET title = ?, description = ?, track_id = ?, format = ?,
                duration_minutes = ?, required_resources_json = ?,
                visibility = ?, revision = revision + 1,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND status = 'draft'
                 AND publication_operation_id = ?
            )`,
      ).bind(
        parsed.title,
        parsed.description || null,
        parsed.trackId,
        parsed.format,
        parsed.durationMinutes,
        JSON.stringify(parsed.requiredResources),
        parsed.visibility,
        session.id,
        viewer.eventId,
        parsed.sessionRevision,
        parsed.scheduleVersionId,
        viewer.eventId,
        commandId,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_session_contents
            SET title = ?, description = ?, track_id = ?, format = ?,
                duration_minutes = ?, required_resources_json = ?,
                visibility = ?, content_status = 'draft',
                content_revision = content_revision + 1,
                last_edited_by_person_id = ?, approved_by_person_id = NULL,
                approved_at = NULL, approval_source = NULL, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?
            AND content_revision = ?
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = schedule_session_contents.schedule_version_id
                 AND event_id = schedule_session_contents.event_id
                 AND status = 'draft' AND publication_operation_id = ?
            )`,
      ).bind(
        parsed.title,
        parsed.description || null,
        parsed.trackId,
        parsed.format,
        parsed.durationMinutes,
        JSON.stringify(parsed.requiredResources),
        parsed.visibility,
        viewer.personId,
        commandId,
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        session.contentRevision,
        commandId,
      ),
      this.env.DB.prepare(
        `INSERT INTO session_content_revisions (
           id, event_id, schedule_version_id, session_id, revision_number,
           title, slug, description, track_id, format, duration_minutes,
           required_resources_json, visibility, content_status, change_kind,
           restored_from_revision_id, created_by_person_id, created_at
         )
         SELECT ?, content.event_id, content.schedule_version_id,
                content.session_id, content.content_revision, content.title,
                content.slug, content.description, content.track_id,
                content.format, content.duration_minutes,
                content.required_resources_json, content.visibility,
                content.content_status, ?, ?, ?, unixepoch()
           FROM schedule_session_contents content
          WHERE content.schedule_version_id = ? AND content.event_id = ?
            AND content.session_id = ? AND content.last_operation_id = ?
            AND content.content_revision = ?`,
      ).bind(
        historyRevisionId,
        history.changeKind,
        history.restoredFromRevisionId,
        viewer.personId,
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        commandId,
        nextContentRevision,
      ),
      ...(scheduledEntry
        ? [
            this.env.DB.prepare(
              `UPDATE schedule_entries
                  SET ends_at = starts_at + ?, revision = revision + 1,
                      updated_at = unixepoch()
                WHERE id = ? AND event_id = ? AND schedule_version_id = ?
                  AND revision = ?
                  AND EXISTS (
                    SELECT 1 FROM schedule_versions
                     WHERE id = schedule_entries.schedule_version_id
                       AND event_id = schedule_entries.event_id
                       AND status = 'draft' AND publication_operation_id = ?
                  )`,
            ).bind(
              parsed.durationMinutes * 60,
              scheduledEntry.id,
              viewer.eventId,
              parsed.scheduleVersionId,
              scheduledEntry.revision,
              commandId,
            ),
          ]
        : []),
      this.env.DB.prepare(
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
        commandId,
      ),
      ...conflicts.map(({ entryId, conflict }) =>
        this.conflictInsert(
          viewer.eventId,
          parsed.scheduleVersionId,
          entryId,
          conflict,
          commandId,
        ),
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'session.content.updated', 'session', ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM schedule_session_contents
             WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?
               AND last_operation_id = ?
          )`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        session.id,
        JSON.stringify({
          revision: nextRevision,
          scheduleRevision: nextScheduleRevision,
          contentRevision: nextContentRevision,
          contentStatus: "draft",
          visibility: parsed.visibility,
        }),
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        commandId,
      ),
      this.env.DB.prepare(
        `UPDATE idempotency_records
            SET status = 'completed', response_status = 200,
                response_json = ?, entity_type = 'session', entity_id = ?,
                completed_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = 'schedule.session_content.save'
            AND idempotency_key = ? AND request_hash = ?
            AND status = 'processing'
            AND EXISTS (
              SELECT 1 FROM schedule_session_contents
               WHERE schedule_version_id = ? AND event_id = ?
                 AND session_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        JSON.stringify(result),
        session.id,
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        commandId,
      ),
      this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND scope = 'schedule.session_content.save'
            AND idempotency_key = ? AND request_hash = ?
            AND status = 'processing'
            AND NOT EXISTS (
              SELECT 1 FROM schedule_session_contents
               WHERE schedule_version_id = ? AND event_id = ?
                 AND session_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        commandId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        requestHash,
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        commandId,
      ),
    ];
    const auditIndex = statements.length - 3;
    statements.push(...preparedWebhook.statements);
    const results = await this.env.DB.batch(statements);
    const eventUpdated = results[2]!;
    const versionUpdated = results[3]!;
    const sessionUpdated = results[4]!;
    const snapshotUpdated = results[5]!;
    const historyInserted = results[6]!;
    const entryUpdated = scheduledEntry ? results[7]! : null;
    if (
      (eventUpdated.meta.changes ?? 0) !== 1 ||
      (versionUpdated.meta.changes ?? 0) !== 1 ||
      (sessionUpdated.meta.changes ?? 0) !== 1 ||
      (snapshotUpdated.meta.changes ?? 0) !== 1 ||
      (historyInserted.meta.changes ?? 0) !== 1 ||
      (entryUpdated && (entryUpdated.meta.changes ?? 0) !== 1) ||
      (results[auditIndex]?.meta.changes ?? 0) !== 1
    ) {
      const racedReplay = await this.replayEditorCommand(
        viewer,
        "schedule.session_content.save",
        parsed.idempotencyKey,
        requestHash,
        parseResult,
      );
      if (racedReplay) return racedReplay;
      throw new ScheduleRevisionConflictError();
    }
    const completed = await this.replayEditorCommand(
      viewer,
      "schedule.session_content.save",
      parsed.idempotencyKey,
      requestHash,
      parseResult,
    );
    if (!completed)
      throw new Error("The session-content save did not record its result.");
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    return completed;
  }
}
