import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  fixedDateEndEpoch,
  type TaskCompletionMutationResult,
  type TaskRow,
  TaskStateError,
  type TemplateRow,
  hashUndoSecret,
  parseTaskEvidenceDetails,
  randomUndoSecret,
  statusProgress,
  structuredTaskForm,
  TaskServiceFoundation,
} from "./task-service-foundation.server";

export class TaskAdministrationWorkflows extends TaskServiceFoundation {
  async extendSpeakerDeadline(viewer: Viewer, rawInput: unknown) {
    return this.projectCommand(
      viewer,
      "task.deadline.extend",
      rawInput,
      () => this.extendSpeakerDeadlineD1(viewer, rawInput),
      { replay: "reject" },
    );
  }

  protected async extendSpeakerDeadlineD1(viewer: Viewer, rawInput: unknown) {
    const event = await this.assertEvent(viewer);
    const input = z
      .object({
        taskId: z.string().min(1),
        revision: z.coerce.number().int().positive(),
        dueDate: z.iso.date(),
        reason: z
          .string()
          .trim()
          .min(5, "Explain why this deadline is changing.")
          .max(1_000),
      })
      .parse(rawInput);
    const dueAt = fixedDateEndEpoch(input.dueDate, event.timezone)!;
    if (dueAt <= Math.floor(Date.now() / 1_000)) {
      throw new TaskStateError("Choose a future deadline extension date.");
    }
    const task = await this.env.DB.prepare(
      `SELECT id, due_at AS dueAt, status, target_type AS targetType
         FROM task_instances
        WHERE id = ? AND event_id = ? AND revision = ?`,
    )
      .bind(input.taskId, viewer.eventId, input.revision)
      .first<{
        id: string;
        dueAt: number | null;
        status: string;
        targetType: string;
      }>();
    if (!task) {
      throw new TaskStateError(
        "The task changed. Refresh before extending its deadline.",
      );
    }
    if (task.targetType !== "speaker") {
      throw new TaskStateError(
        "Per-participant deadline extensions apply only to speaker tasks.",
      );
    }
    if (["completed", "waived"].includes(task.status)) {
      throw new TaskStateError(
        "Completed or waived tasks do not need a deadline extension.",
      );
    }
    if (task.dueAt === null) {
      throw new TaskStateError(
        "This task has no existing deadline to extend. Set a deadline on its template instead.",
      );
    }
    if (dueAt <= task.dueAt) {
      throw new TaskStateError(
        "The new deadline must be later than the current deadline.",
      );
    }
    await this.requireTaskWebhookReadiness(viewer, "task.updated");
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const webhook = new WebhookService(this.env);
    const preparedWebhook = await webhook.prepareEventForAudit(
      viewer,
      {
        eventType: "task.updated",
        entityType: "task",
        entityId: task.id,
        idempotencyKey: `task.deadline.extended:${task.id}:${operationId}`,
        correlationId: operationId,
        data: {
          action: "deadline_extended",
          priorDueAt: task.dueAt,
          dueAt,
          reason: input.reason,
        },
      },
      auditEventId,
    );
    const statements = [
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, correlation_id,
           metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                'task.deadline.extended', 'task_instance', ?, ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM task_instances
             WHERE id = ? AND event_id = ? AND revision = ?
               AND target_type = 'speaker'
               AND status NOT IN ('completed','waived')
               AND due_at IS NOT NULL AND due_at < ?
          )`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        task.id,
        operationId,
        JSON.stringify({
          priorDueAt: task.dueAt,
          dueAt,
          reason: input.reason,
        }),
        task.id,
        viewer.eventId,
        input.revision,
        dueAt,
      ),
      this.env.DB.prepare(
        `UPDATE task_instances AS task
            SET due_at = ?,
                status = CASE
                  WHEN status = 'overdue' AND EXISTS (
                    SELECT 1 FROM task_instance_dependencies dependency
                    JOIN task_instances prerequisite
                      ON prerequisite.id = dependency.depends_on_task_id
                   WHERE dependency.task_id = task.id
                     AND prerequisite.status NOT IN ('completed','waived')
                  ) THEN 'blocked'
                  WHEN status = 'overdue' THEN 'not_started'
                  ELSE status
                END,
                readiness_state = CASE
                  WHEN status = 'overdue' AND EXISTS (
                    SELECT 1 FROM task_instance_dependencies dependency
                    JOIN task_instances prerequisite
                      ON prerequisite.id = dependency.depends_on_task_id
                   WHERE dependency.task_id = task.id
                     AND prerequisite.status NOT IN ('completed','waived')
                  ) THEN 'blocked'
                  WHEN status = 'overdue' THEN 'on_track'
                  ELSE readiness_state
                END,
                readiness_percent = CASE
                  WHEN status = 'overdue' THEN 0
                  ELSE readiness_percent
                END,
                revision = revision + 1, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND revision = ?
            AND target_type = 'speaker'
            AND status NOT IN ('completed','waived')
            AND due_at IS NOT NULL AND due_at < ?
            AND EXISTS (
              SELECT 1 FROM audit_events
               WHERE id = ? AND organisation_id = ? AND event_id = ?
            )`,
      ).bind(
        dueAt,
        operationId,
        task.id,
        viewer.eventId,
        input.revision,
        dueAt,
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
      ),
      ...preparedWebhook.statements,
    ];
    const [audit, updated] = await this.env.DB.batch(statements);
    if ((audit.meta.changes ?? 0) !== 1 || (updated.meta.changes ?? 0) !== 1) {
      throw new TaskStateError(
        "The task changed. Refresh before extending its deadline.",
      );
    }
    const deliveries = await webhook.dispatchPreparedEvent(preparedWebhook);
    return {
      taskId: task.id,
      dueAt,
      webhookWarning: deliveries.some(
        (delivery) => delivery.status === "queue_failed",
      )
        ? "The deadline was extended, but one or more outbound webhooks need a queue retry."
        : null,
    };
  }

  async getAdminWorkspace(viewer: Viewer) {
    await this.projectCommand(
      viewer,
      "task.state.refresh.administration",
      { requestedAt: Date.now() },
      () => this.refreshStates(viewer.eventId),
    );
    await this.airtable.assertReadable(viewer);
    return this.getAdminWorkspaceD1(viewer);
  }

  protected async getAdminWorkspaceD1(viewer: Viewer) {
    const event = await this.assertEvent(viewer);
    const [
      templates,
      tasks,
      speakers,
      sessions,
      dependencyRows,
      evidence,
      comments,
    ] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT id, name, description, target_type AS targetType, task_type AS taskType, impact,
               evidence_mode AS evidenceMode, due_anchor AS dueAnchor, due_offset_minutes AS dueOffsetMinutes,
               fixed_due_at AS fixedDueAt, auto_assign_on_acceptance AS autoAssignOnAcceptance,
               configuration_json AS configurationJson, status
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
               ti.evidence_json AS evidenceJson, ti.waiver_json AS waiverJson,
               ti.submitted_at AS submittedAt, ti.completed_at AS completedAt,
               ti.completed_by_person_id AS completedByPersonId,
               ti.last_operation_id AS lastOperationId,
               COALESCE(tt.configuration_json, '{}') AS configurationJson
          FROM task_instances ti
          LEFT JOIN people p ON p.id = ti.owner_person_id
          LEFT JOIN task_templates tt ON tt.id = ti.template_id AND tt.event_id = ti.event_id
         WHERE ti.event_id = ? ORDER BY ti.status, ti.due_at IS NULL, ti.due_at, ti.title
      `,
      )
        .bind(viewer.eventId)
        .all<TaskRow>(),
      this.env.DB.prepare(
        `
        SELECT DISTINCT p.id, p.display_name AS name, p.email
          FROM people p
          JOIN event_speaker_workflows workflow
            ON workflow.person_id = p.id AND workflow.event_id = ?
           AND workflow.status IN ('prospect','invited','confirmed')
         ORDER BY p.display_name, p.id
      `,
      )
        .bind(viewer.eventId)
        .all<{ id: string; name: string; email: string }>(),
      this.env.DB.prepare(
        `
        SELECT id, title AS name, status
          FROM sessions
         WHERE event_id = ? AND status NOT IN ('cancelled','archived')
         ORDER BY title, id
      `,
      )
        .bind(viewer.eventId)
        .all<{ id: string; name: string; status: string }>(),
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
      eventTarget: { id: event.id, name: event.name },
      templates: templates.results.map((template) => ({
        ...template,
        dependencies: dependencyRows.results
          .filter((row) => row.templateId === template.id)
          .map((row) => row.dependsOnTemplateId),
      })),
      tasks: tasks.results.map((task) => ({
        ...task,
        formFields: structuredTaskForm(task.configurationJson)?.fields ?? [],
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
      sessions: sessions.results,
    };
  }

  async administerTask(viewer: Viewer, rawInput: unknown) {
    return this.projectCommand(
      viewer,
      "task.administer",
      rawInput,
      () => this.administerTaskD1(viewer, rawInput),
      { replay: "reject" },
    );
  }

  protected async administerTaskD1(viewer: Viewer, rawInput: unknown) {
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
      SELECT id, template_id AS templateId, target_type AS targetType, target_id AS targetId,
             owner_person_id AS ownerPersonId, NULL AS ownerName, title, description,
             task_type AS taskType, impact, status, readiness_state AS readinessState,
             readiness_percent AS readinessPercent, revision, due_at AS dueAt,
             evidence_json AS evidenceJson, waiver_json AS waiverJson,
             submitted_at AS submittedAt, completed_at AS completedAt,
             completed_by_person_id AS completedByPersonId,
             last_operation_id AS lastOperationId
        FROM task_instances WHERE id = ? AND event_id = ?
    `,
    )
      .bind(input.taskId, viewer.eventId)
      .first<TaskRow>();
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
    await this.requireTaskWebhookReadiness(viewer, "task.updated");
    const nextStatus: TaskRow["status"] =
      input.intent === "waive"
        ? "waived"
        : input.intent === "reopen"
          ? "not_started"
          : "completed";
    const progress = statusProgress(nextStatus);
    const operationId = crypto.randomUUID();
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
        data: { action: input.intent, status: nextStatus },
      },
      auditEventId,
    );
    const undoSecret = randomUndoSecret();
    const undoTokenHash = await hashUndoSecret(undoSecret);
    const undoExpiresAt = Math.floor(Date.now() / 1_000) + 300;
    const dependentRevisions =
      input.intent === "complete"
        ? await this.dependentRevisionSnapshot(task.id)
        : [];
    const undoResult = JSON.stringify({
      version: 1,
      taskId: task.id,
      completionRevision: task.revision + 1,
      evidenceId: null,
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
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, ?, 'task_instance', ?, ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM task_instances
            WHERE id = ? AND event_id = ? AND revision = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        auditEventId,
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
         WHERE ? = 'complete' AND task.id = ? AND task.event_id = ?
           AND task.status = 'completed' AND task.revision = ?
           AND task.last_operation_id = ?
           AND EXISTS (
             SELECT 1 FROM events event
              WHERE event.id = task.event_id AND event.organisation_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM task_evidence evidence WHERE evidence.task_id = task.id
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
        input.intent,
        task.id,
        viewer.eventId,
        task.revision + 1,
        operationId,
        viewer.organisationId,
        JSON.stringify(dependentRevisions),
        JSON.stringify(dependentRevisions),
      ),
      ...preparedWebhook.statements,
    ]);
    const updated = results[0];
    if ((updated.meta.changes ?? 0) !== 1)
      throw new TaskStateError(
        "The task changed. Refresh before applying the action.",
      );
    await this.refreshStates(viewer.eventId);
    const undoOffered = (results[3]?.meta.changes ?? 0) === 1;
    const webhookWarning = await this.queueTaskWebhook(viewer, {
      eventType: "task.updated",
      taskId: task.id,
      operationId,
      data: { action: input.intent, status: nextStatus },
    });
    return {
      taskId: task.id,
      undoToken: undoOffered ? `${operationId}.${undoSecret}` : null,
      undoExpiresAt: undoOffered ? undoExpiresAt : null,
      webhookWarning,
    } satisfies TaskCompletionMutationResult;
  }
}
