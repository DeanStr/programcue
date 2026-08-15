import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { participantEvidenceSchema } from "./task-schema";
import {
  type TaskCompletionMutationResult,
  TaskStateError,
  completionUndoResultSchema,
  equalHash,
  hashUndoSecret,
  parseJson,
  randomUndoSecret,
  statusProgress,
  structuredTaskEvidence,
} from "./task-service-foundation.server";

import { ParticipantTaskWorkflowFoundation } from "./participant-task-workflow-foundation.server";

export class ParticipantTaskCompletionCommands extends ParticipantTaskWorkflowFoundation {
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
}
