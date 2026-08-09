import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { eventLocalTimeEpoch } from "~/modules/schedule/schedule-time";
import {
  participantEvidenceSchema,
  taskEvidenceUrlSchema,
  taskTemplateInputSchema,
} from "./task-schema";

export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStateError";
  }
}

type TemplateRow = {
  id: string;
  name: string;
  description: string | null;
  targetType: "speaker" | "session" | "event";
  taskType:
    | "checklist"
    | "acknowledgement"
    | "short_form"
    | "file_upload"
    | "link_visit"
    | "administrator_only";
  impact: "critical" | "high" | "medium" | "low";
  evidenceMode:
    "none" | "checkbox" | "file" | "text" | "link" | "admin_approval";
  dueAnchor: "none" | "acceptance" | "session_start" | "fixed";
  dueOffsetMinutes: number | null;
  fixedDueAt: number | null;
  configurationJson: string;
  status: string;
};

type TaskRow = {
  id: string;
  templateId: string | null;
  targetType: string;
  targetId: string;
  ownerPersonId: string | null;
  ownerName: string | null;
  title: string;
  description: string | null;
  taskType: TemplateRow["taskType"];
  impact: TemplateRow["impact"];
  status:
    | "not_started"
    | "in_progress"
    | "blocked"
    | "submitted"
    | "completed"
    | "waived"
    | "overdue";
  readinessState: string;
  readinessPercent: number;
  revision: number;
  dueAt: number | null;
  evidenceJson: string | null;
  waiverJson: string | null;
  completedAt: number | null;
};

const taskEvidenceDetailsSchema = z
  .object({
    confirmed: z.boolean().optional(),
    text: z.string().optional(),
    url: taskEvidenceUrlSchema.optional(),
    fileVersionId: z.string().optional(),
    scanStatus: z.string().optional(),
  })
  .passthrough();

function parseTaskEvidenceDetails(taskId: string, value: string) {
  try {
    return taskEvidenceDetailsSchema.parse(JSON.parse(value));
  } catch (error) {
    throw new Error(`Task ${taskId} contains invalid evidence metadata.`, {
      cause: error,
    });
  }
}

export function fixedDateEndEpoch(value: string | null, timezone: string) {
  if (!value) return null;
  const endMarker = Math.floor(Date.parse(`${value}T23:59:59Z`) / 1_000);
  return eventLocalTimeEpoch(endMarker + 1, timezone, 0) - 1;
}

function statusProgress(status: TaskRow["status"]) {
  if (status === "completed" || status === "waived")
    return { percent: 100, readiness: "on_track" };
  if (status === "submitted") return { percent: 80, readiness: "on_track" };
  if (status === "in_progress") return { percent: 40, readiness: "at_risk" };
  if (status === "blocked") return { percent: 0, readiness: "blocked" };
  if (status === "overdue") return { percent: 0, readiness: "overdue" };
  return { percent: 0, readiness: "on_track" };
}

