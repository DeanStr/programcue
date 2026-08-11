import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { eventLocalTimeEpoch } from "~/modules/schedule/schedule-time";
import {
  WebhookQueueConfigurationError,
  WebhookService,
} from "~/platform/operations/webhook-service.server";
import {
  participantEvidenceSchema,
  taskEvidenceUrlSchema,
  taskTemplateConfigurationSchema,
  taskTemplateInputSchema,
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

const TRAVEL_ONBOARDING_TEMPLATE_INTENTS = {
  hotel: "preset:travel-onboarding:v1:hotel",
  flight: "preset:travel-onboarding:v1:flight",
} as const;

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
  autoAssignOnAcceptance: number | boolean;
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
  submittedAt: number | null;
  completedAt: number | null;
  completedByPersonId: string | null;
  lastOperationId: string | null;
  configurationJson: string;
};

const completionUndoResultSchema = z.object({
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

function randomUndoSecret() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

async function hashUndoSecret(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function equalHash(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function structuredTaskForm(configurationJson: string) {
  try {
    return taskTemplateConfigurationSchema.parse(JSON.parse(configurationJson))
      .form;
  } catch {
    throw new TaskStateError(
      "This task has invalid structured-form configuration. Ask an administrator to repair the template.",
    );
  }
}

function structuredTaskEvidence(
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

function parseJson(value: string, context: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new Error(`${context} contains invalid JSON.`, { cause: error });
  }
}

const taskEvidenceDetailsSchema = z
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

const completedFileEvidenceAttachmentSchema = z.object({
  taskId: z.string().min(1).max(160),
  assetId: z.string().min(1).max(160),
  versionId: z.string().min(1).max(160),
});

type CompletedFileEvidenceAsset = {
  id: string;
  versionId: string;
  uploadStatus: string;
  signatureStatus: string;
  scanStatus: string;
  evidenceId: string | null;
  evidenceStatus: string | null;
};

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
  private readonly airtable;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  private async projectCommand<T>(
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

  private async projectIntentCommand<T>(
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

  private async queueTaskWebhook(
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

  private requireTaskWebhookReadiness(
    viewer: Viewer,
    eventType: "task.created" | "task.updated",
  ) {
    return new WebhookService(this.env).assertEventDeliveryReady(
      viewer,
      eventType,
    );
  }

  private async assertEvent(viewer: Viewer) {
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

  async createTemplate(
    viewer: Viewer,
    rawInput: unknown,
    intentId: string = crypto.randomUUID(),
  ) {
    const result = await this.createTemplateWithResult(
      viewer,
      rawInput,
      intentId,
    );
    return result.id;
  }

  private async createTemplateWithResult(
    viewer: Viewer,
    rawInput: unknown,
    intentId: string,
  ) {
    return this.projectIntentCommand(
      viewer,
      "task.template.create",
      intentId,
      rawInput,
      () => this.createTemplateD1(viewer, rawInput, intentId),
    );
  }

  async createTravelOnboardingTemplates(viewer: Viewer, confirmed: unknown) {
    if (confirmed !== true) {
      throw new TaskStateError(
        "Review and confirm the two automatically assigned travel onboarding forms before creating them.",
      );
    }
    const common = {
      targetType: "speaker" as const,
      taskType: "short_form" as const,
      impact: "high" as const,
      evidenceMode: "text" as const,
      dueAnchor: "acceptance" as const,
      dueOffsetDays: 7,
      fixedDueDate: null,
      autoAssignOnAcceptance: true,
      dependencyIds: [],
    };
    const presets = [
      {
        preset: "speaker_travel_hotel_v1" as const,
        intent: TRAVEL_ONBOARDING_TEMPLATE_INTENTS.hotel,
        input: {
          ...common,
          name: "Hotel stay requirements",
          description:
            "Confirm whether you need event-arranged accommodation and provide the dates and room requirements the team needs.",
          configuration: {
            preset: "speaker_travel_hotel_v1" as const,
            form: {
              fields: [
                {
                  id: "requires_hotel",
                  label: "Do you need event-arranged accommodation?",
                  type: "boolean",
                  required: true,
                  help: "Choose no if you are arranging your own stay.",
                },
                {
                  id: "check_in",
                  label: "Check-in date",
                  type: "date",
                  required: false,
                  requiredWhen: {
                    fieldId: "requires_hotel",
                    equals: true,
                  },
                  help: "Required when event-arranged accommodation is needed.",
                },
                {
                  id: "check_out",
                  label: "Check-out date",
                  type: "date",
                  required: false,
                  requiredWhen: {
                    fieldId: "requires_hotel",
                    equals: true,
                  },
                  help: "Required when event-arranged accommodation is needed.",
                },
                {
                  id: "room_requirements",
                  label: "Accessibility, room or arrival requirements",
                  type: "long_text",
                  required: false,
                  help: "Share only details the event team needs to arrange your stay.",
                },
              ],
            },
          },
        },
      },
      {
        preset: "speaker_travel_flight_v1" as const,
        intent: TRAVEL_ONBOARDING_TEMPLATE_INTENTS.flight,
        input: {
          ...common,
          name: "Flight reimbursement",
          description:
            "Tell the event team whether you plan to claim flight reimbursement and provide the booking details needed for approval.",
          configuration: {
            preset: "speaker_travel_flight_v1" as const,
            form: {
              fields: [
                {
                  id: "requires_reimbursement",
                  label: "Will you request flight reimbursement?",
                  type: "boolean",
                  required: true,
                  help: "Choose no if no flight reimbursement is needed.",
                },
                {
                  id: "traveller_name",
                  label: "Traveller name used for booking",
                  type: "short_text",
                  required: false,
                  requiredWhen: {
                    fieldId: "requires_reimbursement",
                    equals: true,
                  },
                  help: "Required when reimbursement is requested. Use the name that will appear on the booking.",
                },
                {
                  id: "departure_airport",
                  label: "Departure airport",
                  type: "short_text",
                  required: false,
                  requiredWhen: {
                    fieldId: "requires_reimbursement",
                    equals: true,
                  },
                  help: "Required when reimbursement is requested. Enter a city or IATA airport code.",
                },
                {
                  id: "estimated_fare",
                  label: "Estimated round-trip fare and currency",
                  type: "short_text",
                  required: false,
                  requiredWhen: {
                    fieldId: "requires_reimbursement",
                    equals: true,
                  },
                  help: "Required when reimbursement is requested. For example, USD 450. Do not enter payment-card details.",
                },
                {
                  id: "reimbursement_notes",
                  label: "Route or reimbursement notes",
                  type: "long_text",
                  required: false,
                  help: "Include constraints or approval questions for the event team.",
                },
              ],
            },
          },
        },
      },
    ] as const;
    const existingTemplates = await this.env.DB.prepare(
      `SELECT id, name, description, target_type AS targetType,
              task_type AS taskType, impact, evidence_mode AS evidenceMode,
              due_anchor AS dueAnchor, due_offset_minutes AS dueOffsetMinutes,
              fixed_due_at AS fixedDueAt,
              auto_assign_on_acceptance AS autoAssignOnAcceptance,
              configuration_json AS configurationJson, status,
              (SELECT COUNT(*) FROM task_template_dependencies dependency
                WHERE dependency.template_id = task_templates.id) AS dependencyCount
         FROM task_templates
        WHERE event_id = ?
          AND json_extract(configuration_json, '$.preset') IN (?, ?)`,
    )
      .bind(viewer.eventId, presets[0].preset, presets[1].preset)
      .all<TemplateRow & { dependencyCount: number }>();
    const resolved = new Map<
      (typeof presets)[number]["preset"],
      { id: string; created: boolean }
    >();
    const missingPresets: (typeof presets)[number][] = [];
    for (const preset of presets) {
      const matches = existingTemplates.results.filter((template) => {
        try {
          return (
            taskTemplateConfigurationSchema.parse(
              JSON.parse(template.configurationJson),
            ).preset === preset.preset
          );
        } catch {
          throw new TaskStateError(
            "A travel onboarding preset has invalid stored configuration.",
          );
        }
      });
      if (matches.length > 1) {
        throw new TaskStateError(
          "This event contains duplicate travel onboarding presets. Repair the duplicate preset markers before continuing.",
        );
      }
      const existing = matches[0];
      if (!existing) {
        missingPresets.push(preset);
        continue;
      }
      if (existing.status !== "active") {
        throw new TaskStateError(
          "A travel onboarding preset is archived. Restore it before creating the preset forms again.",
        );
      }
      let storedInput;
      try {
        storedInput = taskTemplateInputSchema.parse({
          name: existing.name,
          description: existing.description ?? "",
          targetType: existing.targetType,
          taskType: existing.taskType,
          impact: existing.impact,
          evidenceMode: existing.evidenceMode,
          dueAnchor: existing.dueAnchor,
          dueOffsetDays:
            existing.dueOffsetMinutes === null
              ? null
              : existing.dueOffsetMinutes / 1_440,
          fixedDueDate: null,
          autoAssignOnAcceptance: Boolean(existing.autoAssignOnAcceptance),
          dependencyIds: [],
          configuration: JSON.parse(existing.configurationJson),
        });
      } catch {
        throw new TaskStateError(
          "A travel onboarding preset has invalid stored configuration.",
        );
      }
      const expectedInput = taskTemplateInputSchema.parse(preset.input);
      if (
        existing.dependencyCount !== 0 ||
        JSON.stringify(storedInput) !== JSON.stringify(expectedInput)
      ) {
        throw new TaskStateError(
          "A travel onboarding preset differs from the required hotel or flight form. Restore the preset before continuing.",
        );
      }
      resolved.set(preset.preset, { id: existing.id, created: false });
    }
    for (const preset of missingPresets) {
      resolved.set(
        preset.preset,
        await this.createTemplateWithResult(
          viewer,
          preset.input,
          preset.intent,
        ),
      );
    }
    const hotel = resolved.get("speaker_travel_hotel_v1")!;
    const flight = resolved.get("speaker_travel_flight_v1")!;
    return {
      hotelTemplateId: hotel.id,
      flightTemplateId: flight.id,
      createdTemplateIds: [hotel, flight]
        .filter((template) => template.created)
        .map((template) => template.id),
    };
  }

  private async createTemplateD1(
    viewer: Viewer,
    rawInput: unknown,
    intentId: string,
  ) {
    const event = await this.assertEvent(viewer);
    const input = taskTemplateInputSchema.parse(rawInput);
    const dependencyIds = [...new Set(input.dependencyIds)].sort();
    if (dependencyIds.length) {
      const dependencies = await this.env.DB.prepare(
        `
        SELECT id, target_type AS targetType FROM task_templates
         WHERE event_id = ? AND status = 'active'
           AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      `,
      )
        .bind(viewer.eventId, JSON.stringify(dependencyIds))
        .all<{ id: string; targetType: TemplateRow["targetType"] }>();
      if (dependencies.results.length !== dependencyIds.length)
        throw new TaskStateError(
          "One or more prerequisite templates are unavailable in this event.",
        );
      if (
        dependencies.results.some(
          (dependency) => dependency.targetType !== input.targetType,
        )
      ) {
        throw new TaskStateError(
          "Prerequisite templates must use the same task scope.",
        );
      }
    }
    const id = taskTemplateIdForIntent(viewer.eventId, intentId);
    const expected = {
      name: input.name,
      description: input.description || null,
      targetType: input.targetType,
      taskType: input.taskType,
      impact: input.impact,
      evidenceMode: input.evidenceMode,
      dueAnchor: input.dueAnchor,
      dueOffsetMinutes:
        input.dueOffsetDays === null ? null : input.dueOffsetDays * 1_440,
      fixedDueAt: fixedDateEndEpoch(input.fixedDueDate, event.timezone),
      autoAssignOnAcceptance: input.autoAssignOnAcceptance ? 1 : 0,
      configurationJson: JSON.stringify(input.configuration),
    };
    const recoverExactTemplate = async () => {
      const recovered = await this.env.DB.prepare(
        `SELECT id, name, description, target_type AS targetType,
                task_type AS taskType, impact, evidence_mode AS evidenceMode,
                due_anchor AS dueAnchor, due_offset_minutes AS dueOffsetMinutes,
                fixed_due_at AS fixedDueAt,
                auto_assign_on_acceptance AS autoAssignOnAcceptance,
                configuration_json AS configurationJson
           FROM task_templates WHERE id = ? AND event_id = ?`,
      )
        .bind(id, viewer.eventId)
        .first<{
          id: string;
          name: string;
          description: string | null;
          targetType: string;
          taskType: string;
          impact: string;
          evidenceMode: string;
          dueAnchor: string;
          dueOffsetMinutes: number | null;
          fixedDueAt: number | null;
          autoAssignOnAcceptance: number;
          configurationJson: string;
        }>();
      if (!recovered) return null;
      const recoveredDependencies = await this.env.DB.prepare(
        `SELECT depends_on_template_id AS dependencyId
           FROM task_template_dependencies
          WHERE template_id = ? ORDER BY depends_on_template_id`,
      )
        .bind(id)
        .all<{ dependencyId: string }>();
      const { id: _id, ...recoveredConfiguration } = recovered;
      if (
        JSON.stringify(recoveredConfiguration) !== JSON.stringify(expected) ||
        JSON.stringify(
          recoveredDependencies.results.map((row) => row.dependencyId),
        ) !== JSON.stringify(dependencyIds)
      )
        throw new TaskStateError(
          "This task-template creation intent was already used with different configuration.",
        );
      return recovered.id;
    };
    const recoveredId = await recoverExactTemplate();
    if (recoveredId) return { id: recoveredId, created: false };
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `
          INSERT INTO task_templates (
            id, event_id, name, description, target_type, task_type, impact, evidence_mode,
            due_anchor, due_offset_minutes, fixed_due_at, auto_assign_on_acceptance,
            configuration_json, status, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', unixepoch(), unixepoch())
        `,
        ).bind(
          id,
          viewer.eventId,
          expected.name,
          expected.description,
          expected.targetType,
          expected.taskType,
          expected.impact,
          expected.evidenceMode,
          expected.dueAnchor,
          expected.dueOffsetMinutes,
          expected.fixedDueAt,
          expected.autoAssignOnAcceptance,
          expected.configurationJson,
        ),
        ...dependencyIds.map((dependencyId) =>
          this.env.DB.prepare(
            `
          INSERT INTO task_template_dependencies (template_id, depends_on_template_id, created_at) VALUES (?, ?, unixepoch())
        `,
          ).bind(id, dependencyId),
        ),
        this.env.DB.prepare(
          `
          INSERT OR IGNORE INTO audit_events (
            id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, 'task_template.created', 'task_template', ?, ?, unixepoch())
        `,
        ).bind(
          `audit:${id}`,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          id,
          JSON.stringify({
            taskType: input.taskType,
            targetType: input.targetType,
            autoAssignOnAcceptance: input.autoAssignOnAcceptance,
            dependencies: input.dependencyIds,
          }),
        ),
      ]);
    } catch (error) {
      const concurrentWinnerId = await recoverExactTemplate();
      if (concurrentWinnerId) return { id: concurrentWinnerId, created: false };
      throw error;
    }
    return { id, created: true };
  }

  private async getTemplate(eventId: string, templateId: string) {
    return this.env.DB.prepare(
      `
      SELECT id, name, description, target_type AS targetType, task_type AS taskType, impact,
             evidence_mode AS evidenceMode, due_anchor AS dueAnchor, due_offset_minutes AS dueOffsetMinutes,
             fixed_due_at AS fixedDueAt, auto_assign_on_acceptance AS autoAssignOnAcceptance,
             configuration_json AS configurationJson, status
        FROM task_templates WHERE id = ? AND event_id = ?
    `,
    )
      .bind(templateId, eventId)
      .first<TemplateRow>();
  }

  private async dueAtFor(
    template: TemplateRow,
    eventId: string,
    targetId: string,
  ) {
    let anchor: number | null = null;
    if (template.dueAnchor === "fixed") anchor = template.fixedDueAt;
    if (template.dueAnchor === "acceptance") {
      const acceptanceQueries = {
        speaker: `
          SELECT MIN(sd.published_at) AS anchor
            FROM session_speakers ss
            JOIN sessions s ON s.id = ss.session_id AND s.event_id = ss.event_id
            JOIN submission_decisions sd
              ON sd.submission_id = s.source_submission_id AND sd.event_id = s.event_id
           WHERE ss.event_id = ? AND ss.person_id = ?
             AND sd.status = 'published' AND sd.decision = 'accepted'`,
        session: `
          SELECT MIN(sd.published_at) AS anchor
            FROM sessions s
            JOIN submission_decisions sd
              ON sd.submission_id = s.source_submission_id AND sd.event_id = s.event_id
           WHERE s.event_id = ? AND s.id = ?
             AND sd.status = 'published' AND sd.decision = 'accepted'`,
        event: `
          SELECT MIN(sd.published_at) AS anchor
            FROM submission_decisions sd
           WHERE sd.event_id = ? AND ? = sd.event_id
             AND sd.status = 'published' AND sd.decision = 'accepted'`,
      } satisfies Record<TemplateRow["targetType"], string>;
      const row = await this.env.DB.prepare(
        acceptanceQueries[template.targetType],
      )
        .bind(eventId, targetId)
        .first<{ anchor: number | null }>();
      anchor = row?.anchor ?? null;
    }
    if (template.dueAnchor === "session_start") {
      const sessionStartQueries = {
        speaker: `
          SELECT MIN(se.starts_at) AS anchor
            FROM session_speakers ss
            JOIN schedule_versions sv
              ON sv.event_id = ss.event_id AND sv.status = 'published'
            JOIN schedule_entries se
              ON se.schedule_version_id = sv.id AND se.session_id = ss.session_id
           WHERE ss.event_id = ? AND ss.person_id = ?`,
        session: `
          SELECT MIN(se.starts_at) AS anchor
            FROM schedule_versions sv
            JOIN schedule_entries se ON se.schedule_version_id = sv.id
           WHERE sv.event_id = ? AND se.session_id = ? AND sv.status = 'published'`,
        event: `
          SELECT starts_at AS anchor FROM events WHERE id = ? AND id = ?`,
      } satisfies Record<TemplateRow["targetType"], string>;
      const row = await this.env.DB.prepare(
        sessionStartQueries[template.targetType],
      )
        .bind(eventId, targetId)
        .first<{ anchor: number | null }>();
      anchor = row?.anchor ?? null;
    }
    return anchor === null
      ? null
      : anchor + (template.dueOffsetMinutes ?? 0) * 60;
  }

  private async assertTaskTarget(
    eventId: string,
    targetType: TemplateRow["targetType"],
    targetId: string,
  ) {
    if (targetType === "event") {
      if (targetId !== eventId)
        throw new TaskStateError("The selected event target is unavailable.");
      return;
    }
    const target =
      targetType === "speaker"
        ? await this.env.DB.prepare(
            `
            SELECT 1 FROM memberships
             WHERE event_id = ? AND person_id = ? AND role = 'speaker'
               AND accepted_at IS NOT NULL AND revoked_at IS NULL
            UNION
            SELECT 1 FROM session_speakers
             WHERE event_id = ? AND person_id = ? LIMIT 1
          `,
          )
            .bind(eventId, targetId, eventId, targetId)
            .first()
        : await this.env.DB.prepare(
            `SELECT 1 FROM sessions
              WHERE event_id = ? AND id = ? AND status NOT IN ('cancelled','archived')`,
          )
            .bind(eventId, targetId)
            .first();
    if (!target) {
      throw new TaskStateError(
        targetType === "speaker"
          ? "The selected person is not a speaker in this event."
          : "The selected session is unavailable in this event.",
      );
    }
  }

  private async recordAssignmentAudit(
    viewer: Viewer,
    template: TemplateRow,
    targetId: string,
    taskId: string,
    operationId: string,
  ) {
    await this.env.DB.prepare(
      `INSERT OR IGNORE INTO audit_events (
         id, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, correlation_id, metadata_json, created_at
       ) VALUES (?, ?, ?, ?, 'task.assigned', 'task_instance', ?, ?, ?, unixepoch())`,
    )
      .bind(
        `audit:task-assigned:${operationId}`,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        taskId,
        operationId,
        JSON.stringify({
          templateId: template.id,
          targetType: template.targetType,
          targetId,
        }),
      )
      .run();
  }

  private async materializeTemplate(
    viewer: Viewer,
    templateId: string,
    targetId: string,
    visiting = new Set<string>(),
    webhookWarnings: string[] = [],
    expectedTargetType?: TemplateRow["targetType"],
    assignmentIntentId?: string,
  ): Promise<string> {
    if (visiting.has(templateId))
      throw new TaskStateError("Task template dependencies contain a cycle.");
    const template = await this.getTemplate(viewer.eventId, templateId);
    if (!template || template.status !== "active")
      throw new TaskStateError("Task template not found or archived.");
    if (expectedTargetType && template.targetType !== expectedTargetType) {
      throw new TaskStateError(
        "Prerequisite templates must use the same task scope.",
      );
    }
    const existing = await this.env.DB.prepare(
      `
      SELECT id, title, status, last_operation_id AS lastOperationId
        FROM task_instances
       WHERE event_id = ? AND template_id = ? AND target_type = ? AND target_id = ?
       LIMIT 1
    `,
    )
      .bind(viewer.eventId, templateId, template.targetType, targetId)
      .first<{
        id: string;
        title: string;
        status: string;
        lastOperationId: string | null;
      }>();
    if (existing) {
      const operationId = assignmentIntentId
        ? expectedTargetType === undefined
          ? assignmentIntentId
          : `${assignmentIntentId}:${template.id}`
        : (existing.lastOperationId ?? `existing:${existing.id}`);
      if (assignmentIntentId) {
        await this.recordAssignmentAudit(
          viewer,
          template,
          targetId,
          existing.id,
          operationId,
        );
      }
      const warning = await this.queueTaskWebhook(viewer, {
        eventType: "task.created",
        taskId: existing.id,
        operationId,
        data: {
          title: existing.title,
          status: existing.status,
          targetType: template.targetType,
          targetId,
          templateId,
        },
      });
      if (warning) webhookWarnings.push(warning);
      return existing.id;
    }
    visiting.add(templateId);
    const dueAt = await this.dueAtFor(template, viewer.eventId, targetId);
    if (template.dueAnchor !== "none" && dueAt === null) {
      throw new TaskStateError(
        `The ${template.dueAnchor.replace("_", " ")} due anchor cannot be resolved for this ${template.targetType}.`,
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
          targetId,
          visiting,
          webhookWarnings,
          template.targetType,
          assignmentIntentId,
        ),
      );
    }
    visiting.delete(templateId);
    const operationId = assignmentIntentId
      ? expectedTargetType === undefined
        ? assignmentIntentId
        : `${assignmentIntentId}:${template.id}`
      : crypto.randomUUID();
    const id = assignmentIntentId ? `task:${operationId}` : crypto.randomUUID();
    const blocked = dependencyTaskIds.length > 0;
    const auditEventId = assignmentIntentId
      ? `audit:task-assigned:${operationId}`
      : crypto.randomUUID();
    const preparedWebhook = await new WebhookService(
      this.env,
    ).prepareEventForAudit(
      viewer,
      {
        eventType: "task.created",
        entityType: "task",
        entityId: id,
        idempotencyKey: `task.created:${id}:${operationId}`,
        correlationId: operationId,
        data: {
          title: template.name,
          status: blocked ? "blocked" : "not_started",
          targetType: template.targetType,
          targetId,
          templateId: template.id,
        },
      },
      auditEventId,
    );
    const [inserted] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO task_instances (
          id, event_id, template_id, target_type, target_id, owner_person_id, title, description,
          task_type, impact, status, readiness_state, readiness_percent, revision, last_operation_id,
          due_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1, ?, ?, unixepoch(), unixepoch())
      `,
      ).bind(
        id,
        viewer.eventId,
        template.id,
        template.targetType,
        targetId,
        template.targetType === "speaker" ? targetId : null,
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
        INSERT OR IGNORE INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type,
          entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'task.assigned', 'task_instance', ?, ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM task_instances
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        id,
        operationId,
        JSON.stringify({
          templateId,
          targetType: template.targetType,
          targetId,
        }),
        id,
        viewer.eventId,
        operationId,
      ),
      ...preparedWebhook.statements,
    ]);
    if ((inserted.meta.changes ?? 0) === 1) {
      const warning = await this.queueTaskWebhook(viewer, {
        eventType: "task.created",
        taskId: id,
        operationId,
        data: {
          title: template.name,
          status: blocked ? "blocked" : "not_started",
          targetType: template.targetType,
          targetId,
          templateId: template.id,
        },
      });
      if (warning) webhookWarnings.push(warning);
      return id;
    }
    const winner = await this.env.DB.prepare(
      `
      SELECT id, title, status, last_operation_id AS lastOperationId FROM task_instances
       WHERE event_id = ? AND template_id = ? AND target_type = ? AND target_id = ?
       LIMIT 1
    `,
    )
      .bind(viewer.eventId, templateId, template.targetType, targetId)
      .first<{
        id: string;
        title: string;
        status: string;
        lastOperationId: string | null;
      }>();
    if (winner) {
      if (assignmentIntentId) {
        await this.recordAssignmentAudit(
          viewer,
          template,
          targetId,
          winner.id,
          operationId,
        );
      }
      const warning = await this.queueTaskWebhook(viewer, {
        eventType: "task.created",
        taskId: winner.id,
        operationId: winner.lastOperationId ?? `existing:${winner.id}`,
        data: {
          title: winner.title,
          status: winner.status,
          targetType: template.targetType,
          targetId,
          templateId,
        },
      });
      if (warning) webhookWarnings.push(warning);
      return winner.id;
    }
    throw new TaskStateError(
      "The task assignment changed before it could be created.",
    );
  }

  async assignTemplate(
    viewer: Viewer,
    templateId: string,
    targetId: string,
    intentId?: string,
  ) {
    const execute = () =>
      this.assignTemplateD1(viewer, templateId, targetId, intentId);
    return intentId
      ? this.projectIntentCommand(
          viewer,
          "task.template.assign",
          intentId,
          { templateId, targetId },
          execute,
        )
      : this.projectCommand(
          viewer,
          "task.template.assign",
          { templateId, targetId },
          execute,
        );
  }

  private async assignTemplateD1(
    viewer: Viewer,
    templateId: string,
    targetId: string,
    intentId?: string,
  ) {
    await this.assertEvent(viewer);
    const parsedTemplateId = z.string().min(1).parse(templateId);
    const parsedTargetId = z.string().min(1).parse(targetId);
    const template = await this.getTemplate(viewer.eventId, parsedTemplateId);
    if (!template || template.status !== "active")
      throw new TaskStateError("Task template not found or archived.");
    await this.assertTaskTarget(
      viewer.eventId,
      template.targetType,
      parsedTargetId,
    );
    await this.requireTaskWebhookReadiness(viewer, "task.created");
    const webhookWarnings: string[] = [];
    const taskId = await this.materializeTemplate(
      viewer,
      parsedTemplateId,
      parsedTargetId,
      new Set(),
      webhookWarnings,
      undefined,
      intentId,
    );
    return {
      taskId,
      webhookWarning: [...new Set(webhookWarnings)].join(" ") || null,
    };
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
    await this.projectCommand(
      viewer,
      "task.state.refresh.participant",
      { requestedAt: Date.now() },
      () => this.refreshStates(viewer.eventId),
    );
    await this.airtable.assertReadable(viewer);
    return this.listParticipantTasksD1(viewer);
  }

  private async listParticipantTasksD1(viewer: Viewer) {
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

  private async participantTask(viewer: Viewer, taskId: string) {
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

  private async dependentRevisionSnapshot(taskId: string) {
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

  private async completeParticipantD1(
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

  private async undoCompletionD1(viewer: Viewer, rawToken: unknown) {
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

  private async completedFileEvidenceAsset(
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

  private exactFileEvidenceAlreadyAttached(
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

  private async attachCompletedFileEvidenceD1(
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

  private async addCommentD1(
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

  private async getAdminWorkspaceD1(viewer: Viewer) {
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
          LEFT JOIN memberships m ON m.person_id = p.id AND m.event_id = ? AND m.role = 'speaker' AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
          LEFT JOIN session_speakers ss ON ss.person_id = p.id AND ss.event_id = ?
         WHERE m.id IS NOT NULL OR ss.person_id IS NOT NULL ORDER BY p.display_name
      `,
      )
        .bind(viewer.eventId, viewer.eventId)
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

  private async administerTaskD1(viewer: Viewer, rawInput: unknown) {
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
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, ?, 'task_instance', ?, ?, ?, unixepoch()
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
