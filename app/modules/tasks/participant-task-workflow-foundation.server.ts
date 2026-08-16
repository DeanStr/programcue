import type { Viewer } from "~/platform/auth/authorize.server";
import {
  parseTaskEvidenceDetails,
  type TaskRow,
  TaskServiceFoundation,
  TaskStateError,
  type TemplateRow,
} from "./task-service-foundation.server";

export class ParticipantTaskWorkflowFoundation extends TaskServiceFoundation {
  protected async participantTask(viewer: Viewer, taskId: string) {
    return this.env.DB.prepare(
      `
      SELECT ti.id, ti.template_id AS templateId, ti.target_type AS targetType,
             ti.target_id AS targetId, target_session.title AS targetLabel,
             ti.owner_person_id AS ownerPersonId, p.display_name AS ownerName, ti.title, ti.description,
             ti.task_type AS taskType, ti.impact, ti.status, ti.readiness_state AS readinessState,
             ti.readiness_percent AS readinessPercent, ti.revision, ti.due_at AS dueAt,
             ti.evidence_json AS evidenceJson, ti.waiver_json AS waiverJson,
             ti.submitted_at AS submittedAt, ti.completed_at AS completedAt,
             ti.completed_by_person_id AS completedByPersonId,
             ti.last_operation_id AS lastOperationId,
             tt.evidence_mode AS evidenceMode,
             COALESCE(tt.configuration_json, '{}') AS configurationJson
        FROM task_instances ti
        LEFT JOIN people p ON p.id = ti.owner_person_id
        LEFT JOIN task_templates tt ON tt.id = ti.template_id
        LEFT JOIN sessions target_session
          ON ti.target_type = 'session'
         AND target_session.id = ti.target_id
         AND target_session.event_id = ti.event_id
       WHERE ti.id = ? AND ti.event_id = ? AND ${this.taskAccessClause()}
    `,
    )
      .bind(
        taskId,
        viewer.eventId,
        viewer.personId,
        viewer.personId,
        viewer.personId,
      )
      .first<TaskRow & { evidenceMode: TemplateRow["evidenceMode"] | null }>();
  }

  async assertFileEvidenceUploadAllowed(viewer: Viewer, taskId: string) {
    await this.airtable.assertReadable(viewer);
    const task = await this.participantTask(viewer, taskId);
    if (task?.taskType !== "file_upload")
      throw new TaskStateError(
        "File task not found or not owned by this speaker.",
      );
    if (["completed", "waived"].includes(task.status))
      throw new TaskStateError("This task is already completed or waived.");
    if (!(await this.dependenciesComplete(task.id)))
      throw new TaskStateError("Complete the prerequisite tasks first.");
    return task;
  }

  protected async submittedFileEvidence(
    viewer: Viewer,
    task: TaskRow,
  ): Promise<{
    assetId: string;
    versionId: string;
    versionNumber: number;
  } | null> {
    if (task.status !== "submitted") return null;
    if (!task.evidenceJson) {
      throw new TaskStateError(
        "The submitted file task is missing canonical evidence metadata.",
      );
    }
    let details: ReturnType<typeof parseTaskEvidenceDetails>;
    try {
      details = parseTaskEvidenceDetails(task.id, task.evidenceJson);
    } catch {
      throw new TaskStateError(
        "The submitted file task has invalid canonical evidence metadata.",
      );
    }
    if (!details.fileAssetId || !details.fileVersionId) {
      throw new TaskStateError(
        "The submitted file task is missing canonical evidence metadata.",
      );
    }
    const canonical = await this.env.DB.prepare(
      `SELECT version.version_number AS versionNumber
         FROM file_assets asset
         JOIN file_versions version
           ON version.id = ? AND version.asset_id = asset.id
          AND version.event_id = asset.event_id
         JOIN task_evidence evidence
           ON evidence.event_id = asset.event_id
          AND evidence.task_id = asset.target_id
          AND evidence.file_asset_id = asset.id
          AND evidence.submitted_by_person_id = ?
          AND evidence.status = 'submitted'
          AND CASE WHEN json_valid(evidence.evidence_json)
                THEN json_extract(evidence.evidence_json, '$.fileVersionId')
              END = version.id
        WHERE asset.id = ? AND asset.event_id = ?
          AND asset.owner_person_id = ? AND asset.target_type = 'task'
          AND asset.target_id = ? AND asset.asset_kind = 'task_evidence'
          AND asset.status <> 'deleted' AND version.deleted_at IS NULL
          AND version.created_by_person_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM audit_events audit
             WHERE audit.id = 'file-erasure:' || asset.id
          )`,
    )
      .bind(
        details.fileVersionId,
        viewer.personId,
        details.fileAssetId,
        viewer.eventId,
        viewer.personId,
        task.id,
        viewer.personId,
      )
      .first<{ versionNumber: number }>();
    if (!canonical || !Number.isSafeInteger(canonical.versionNumber)) {
      throw new TaskStateError(
        "The submitted file task has inconsistent canonical evidence.",
      );
    }
    return {
      assetId: details.fileAssetId,
      versionId: details.fileVersionId,
      versionNumber: canonical.versionNumber,
    };
  }
}
