import type { Viewer } from "~/platform/auth/authorize.server";
import { ParticipantTaskWorkflowFoundation } from "./participant-task-workflow-foundation.server";
import {
  structuredTaskForm,
  type TaskRow,
  taskDestinationUrl,
} from "./task-service-foundation.server";

export class ParticipantTaskQueries extends ParticipantTaskWorkflowFoundation {
  async listParticipantTasks(viewer: Viewer) {
    await this.projectCommand(
      viewer,
      "task.state.refresh.participant",
      { requestedAt: Date.now() },
      () => this.refreshStates(viewer.eventId),
    );
    await this.airtable.assertReadable(viewer);
    return this.listParticipantTasksD1(viewer);
  }

  protected async listParticipantTasksD1(viewer: Viewer) {
    const tasks = await this.env.DB.prepare(
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
             ti.evidence_mode AS evidenceMode,
             ti.configuration_json AS configurationJson
        FROM task_instances ti
        LEFT JOIN people p ON p.id = ti.owner_person_id
        LEFT JOIN sessions target_session
          ON ti.target_type = 'session'
         AND target_session.id = ti.target_id
         AND target_session.event_id = ti.event_id
       WHERE ti.event_id = ? AND ${this.taskAccessClause()}
       ORDER BY CASE ti.status WHEN 'overdue' THEN 0 WHEN 'blocked' THEN 1 WHEN 'not_started' THEN 2 WHEN 'in_progress' THEN 3 WHEN 'submitted' THEN 4 ELSE 5 END,
                ti.due_at IS NULL, ti.due_at, ti.title
    `,
    )
      .bind(viewer.eventId, viewer.personId, viewer.personId, viewer.personId)
      .all<TaskRow>();
    const ids = tasks.results.map((task) => task.id);
    const dependencies = ids.length
      ? await this.env.DB.prepare(
          `
      SELECT dep.task_id AS taskId, prerequisite.id, prerequisite.title, prerequisite.status
        FROM task_instance_dependencies dep
        JOIN task_instances prerequisite ON prerequisite.id = dep.depends_on_task_id
       WHERE dep.task_id IN (
         SELECT CAST(value AS TEXT) FROM json_each(?)
       )
       ORDER BY prerequisite.title
    `,
        )
          .bind(JSON.stringify(ids))
          .all<{ taskId: string; id: string; title: string; status: string }>()
      : { results: [] };
    const comments = ids.length
      ? await this.env.DB.prepare(
          `
      SELECT tc.id, tc.task_id AS taskId, tc.body, tc.visibility, tc.created_at AS createdAt,
             p.display_name AS authorName
        FROM task_comments tc JOIN people p ON p.id = tc.author_person_id
       WHERE tc.task_id IN (
         SELECT CAST(value AS TEXT) FROM json_each(?)
       ) AND tc.visibility = 'participant'
       ORDER BY tc.created_at
    `,
        )
          .bind(JSON.stringify(ids))
          .all<{
            id: string;
            taskId: string;
            body: string;
            visibility: string;
            createdAt: number;
            authorName: string;
          }>()
      : { results: [] };
    return tasks.results.map((task) => ({
      ...task,
      formFields: structuredTaskForm(task.configurationJson)?.fields ?? [],
      destinationUrl:
        task.taskType === "link_visit"
          ? taskDestinationUrl(task.configurationJson)
          : null,
      dependencies: dependencies.results.filter(
        (dependency) => dependency.taskId === task.id,
      ),
      comments: comments.results.filter(
        (comment) => comment.taskId === task.id,
      ),
    }));
  }
}