export class TaskService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async assertEvent(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      "SELECT timezone FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ timezone: string }>();
    if (!row) throw new Response("Event not found.", { status: 404 });
    return row;
  }

  private async refreshStates(eventId: string) {
    await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE task_instances AS task
           SET status = 'blocked', readiness_state = 'blocked', readiness_percent = 0, updated_at = unixepoch()
         WHERE event_id = ? AND status IN ('not_started','in_progress','overdue')
           AND EXISTS (
             SELECT 1 FROM task_instance_dependencies dep
             JOIN task_instances prerequisite ON prerequisite.id = dep.depends_on_task_id
              WHERE dep.task_id = task.id AND prerequisite.status NOT IN ('completed','waived')
           )
      `,
      ).bind(eventId),
      this.env.DB.prepare(
        `
        UPDATE task_instances AS task
           SET status = CASE WHEN due_at IS NOT NULL AND due_at < unixepoch() THEN 'overdue' ELSE 'not_started' END,
               readiness_state = CASE WHEN due_at IS NOT NULL AND due_at < unixepoch() THEN 'overdue' ELSE 'on_track' END,
               updated_at = unixepoch()
         WHERE event_id = ? AND status = 'blocked'
           AND NOT EXISTS (
             SELECT 1 FROM task_instance_dependencies dep
             JOIN task_instances prerequisite ON prerequisite.id = dep.depends_on_task_id
              WHERE dep.task_id = task.id AND prerequisite.status NOT IN ('completed','waived')
           )
      `,
      ).bind(eventId),
      this.env.DB.prepare(
        `
        UPDATE task_instances
           SET status = 'overdue', readiness_state = 'overdue', readiness_percent = 0, updated_at = unixepoch()
         WHERE event_id = ? AND due_at IS NOT NULL AND due_at < unixepoch()
           AND status IN ('not_started','in_progress')
      `,
      ).bind(eventId),
    ]);
  }

  async createTemplate(viewer: Viewer, rawInput: unknown) {
    const event = await this.assertEvent(viewer);
    const input = taskTemplateInputSchema.parse(rawInput);
    if (input.dependencyIds.length) {
      const placeholders = input.dependencyIds.map(() => "?").join(",");
      const dependencies = await this.env.DB.prepare(
        `
        SELECT COUNT(*) AS count FROM task_templates
         WHERE event_id = ? AND status = 'active' AND id IN (${placeholders})
      `,
      )
        .bind(viewer.eventId, ...input.dependencyIds)
        .first<{ count: number }>();
      if (dependencies?.count !== new Set(input.dependencyIds).size)
        throw new TaskStateError(
          "One or more prerequisite templates are unavailable in this event.",
        );
    }
    const id = crypto.randomUUID();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO task_templates (
          id, event_id, name, description, target_type, task_type, impact, evidence_mode,
          due_anchor, due_offset_minutes, fixed_due_at, configuration_json, status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 'active', unixepoch(), unixepoch())
      `,
      ).bind(
        id,
        viewer.eventId,
        input.name,
        input.description || null,
        input.targetType,
        input.taskType,
        input.impact,
        input.evidenceMode,
        input.dueAnchor,
        input.dueOffsetDays === null ? null : input.dueOffsetDays * 1_440,
        fixedDateEndEpoch(input.fixedDueDate, event.timezone),
      ),
      ...[...new Set(input.dependencyIds)].map((dependencyId) =>
        this.env.DB.prepare(
          `
        INSERT INTO task_template_dependencies (template_id, depends_on_template_id, created_at) VALUES (?, ?, unixepoch())
      `,
        ).bind(id, dependencyId),
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, 'task_template.created', 'task_template', ?, ?, unixepoch())
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        id,
        JSON.stringify({
          taskType: input.taskType,
          dependencies: input.dependencyIds,
        }),
      ),
    ]);
    return id;
  }

  private async getTemplate(eventId: string, templateId: string) {
    return this.env.DB.prepare(
      `
      SELECT id, name, description, target_type AS targetType, task_type AS taskType, impact,
             evidence_mode AS evidenceMode, due_anchor AS dueAnchor, due_offset_minutes AS dueOffsetMinutes,
             fixed_due_at AS fixedDueAt, configuration_json AS configurationJson, status
        FROM task_templates WHERE id = ? AND event_id = ?
    `,
    )
      .bind(templateId, eventId)
      .first<TemplateRow>();
  }

  private async dueAtFor(
    template: TemplateRow,
    eventId: string,
    personId: string,
  ) {
    let anchor: number | null = null;
    if (template.dueAnchor === "fixed") anchor = template.fixedDueAt;
    if (template.dueAnchor === "acceptance") {
      const row = await this.env.DB.prepare(
        `
        SELECT MIN(sd.published_at) AS anchor
          FROM session_speakers ss
          JOIN sessions s ON s.id = ss.session_id AND s.event_id = ss.event_id
          JOIN submission_decisions sd ON sd.submission_id = s.source_submission_id AND sd.event_id = s.event_id
         WHERE ss.event_id = ? AND ss.person_id = ? AND sd.status = 'published' AND sd.decision = 'accepted'
      `,
      )
        .bind(eventId, personId)
        .first<{ anchor: number | null }>();
      anchor = row?.anchor ?? null;
    }
    if (template.dueAnchor === "session_start") {
      const row = await this.env.DB.prepare(
        `
        SELECT MIN(se.starts_at) AS anchor
          FROM session_speakers ss
          JOIN schedule_versions sv ON sv.event_id = ss.event_id AND sv.status = 'published'
          JOIN schedule_entries se ON se.schedule_version_id = sv.id AND se.session_id = ss.session_id
         WHERE ss.event_id = ? AND ss.person_id = ?
      `,
      )
        .bind(eventId, personId)
        .first<{ anchor: number | null }>();
      anchor = row?.anchor ?? null;
    }
    return anchor === null
      ? null
      : anchor + (template.dueOffsetMinutes ?? 0) * 60;
  }

  private async assertSpeakerTarget(eventId: string, personId: string) {
    const speaker = await this.env.DB.prepare(
      `
      SELECT 1 FROM memberships
       WHERE event_id = ? AND person_id = ? AND role = 'speaker' AND accepted_at IS NOT NULL AND revoked_at IS NULL
      UNION SELECT 1 FROM session_speakers WHERE event_id = ? AND person_id = ? LIMIT 1
    `,
    )
      .bind(eventId, personId, eventId, personId)
      .first();
    if (!speaker)
      throw new TaskStateError(
        "The selected person is not a speaker in this event.",
      );
  }

  private async materializeTemplate(
    viewer: Viewer,
    templateId: string,
    personId: string,
    visiting = new Set<string>(),
  ): Promise<string> {
    const existing = await this.env.DB.prepare(
      `
      SELECT id FROM task_instances WHERE event_id = ? AND template_id = ? AND target_type = 'speaker' AND target_id = ? LIMIT 1
    `,
    )
      .bind(viewer.eventId, templateId, personId)
      .first<{ id: string }>();
    if (existing) return existing.id;
    if (visiting.has(templateId))
      throw new TaskStateError("Task template dependencies contain a cycle.");
    visiting.add(templateId);
    const template = await this.getTemplate(viewer.eventId, templateId);
    if (!template || template.status !== "active")
      throw new TaskStateError("Task template not found or archived.");
    if (template.targetType !== "speaker")
      throw new TaskStateError(
        "This assignment workflow currently accepts speaker-scoped templates only.",
      );
    const dueAt = await this.dueAtFor(template, viewer.eventId, personId);
    if (template.dueAnchor !== "none" && dueAt === null) {
      throw new TaskStateError(
        `The ${template.dueAnchor.replace("_", " ")} due anchor cannot be resolved for this speaker.`,
      );
    }
    const dependencyRows = await this.env.DB.prepare(
      `
      SELECT depends_on_template_id AS id FROM task_template_dependencies WHERE template_id = ?
    `,
    )
      .bind(templateId)
      .all<{ id: string }>();
    const dependencyTaskIds: string[] = [];
    for (const dependency of dependencyRows.results) {
      dependencyTaskIds.push(
        await this.materializeTemplate(
          viewer,
          dependency.id,
          personId,
          visiting,
        ),
      );
    }
    visiting.delete(templateId);
    const id = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const blocked = dependencyTaskIds.length > 0;
    const [inserted] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO task_instances (
          id, event_id, template_id, target_type, target_id, owner_person_id, title, description,
          task_type, impact, status, readiness_state, readiness_percent, revision, last_operation_id,
          due_at, created_at, updated_at
        ) VALUES (?, ?, ?, 'speaker', ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, unixepoch(), unixepoch())
      `,
      ).bind(
        id,
        viewer.eventId,
        template.id,
        personId,
        personId,
        template.name,
        template.description,
        template.taskType,
        template.impact,
        blocked ? "blocked" : "not_started",
        blocked ? "blocked" : "on_track",
        operationId,
        dueAt,
      ),
      ...dependencyTaskIds.map((dependencyTaskId) =>
        this.env.DB.prepare(
          `
        INSERT INTO task_instance_dependencies (task_id, depends_on_task_id, created_at)
        SELECT ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM task_instances
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
      `,
        ).bind(id, dependencyTaskId, id, viewer.eventId, operationId),
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'task.assigned', 'task_instance', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM task_instances
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        id,
        JSON.stringify({ templateId, personId }),
        id,
        viewer.eventId,
        operationId,
      ),
    ]);
    if ((inserted.meta.changes ?? 0) === 1) return id;
    const winner = await this.env.DB.prepare(
      `
      SELECT id FROM task_instances
       WHERE event_id = ? AND template_id = ? AND target_type = 'speaker' AND target_id = ?
       LIMIT 1
    `,
    )
      .bind(viewer.eventId, templateId, personId)
      .first<{ id: string }>();
    if (winner) return winner.id;
    throw new TaskStateError(
      "The task assignment changed before it could be created.",
    );
  }

  async assignTemplate(viewer: Viewer, templateId: string, personId: string) {
    await this.assertEvent(viewer);
    await this.assertSpeakerTarget(viewer.eventId, personId);
    return this.materializeTemplate(
      viewer,
      z.string().min(1).parse(templateId),
      z.string().min(1).parse(personId),
    );
  }

  private taskAccessClause() {
    return `(
      ti.owner_person_id = ?
      OR (ti.target_type = 'speaker' AND ti.target_id = ?)
      OR (ti.target_type = 'session' AND EXISTS (
        SELECT 1 FROM session_speakers ss
         WHERE ss.event_id = ti.event_id AND ss.session_id = ti.target_id AND ss.person_id = ?
      ))
    )`;
  }

  async listParticipantTasks(viewer: Viewer) {
    await this.refreshStates(viewer.eventId);
    const tasks = await this.env.DB.prepare(
      `
      SELECT ti.id, ti.template_id AS templateId, ti.target_type AS targetType, ti.target_id AS targetId,
             ti.owner_person_id AS ownerPersonId, p.display_name AS ownerName, ti.title, ti.description,
             ti.task_type AS taskType, ti.impact, ti.status, ti.readiness_state AS readinessState,
             ti.readiness_percent AS readinessPercent, ti.revision, ti.due_at AS dueAt,
             ti.evidence_json AS evidenceJson, ti.waiver_json AS waiverJson, ti.completed_at AS completedAt
        FROM task_instances ti LEFT JOIN people p ON p.id = ti.owner_person_id
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
      dependencies: dependencies.results.filter(
        (dependency) => dependency.taskId === task.id,
      ),
      comments: comments.results.filter(
        (comment) => comment.taskId === task.id,
      ),
    }));
  }

  private async participantTask(viewer: Viewer, taskId: string) {
    return this.env.DB.prepare(
      `
      SELECT ti.id, ti.template_id AS templateId, ti.target_type AS targetType, ti.target_id AS targetId,
             ti.owner_person_id AS ownerPersonId, p.display_name AS ownerName, ti.title, ti.description,
             ti.task_type AS taskType, ti.impact, ti.status, ti.readiness_state AS readinessState,
             ti.readiness_percent AS readinessPercent, ti.revision, ti.due_at AS dueAt,
             ti.evidence_json AS evidenceJson, ti.waiver_json AS waiverJson, ti.completed_at AS completedAt,
             tt.evidence_mode AS evidenceMode
        FROM task_instances ti
        LEFT JOIN people p ON p.id = ti.owner_person_id
        LEFT JOIN task_templates tt ON tt.id = ti.template_id
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

  private async dependenciesComplete(taskId: string) {
    const incomplete = await this.env.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM task_instance_dependencies dep
      JOIN task_instances prerequisite ON prerequisite.id = dep.depends_on_task_id
      WHERE dep.task_id = ? AND prerequisite.status NOT IN ('completed','waived')
    `,
    )
      .bind(taskId)
      .first<{ count: number }>();
    return (incomplete?.count ?? 0) === 0;
  }

  async assertFileEvidenceUploadAllowed(viewer: Viewer, taskId: string) {
    const task = await this.participantTask(viewer, taskId);
    if (!task || task.taskType !== "file_upload")
      throw new TaskStateError(
        "File task not found or not owned by this speaker.",
      );
    if (["completed", "waived", "submitted"].includes(task.status))
      throw new TaskStateError(
        task.status === "submitted"
          ? "This file task is already awaiting administrator review."
          : "This task is already completed or waived.",
      );
    if (!(await this.dependenciesComplete(task.id)))
      throw new TaskStateError("Complete the prerequisite tasks first.");
    return task;
  }

  async completeParticipant(viewer: Viewer, rawInput: unknown) {
    const input = participantEvidenceSchema.parse(rawInput);
    const task = await this.participantTask(viewer, input.taskId);
    if (!task)
      throw new TaskStateError("Task not found or not owned by this speaker.");
    if (task.revision !== input.revision)
      throw new TaskStateError(
        "This task changed. Refresh before completing it.",
      );
    if (["completed", "waived", "submitted"].includes(task.status))
      throw new TaskStateError(
        "This task is already final or awaiting review.",
      );
    if (task.taskType === "administrator_only")
      throw new TaskStateError("Only an administrator can complete this task.");
    if (task.taskType === "file_upload")
      throw new TaskStateError("Upload a file to submit this task.");
    if (!(await this.dependenciesComplete(task.id)))
      throw new TaskStateError("Complete the prerequisite tasks first.");
    const evidence: Record<string, unknown> = {};
    if (["checklist", "acknowledgement"].includes(task.taskType)) {
      if (!(
        input.confirmed === true ||
        input.confirmed === "true" ||
        input.confirmed === "on"
      ))
        throw new TaskStateError("Confirm the task before completing it.");
      evidence.confirmed = true;
    }
    if (task.taskType === "short_form") {
      if (!input.text)
        throw new TaskStateError("Enter the requested response.");
      evidence.text = input.text;
    }
    if (task.taskType === "link_visit") {
      if (!input.url) throw new TaskStateError("Enter the link you visited.");
      evidence.url = input.url;
    }
    const nextStatus =
      task.evidenceMode === "admin_approval" ? "submitted" : "completed";
    const progress = statusProgress(nextStatus);
    const evidenceId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE task_instances SET status = ?, readiness_state = ?, readiness_percent = ?, evidence_json = ?,
          submitted_at = unixepoch(), completed_at = CASE WHEN ? = 'completed' THEN unixepoch() ELSE NULL END,
          completed_by_person_id = CASE WHEN ? = 'completed' THEN ? ELSE NULL END,
          revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ? AND status NOT IN ('completed','waived','submitted')
           AND NOT EXISTS (
             SELECT 1 FROM task_instance_dependencies dep
             JOIN task_instances prerequisite ON prerequisite.id = dep.depends_on_task_id
              WHERE dep.task_id = task_instances.id
                AND prerequisite.status NOT IN ('completed','waived')
           )
      `,
      ).bind(
        nextStatus,
        progress.readiness,
        progress.percent,
        JSON.stringify(evidence),
        nextStatus,
        nextStatus,
        viewer.personId,
        operationId,
        task.id,
        viewer.eventId,
        task.revision,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO task_evidence (id, event_id, task_id, submitted_by_person_id, evidence_json, status, created_at)
        SELECT ?, ?, ?, ?, ?, ?, unixepoch() WHERE EXISTS (
          SELECT 1 FROM task_instances
           WHERE id = ? AND event_id = ? AND revision = ? AND last_operation_id = ?
        )
      `,
      ).bind(
        evidenceId,
        viewer.eventId,
        task.id,
        viewer.personId,
        JSON.stringify(evidence),
        nextStatus === "completed" ? "approved" : "submitted",
        task.id,
        viewer.eventId,
        task.revision + 1,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, ?, 'task_instance', ?, ?, unixepoch() WHERE EXISTS (
          SELECT 1 FROM task_instances
           WHERE id = ? AND event_id = ? AND revision = ? AND last_operation_id = ?
        )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        nextStatus === "completed" ? "task.completed" : "task.submitted",
        task.id,
        JSON.stringify({ evidenceId }),
        task.id,
        viewer.eventId,
        task.revision + 1,
        operationId,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1)
      throw new TaskStateError(
        "This task changed. Refresh before completing it.",
      );
    await this.refreshStates(viewer.eventId);
  }

  async submitFileEvidence(viewer: Viewer, taskId: string, assetId: string) {
    const task = await this.assertFileEvidenceUploadAllowed(viewer, taskId);
    const asset = await this.env.DB.prepare(
      `
      SELECT fa.id, fv.id AS versionId, fv.upload_status AS uploadStatus, fv.signature_status AS signatureStatus,
             fv.scan_status AS scanStatus
        FROM file_assets fa JOIN file_versions fv ON fv.asset_id = fa.id
       WHERE fa.id = ? AND fa.event_id = ? AND fa.owner_person_id = ? AND fa.target_type = 'task' AND fa.target_id = ?
       ORDER BY fv.version_number DESC LIMIT 1
    `,
    )
      .bind(assetId, viewer.eventId, viewer.personId, task.id)
      .first<{
        id: string;
        versionId: string;
        uploadStatus: string;
        signatureStatus: string;
        scanStatus: string;
      }>();
    if (
      !asset ||
      asset.uploadStatus !== "uploaded" ||
      asset.signatureStatus !== "valid"
    )
      throw new TaskStateError("The file upload did not complete safely.");
    const evidenceId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const taskEvidenceJson = JSON.stringify({
      fileAssetId: asset.id,
      fileVersionId: asset.versionId,
      scanStatus: asset.scanStatus,
    });
    const evidenceJson = JSON.stringify({
      fileVersionId: asset.versionId,
      scanStatus: asset.scanStatus,
    });
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE task_instances SET status = 'submitted', readiness_state = 'on_track', readiness_percent = 80,
          evidence_json = ?, submitted_at = unixepoch(), revision = revision + 1,
          last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ? AND status NOT IN ('completed','waived')
           AND NOT EXISTS (
             SELECT 1 FROM task_instance_dependencies dep
             JOIN task_instances prerequisite ON prerequisite.id = dep.depends_on_task_id
              WHERE dep.task_id = task_instances.id
                AND prerequisite.status NOT IN ('completed','waived')
           )
      `,
      ).bind(
        taskEvidenceJson,
        operationId,
        task.id,
        viewer.eventId,
        task.revision,
      ),
      this.env.DB.prepare(
        `
        UPDATE task_evidence SET status = 'superseded'
         WHERE task_id = ? AND status = 'submitted'
           AND EXISTS (
             SELECT 1 FROM task_instances
              WHERE id = ? AND event_id = ? AND revision = ? AND last_operation_id = ?
           )
      `,
      ).bind(task.id, task.id, viewer.eventId, task.revision + 1, operationId),
      this.env.DB.prepare(
        `
        INSERT INTO task_evidence (id, event_id, task_id, submitted_by_person_id, file_asset_id, evidence_json, status, created_at)
        SELECT ?, ?, ?, ?, ?, ?, 'submitted', unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM task_instances
            WHERE id = ? AND event_id = ? AND revision = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        evidenceId,
        viewer.eventId,
        task.id,
        viewer.personId,
        asset.id,
        evidenceJson,
        task.id,
        viewer.eventId,
        task.revision + 1,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'task.file.submitted', 'task_instance', ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM task_evidence WHERE id = ? AND event_id = ? AND task_id = ?
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        task.id,
        JSON.stringify({ evidenceId, assetId, scanStatus: asset.scanStatus }),
        evidenceId,
        viewer.eventId,
        task.id,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1)
      throw new TaskStateError(
        "This task changed. Refresh before submitting file evidence.",
      );
  }

  async addComment(
    viewer: Viewer,
    taskId: string,
    body: string,
    visibility: "participant" | "administrator" = "participant",
  ) {
    const clean = z.string().trim().min(1).max(2_000).parse(body);
    if (viewer.role === "speaker") {
      const task = await this.participantTask(viewer, taskId);
      if (!task)
        throw new TaskStateError(
          "Task not found or not owned by this speaker.",
        );
      visibility = "participant";
    } else {
      await this.assertEvent(viewer);
      const task = await this.env.DB.prepare(
        "SELECT 1 FROM task_instances WHERE id = ? AND event_id = ?",
      )
        .bind(taskId, viewer.eventId)
        .first();
      if (!task) throw new TaskStateError("Task not found.");
    }
    await this.env.DB.prepare(
      `
      INSERT INTO task_comments (id, event_id, task_id, author_person_id, body, visibility, created_at)
      VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    `,
    )
      .bind(
        crypto.randomUUID(),
        viewer.eventId,
        taskId,
        viewer.personId,
        clean,
        visibility,
      )
      .run();
  }

  async getAdminWorkspace(viewer: Viewer) {
    const event = await this.assertEvent(viewer);
    await this.refreshStates(viewer.eventId);
    const [templates, tasks, speakers, dependencyRows, evidence, comments] =
      await Promise.all([
        this.env.DB.prepare(
          `
        SELECT id, name, description, target_type AS targetType, task_type AS taskType, impact,
               evidence_mode AS evidenceMode, due_anchor AS dueAnchor, due_offset_minutes AS dueOffsetMinutes,
               fixed_due_at AS fixedDueAt, configuration_json AS configurationJson, status
          FROM task_templates WHERE event_id = ? ORDER BY status, name
      `,
        )
          .bind(viewer.eventId)
          .all<TemplateRow>(),
        this.env.DB.prepare(
          `
        SELECT ti.id, ti.template_id AS templateId, ti.target_type AS targetType, ti.target_id AS targetId,
               ti.owner_person_id AS ownerPersonId, p.display_name AS ownerName, ti.title, ti.description,
               ti.task_type AS taskType, ti.impact, ti.status, ti.readiness_state AS readinessState,
               ti.readiness_percent AS readinessPercent, ti.revision, ti.due_at AS dueAt,
               ti.evidence_json AS evidenceJson, ti.waiver_json AS waiverJson, ti.completed_at AS completedAt
          FROM task_instances ti LEFT JOIN people p ON p.id = ti.owner_person_id
         WHERE ti.event_id = ? ORDER BY ti.status, ti.due_at IS NULL, ti.due_at, ti.title
      `,
        )
          .bind(viewer.eventId)
          .all<TaskRow>(),
        this.env.DB.prepare(
          `
        SELECT DISTINCT p.id, p.display_name AS name, p.email
          FROM people p
          LEFT JOIN memberships m ON m.person_id = p.id AND m.event_id = ? AND m.role = 'speaker' AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
          LEFT JOIN session_speakers ss ON ss.person_id = p.id AND ss.event_id = ?
         WHERE m.id IS NOT NULL OR ss.person_id IS NOT NULL ORDER BY p.display_name
      `,
        )
          .bind(viewer.eventId, viewer.eventId)
          .all<{ id: string; name: string; email: string }>(),
        this.env.DB.prepare(
          `
        SELECT template_id AS templateId, depends_on_template_id AS dependsOnTemplateId
          FROM task_template_dependencies
         WHERE template_id IN (SELECT id FROM task_templates WHERE event_id = ?)
      `,
        )
          .bind(viewer.eventId)
          .all<{ templateId: string; dependsOnTemplateId: string }>(),
        this.env.DB.prepare(
          `
        SELECT te.id, te.task_id AS taskId, te.file_asset_id AS fileAssetId, te.evidence_json AS evidenceJson,
               te.status, te.created_at AS createdAt, p.display_name AS submittedBy,
               CASE WHEN te.file_asset_id IS NOT NULL AND EXISTS (
                 SELECT 1
                   FROM file_assets asset
                   JOIN file_versions version
                     ON version.id = json_extract(te.evidence_json, '$.fileVersionId')
                    AND version.asset_id = asset.id AND version.event_id = asset.event_id
                  WHERE asset.id = te.file_asset_id AND asset.event_id = te.event_id
                    AND asset.status = 'active' AND version.upload_status = 'uploaded'
                    AND version.signature_status = 'valid' AND version.scan_status = 'clean'
                    AND version.released_at IS NOT NULL AND version.deleted_at IS NULL
               ) THEN 1 ELSE 0 END AS downloadAvailable
          FROM task_evidence te JOIN people p ON p.id = te.submitted_by_person_id
         WHERE te.event_id = ? ORDER BY te.created_at DESC
      `,
        )
          .bind(viewer.eventId)
          .all<{
            id: string;
            taskId: string;
            fileAssetId: string | null;
            evidenceJson: string;
            status: string;
            createdAt: number;
            submittedBy: string;
            downloadAvailable: number;
          }>(),
        this.env.DB.prepare(
          `
        SELECT tc.id, tc.task_id AS taskId, tc.body, tc.visibility,
               tc.created_at AS createdAt, p.display_name AS authorName
          FROM task_comments tc
          JOIN people p ON p.id = tc.author_person_id
         WHERE tc.event_id = ?
         ORDER BY tc.created_at, tc.id
      `,
        )
          .bind(viewer.eventId)
          .all<{
            id: string;
            taskId: string;
            body: string;
            visibility: "participant" | "administrator";
            createdAt: number;
            authorName: string;
          }>(),
      ]);
    return {
      eventTimezone: event.timezone,
      templates: templates.results.map((template) => ({
        ...template,
        dependencies: dependencyRows.results
          .filter((row) => row.templateId === template.id)
          .map((row) => row.dependsOnTemplateId),
      })),
      tasks: tasks.results.map((task) => ({
        ...task,
        evidence: evidence.results
          .filter((item) => item.taskId === task.id)
          .map((item) => ({
            ...item,
            downloadAvailable: item.downloadAvailable === 1,
            details: parseTaskEvidenceDetails(task.id, item.evidenceJson),
          })),
        comments: comments.results.filter((item) => item.taskId === task.id),
      })),
      speakers: speakers.results,
    };
  }

  async administerTask(viewer: Viewer, rawInput: unknown) {
    await this.assertEvent(viewer);
    const input = z
      .object({
        taskId: z.string().min(1),
        revision: z.coerce.number().int().positive(),
        intent: z.enum(["approve", "complete", "waive", "reopen"]),
        reason: z.string().trim().max(1_000).default(""),
      })
      .parse(rawInput);
    const task = await this.env.DB.prepare(
      `
      SELECT id, status, task_type AS taskType, revision FROM task_instances WHERE id = ? AND event_id = ?
    `,
    )
      .bind(input.taskId, viewer.eventId)
      .first<{
        id: string;
        status: TaskRow["status"];
        taskType: string;
        revision: number;
      }>();
    if (!task) throw new TaskStateError("Task not found.");
    if (task.revision !== input.revision)
      throw new TaskStateError(
        "The task changed. Refresh before applying the action.",
      );
    if (input.intent === "waive" && input.reason.length < 5)
      throw new TaskStateError("Explain why this requirement is being waived.");
    const allowedStatuses: Record<
      typeof input.intent,
      ReadonlyArray<TaskRow["status"]>
    > = {
      approve: ["submitted"],
      complete: ["not_started", "in_progress", "blocked", "overdue"],
      waive: ["not_started", "in_progress", "blocked", "submitted", "overdue"],
      reopen: ["completed", "waived"],
    };
    if (!allowedStatuses[input.intent].includes(task.status)) {
      throw new TaskStateError(
        `A task in ${task.status.replaceAll("_", " ")} state cannot be ${input.intent === "reopen" ? "reopened" : `${input.intent}d`}. Refresh before applying the action.`,
      );
    }
    if (
      ["approve", "complete"].includes(input.intent) &&
      task.taskType === "file_upload"
    ) {
      const safe = await this.env.DB.prepare(
        `
        SELECT 1 FROM task_evidence te
        JOIN file_assets fa ON fa.id = te.file_asset_id AND fa.event_id = te.event_id
        JOIN file_versions fv
          ON fv.id = json_extract(te.evidence_json, '$.fileVersionId')
         AND fv.asset_id = fa.id AND fv.event_id = fa.event_id
        WHERE te.task_id = ? AND te.status = 'submitted' AND fa.status = 'active'
          AND fv.scan_status = 'clean' AND fv.signature_status = 'valid' AND fv.released_at IS NOT NULL
        LIMIT 1
      `,
      )
        .bind(task.id)
        .first();
      if (!safe)
        throw new TaskStateError(
          "File evidence is still quarantined or failed scanning; it cannot be approved.",
        );
    }
    if (
      ["approve", "complete"].includes(input.intent) &&
      !(await this.dependenciesComplete(task.id))
    ) {
      throw new TaskStateError(
        "Complete the prerequisite tasks first, or explicitly waive this requirement with a reason.",
      );
    }
    const nextStatus: TaskRow["status"] =
      input.intent === "waive"
        ? "waived"
        : input.intent === "reopen"
          ? "not_started"
          : "completed";
    const progress = statusProgress(nextStatus);
    const operationId = crypto.randomUUID();
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE task_instances SET status = ?, readiness_state = ?, readiness_percent = ?,
          waiver_json = CASE WHEN ? = 'waive' THEN ? ELSE NULL END,
          completed_at = CASE WHEN ? IN ('approve','complete','waive') THEN unixepoch() ELSE NULL END,
          completed_by_person_id = CASE WHEN ? IN ('approve','complete','waive') THEN ? ELSE NULL END,
          revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND status IN (${allowedStatuses[input.intent].map(() => "?").join(",")})
           AND (
             ? NOT IN ('approve','complete') OR NOT EXISTS (
               SELECT 1 FROM task_instance_dependencies dep
               JOIN task_instances prerequisite ON prerequisite.id = dep.depends_on_task_id
                WHERE dep.task_id = task_instances.id
                  AND prerequisite.status NOT IN ('completed','waived')
             )
           )
           AND (
             ? <> 'reopen' OR NOT EXISTS (
               SELECT 1 FROM task_instance_dependencies dep
               JOIN task_instances dependent ON dependent.id = dep.task_id
                WHERE dep.depends_on_task_id = task_instances.id
                  AND dependent.status IN ('submitted','completed')
             )
           )
      `,
      ).bind(
        nextStatus,
        progress.readiness,
        progress.percent,
        input.intent,
        JSON.stringify({ reason: input.reason, by: viewer.personId }),
        input.intent,
        input.intent,
        viewer.personId,
        operationId,
        task.id,
        viewer.eventId,
        task.revision,
        ...allowedStatuses[input.intent],
        input.intent,
        input.intent,
      ),
      this.env.DB.prepare(
        `
        UPDATE task_evidence SET status = 'approved', reviewed_by_person_id = ?, reviewed_at = unixepoch()
         WHERE task_id = ? AND status = 'submitted' AND ? = 'approve'
           AND EXISTS (
             SELECT 1 FROM task_instances
              WHERE id = ? AND event_id = ? AND revision = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.personId,
        task.id,
        input.intent,
        task.id,
        viewer.eventId,
        task.revision + 1,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, ?, 'task_instance', ?, ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM task_instances
            WHERE id = ? AND event_id = ? AND revision = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `task.${input.intent}`,
        task.id,
        operationId,
        JSON.stringify({ reason: input.reason }),
        task.id,
        viewer.eventId,
        task.revision + 1,
        operationId,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1)
      throw new TaskStateError(
        "The task changed. Refresh before applying the action.",
      );
    await this.refreshStates(viewer.eventId);
  }
}
