import type { Viewer } from "~/platform/auth/authorize.server";
import { scheduleDraftConflictRebuildStatements } from "./schedule-conflict-statement.server";
import { ScheduleRevisionConflictError } from "./schedule-errors";
import { ScheduleNotesWorkflow } from "./schedule-notes-workflow.server";
import type { SchedulePolicies } from "./schedule-rules";
import { schedulePolicySchema } from "./schedule-schema";
import {
  detectWorkspaceConflicts,
  schedulePolicyAction,
  scheduleUnavailablePolicyAction,
} from "./schedule-workspace.server";

export abstract class SchedulePolicyWorkflow extends ScheduleNotesWorkflow {
  async updatePoliciesD1(viewer: Viewer, input: unknown) {
    const parsed = schedulePolicySchema.parse(input);
    const workspace = await this.getWorkspace(viewer);
    if (workspace.policyRevision !== parsed.revision)
      throw new ScheduleRevisionConflictError();
    const operationId = crypto.randomUUID();
    const versionGuard = workspace.version
      ? `EXISTS (
           SELECT 1 FROM schedule_versions current_version
            WHERE current_version.id = ? AND current_version.event_id = events.id
              AND current_version.status = ? AND current_version.revision = ?
         )`
      : `NOT EXISTS (
           SELECT 1 FROM schedule_versions current_version
            WHERE current_version.event_id = events.id
              AND current_version.status IN ('draft','published')
         )`;
    const versionBindings = workspace.version
      ? [
          workspace.version.id,
          workspace.version.status,
          workspace.version.revision,
        ]
      : [];
    const nextPolicies: SchedulePolicies = {
      room: schedulePolicyAction(parsed.roomAction),
      speaker: schedulePolicyAction(parsed.speakerAction),
      resource: schedulePolicyAction(parsed.resourceAction),
      track: schedulePolicyAction(parsed.trackAction),
      boundary: schedulePolicyAction(parsed.boundaryAction),
      capacity: schedulePolicyAction(parsed.capacityAction),
      speakerUnavailable: scheduleUnavailablePolicyAction(
        parsed.speakerUnavailableAction,
      ),
      minimumTurnaroundMinutes: parsed.minimumTurnaroundMinutes,
    };
    const conflicts =
      workspace.version?.status === "draft"
        ? detectWorkspaceConflicts({ ...workspace, policies: nextPolicies })
        : [];
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE events
           SET revision = revision + 1, last_operation_id = ?,
               last_updated_by_person_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1 FROM schedule_policies policy
              WHERE policy.event_id = events.id AND policy.revision = ?
           )
           AND ${versionGuard}
      `,
      ).bind(
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
        ...versionBindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE schedule_policies
           SET room_overlap_action = ?, speaker_overlap_action = ?,
               required_resource_overlap_action = ?,
               exclusive_track_overlap_action = ?, event_boundary_action = ?,
               capacity_action = ?, speaker_unavailable_action = ?,
               minimum_turnaround_minutes = ?,
               revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = schedule_policies.event_id AND organisation_id = ?
                AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.roomAction,
        parsed.speakerAction,
        parsed.resourceAction,
        parsed.trackAction,
        parsed.boundaryAction,
        parsed.capacityAction,
        parsed.speakerUnavailableAction,
        parsed.minimumTurnaroundMinutes,
        viewer.eventId,
        parsed.revision,
        viewer.organisationId,
        operationId,
      ),
    ];
    if (workspace.version?.status === "draft") {
      statements.push(
        ...scheduleDraftConflictRebuildStatements(this.env, {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          operationId,
          draft: workspace.version,
          conflicts,
        }),
      );
    }
    const auditIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'schedule.policy.updated', 'schedule_policy', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.eventId,
        JSON.stringify(parsed),
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    );
    const results = await this.env.DB.batch(statements);
    const [eventUpdated, policyUpdated] = results;
    const draftUpdated =
      workspace.version?.status === "draft" ? results[2] : null;
    const audit = results[auditIndex];
    if (
      (eventUpdated.meta.changes ?? 0) !== 1 ||
      (policyUpdated.meta.changes ?? 0) !== 1 ||
      (draftUpdated && (draftUpdated.meta.changes ?? 0) !== 1) ||
      (audit.meta.changes ?? 0) !== 1
    ) {
      throw new ScheduleRevisionConflictError();
    }
  }
}
