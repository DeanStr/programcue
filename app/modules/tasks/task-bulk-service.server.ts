import { z, ZodError } from "zod";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { TaskService, TaskStateError } from "./task-service.server";

const taskBulkActionSchema = z.enum(["assign_template", "waive", "reopen"]);
export type TaskBulkAction = z.infer<typeof taskBulkActionSchema>;

const previewInputSchema = z
  .object({
    action: taskBulkActionSchema,
    recordIds: z
      .array(z.string().trim().min(1).max(200))
      .min(1, "Select at least one record.")
      .max(100, "A bulk task action is limited to 100 records."),
    templateId: z.string().trim().max(200).nullish(),
    reason: z.string().trim().max(1_000).nullish(),
  })
  .transform((value) => ({
    ...value,
    recordIds: [...new Set(value.recordIds)],
    templateId: value.templateId || null,
    reason: value.reason || "",
  }))
  .superRefine((value, context) => {
    if (value.action === "assign_template" && !value.templateId) {
      context.addIssue({
        code: "custom",
        path: ["templateId"],
        message: "Choose a task template to assign.",
      });
    }
    if (value.action !== "assign_template" && value.templateId) {
      context.addIssue({
        code: "custom",
        path: ["templateId"],
        message: "Status changes do not accept a task template.",
      });
    }
    if (value.action === "waive" && value.reason.length < 5) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Explain why these requirements are being waived.",
      });
    }
    if (value.action !== "waive" && value.reason) {
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "Only a waiver accepts a reason.",
      });
    }
  });

const storedItemSchema = z.object({
  recordId: z.string().min(1),
  label: z.string().min(1),
  expectedRevision: z.number().int().positive().nullable(),
  beforeStatus: z.string().nullable(),
  afterStatus: z.string().min(1),
  personId: z.string().min(1).nullable(),
  templateId: z.string().min(1).nullable(),
  additionalPrerequisites: z.array(z.string()),
  expectedTemplateAssignments: z.array(
    z.object({
      templateId: z.string().min(1),
      assigned: z.boolean(),
    }),
  ),
  createdTaskId: z.string().min(1).nullable().optional(),
});

const storedSummarySchema = z.object({
  action: taskBulkActionSchema,
  label: z.string().min(1),
  templateId: z.string().min(1).nullable(),
  templateName: z.string().min(1).nullable(),
  reason: z.string(),
  changeCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  invalidCount: z.number().int().nonnegative(),
});

type TaskRow = {
  id: string;
  title: string;
  ownerName: string | null;
  ownerPersonId: string | null;
  taskType: string;
  status: string;
  revision: number;
  dependenciesBlocked: number;
  dependentAdvanced: number;
};

export type TaskBulkWorkspace = {
  templates: Array<{ id: string; name: string }>;
  speakers: Array<{ id: string; name: string; email: string }>;
  tasks: TaskRow[];
  selectionLimit: number;
};

export type TaskBulkOperation = {
  id: string;
  status: string;
  createdAt: number;
  completedAt: number | null;
  summary: z.infer<typeof storedSummarySchema>;
  items: Array<{
    id: string;
    status: string;
    errorCode: string | null;
    errorMessage: string | null;
    result: z.infer<typeof storedItemSchema>;
  }>;
};

const actionLabels: Record<TaskBulkAction, string> = {
  assign_template: "Assign task plan",
  waive: "Waive requirements",
  reopen: "Reopen requirements",
};

function parseJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${context} contains invalid JSON.`, { cause: error });
  }
}

export class TaskBulkStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskBulkStateError";
  }
}

export class TaskBulkService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async workspace(viewer: Viewer): Promise<TaskBulkWorkspace> {
    await this.airtable.assertReadable(viewer);
    const selectionLimit = 500;
    const [event, templates, speakers, tasks] = await Promise.all([
      this.env.DB.prepare(
        "SELECT 1 FROM events WHERE id = ? AND organisation_id = ?",
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first(),
      this.env.DB.prepare(
        `SELECT template.id, template.name
           FROM task_templates template
           JOIN events event ON event.id = template.event_id AND event.organisation_id = ?
          WHERE template.event_id = ? AND template.status = 'active'
            AND template.target_type = 'speaker'
          ORDER BY template.name COLLATE NOCASE, template.id`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<{ id: string; name: string }>(),
      this.env.DB.prepare(
        `SELECT DISTINCT person.id, person.display_name AS name, person.email
           FROM people person
           JOIN events event ON event.id = ? AND event.organisation_id = ?
           LEFT JOIN memberships membership
             ON membership.person_id = person.id AND membership.event_id = event.id
            AND membership.role = 'speaker' AND membership.accepted_at IS NOT NULL
            AND membership.revoked_at IS NULL
           LEFT JOIN session_speakers session_speaker
             ON session_speaker.person_id = person.id AND session_speaker.event_id = event.id
          WHERE membership.id IS NOT NULL OR session_speaker.person_id IS NOT NULL
          ORDER BY person.display_name COLLATE NOCASE, person.id
          LIMIT ?`,
      )
        .bind(viewer.eventId, viewer.organisationId, selectionLimit)
        .all<{ id: string; name: string; email: string }>(),
      this.env.DB.prepare(
        `SELECT task.id, task.title, owner.display_name AS ownerName,
                task.owner_person_id AS ownerPersonId, task.task_type AS taskType,
                task.status, task.revision,
                EXISTS (
                  SELECT 1 FROM task_instance_dependencies dependency
                  JOIN task_instances prerequisite
                    ON prerequisite.id = dependency.depends_on_task_id
                  WHERE dependency.task_id = task.id
                    AND prerequisite.status NOT IN ('completed','waived')
                ) AS dependenciesBlocked,
                EXISTS (
                  SELECT 1 FROM task_instance_dependencies dependency
                  JOIN task_instances dependent ON dependent.id = dependency.task_id
                  WHERE dependency.depends_on_task_id = task.id
                    AND dependent.status IN ('submitted','completed')
                ) AS dependentAdvanced
           FROM task_instances task
           JOIN events event ON event.id = task.event_id AND event.organisation_id = ?
           LEFT JOIN people owner ON owner.id = task.owner_person_id
          WHERE task.event_id = ?
          ORDER BY task.title COLLATE NOCASE, owner.display_name COLLATE NOCASE, task.id
          LIMIT ?`,
      )
        .bind(viewer.organisationId, viewer.eventId, selectionLimit)
        .all<TaskRow>(),
    ]);
    if (!event) throw new Response("Event not found.", { status: 404 });
    return {
      templates: templates.results,
      speakers: speakers.results,
      tasks: tasks.results,
      selectionLimit,
    };
  }

  async operation(
    viewer: Viewer,
    operationId: string,
  ): Promise<TaskBulkOperation> {
    const operation = await this.env.DB.prepare(
      `SELECT operation.id, operation.status, operation.result_json AS resultJson,
              operation.created_at AS createdAt, operation.completed_at AS completedAt
         FROM operation_jobs operation
         JOIN events event ON event.id = operation.event_id AND event.organisation_id = ?
        WHERE operation.id = ? AND operation.event_id = ? AND operation.type = 'task.bulk'
        LIMIT 1`,
    )
      .bind(viewer.organisationId, operationId, viewer.eventId)
      .first<{
        id: string;
        status: string;
        resultJson: string;
        createdAt: number;
        completedAt: number | null;
      }>();
    if (!operation)
      throw new TaskBulkStateError("Bulk task preview not found.");
    const items = await this.env.DB.prepare(
      `SELECT id, status, error_code AS errorCode, error_message AS errorMessage,
              result_json AS resultJson
         FROM operation_items WHERE operation_id = ? ORDER BY item_key`,
    )
      .bind(operationId)
      .all<{
        id: string;
        status: string;
        errorCode: string | null;
        errorMessage: string | null;
        resultJson: string;
      }>();
    return {
      id: operation.id,
      status: operation.status,
      createdAt: operation.createdAt,
      completedAt: operation.completedAt,
      summary: storedSummarySchema.parse(
        parseJson(operation.resultJson, `Task bulk operation ${operation.id}`),
      ),
      items: items.results.map(({ resultJson, ...item }) => ({
        ...item,
        result: storedItemSchema.parse(
          parseJson(resultJson, `Task bulk item ${item.id}`),
        ),
      })),
    };
  }

  private async dependencyTemplates(eventId: string, templateId: string) {
    const rows = await this.env.DB.prepare(
      `WITH RECURSIVE dependency(id) AS (
         SELECT depends_on_template_id
           FROM task_template_dependencies
          WHERE template_id = ?
         UNION
         SELECT edge.depends_on_template_id
           FROM task_template_dependencies edge
           JOIN dependency parent ON edge.template_id = parent.id
       )
       SELECT template.id, template.name, template.event_id AS eventId,
              template.status
         FROM dependency
         JOIN task_templates template ON template.id = dependency.id
        ORDER BY template.name COLLATE NOCASE, template.id`,
    )
      .bind(templateId)
      .all<{
        id: string;
        name: string;
        eventId: string | null;
        status: string;
      }>();
    if (
      rows.results.some(
        (dependency) =>
          dependency.eventId !== eventId || dependency.status !== "active",
      )
    ) {
      throw new TaskBulkStateError(
        "This task plan has an archived or cross-event prerequisite and cannot be assigned.",
      );
    }
    return rows.results.map(({ id, name }) => ({ id, name }));
  }

  async preview(
    viewer: Viewer,
    input: {
      action: unknown;
      recordIds: unknown[];
      templateId?: unknown;
      reason?: unknown;
    },
  ) {
    const parsed = previewInputSchema.parse(input);
    const workspace = await this.workspace(viewer);
    const items: Array<{
      id: string;
      itemKey: string;
      entityType: "person" | "task_instance";
      entityId: string;
      status: "pending" | "skipped" | "failed";
      errorCode: string | null;
      errorMessage: string | null;
      result: z.infer<typeof storedItemSchema>;
    }> = [];
    let templateName: string | null = null;

    if (parsed.action === "assign_template") {
      const template = workspace.templates.find(
        (candidate) => candidate.id === parsed.templateId,
      );
      if (!template) {
        throw new TaskBulkStateError(
          "The selected active task template does not belong to this event.",
        );
      }
      templateName = template.name;
      const speakers = await this.env.DB.prepare(
        `SELECT DISTINCT person.id, person.display_name AS name
           FROM people person
           JOIN events event ON event.id = ? AND event.organisation_id = ?
           LEFT JOIN memberships membership
             ON membership.person_id = person.id AND membership.event_id = event.id
            AND membership.role = 'speaker' AND membership.accepted_at IS NOT NULL
            AND membership.revoked_at IS NULL
           LEFT JOIN session_speakers session_speaker
             ON session_speaker.person_id = person.id AND session_speaker.event_id = event.id
          WHERE person.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
            AND (membership.id IS NOT NULL OR session_speaker.person_id IS NOT NULL)`,
      )
        .bind(
          viewer.eventId,
          viewer.organisationId,
          JSON.stringify(parsed.recordIds),
        )
        .all<{ id: string; name: string }>();
      if (speakers.results.length !== parsed.recordIds.length) {
        throw new TaskBulkStateError(
          "The selected speakers do not all belong to the current event.",
        );
      }
      const dependencies = await this.dependencyTemplates(
        viewer.eventId,
        template.id,
      );
      const relevantTemplateIds = [
        template.id,
        ...dependencies.map((row) => row.id),
      ];
      const existing = await this.env.DB.prepare(
        `SELECT template_id AS templateId, target_id AS personId
           FROM task_instances
          WHERE event_id = ? AND target_type = 'speaker'
            AND target_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
            AND template_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
      )
        .bind(
          viewer.eventId,
          JSON.stringify(parsed.recordIds),
          JSON.stringify(relevantTemplateIds),
        )
        .all<{ templateId: string; personId: string }>();
      const existingKeys = new Set(
        existing.results.map((row) => `${row.personId}:${row.templateId}`),
      );
      const speakerById = new Map(speakers.results.map((row) => [row.id, row]));
      for (const personId of parsed.recordIds) {
        const speaker = speakerById.get(personId)!;
        const alreadyAssigned = existingKeys.has(`${personId}:${template.id}`);
        items.push({
          id: crypto.randomUUID(),
          itemKey: `speaker:${personId}`,
          entityType: "person",
          entityId: personId,
          status: alreadyAssigned ? "skipped" : "pending",
          errorCode: null,
          errorMessage: null,
          result: {
            recordId: personId,
            label: speaker.name,
            expectedRevision: null,
            beforeStatus: alreadyAssigned ? "assigned" : "not assigned",
            afterStatus: "assigned",
            personId,
            templateId: template.id,
            additionalPrerequisites: dependencies
              .filter(
                (dependency) =>
                  !existingKeys.has(`${personId}:${dependency.id}`),
              )
              .map((dependency) => dependency.name),
            expectedTemplateAssignments: relevantTemplateIds.map(
              (relevantTemplateId) => ({
                templateId: relevantTemplateId,
                assigned: existingKeys.has(`${personId}:${relevantTemplateId}`),
              }),
            ),
            createdTaskId: null,
          },
        });
      }
    } else {
      const selected = await this.env.DB.prepare(
        `SELECT task.id, task.title, owner.display_name AS ownerName,
                task.owner_person_id AS ownerPersonId, task.task_type AS taskType,
                task.status, task.revision,
                EXISTS (
                  SELECT 1 FROM task_instance_dependencies dependency
                  JOIN task_instances prerequisite
                    ON prerequisite.id = dependency.depends_on_task_id
                  WHERE dependency.task_id = task.id
                    AND prerequisite.status NOT IN ('completed','waived')
                ) AS dependenciesBlocked,
                EXISTS (
                  SELECT 1 FROM task_instance_dependencies dependency
                  JOIN task_instances dependent ON dependent.id = dependency.task_id
                  WHERE dependency.depends_on_task_id = task.id
                    AND dependent.status IN ('submitted','completed')
                ) AS dependentAdvanced
           FROM task_instances task
           JOIN events event ON event.id = task.event_id AND event.organisation_id = ?
           LEFT JOIN people owner ON owner.id = task.owner_person_id
          WHERE task.event_id = ?
            AND task.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          JSON.stringify(parsed.recordIds),
        )
        .all<TaskRow>();
      if (selected.results.length !== parsed.recordIds.length) {
        throw new TaskBulkStateError(
          "The selected tasks do not all belong to the current event.",
        );
      }
      const taskById = new Map(selected.results.map((task) => [task.id, task]));
      for (const taskId of parsed.recordIds) {
        const task = taskById.get(taskId)!;
        let status: "pending" | "skipped" | "failed" = "pending";
        let errorCode: string | null = null;
        let errorMessage: string | null = null;
        const afterStatus =
          parsed.action === "waive" ? "waived" : "not_started";
        if (task.status === afterStatus) {
          status = "skipped";
        } else if (
          parsed.action === "waive" &&
          ![
            "not_started",
            "in_progress",
            "blocked",
            "submitted",
            "overdue",
          ].includes(task.status)
        ) {
          status = "failed";
          errorCode = "TASK_NOT_WAIVABLE";
          errorMessage = `A ${task.status.replaceAll("_", " ")} task cannot be waived.`;
        } else if (
          parsed.action === "reopen" &&
          !["completed", "waived"].includes(task.status)
        ) {
          status = "failed";
          errorCode = "TASK_NOT_REOPENABLE";
          errorMessage = `A ${task.status.replaceAll("_", " ")} task cannot be reopened.`;
        } else if (parsed.action === "reopen" && task.dependentAdvanced === 1) {
          status = "failed";
          errorCode = "DEPENDENT_TASK_ADVANCED";
          errorMessage =
            "A dependent task was submitted or completed; reopen that work first.";
        }
        items.push({
          id: crypto.randomUUID(),
          itemKey: `task:${task.id}`,
          entityType: "task_instance",
          entityId: task.id,
          status,
          errorCode,
          errorMessage,
          result: {
            recordId: task.id,
            label: `${task.title} · ${task.ownerName ?? task.ownerPersonId ?? "Unassigned"}`,
            expectedRevision: task.revision,
            beforeStatus: task.status,
            afterStatus,
            personId: task.ownerPersonId,
            templateId: null,
            additionalPrerequisites: [],
            expectedTemplateAssignments: [],
            createdTaskId: null,
          },
        });
      }
    }

    const changeCount = items.filter(
      (item) => item.status === "pending",
    ).length;
    const skippedCount = items.filter(
      (item) => item.status === "skipped",
    ).length;
    const invalidCount = items.filter(
      (item) => item.status === "failed",
    ).length;
    if (changeCount === 0 && invalidCount === 0) {
      throw new TaskBulkStateError(
        "The selected action would not change any records.",
      );
    }
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const summary = {
      action: parsed.action,
      label: actionLabels[parsed.action],
      templateId: parsed.templateId,
      templateName,
      reason: parsed.reason,
      changeCount,
      skippedCount,
      invalidCount,
    };
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, result_json,
           progress_total, progress_completed, progress_failed, cancellable,
           created_at, updated_at
         )
         SELECT ?, ?, ?, ?, 'task.bulk', ?, ?, 'received', ?, ?, ?, ?, ?, 1,
                unixepoch(), unixepoch()
           FROM events WHERE id = ? AND organisation_id = ?`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `task-bulk:${operationId}`,
        correlationId,
        JSON.stringify({ operationId, action: parsed.action }),
        JSON.stringify(summary),
        items.length,
        skippedCount,
        invalidCount,
        viewer.eventId,
        viewer.organisationId,
      ),
      ...items.map((item) =>
        this.env.DB.prepare(
          `INSERT INTO operation_items (
             id, operation_id, item_key, entity_type, entity_id, status,
             result_json, error_code, error_message, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`,
        ).bind(
          item.id,
          operationId,
          item.itemKey,
          item.entityType,
          item.entityId,
          item.status,
          JSON.stringify(item.result),
          item.errorCode,
          item.errorMessage,
        ),
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'task_bulk.previewed', 'operation', ?, correlation_id, ?, unixepoch()
           FROM operation_jobs WHERE id = ? AND status = 'received'`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        JSON.stringify({ operationId, ...summary }),
        operationId,
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      throw new Error("The bulk task preview could not be recorded.");
    }
    return { operationId, ...summary };
  }

  private async failStale(viewer: Viewer, operationId: string) {
    await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE operation_items
            SET status = 'failed', error_code = 'STALE_PREVIEW',
                error_message = 'This record changed after the preview was created.',
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE operation_id = ? AND status = 'pending'
            AND EXISTS (
              SELECT 1 FROM operation_jobs
               WHERE id = ? AND event_id = ? AND organisation_id = ?
                 AND type = 'task.bulk' AND status = 'received'
            )`,
      ).bind(operationId, operationId, viewer.eventId, viewer.organisationId),
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'failed', cancellable = 0,
                progress_failed = (
                  SELECT COUNT(*) FROM operation_items item
                   WHERE item.operation_id = operation_jobs.id AND item.status = 'failed'
                ),
                last_error = 'The selected task records changed after preview.',
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'task.bulk' AND status = 'received'`,
      ).bind(operationId, viewer.eventId, viewer.organisationId),
    ]);
  }

  private async assertPreviewFresh(
    viewer: Viewer,
    operation: TaskBulkOperation,
  ) {
    const pending = operation.items.filter((item) => item.status === "pending");
    if (operation.summary.action === "assign_template") {
      const template = await this.env.DB.prepare(
        `SELECT 1 FROM task_templates template
          JOIN events event ON event.id = template.event_id AND event.organisation_id = ?
         WHERE template.id = ? AND template.event_id = ? AND template.status = 'active'
           AND template.target_type = 'speaker'`,
      )
        .bind(
          viewer.organisationId,
          operation.summary.templateId,
          viewer.eventId,
        )
        .first();
      if (!template) return false;
      let dependencyIds: string[];
      try {
        dependencyIds = (
          await this.dependencyTemplates(
            viewer.eventId,
            operation.summary.templateId!,
          )
        ).map((dependency) => dependency.id);
      } catch (error) {
        if (error instanceof TaskBulkStateError) return false;
        throw error;
      }
      const currentTemplateIds = [
        operation.summary.templateId!,
        ...dependencyIds,
      ].sort();
      if (
        pending.some(
          (item) =>
            JSON.stringify(
              item.result.expectedTemplateAssignments
                .map((assignment) => assignment.templateId)
                .sort(),
            ) !== JSON.stringify(currentTemplateIds),
        )
      ) {
        return false;
      }
      const personIds = pending.map((item) => item.result.personId);
      const eligible = await this.env.DB.prepare(
        `SELECT COUNT(DISTINCT person.id) AS count
           FROM people person
           JOIN events event ON event.id = ? AND event.organisation_id = ?
          WHERE person.id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
            AND (
              EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.event_id = event.id AND membership.person_id = person.id
                   AND membership.role = 'speaker' AND membership.accepted_at IS NOT NULL
                   AND membership.revoked_at IS NULL
              ) OR EXISTS (
                SELECT 1 FROM session_speakers session_speaker
                 WHERE session_speaker.event_id = event.id
                   AND session_speaker.person_id = person.id
              )
            )`,
      )
        .bind(viewer.eventId, viewer.organisationId, JSON.stringify(personIds))
        .first<{ count: number }>();
      if ((eligible?.count ?? 0) !== pending.length) return false;
      const assignmentSnapshot = pending.flatMap((item) =>
        item.result.expectedTemplateAssignments.map((assignment) => ({
          personId: item.result.personId,
          ...assignment,
        })),
      );
      const changedAssignment = await this.env.DB.prepare(
        `SELECT 1
           FROM json_each(?) expected
          WHERE EXISTS (
                  SELECT 1 FROM task_instances task
                   WHERE task.event_id = ? AND task.target_type = 'speaker'
                     AND task.target_id = json_extract(expected.value, '$.personId')
                     AND task.template_id = json_extract(expected.value, '$.templateId')
                ) <> json_extract(expected.value, '$.assigned')
          LIMIT 1`,
      )
        .bind(JSON.stringify(assignmentSnapshot), viewer.eventId)
        .first();
      return !changedAssignment;
    }
    const expected = pending.map((item) => ({
      id: item.result.recordId,
      revision: item.result.expectedRevision,
      status: item.result.beforeStatus,
    }));
    const exact = await this.env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM task_instances task
         JOIN events event ON event.id = task.event_id AND event.organisation_id = ?
         JOIN json_each(?) expected ON task.id = json_extract(expected.value, '$.id')
        WHERE task.event_id = ?
          AND task.revision = json_extract(expected.value, '$.revision')
          AND task.status = json_extract(expected.value, '$.status')`,
    )
      .bind(viewer.organisationId, JSON.stringify(expected), viewer.eventId)
      .first<{ count: number }>();
    return (exact?.count ?? 0) === pending.length;
  }

  async confirm(viewer: Viewer, operationId: string) {
    const operation = await this.operation(viewer, operationId);
    if (operation.status !== "received") {
      throw new TaskBulkStateError(
        "Only an uncommitted bulk task preview can be confirmed.",
      );
    }
    if (operation.summary.invalidCount > 0) {
      throw new TaskBulkStateError(
        "Remove ineligible records before confirming this bulk task action.",
      );
    }
    if (!(await this.assertPreviewFresh(viewer, operation))) {
      await this.failStale(viewer, operationId);
      throw new TaskBulkStateError(
        "The selected records changed after preview. Create a new preview before applying the action.",
      );
    }
    const claim = await this.env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'running', cancellable = 0, started_at = unixepoch(),
              updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'task.bulk' AND status = 'received'`,
    )
      .bind(operationId, viewer.eventId, viewer.organisationId)
      .run();
    if ((claim.meta.changes ?? 0) !== 1) {
      throw new TaskBulkStateError(
        "This bulk task preview was already confirmed or cancelled.",
      );
    }

    const taskService = new TaskService(this.env);
    let completed = operation.summary.skippedCount;
    let failed = 0;
    const webhookWarnings: string[] = [];
    for (const item of operation.items.filter(
      (candidate) => candidate.status === "pending",
    )) {
      try {
        let changedTaskId = item.result.recordId;
        if (operation.summary.action === "assign_template") {
          const result = await taskService.assignTemplate(
            viewer,
            item.result.templateId!,
            item.result.personId!,
          );
          changedTaskId = result.taskId;
          if (result.webhookWarning)
            webhookWarnings.push(result.webhookWarning);
        } else {
          const result = await taskService.administerTask(viewer, {
            taskId: item.result.recordId,
            revision: item.result.expectedRevision,
            intent: operation.summary.action,
            reason: operation.summary.reason,
          });
          if (result.webhookWarning)
            webhookWarnings.push(result.webhookWarning);
        }
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE operation_items
                SET status = 'completed', result_json = json_set(result_json, '$.createdTaskId', ?),
                    completed_at = unixepoch(), updated_at = unixepoch()
              WHERE id = ? AND operation_id = ? AND status = 'pending'`,
          ).bind(changedTaskId, item.id, operationId),
          this.env.DB.prepare(
            `INSERT INTO event_changes (
               event_id, entity_type, entity_id, change_type, correlation_id, created_at
             )
             SELECT ?, 'task_instance', ?, 'updated', operation.correlation_id, unixepoch()
               FROM operation_jobs operation
              WHERE operation.id = ? AND operation.status = 'running'`,
          ).bind(viewer.eventId, changedTaskId, operationId),
        ]);
        completed += 1;
      } catch (error) {
        if (
          !(error instanceof TaskStateError) &&
          !(error instanceof ZodError)
        ) {
          await this.env.DB.prepare(
            `UPDATE operation_jobs
                SET status = 'failed', progress_completed = ?, progress_failed = ?,
                    last_error = 'The bulk task action stopped after an unexpected failure.',
                    completed_at = unixepoch(), updated_at = unixepoch()
              WHERE id = ? AND status = 'running'`,
          )
            .bind(completed, failed + 1, operationId)
            .run();
          throw error;
        }
        failed += 1;
        await this.env.DB.prepare(
          `UPDATE operation_items
              SET status = 'failed', error_code = 'DOMAIN_VALIDATION_FAILED',
                  error_message = ?, completed_at = unixepoch(), updated_at = unixepoch()
            WHERE id = ? AND operation_id = ? AND status = 'pending'`,
        )
          .bind(
            error instanceof ZodError
              ? (error.issues[0]?.message ?? "Task validation failed.")
              : error.message,
            item.id,
            operationId,
          )
          .run();
      }
    }

    const finalStatus = failed > 0 ? "partially_failed" : "completed";
    const [finalized] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = ?, progress_completed = ?, progress_failed = ?,
                last_error = CASE WHEN ? > 0 THEN 'One or more records failed domain revalidation.' ELSE NULL END,
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'task.bulk' AND status = 'running'`,
      ).bind(
        finalStatus,
        completed,
        failed,
        failed,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, ?, 'operation', operation.id, operation.correlation_id, ?, unixepoch()
           FROM operation_jobs operation WHERE operation.id = ? AND operation.status = ?`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        finalStatus === "completed"
          ? "task_bulk.completed"
          : "task_bulk.partially_failed",
        JSON.stringify({ operationId, completed, failed }),
        operationId,
        finalStatus,
      ),
    ]);
    if ((finalized.meta.changes ?? 0) !== 1) {
      throw new Error("The bulk task operation did not reach a final state.");
    }
    return {
      operationId,
      status: finalStatus,
      completed,
      failed,
      webhookWarning: [...new Set(webhookWarnings)].join(" ") || null,
    };
  }

  async cancel(viewer: Viewer, operationId: string) {
    const [cancelled] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'cancelled', cancellable = 0, completed_at = unixepoch(),
                last_error = NULL, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'task.bulk' AND status = 'received' AND cancellable = 1`,
      ).bind(operationId, viewer.eventId, viewer.organisationId),
      this.env.DB.prepare(
        `UPDATE operation_items
            SET status = 'skipped', error_code = 'BULK_CANCELLED',
                error_message = 'The bulk task preview was cancelled before commitment.',
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE operation_id = ? AND status = 'pending'
            AND EXISTS (
              SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'cancelled'
            )`,
      ).bind(operationId, operationId),
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET progress_completed = progress_total - progress_failed,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'task.bulk' AND status = 'cancelled'`,
      ).bind(operationId, viewer.eventId, viewer.organisationId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'task_bulk.cancelled', 'operation', ?, '{}', unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'cancelled'
          )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        operationId,
      ),
    ]);
    if ((cancelled.meta.changes ?? 0) !== 1) {
      throw new TaskBulkStateError(
        "Only an uncommitted bulk task preview can be cancelled.",
      );
    }
  }
}
