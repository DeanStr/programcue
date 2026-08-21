import type { Viewer } from "~/platform/auth/authorize.server";
import { ParticipantTaskWorkflowFoundation } from "./participant-task-workflow-foundation.server";
import {
  isCanonicalSessionDetailsReviewTask,
  loadParticipantSessionDetailsReview,
  SESSION_DETAILS_REVIEW_PRESET,
} from "./session-details-review.server";
import {
  parseTaskEvidenceDetails,
  participantTaskAccessSql,
  structuredTaskForm,
  type TaskRow,
  taskConfiguration,
  taskDestinationUrl,
  taskResourcePageId,
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
      WITH requested_tasks(id) AS (
        SELECT CAST(value AS TEXT) FROM json_each(?)
      ), scoped_dependencies AS (
        SELECT dep.task_id AS taskId, prerequisite.id, prerequisite.title,
               prerequisite.status,
               CASE WHEN prerequisite.event_id = ?
                          AND ${participantTaskAccessSql("prerequisite", true)}
                    THEN 1 ELSE 0 END AS participantAccessible
          FROM task_instance_dependencies dep
          JOIN requested_tasks requested ON requested.id = dep.task_id
          JOIN task_instances prerequisite
            ON prerequisite.id = dep.depends_on_task_id
      )
      SELECT taskId, id, title, status
        FROM scoped_dependencies
       WHERE participantAccessible = 1
      UNION ALL
      SELECT taskId, 'restricted-prerequisite:' || taskId,
             'a prerequisite managed by the event team', 'blocked'
        FROM scoped_dependencies
       WHERE participantAccessible = 0
       GROUP BY taskId
       ORDER BY title
    `,
        )
          .bind(
            JSON.stringify(ids),
            viewer.eventId,
            viewer.personId,
            viewer.personId,
            viewer.personId,
          )
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
    const resourcePageIds = [
      ...new Set(
        tasks.results.flatMap((task) => {
          if (task.taskType !== "acknowledgement") return [];
          const resourcePageId = taskResourcePageId(task.configurationJson);
          return resourcePageId ? [resourcePageId] : [];
        }),
      ),
    ];
    const resourceHrefs = new Map<string, string>();
    if (resourcePageIds.length) {
      const pages = await this.env.DB.prepare(
        `
        SELECT rp.id, rv.slug
          FROM resource_pages rp
          JOIN resource_page_versions rv
            ON rv.resource_page_id = rp.id AND rv.event_id = rp.event_id
         WHERE rp.event_id = ? AND rp.status = 'published'
           AND rv.status = 'published'
           AND rp.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
         ORDER BY rv.version_number DESC
      `,
      )
        .bind(viewer.eventId, JSON.stringify(resourcePageIds))
        .all<{ id: string; slug: string }>();
      for (const page of pages.results) {
        if (resourceHrefs.has(page.id)) continue;
        resourceHrefs.set(
          page.id,
          `/participant/resources?resource=${encodeURIComponent(page.slug)}`,
        );
      }
    }
    const projected = await Promise.all(
      tasks.results.map(async (task) => {
        const configuration = taskConfiguration(task.configurationJson);
        const isSessionDetailsReview =
          configuration.preset === SESSION_DETAILS_REVIEW_PRESET &&
          task.targetType === "session" &&
          task.taskType === "acknowledgement" &&
          task.evidenceMode === "checkbox";
        if (
          configuration.preset === SESSION_DETAILS_REVIEW_PRESET &&
          !(await isCanonicalSessionDetailsReviewTask(
            this.env,
            viewer.eventId,
            task.id,
          ))
        ) {
          throw new Error(
            `Session-details review task ${task.id} differs from the required shared acknowledgement.`,
          );
        }
        const evidenceDetails = task.evidenceJson
          ? parseTaskEvidenceDetails(task.id, task.evidenceJson)
          : null;
        if (
          isSessionDetailsReview &&
          task.status === "completed" &&
          !evidenceDetails?.sessionDetailsReview
        )
          throw new Error(
            `Completed session-details review task ${task.id} is missing its canonical review evidence.`,
          );
        const resourcePageId =
          task.taskType === "acknowledgement"
            ? taskResourcePageId(task.configurationJson)
            : null;
        const taskDependencies = dependencies.results.filter(
          (dependency) => dependency.taskId === task.id,
        );
        const restrictedPrerequisite = taskDependencies.some((dependency) =>
          dependency.id.startsWith("restricted-prerequisite:"),
        );
        return {
          ...task,
          status:
            restrictedPrerequisite &&
            !["completed", "waived", "submitted"].includes(task.status)
              ? ("blocked" as const)
              : task.status,
          readinessState:
            restrictedPrerequisite &&
            !["completed", "waived", "submitted"].includes(task.status)
              ? ("blocked" as const)
              : task.readinessState,
          readinessPercent:
            restrictedPrerequisite &&
            !["completed", "waived", "submitted"].includes(task.status)
              ? 0
              : task.readinessPercent,
          formFields: structuredTaskForm(task.configurationJson)?.fields ?? [],
          destinationUrl:
            task.taskType === "link_visit"
              ? taskDestinationUrl(task.configurationJson)
              : null,
          fileScope:
            task.taskType === "file_upload"
              ? (configuration.fileScope ?? null)
              : null,
          sessionDetailsReview: isSessionDetailsReview
            ? await loadParticipantSessionDetailsReview(
                this.env,
                viewer,
                task.targetId,
              )
            : null,
          reviewedSessionDetails: evidenceDetails?.sessionDetailsReview ?? null,
          resourcePageId,
          resourceHref: resourcePageId
            ? (resourceHrefs.get(resourcePageId) ?? null)
            : null,
          dependencies: taskDependencies,
          comments: comments.results.filter(
            (comment) => comment.taskId === task.id,
          ),
        };
      }),
    );
    const statusOrder = new Map([
      ["overdue", 0],
      ["blocked", 1],
      ["not_started", 2],
      ["in_progress", 3],
      ["submitted", 4],
    ]);
    return projected.sort(
      (left, right) =>
        (statusOrder.get(left.status) ?? 5) -
          (statusOrder.get(right.status) ?? 5) ||
        Number(left.dueAt === null) - Number(right.dueAt === null) ||
        (left.dueAt ?? 0) - (right.dueAt ?? 0) ||
        left.title.localeCompare(right.title),
    );
  }
}
