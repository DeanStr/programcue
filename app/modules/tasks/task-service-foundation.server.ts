import { z } from "zod";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { eventLocalTimeEpoch } from "~/modules/schedule/schedule-time";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  WebhookQueueConfigurationError,
  WebhookService,
} from "~/platform/operations/webhook-service.server";
import {
  taskEvidenceUrlSchema,
  taskTemplateConfigurationSchema,
} from "./task-schema";

export class TaskStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TaskStateError";
  }
}

export class TaskEvidenceAttachmentConflictError extends TaskStateError {
  constructor(message: string) {
    super(message);
    this.name = "TaskEvidenceAttachmentConflictError";
  }
}

export function taskTemplateIdForIntent(eventId: string, intentId: string) {
  const normalizedEventId = eventId.trim();
  const normalizedIntentId = intentId.trim();
  if (
    !normalizedEventId ||
    !normalizedIntentId ||
    normalizedIntentId.length > 200
  )
    throw new TaskStateError(
      "A bounded task-template creation intent is required.",
    );
  return `task-template:${normalizedEventId.length}:${normalizedEventId}:${normalizedIntentId}`;
}

export const TRAVEL_ONBOARDING_TEMPLATE_INTENTS = {
  hotel: "preset:travel-onboarding:v1:hotel",
  flight: "preset:travel-onboarding:v1:flight",
} as const;

export type TemplateRow = {
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
  autoAssignOnAcceptance: number | boolean;
  configurationJson: string;
  status: string;
};

export type TaskRow = {
  id: string;
  templateId: string | null;
  targetType: string;
  targetId: string;
  targetLabel?: string | null;
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
  submittedAt: number | null;
  completedAt: number | null;
  completedByPersonId: string | null;
  lastOperationId: string | null;
  configurationJson: string;
};

export const completionUndoResultSchema = z.object({
  version: z.literal(1),
  taskId: z.string().min(1),
  completionRevision: z.number().int().positive(),
  evidenceId: z.string().min(1).nullable(),
  dependentRevisions: z.array(
    z.object({
      taskId: z.string().min(1),
      revision: z.number().int().positive(),
    }),
  ),
  undoTokenHash: z.string().regex(/^[a-f0-9]{64}$/),
  undoExpiresAt: z.number().int().positive(),
  undoneAt: z.number().int().positive().nullable(),
  undoOperationId: z.string().min(1).nullable(),
  before: z.object({
    status: z.enum(["not_started", "in_progress", "blocked", "overdue"]),
    readinessState: z.enum(["on_track", "at_risk", "overdue", "blocked"]),
    readinessPercent: z.number().int().min(0).max(100),
    evidenceJson: z.string().nullable(),
    waiverJson: z.string().nullable(),
    submittedAt: z.number().int().nullable(),
    completedAt: z.number().int().nullable(),
    completedByPersonId: z.string().nullable(),
  }),
});

export type TaskCompletionMutationResult = {
  taskId: string;
  undoToken: string | null;
  undoExpiresAt: number | null;
  webhookWarning: string | null;
};

