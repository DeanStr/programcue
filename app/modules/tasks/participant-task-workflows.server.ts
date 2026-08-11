import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { participantEvidenceSchema } from "./task-schema";
import {
  type CompletedFileEvidenceAsset,
  type TaskCompletionMutationResult,
  TaskEvidenceAttachmentConflictError,
  type TaskRow,
  TaskStateError,
  type TemplateRow,
  completedFileEvidenceAttachmentSchema,
  completionUndoResultSchema,
  equalHash,
  hashUndoSecret,
  parseJson,
  parseTaskEvidenceDetails,
  randomUndoSecret,
  statusProgress,
  structuredTaskEvidence,
  structuredTaskForm,
} from "./task-service-foundation.server";
import { TaskTemplateWorkflows } from "./task-template-workflows.server";

export abstract class ParticipantTaskWorkflows extends TaskTemplateWorkflows {
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
      SELECT ti.id, ti.template_id AS templateId, ti.target_type AS targetType, ti.target_id AS targetId,
             ti.owner_person_id AS ownerPersonId, p.display_name AS ownerName, ti.title, ti.description,
             ti.task_type AS taskType, ti.impact, ti.status, ti.readiness_state AS readinessState,
             ti.readiness_percent AS readinessPercent, ti.revision, ti.due_at AS dueAt,
             ti.evidence_json AS evidenceJson, ti.waiver_json AS waiverJson,
             ti.submitted_at AS submittedAt, ti.completed_at AS completedAt,
             ti.completed_by_person_id AS completedByPersonId,
             ti.last_operation_id AS lastOperationId,
             COALESCE(tt.configuration_json, '{}') AS configurationJson
        FROM task_instances ti
        LEFT JOIN people p ON p.id = ti.owner_person_id
        LEFT JOIN task_templates tt ON tt.id = ti.template_id AND tt.event_id = ti.event_id
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
      dependencies: dependencies.results.filter(
        (dependency) => dependency.taskId === task.id,
      ),
      comments: comments.results.filter(
        (comment) => comment.taskId === task.id,
      ),
    }));
  }

  protected async participantTask(viewer: Viewer, taskId: string) {
    return this.env.DB.prepare(
      `
      SELECT ti.id, ti.template_id AS templateId, ti.target_type AS targetType, ti.target_id AS targetId,
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

  protected async dependenciesComplete(taskId: string) {
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

  protected async dependentRevisionSnapshot(taskId: string) {
    const dependents = await this.env.DB.prepare(
      `
      SELECT dependent.id AS taskId, dependent.revision
        FROM task_instance_dependencies dependency
        JOIN task_instances dependent ON dependent.id = dependency.task_id
       WHERE dependency.depends_on_task_id = ?
       ORDER BY dependent.id
    `,
    )
      .bind(taskId)
      .all<{ taskId: string; revision: number }>();
    return dependents.results;
  }

  async assertFileEvidenceUploadAllowed(viewer: Viewer, taskId: string) {
    await this.airtable.assertReadable(viewer);
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

  async completeParticipant(
    viewer: Viewer,
    rawInput: unknown,
    operationId?: string,
  ) {
    return this.projectCommand(
      viewer,
      "task.participant.complete",
      rawInput,
      () => this.completeParticipantD1(viewer, rawInput, operationId),
      { replay: "reject" },
    );
  }

  protected async completeParticipantD1(
    viewer: Viewer,
    rawInput: unknown,
    suppliedOperationId?: string,
  ) {
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
      const responses = structuredTaskEvidence(
        task.configurationJson,
        input.responses,
      );
      if (responses) {
        evidence.responses = responses;
      } else {
        if (!input.text)
          throw new TaskStateError("Enter the requested response.");
        evidence.text = input.text;
      }
    }
    if (task.taskType === "link_visit") {
      if (!input.url) throw new TaskStateError("Enter the link you visited.");
      evidence.url = input.url;
    }
    await this.requireTaskWebhookReadiness(viewer, "task.updated");
    const nextStatus =
      task.evidenceMode === "admin_approval" ? "submitted" : "completed";
    const progress = statusProgress(nextStatus);
    const operationId = suppliedOperationId ?? crypto.randomUUID();
    const evidenceId = suppliedOperationId
      ? `task-evidence:${suppliedOperationId}`
      : crypto.randomUUID();
    const undoSecret = randomUndoSecret();
    const undoTokenHash = await hashUndoSecret(undoSecret);
    const undoExpiresAt = Math.floor(Date.now() / 1_000) + 300;
    const dependentRevisions =
      nextStatus === "completed"
        ? await this.dependentRevisionSnapshot(task.id)
        : [];
    const auditEventId = crypto.randomUUID();
    const preparedWebhook = await new WebhookService(
      this.env,
    ).prepareEventForAudit(
      viewer,
      {
        eventType: "task.updated",
        entityType: "task",
        entityId: task.id,
        idempotencyKey: `task.updated:${task.id}:${operationId}`,
        correlationId: operationId,
        data: { status: nextStatus, action: "participant_completion" },
      },
      auditEventId,
    );
    const undoResult = JSON.stringify({
      version: 1,
      taskId: task.id,
      completionRevision: task.revision + 1,
      evidenceId,
      dependentRevisions,
      undoTokenHash,
      undoExpiresAt,
      undoneAt: null,
      undoOperationId: null,
      before: {
        status: task.status,
        readinessState: task.readinessState,
        readinessPercent: task.readinessPercent,
        evidenceJson: task.evidenceJson,
        waiverJson: task.waiverJson,
        submittedAt: task.submittedAt,
        completedAt: task.completedAt,
        completedByPersonId: task.completedByPersonId,
      },
    });
    const results = await this.env.DB.batch([
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
        auditEventId,
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
      this.env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json, result_json,
          progress_total, progress_completed, progress_failed, cancellable,
          started_at, completed_at, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'task.completion', ?, ?, 'completed', ?, ?,
               1, 1, 0, 0, unixepoch(), unixepoch(), unixepoch(), unixepoch()
          FROM task_instances task
         WHERE ? = 'completed' AND task.id = ? AND task.event_id = ?
           AND task.revision = ? AND task.last_operation_id = ?
           AND EXISTS (
             SELECT 1 FROM events event
              WHERE event.id = task.event_id AND event.organisation_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM task_evidence evidence
              WHERE evidence.id = ? AND evidence.task_id = task.id
                AND evidence.event_id = task.event_id AND evidence.status = 'approved'
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_evidence other
              WHERE other.task_id = task.id AND other.id <> ?
           )
           AND NOT EXISTS (
             SELECT 1
               FROM task_instance_dependencies dependency
               JOIN task_instances dependent ON dependent.id = dependency.task_id
              WHERE dependency.depends_on_task_id = task.id
                AND (
                  dependent.status NOT IN ('not_started','blocked','overdue')
                  OR EXISTS (
                    SELECT 1 FROM task_evidence downstream
                     WHERE downstream.task_id = dependent.id
                  )
                )
           )
           AND (
             SELECT COUNT(*) FROM task_instance_dependencies dependency
              WHERE dependency.depends_on_task_id = task.id
           ) = json_array_length(?)
           AND NOT EXISTS (
             SELECT 1
               FROM task_instance_dependencies dependency
               JOIN task_instances dependent ON dependent.id = dependency.task_id
              WHERE dependency.depends_on_task_id = task.id
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(?) expected
                   WHERE json_extract(expected.value, '$.taskId') = dependent.id
                     AND json_extract(expected.value, '$.revision') = dependent.revision
                )
           )
      `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `task-completion:${operationId}`,
        operationId,
        JSON.stringify({ taskId: task.id, intent: "complete" }),
        undoResult,
        nextStatus,
        task.id,
        viewer.eventId,
        task.revision + 1,
        operationId,
        viewer.organisationId,
        evidenceId,
        evidenceId,
        JSON.stringify(dependentRevisions),
        JSON.stringify(dependentRevisions),
      ),
      ...preparedWebhook.statements,
    ]);
    const updated = results[0];
    if ((updated.meta.changes ?? 0) !== 1)
      throw new TaskStateError(
        "This task changed. Refresh before completing it.",
      );
    await this.refreshStates(viewer.eventId);
    const undoOffered = (results[3]?.meta.changes ?? 0) === 1;
    const webhookWarning = await this.queueTaskWebhook(viewer, {
      eventType: "task.updated",
      taskId: task.id,
      operationId,
      data: { status: nextStatus, action: "participant_completion" },
    });
    return {
      taskId: task.id,
      undoToken: undoOffered ? `${operationId}.${undoSecret}` : null,
      undoExpiresAt: undoOffered ? undoExpiresAt : null,
      webhookWarning,
    } satisfies TaskCompletionMutationResult;
  }

  async undoCompletion(viewer: Viewer, rawToken: unknown) {
    return this.projectCommand(viewer, "task.completion.undo", rawToken, () =>
      this.undoCompletionD1(viewer, rawToken),
    );
  }

  protected async undoCompletionD1(viewer: Viewer, rawToken: unknown) {
    const token = z.string().trim().min(1).max(500).parse(rawToken);
    const separator = token.indexOf(".");
    if (separator < 1 || token.indexOf(".", separator + 1) !== -1) {
      throw new TaskStateError("This task-completion undo link is invalid.");
    }
    const operationId = z.string().uuid().parse(token.slice(0, separator));
    const secret = z
      .string()
      .regex(/^[A-Za-z0-9_-]{43}$/)
      .parse(token.slice(separator + 1));
    const operation = await this.env.DB.prepare(
      `
      SELECT result_json AS resultJson
        FROM operation_jobs
       WHERE id = ? AND organisation_id = ? AND event_id = ?
         AND requested_by_person_id = ? AND type = 'task.completion'
         AND status = 'completed'
       LIMIT 1
    `,
    )
      .bind(operationId, viewer.organisationId, viewer.eventId, viewer.personId)
      .first<{ resultJson: string }>();
    if (!operation) {
      throw new TaskStateError("This task-completion undo link is invalid.");
    }
    const result = completionUndoResultSchema.parse(
      parseJson(operation.resultJson, `Task completion ${operationId}`),
    );
    if (
      result.undoneAt !== null ||
      result.undoOperationId !== null ||
      !equalHash(result.undoTokenHash, await hashUndoSecret(secret))
    ) {
      throw new TaskStateError(
        result.undoneAt !== null
          ? "This task completion was already undone."
          : "This task-completion undo link is invalid.",
      );
    }
    if (result.undoExpiresAt < Math.floor(Date.now() / 1_000)) {
      throw new TaskStateError("The five-minute undo window has expired.");
    }
    await this.requireTaskWebhookReadiness(viewer, "task.updated");

    const undoOperationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const preparedWebhook = await new WebhookService(
      this.env,
    ).prepareEventForAudit(
      viewer,
      {
        eventType: "task.updated",
        entityType: "task",
        entityId: result.taskId,
        idempotencyKey: `task.updated:${result.taskId}:${undoOperationId}`,
        correlationId: undoOperationId,
        data: { action: "completion_undone", status: result.before.status },
      },
      auditEventId,
    );
    const evidenceGuard = result.evidenceId
      ? `
           AND EXISTS (
             SELECT 1 FROM task_evidence evidence
              WHERE evidence.id = ? AND evidence.task_id = task_instances.id
                AND evidence.event_id = task_instances.event_id
                AND evidence.status = 'approved'
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_evidence other
              WHERE other.task_id = task_instances.id AND other.id <> ?
           )`
      : `
           AND NOT EXISTS (
             SELECT 1 FROM task_evidence evidence
              WHERE evidence.task_id = task_instances.id
           )`;
    const evidenceBindings = result.evidenceId
      ? [result.evidenceId, result.evidenceId]
      : [];
    const statements = [
      this.env.DB.prepare(
        `
        UPDATE task_instances
           SET status = ?, readiness_state = ?, readiness_percent = ?,
               evidence_json = ?, waiver_json = ?, submitted_at = ?,
               completed_at = ?, completed_by_person_id = ?,
               revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status = 'completed'
           AND revision = ? AND last_operation_id = ?
           ${evidenceGuard}
           AND NOT EXISTS (
             SELECT 1
               FROM task_instance_dependencies dependency
               JOIN task_instances dependent ON dependent.id = dependency.task_id
              WHERE dependency.depends_on_task_id = task_instances.id
                AND (
                  dependent.status NOT IN ('not_started','blocked','overdue')
                  OR EXISTS (
                    SELECT 1 FROM task_evidence downstream
                     WHERE downstream.task_id = dependent.id
                  )
                )
           )
           AND (
             SELECT COUNT(*) FROM task_instance_dependencies dependency
              WHERE dependency.depends_on_task_id = task_instances.id
           ) = json_array_length(?)
           AND NOT EXISTS (
             SELECT 1
               FROM task_instance_dependencies dependency
               JOIN task_instances dependent ON dependent.id = dependency.task_id
              WHERE dependency.depends_on_task_id = task_instances.id
                AND NOT EXISTS (
                  SELECT 1 FROM json_each(?) expected
                   WHERE json_extract(expected.value, '$.taskId') = dependent.id
                     AND json_extract(expected.value, '$.revision') = dependent.revision
                )
           )
           AND EXISTS (
             SELECT 1 FROM operation_jobs completion
              WHERE completion.id = ? AND completion.organisation_id = ?
                AND completion.event_id = ? AND completion.requested_by_person_id = ?
                AND completion.type = 'task.completion' AND completion.status = 'completed'
                AND json_extract(completion.result_json, '$.undoneAt') IS NULL
                AND json_extract(completion.result_json, '$.undoExpiresAt') >= unixepoch()
           )
      `,
      ).bind(
        result.before.status,
        result.before.readinessState,
        result.before.readinessPercent,
        result.before.evidenceJson,
        result.before.waiverJson,
        result.before.submittedAt,
        result.before.completedAt,
        result.before.completedByPersonId,
        undoOperationId,
        result.taskId,
        viewer.eventId,
        result.completionRevision,
        operationId,
        ...evidenceBindings,
        JSON.stringify(result.dependentRevisions),
        JSON.stringify(result.dependentRevisions),
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
      ),
      ...(result.evidenceId
        ? [
            this.env.DB.prepare(
              `
              UPDATE task_evidence SET status = 'superseded'
               WHERE id = ? AND task_id = ? AND event_id = ? AND status = 'approved'
                 AND EXISTS (
                   SELECT 1 FROM task_instances task
                    WHERE task.id = task_evidence.task_id
                      AND task.event_id = task_evidence.event_id
                      AND task.last_operation_id = ?
                 )
            `,
            ).bind(
              result.evidenceId,
              result.taskId,
              viewer.eventId,
              undoOperationId,
            ),
          ]
        : []),
      this.env.DB.prepare(
        `
        UPDATE operation_jobs
           SET result_json = json_set(
                 result_json,
                 '$.undoneAt', unixepoch(),
                 '$.undoOperationId', ?
               ), updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ? AND event_id = ?
           AND requested_by_person_id = ? AND type = 'task.completion'
           AND status = 'completed'
           AND json_extract(result_json, '$.undoneAt') IS NULL
           AND json_extract(result_json, '$.undoExpiresAt') >= unixepoch()
           AND EXISTS (
             SELECT 1 FROM task_instances task
              WHERE task.id = ? AND task.event_id = ?
                AND task.last_operation_id = ?
           )
      `,
      ).bind(
        undoOperationId,
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        result.taskId,
        viewer.eventId,
        undoOperationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'task.completion_undone', 'task_instance', ?, ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM task_instances task
            WHERE task.id = ? AND task.event_id = ?
              AND task.last_operation_id = ?
         )
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        result.taskId,
        undoOperationId,
        JSON.stringify({ completionOperationId: operationId }),
        result.taskId,
        viewer.eventId,
        undoOperationId,
      ),
      ...preparedWebhook.statements,
    ];
    const [updated] = await this.env.DB.batch(statements);
    if ((updated.meta.changes ?? 0) !== 1) {
      throw new TaskStateError(
        "This completion can no longer be undone because the task, its evidence or dependent work changed.",
      );
    }
    await this.refreshStates(viewer.eventId);
    const webhookWarning = await this.queueTaskWebhook(viewer, {
      eventType: "task.updated",
      taskId: result.taskId,
      operationId: undoOperationId,
      data: { action: "completion_undone", status: result.before.status },
    });
    return { taskId: result.taskId, webhookWarning };
  }

  protected async completedFileEvidenceAsset(
    viewer: Viewer,
    input: z.infer<typeof completedFileEvidenceAttachmentSchema>,
  ) {
    return this.env.DB.prepare(
      `
      SELECT fa.id, fv.id AS versionId, fv.upload_status AS uploadStatus, fv.signature_status AS signatureStatus,
             fv.scan_status AS scanStatus, evidence.id AS evidenceId,
             evidence.status AS evidenceStatus
        FROM file_assets fa
        JOIN file_versions fv
          ON fv.id = ? AND fv.asset_id = fa.id AND fv.event_id = fa.event_id
        LEFT JOIN task_evidence evidence
          ON evidence.event_id = fa.event_id
         AND evidence.task_id = fa.target_id
         AND evidence.file_asset_id = fa.id
         AND evidence.submitted_by_person_id = ?
         AND json_extract(evidence.evidence_json, '$.fileVersionId') = fv.id
       WHERE fa.id = ? AND fa.event_id = ? AND fa.owner_person_id = ?
         AND fa.target_type = 'task' AND fa.target_id = ?
         AND fa.asset_kind = 'task_evidence' AND fa.status <> 'deleted'
         AND fv.created_by_person_id = ? AND fv.deleted_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM audit_events audit
            WHERE audit.id = 'file-erasure:' || fa.id
         )
       ORDER BY evidence.created_at DESC LIMIT 1
    `,
    )
      .bind(
        input.versionId,
        viewer.personId,
        input.assetId,
        viewer.eventId,
        viewer.personId,
        input.taskId,
        viewer.personId,
      )
      .first<CompletedFileEvidenceAsset>();
  }

  protected exactFileEvidenceAlreadyAttached(
    task: TaskRow,
    asset: CompletedFileEvidenceAsset | null,
    input: z.infer<typeof completedFileEvidenceAttachmentSchema>,
  ) {
    if (
      !asset ||
      !["submitted", "completed"].includes(task.status) ||
      !["submitted", "approved"].includes(asset.evidenceStatus ?? "") ||
      asset.uploadStatus !== "uploaded" ||
      asset.signatureStatus !== "valid" ||
      !["pending", "clean"].includes(asset.scanStatus) ||
      !task.evidenceJson
    )
      return false;
    const evidence = parseTaskEvidenceDetails(task.id, task.evidenceJson);
    return (
      evidence.fileAssetId === input.assetId &&
      evidence.fileVersionId === input.versionId
    );
  }

  async attachCompletedFileEvidence(viewer: Viewer, rawInput: unknown) {
    return this.projectCommand(viewer, "task.evidence.attach", rawInput, () =>
      this.attachCompletedFileEvidenceD1(viewer, rawInput),
    );
  }

  protected async attachCompletedFileEvidenceD1(
    viewer: Viewer,
    rawInput: unknown,
  ) {
    const input = completedFileEvidenceAttachmentSchema.parse(rawInput);
    const ownedTask = await this.participantTask(viewer, input.taskId);
    if (!ownedTask || ownedTask.taskType !== "file_upload")
      throw new TaskStateError(
        "File task not found or not owned by this speaker.",
      );
    let asset = await this.completedFileEvidenceAsset(viewer, input);
    await this.requireTaskWebhookReadiness(viewer, "task.updated");
    if (this.exactFileEvidenceAlreadyAttached(ownedTask, asset, input)) {
      const webhookWarning = await this.queueTaskWebhook(viewer, {
        eventType: "task.updated",
        taskId: input.taskId,
        operationId:
          ownedTask.lastOperationId ?? `evidence:${asset!.evidenceId}`,
        data: { action: "file_evidence_attached", status: ownedTask.status },
      });
      return { ...input, duplicate: true, webhookWarning };
    }
    if (
      !asset ||
      asset.uploadStatus !== "uploaded" ||
      asset.signatureStatus !== "valid" ||
      !["pending", "clean"].includes(asset.scanStatus)
    )
      throw new TaskStateError(
        "The exact file version did not complete safely or is no longer attachable.",
      );
    let task: TaskRow;
    try {
      task = await this.assertFileEvidenceUploadAllowed(viewer, input.taskId);
    } catch (error) {
      if (error instanceof TaskStateError) {
        throw new TaskEvidenceAttachmentConflictError(error.message);
      }
      throw error;
    }
    const evidenceId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const preparedWebhook = await new WebhookService(
      this.env,
    ).prepareEventForAudit(
      viewer,
      {
        eventType: "task.updated",
        entityType: "task",
        entityId: input.taskId,
        idempotencyKey: `task.updated:${input.taskId}:${operationId}`,
        correlationId: operationId,
        data: { action: "file_evidence_attached", status: "submitted" },
      },
      auditEventId,
    );
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
           AND EXISTS (
             SELECT 1
               FROM file_assets fa
               JOIN file_versions fv
                 ON fv.id = ? AND fv.asset_id = fa.id AND fv.event_id = fa.event_id
              WHERE fa.id = ? AND fa.event_id = task_instances.event_id
                AND fa.owner_person_id = ? AND fa.target_type = 'task'
                AND fa.target_id = task_instances.id
                AND fa.asset_kind = 'task_evidence' AND fa.status <> 'deleted'
                AND fv.created_by_person_id = ? AND fv.upload_status = 'uploaded'
                AND fv.signature_status = 'valid' AND fv.scan_status IN ('pending','clean')
                AND fv.deleted_at IS NULL
                AND NOT EXISTS (
                  SELECT 1 FROM audit_events audit
                   WHERE audit.id = 'file-erasure:' || fa.id
                )
           )
      `,
      ).bind(
        taskEvidenceJson,
        operationId,
        task.id,
        viewer.eventId,
        task.revision,
        input.versionId,
        input.assetId,
        viewer.personId,
        viewer.personId,
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
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        task.id,
        JSON.stringify({
          evidenceId,
          assetId: input.assetId,
          versionId: input.versionId,
          scanStatus: asset.scanStatus,
        }),
        evidenceId,
        viewer.eventId,
        task.id,
      ),
      ...preparedWebhook.statements,
    ]);
    if ((updated.meta.changes ?? 0) !== 1) {
      const currentTask = await this.participantTask(viewer, input.taskId);
      asset = await this.completedFileEvidenceAsset(viewer, input);
      if (
        currentTask &&
        this.exactFileEvidenceAlreadyAttached(currentTask, asset, input)
      ) {
        const webhookWarning = await this.queueTaskWebhook(viewer, {
          eventType: "task.updated",
          taskId: input.taskId,
          operationId:
            currentTask.lastOperationId ?? `evidence:${asset!.evidenceId}`,
          data: {
            action: "file_evidence_attached",
            status: currentTask.status,
          },
        });
        return { ...input, duplicate: true, webhookWarning };
      }
      throw new TaskEvidenceAttachmentConflictError(
        "This task changed. Refresh before submitting file evidence.",
      );
    }
    const webhookWarning = await this.queueTaskWebhook(viewer, {
      eventType: "task.updated",
      taskId: input.taskId,
      operationId,
      data: { action: "file_evidence_attached", status: "submitted" },
    });
    return { ...input, duplicate: false, webhookWarning };
  }

  async addComment(
    viewer: Viewer,
    taskId: string,
    body: string,
    visibility: "participant" | "administrator" = "participant",
    intentId: string = crypto.randomUUID(),
  ) {
    return this.projectIntentCommand(
      viewer,
      "task.comment.add",
      intentId,
      { taskId, body, visibility },
      () => this.addCommentD1(viewer, taskId, body, visibility),
    );
  }

  protected async addCommentD1(
    viewer: Viewer,
    taskId: string,
    body: string,
    visibility: "participant" | "administrator",
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
    await this.requireTaskWebhookReadiness(viewer, "task.updated");
    const commentId = crypto.randomUUID();
    const operationId = `comment:${commentId}`;
    const auditEventId = crypto.randomUUID();
    const preparedWebhook = await new WebhookService(
      this.env,
    ).prepareEventForAudit(
      viewer,
      {
        eventType: "task.updated",
        entityType: "task",
        entityId: taskId,
        idempotencyKey: `task.updated:${taskId}:${operationId}`,
        correlationId: operationId,
        data: { action: "comment_added", visibility },
      },
      auditEventId,
    );
    await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO task_comments (id, event_id, task_id, author_person_id, body, visibility, created_at)
        VALUES (?, ?, ?, ?, ?, ?, unixepoch())
      `,
      ).bind(
        commentId,
        viewer.eventId,
        taskId,
        viewer.personId,
        clean,
        visibility,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'task.comment.added', 'task_instance', ?, ?, ?, unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM task_comments
               WHERE id = ? AND event_id = ? AND task_id = ?
            )`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        taskId,
        operationId,
        JSON.stringify({ commentId, visibility }),
        commentId,
        viewer.eventId,
        taskId,
      ),
      ...preparedWebhook.statements,
    ]);
    const webhookWarning = await this.queueTaskWebhook(viewer, {
      eventType: "task.updated",
      taskId,
      operationId,
      data: { action: "comment_added", visibility },
    });
    return { taskId, webhookWarning };
  }
}
