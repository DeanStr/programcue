import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  ScheduleConfigurationError,
  ScheduleNotFoundError,
  SchedulePlacementBlockedError,
  ScheduleRevisionConflictError,
} from "./schedule-errors";
import { detectWorkspaceConflicts } from "./schedule-workspace.server";
import { scheduleSessionResourcesSchema } from "./schedule-schema";
import type { ScheduleWorkspace } from "./schedule-service.server";
import { ScheduleContentWorkflowFoundation } from "./schedule-content-workflow-foundation.server";

export abstract class ScheduleSessionResourcesWorkflow extends ScheduleContentWorkflowFoundation {
  async updateSessionResourcesD1(viewer: Viewer, input: unknown) {
    const parsed = scheduleSessionResourcesSchema.parse(input);
    const workspace = await this.getWorkspace(viewer);
    if (
      !workspace.version ||
      workspace.version.id !== parsed.scheduleVersionId ||
      workspace.version.status !== "draft"
    ) {
      throw new ScheduleNotFoundError(
        "Create an active draft before changing session scheduling requirements.",
      );
    }
    if (workspace.version.revision !== parsed.scheduleRevision) {
      throw new ScheduleRevisionConflictError();
    }
    const session = workspace.sessions.find(
      (candidate) => candidate.id === parsed.sessionId,
    );
    if (!session) throw new ScheduleNotFoundError("Session not found.");
    if (session.revision !== parsed.sessionRevision) {
      throw new ScheduleRevisionConflictError();
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

    const prospective: ScheduleWorkspace = {
      ...workspace,
      sessions: workspace.sessions.map((candidate) =>
        candidate.id === session.id
          ? { ...candidate, requiredResources: parsed.requiredResources }
          : candidate,
      ),
    };
    const conflicts = detectWorkspaceConflicts(prospective);
    const scheduledEntry = workspace.entries.find(
      (entry) => entry.sessionId === session.id,
    );
    const blockers = scheduledEntry
      ? conflicts
          .filter(
            ({ entryId, conflict }) =>
              conflict.severity === "blocking" &&
              (entryId === scheduledEntry.id ||
                conflict.conflictingEntryId === scheduledEntry.id),
          )
          .map(({ conflict }) => conflict)
      : [];
    if (blockers.length) throw new SchedulePlacementBlockedError(blockers);

    const operationId = crypto.randomUUID();
    const nextSessionRevision = session.revision + 1;
    const nextContentRevision = session.contentRevision + 1;
    const historyRevisionId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "session.updated",
        entityType: "session",
        entityId: session.id,
        idempotencyKey: `session.updated:${session.id}:${nextSessionRevision}`,
        correlationId: `${session.id}:${nextSessionRevision}`,
        data: {
          revision: nextSessionRevision,
          changedFields: ["requiredResources"],
        },
      },
      auditEventId,
    );
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `UPDATE events
            SET revision = revision + 1, last_operation_id = ?,
                last_updated_by_person_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM schedule_versions version
               WHERE version.id = ? AND version.event_id = events.id
                 AND version.status = 'draft' AND version.revision = ?
            )
            AND EXISTS (
              SELECT 1 FROM sessions configured
               WHERE configured.id = ? AND configured.event_id = events.id
                 AND configured.revision = ?
            )`,
      ).bind(
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        workspace.event.revision,
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
        operationId,
        parsed.scheduleVersionId,
        viewer.eventId,
        parsed.scheduleRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE sessions
            SET required_resources_json = ?, revision = revision + 1,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM schedule_versions
               WHERE id = ? AND event_id = ? AND publication_operation_id = ?
            )`,
      ).bind(
        JSON.stringify(parsed.requiredResources),
        session.id,
        viewer.eventId,
        parsed.sessionRevision,
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE schedule_session_contents
            SET required_resources_json = ?, content_status = 'draft',
                content_revision = content_revision + 1,
                last_edited_by_person_id = ?, approved_by_person_id = NULL,
                approved_at = NULL, last_operation_id = ?,
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
        JSON.stringify(parsed.requiredResources),
        viewer.personId,
        operationId,
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        session.contentRevision,
        operationId,
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
                content.content_status, 'edit', NULL, ?, unixepoch()
           FROM schedule_session_contents content
          WHERE content.schedule_version_id = ? AND content.event_id = ?
            AND content.session_id = ? AND content.last_operation_id = ?
            AND content.content_revision = ?`,
      ).bind(
        historyRevisionId,
        viewer.personId,
        parsed.scheduleVersionId,
        viewer.eventId,
        session.id,
        operationId,
        nextContentRevision,
      ),
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
        operationId,
      ),
      ...conflicts.map(({ entryId, conflict }) =>
        this.conflictInsert(
          viewer.eventId,
          parsed.scheduleVersionId,
          entryId,
          conflict,
          operationId,
        ),
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'session.resources.updated', 'session', ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM schedule_versions
             WHERE id = ? AND event_id = ? AND publication_operation_id = ?
          )`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        session.id,
        JSON.stringify({
          requiredResources: parsed.requiredResources,
          revision: nextSessionRevision,
          contentRevision: nextContentRevision,
          contentStatus: "draft",
        }),
        parsed.scheduleVersionId,
        viewer.eventId,
        operationId,
      ),
    ];
    const auditIndex = statements.length - 1;
    statements.push(...preparedWebhook.statements);
    const results = await this.env.DB.batch(statements);
    const [
      eventUpdated,
      versionUpdated,
      sessionUpdated,
      snapshotUpdated,
      historyInserted,
    ] = results;
    const audit = results[auditIndex]!;
    if (
      (eventUpdated.meta.changes ?? 0) !== 1 ||
      (versionUpdated.meta.changes ?? 0) !== 1 ||
      (sessionUpdated.meta.changes ?? 0) !== 1 ||
      (snapshotUpdated.meta.changes ?? 0) !== 1 ||
      (historyInserted.meta.changes ?? 0) !== 1 ||
      (audit.meta.changes ?? 0) !== 1
    ) {
      throw new ScheduleRevisionConflictError();
    }
    await webhookService.dispatchPreparedEvent(preparedWebhook);
    return {
      sessionId: session.id,
      revision: nextSessionRevision,
      contentRevision: nextContentRevision,
      contentStatus: "draft" as const,
      warnings: conflicts
        .filter(
          ({ entryId, conflict }) =>
            conflict.severity === "warning" &&
            scheduledEntry !== undefined &&
            (entryId === scheduledEntry.id ||
              conflict.conflictingEntryId === scheduledEntry.id),
        )
        .map(({ conflict }) => conflict),
    };
  }
}