export function randomUndoSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export async function hashUndoSecret(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function equalHash(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export function structuredTaskForm(configurationJson: string) {
  try {
    return taskTemplateConfigurationSchema.parse(JSON.parse(configurationJson))
      .form;
  } catch {
    throw new TaskStateError(
      "This task has invalid structured-form configuration. Ask an administrator to repair the template.",
    );
  }
}

export function structuredTaskEvidence(
  configurationJson: string,
  responses: Record<string, string | boolean>,
) {
  const form = structuredTaskForm(configurationJson);
  if (!form) return null;
  const allowedIds = new Set(form.fields.map((field) => field.id));
  if (Object.keys(responses).some((fieldId) => !allowedIds.has(fieldId))) {
    throw new TaskStateError(
      "The task form changed. Refresh before submitting it.",
    );
  }
  const normalized: Record<string, string | boolean> = {};
  for (const field of form.fields) {
    const raw = responses[field.id];
    const conditionallyRequired = field.requiredWhen
      ? normalized[field.requiredWhen.fieldId] === field.requiredWhen.equals
      : false;
    const required = field.required || conditionallyRequired;
    if (field.type === "boolean") {
      if (raw === undefined || raw === "") {
        if (required) throw new TaskStateError(`Answer “${field.label}”.`);
        continue;
      }
      if (typeof raw !== "boolean" && raw !== "true" && raw !== "false") {
        throw new TaskStateError(
          `Choose a valid yes or no answer for “${field.label}”.`,
        );
      }
      normalized[field.id] = typeof raw === "boolean" ? raw : raw === "true";
      continue;
    }
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) {
      if (required) throw new TaskStateError(`Answer “${field.label}”.`);
      continue;
    }
    if (field.type === "date" && !z.string().date().safeParse(value).success) {
      throw new TaskStateError(`Enter a valid date for “${field.label}”.`);
    }
    if (field.type === "select" && !field.options.includes(value)) {
      throw new TaskStateError(`Choose a valid option for “${field.label}”.`);
    }
    normalized[field.id] = value;
  }
  return normalized;
}

export function parseJson(value: string, context: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${context} contains invalid JSON.`, { cause: error });
  }
}

export const taskEvidenceDetailsSchema = z
  .object({
    confirmed: z.boolean().optional(),
    text: z.string().optional(),
    url: taskEvidenceUrlSchema.optional(),
    fileAssetId: z.string().optional(),
    fileVersionId: z.string().optional(),
    scanStatus: z.string().optional(),
    responses: z
      .record(z.string(), z.union([z.string(), z.boolean()]))
      .optional(),
  })
  .passthrough();

export const completedFileEvidenceAttachmentSchema = z.object({
  taskId: z.string().min(1).max(160),
  assetId: z.string().min(1).max(160),
  versionId: z.string().min(1).max(160),
});

export type CompletedFileEvidenceAsset = {
  id: string;
  versionId: string;
  versionNumber: number;
  uploadStatus: string;
  signatureStatus: string;
  scanStatus: string;
  evidenceId: string | null;
  evidenceStatus: string | null;
  hasPriorEvidence: number;
};

export function parseTaskEvidenceDetails(taskId: string, value: string) {
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

export function statusProgress(status: TaskRow["status"]) {
  if (status === "completed" || status === "waived")
    return { percent: 100, readiness: "on_track" };
  if (status === "submitted") return { percent: 80, readiness: "on_track" };
  if (status === "in_progress") return { percent: 40, readiness: "at_risk" };
  if (status === "blocked") return { percent: 0, readiness: "blocked" };
  if (status === "overdue") return { percent: 0, readiness: "overdue" };
  return { percent: 0, readiness: "on_track" };
}

export class TaskServiceFoundation {
  protected readonly airtable;
  constructor(
    protected readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  protected async projectCommand<T>(
    viewer: Viewer,
    operation: string,
    input: unknown,
    execute: () => Promise<T>,
    options: { replay?: "store" | "reject" } = {},
  ) {
    const idempotencyKey = await airtableCommandKey(operation, viewer, input);
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation },
      execute,
      options,
    );
  }

  protected async projectIntentCommand<T>(
    viewer: Viewer,
    operation: string,
    intentId: string,
    input: unknown,
    execute: () => Promise<T>,
  ) {
    return this.airtable.executeIdempotent(
      viewer,
      await airtableIntentCommand(operation, viewer, intentId, input),
      execute,
    );
  }

  protected async queueTaskWebhook(
    viewer: Viewer,
    input: {
      eventType: "task.created" | "task.updated";
      taskId: string;
      operationId: string;
      data: Record<string, unknown>;
    },
  ) {
    try {
      const deliveries = await new WebhookService(this.env).queueEvent(viewer, {
        eventType: input.eventType,
        entityType: "task",
        entityId: input.taskId,
        idempotencyKey: `${input.eventType}:${input.taskId}:${input.operationId}`,
        correlationId: input.operationId,
        data: input.data,
      });
      return deliveries.some((delivery) => delivery.status === "queue_failed")
        ? "The task change was saved, but one or more outbound webhooks need a queue retry."
        : null;
    } catch (error) {
      if (error instanceof WebhookQueueConfigurationError) throw error;
      console.error("Failed to record task webhook event", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return "The task change was saved, but its outbound webhook event could not be recorded.";
    }
  }

  protected requireTaskWebhookReadiness(
    viewer: Viewer,
    eventType: "task.created" | "task.updated",
  ) {
    return new WebhookService(this.env).assertEventDeliveryReady(
      viewer,
      eventType,
    );
  }

  protected async assertEvent(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      `SELECT id, name, timezone, starts_at AS startsAt
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{
        id: string;
        name: string;
        timezone: string;
        startsAt: number;
      }>();
    if (!row) throw new Response("This event could not be found.", { status: 404 });
    return row;
  }

  protected async refreshStates(eventId: string) {
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

  protected async dependenciesComplete(taskId: string) {
    const incomplete = await this.env.DB.prepare(
      `SELECT COUNT(*) AS count FROM task_instance_dependencies dep
        JOIN task_instances prerequisite
          ON prerequisite.id = dep.depends_on_task_id
       WHERE dep.task_id = ?
         AND prerequisite.status NOT IN ('completed','waived')`,
    )
      .bind(taskId)
      .first<{ count: number }>();
    return (incomplete?.count ?? 0) === 0;
  }

  protected async dependentRevisionSnapshot(taskId: string) {
    const dependents = await this.env.DB.prepare(
      `SELECT dependent.id AS taskId, dependent.revision
         FROM task_instance_dependencies dependency
         JOIN task_instances dependent ON dependent.id = dependency.task_id
        WHERE dependency.depends_on_task_id = ?
        ORDER BY dependent.id`,
    )
      .bind(taskId)
      .all<{ taskId: string; revision: number }>();
    return dependents.results;
  }

  protected taskAccessClause() {
    return `(
      ti.owner_person_id = ?
      OR (ti.target_type = 'speaker' AND ti.target_id = ?)
      OR (ti.target_type = 'session' AND EXISTS (
        SELECT 1 FROM session_speakers ss
         WHERE ss.event_id = ti.event_id
           AND ss.session_id = ti.target_id
           AND ss.person_id = ?
      ))
    )`;
  }
}
