import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  WebhookService,
  type PreparedWebhookEvent,
} from "~/platform/operations/webhook-service.server";
import {
  taskTemplateConfigurationSchema,
  taskTemplateInputSchema,
} from "./task-schema";
import {
  TRAVEL_ONBOARDING_TEMPLATE_INTENTS,
  TaskServiceFoundation,
  TaskStateError,
  type TemplateRow,
  fixedDateEndEpoch,
  taskTemplateIdForIntent,
} from "./task-service-foundation.server";

type TaskAssignmentSnapshot = {
  targetRevision: number;
  templateAssignments: Array<{ templateId: string; assigned: boolean }>;
  templates: TaskTemplateAssignmentSnapshot[];
};

type TaskTemplateAssignmentSnapshot = {
  id: string;
  name: string;
  description: string | null;
  targetType: TemplateRow["targetType"];
  taskType: TemplateRow["taskType"];
  impact: TemplateRow["impact"];
  evidenceMode: TemplateRow["evidenceMode"];
  dueAnchor: TemplateRow["dueAnchor"];
  dueOffsetMinutes: number | null;
  fixedDueAt: number | null;
  autoAssignOnAcceptance: number;
  configurationJson: string;
  updatedAt: number;
  dependencyIds: string[];
};

type PlannedTaskNode = {
  template: TemplateRow & { updatedAt: number };
  dependencyTemplateIds: string[];
  dueAt: number | null;
  existing: {
    id: string;
    title: string;
    status: string;
    lastOperationId: string | null;
  } | null;
  taskId: string;
  operationId: string;
  auditEventId: string;
};

function assignmentTemplateSnapshot(
  template: TemplateRow & { updatedAt: number },
  dependencyIds: string[] = [],
): TaskTemplateAssignmentSnapshot {
  return {
    id: template.id,
    name: template.name,
    description: template.description,
    targetType: template.targetType,
    taskType: template.taskType,
    impact: template.impact,
    evidenceMode: template.evidenceMode,
    dueAnchor: template.dueAnchor,
    dueOffsetMinutes: template.dueOffsetMinutes,
    fixedDueAt: template.fixedDueAt,
    autoAssignOnAcceptance: Number(template.autoAssignOnAcceptance),
    configurationJson: template.configurationJson,
    updatedAt: template.updatedAt,
    dependencyIds: [...dependencyIds].sort(),
  };
}

function requirePreparedTaskWebhook(
  preparedWebhooks: ReadonlyMap<string, PreparedWebhookEvent>,
  templateId: string,
): PreparedWebhookEvent {
  const prepared = preparedWebhooks.get(templateId);
  if (!prepared) {
    throw new Error(
      `Task assignment invariant failed: webhook preparation is missing for template ${templateId}.`,
    );
  }
  return prepared;
}

const matchingActiveTaskDefinitionSql = `
  duplicate.template_id <> ?
  AND duplicate.status NOT IN ('completed','waived')
  AND lower(trim(duplicate.title)) = lower(trim(?))
  AND duplicate.description IS ?
  AND duplicate.task_type = ?
  AND duplicate.impact = ?
  AND duplicate.due_at IS ?
  AND duplicate_template.evidence_mode = ?
  AND duplicate_template.configuration_json = ?
`;

function matchingActiveTaskDefinitionBindings(
  template: TemplateRow,
  dueAt: number | null,
) {
  return [
    template.id,
    template.name,
    template.description,
    template.taskType,
    template.impact,
    dueAt,
    template.evidenceMode,
    template.configurationJson,
  ];
}

async function dependencyAssignmentOperationId(
  intentId: string,
  templateId: string,
) {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${intentId.length}:${intentId}:${templateId}`),
    ),
  );
  const boundedHash = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 40);
  return `dep:${boundedHash}`;
}

export class TaskTemplateWorkflows extends TaskServiceFoundation {
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

  protected async createTemplateWithResult(
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

  protected async createTemplateD1(
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

  protected async getTemplate(eventId: string, templateId: string) {
    return this.env.DB.prepare(
      `
      SELECT id, name, description, target_type AS targetType, task_type AS taskType, impact,
             evidence_mode AS evidenceMode, due_anchor AS dueAnchor, due_offset_minutes AS dueOffsetMinutes,
             fixed_due_at AS fixedDueAt, auto_assign_on_acceptance AS autoAssignOnAcceptance,
             configuration_json AS configurationJson, status,
             updated_at AS updatedAt
        FROM task_templates WHERE id = ? AND event_id = ?
    `,
    )
      .bind(templateId, eventId)
      .first<TemplateRow & { updatedAt: number }>();
  }

  protected async dueAtFor(
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

  protected async assertTaskTarget(
    eventId: string,
    targetType: TemplateRow["targetType"],
    targetId: string,
    expectedTargetRevision?: number,
  ) {
    if (targetType === "event") {
      if (targetId !== eventId)
        throw new TaskStateError("The selected event target is unavailable.");
      return null;
    }
    const target =
      targetType === "speaker"
        ? await this.env.DB.prepare(
            `
            SELECT revision FROM event_speaker_workflows
             WHERE event_id = ? AND person_id = ?
               AND status IN ('prospect','invited','confirmed')
          `,
          )
            .bind(eventId, targetId)
            .first<{ revision: number }>()
        : await this.env.DB.prepare(
            `SELECT 1 FROM sessions
              WHERE event_id = ? AND id = ? AND status NOT IN ('cancelled','archived')`,
          )
            .bind(eventId, targetId)
            .first();
    if (!target) {
      throw new TaskStateError(
        targetType === "speaker"
          ? "The selected person is not an active speaker in this event."
          : "The selected session is unavailable in this event.",
      );
    }
    if (
      targetType === "speaker" &&
      expectedTargetRevision !== undefined &&
      target.revision !== expectedTargetRevision
    ) {
      throw new TaskStateError(
        "The selected speaker changed after the task assignment was previewed.",
      );
    }
    return targetType === "speaker"
      ? (target as { revision: number }).revision
      : null;
  }

  private assignmentTargetGuard(
    viewer: Viewer,
    targetType: TemplateRow["targetType"],
    targetId: string,
    expectedTargetRevision?: number,
  ) {
    if (targetType === "speaker") {
      return {
        sql: `EXISTS (
          SELECT 1 FROM event_speaker_workflows workflow
           WHERE workflow.event_id = ? AND workflow.person_id = ?
             AND workflow.status IN ('prospect','invited','confirmed')
             AND (? IS NULL OR workflow.revision = ?)
        )`,
        bindings: [
          viewer.eventId,
          targetId,
          expectedTargetRevision ?? null,
          expectedTargetRevision ?? null,
        ],
      };
    }
    if (targetType === "session") {
      return {
        sql: `EXISTS (
          SELECT 1 FROM sessions session
           WHERE session.event_id = ? AND session.id = ?
             AND session.status NOT IN ('cancelled','archived')
        )`,
        bindings: [viewer.eventId, targetId],
      };
    }
    return {
      sql: `? = ?`,
      bindings: [targetId, viewer.eventId],
    };
  }

  private async planTemplateAssignment(
    viewer: Viewer,
    rootTemplateId: string,
    targetId: string,
    assignmentIntentId?: string,
  ) {
    const planned = new Map<string, PlannedTaskNode>();
    const ordered: PlannedTaskNode[] = [];
    const visiting = new Set<string>();
    let rootTargetType: TemplateRow["targetType"] | null = null;

    const visit = async (templateId: string): Promise<void> => {
      if (visiting.has(templateId)) {
        throw new TaskStateError("Task template dependencies contain a cycle.");
      }
      if (planned.has(templateId)) return;
      visiting.add(templateId);
      const template = await this.getTemplate(viewer.eventId, templateId);
      if (!template || template.status !== "active") {
        throw new TaskStateError("Task template not found or archived.");
      }
      rootTargetType ??= template.targetType;
      if (template.targetType !== rootTargetType) {
        throw new TaskStateError(
          "Prerequisite templates must use the same task scope.",
        );
      }
      const [existing, dependencyRows] = await Promise.all([
        this.env.DB.prepare(
          `SELECT id, title, status, last_operation_id AS lastOperationId
             FROM task_instances
            WHERE event_id = ? AND template_id = ?
              AND target_type = ? AND target_id = ?
            LIMIT 1`,
        )
          .bind(viewer.eventId, templateId, template.targetType, targetId)
          .first<NonNullable<PlannedTaskNode["existing"]>>(),
        this.env.DB.prepare(
          `SELECT depends_on_template_id AS id
             FROM task_template_dependencies
            WHERE template_id = ?
            ORDER BY depends_on_template_id`,
        )
          .bind(templateId)
          .all<{ id: string }>(),
      ]);
      const dueAt = existing
        ? null
        : await this.dueAtFor(template, viewer.eventId, targetId);
      if (!existing && template.dueAnchor !== "none" && dueAt === null) {
        throw new TaskStateError(
          `The ${template.dueAnchor.replace("_", " ")} due anchor cannot be resolved for this ${template.targetType}.`,
        );
      }
      if (!existing) {
        const matchingTask = await this.env.DB.prepare(
          `SELECT duplicate.id
             FROM task_instances duplicate
             JOIN task_templates duplicate_template
               ON duplicate_template.id = duplicate.template_id
              AND duplicate_template.event_id = duplicate.event_id
            WHERE duplicate.event_id = ?
              AND duplicate.target_type = ? AND duplicate.target_id = ?
              AND ${matchingActiveTaskDefinitionSql}
            LIMIT 1`,
        )
          .bind(
            viewer.eventId,
            template.targetType,
            targetId,
            ...matchingActiveTaskDefinitionBindings(template, dueAt),
          )
          .first<{ id: string }>();
        if (matchingTask) {
          throw new TaskStateError(
            `“${template.name}” with the same instructions, type, evidence, impact and due date is already assigned to this ${template.targetType}. Use the existing task instead of creating a duplicate.`,
          );
        }
      }
      for (const dependency of dependencyRows.results) {
        await visit(dependency.id);
      }
      const operationId = assignmentIntentId
        ? templateId === rootTemplateId
          ? assignmentIntentId
          : await dependencyAssignmentOperationId(
              assignmentIntentId,
              templateId,
            )
        : crypto.randomUUID();
      const node: PlannedTaskNode = {
        template,
        dependencyTemplateIds: dependencyRows.results.map((row) => row.id),
        dueAt,
        existing: existing ?? null,
        taskId:
          existing?.id ??
          (assignmentIntentId ? `task:${operationId}` : crypto.randomUUID()),
        operationId,
        auditEventId: assignmentIntentId
          ? `audit:task-assigned:${operationId}`
          : crypto.randomUUID(),
      };
      planned.set(templateId, node);
      ordered.push(node);
      visiting.delete(templateId);
    };

    await visit(rootTemplateId);
    return { ordered, root: planned.get(rootTemplateId)! };
  }

  private async returnExistingAssignment(
    viewer: Viewer,
    node: PlannedTaskNode,
    targetId: string,
    assignmentIntentId: string | undefined,
    webhookWarnings: string[],
  ) {
    if (!node.existing) {
      throw new Error("An existing task assignment was required.");
    }
    if (
      assignmentIntentId === undefined ||
      node.existing.lastOperationId !== node.operationId
    ) {
      return node.existing.id;
    }

    const deliveries = await new WebhookService(
      this.env,
    ).resumePreparedEventForAudit(
      viewer,
      {
        eventType: "task.created",
        entityType: "task",
        entityId: node.existing.id,
        idempotencyKey: `task.created:${node.existing.id}:${node.operationId}`,
        correlationId: node.operationId,
        data: {
          title: node.existing.title,
          status: node.dependencyTemplateIds.length ? "blocked" : "not_started",
          targetType: node.template.targetType,
          targetId,
          templateId: node.template.id,
        },
      },
      node.auditEventId,
    );
    if (deliveries.some((delivery) => delivery.status === "queue_failed")) {
      webhookWarnings.push(
        "The task change was saved, but one or more outbound webhooks need a queue retry.",
      );
    }
    return node.existing.id;
  }

  protected async materializeTemplate(
    viewer: Viewer,
    templateId: string,
    targetId: string,
    webhookWarnings: string[] = [],
    assignmentIntentId?: string,
    expectedSnapshot?: TaskAssignmentSnapshot,
    expectedTargetRevision?: number,
  ): Promise<string> {
    const { ordered, root } = await this.planTemplateAssignment(
      viewer,
      templateId,
      targetId,
      assignmentIntentId,
    );
    if (expectedSnapshot) {
      const expected = new Map(
        expectedSnapshot.templateAssignments.map((assignment) => [
          assignment.templateId,
          assignment.assigned,
        ]),
      );
      if (
        expected.size !== expectedSnapshot.templateAssignments.length ||
        expected.size !== ordered.length ||
        ordered.some(
          (node) => expected.get(node.template.id) !== Boolean(node.existing),
        )
      ) {
        throw new TaskStateError(
          "The task plan assignments changed after the bulk preview.",
        );
      }
      const currentTemplates = ordered
        .map((node) =>
          assignmentTemplateSnapshot(node.template, node.dependencyTemplateIds),
        )
        .sort((left, right) => left.id.localeCompare(right.id));
      const expectedTemplates = [...expectedSnapshot.templates].sort(
        (left, right) => left.id.localeCompare(right.id),
      );
      if (
        JSON.stringify(currentTemplates) !== JSON.stringify(expectedTemplates)
      ) {
        throw new TaskStateError(
          "The task templates changed after the bulk preview.",
        );
      }
    }
    if (root.existing) {
      if (expectedSnapshot) {
        return root.existing.id;
      }
      return this.returnExistingAssignment(
        viewer,
        root,
        targetId,
        assignmentIntentId,
        webhookWarnings,
      );
    }

    await this.requireTaskWebhookReadiness(viewer, "task.created");
    const targetGuard = this.assignmentTargetGuard(
      viewer,
      root.template.targetType,
      targetId,
      expectedSnapshot?.targetRevision ?? expectedTargetRevision,
    );
    const missing = ordered.filter((node) => !node.existing);
    const webhookService = new WebhookService(this.env);
    const webhookInput = (node: PlannedTaskNode) => ({
      eventType: "task.created" as const,
      entityType: "task" as const,
      entityId: node.taskId,
      idempotencyKey: `task.created:${node.taskId}:${node.operationId}`,
      correlationId: node.operationId,
      data: {
        title: node.template.name,
        status: node.dependencyTemplateIds.length ? "blocked" : "not_started",
        targetType: node.template.targetType,
        targetId,
        templateId: node.template.id,
      },
    });
    const preparedWebhooks = new Map<string, PreparedWebhookEvent>();
    for (const node of missing) {
      preparedWebhooks.set(
        node.template.id,
        await webhookService.prepareEventForAudit(
          viewer,
          webhookInput(node),
          node.auditEventId,
        ),
      );
    }

    const statements: D1PreparedStatement[] = [];
    for (const node of missing) {
      const blocked = node.dependencyTemplateIds.length > 0;
      statements.push(
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO task_instances (
             id, event_id, template_id, target_type, target_id,
             owner_person_id, title, description, task_type, impact,
             status, readiness_state, readiness_percent, revision,
             last_operation_id, due_at, created_at, updated_at
           )
           SELECT ?, ?, current_template.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 1,
                  ?, ?, unixepoch(), unixepoch()
             FROM task_templates current_template
            WHERE current_template.id = ? AND current_template.event_id = ?
              AND current_template.status = 'active'
              AND current_template.target_type = ?
              AND ${targetGuard.sql}
              AND NOT EXISTS (
                SELECT 1 FROM task_instances duplicate
                JOIN task_templates duplicate_template
                  ON duplicate_template.id = duplicate.template_id
                 AND duplicate_template.event_id = duplicate.event_id
                WHERE duplicate.event_id = ?
                   AND duplicate.target_type = ?
                   AND duplicate.target_id = ?
                   AND ${matchingActiveTaskDefinitionSql}
              )`,
        ).bind(
          node.taskId,
          viewer.eventId,
          node.template.targetType,
          targetId,
          node.template.targetType === "speaker" ? targetId : null,
          node.template.name,
          node.template.description,
          node.template.taskType,
          node.template.impact,
          blocked ? "blocked" : "not_started",
          blocked ? "blocked" : "on_track",
          node.operationId,
          node.dueAt,
          node.template.id,
          viewer.eventId,
          node.template.targetType,
          ...targetGuard.bindings,
          viewer.eventId,
          node.template.targetType,
          targetId,
          ...matchingActiveTaskDefinitionBindings(node.template, node.dueAt),
        ),
      );
    }
    const edges = ordered.flatMap((node) =>
      node.dependencyTemplateIds.map((dependencyTemplateId) => ({
        templateId: node.template.id,
        dependencyTemplateId,
      })),
    );
    for (const edge of edges) {
      statements.push(
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO task_instance_dependencies (
             task_id, depends_on_task_id, created_at
           )
           SELECT task.id, prerequisite.id, unixepoch()
             FROM task_instances task
             JOIN task_instances prerequisite
               ON prerequisite.event_id = task.event_id
              AND prerequisite.target_type = task.target_type
              AND prerequisite.target_id = task.target_id
            WHERE task.event_id = ? AND task.template_id = ?
              AND task.target_type = ? AND task.target_id = ?
              AND prerequisite.template_id = ?`,
        ).bind(
          viewer.eventId,
          edge.templateId,
          root.template.targetType,
          targetId,
          edge.dependencyTemplateId,
        ),
      );
    }

    for (const node of missing.filter((candidate) => candidate !== root)) {
      statements.push(
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           )
           SELECT ?, ?, ?, ?, 'task.assigned', 'task_instance', ?, ?, ?, unixepoch()
             FROM task_instances task
            WHERE task.id = ? AND task.event_id = ?
              AND task.last_operation_id = ?`,
        ).bind(
          node.auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          node.taskId,
          node.operationId,
          JSON.stringify({
            templateId: node.template.id,
            targetType: node.template.targetType,
            targetId,
          }),
          node.taskId,
          viewer.eventId,
          node.operationId,
        ),
        ...requirePreparedTaskWebhook(preparedWebhooks, node.template.id)
          .statements,
      );
    }

    const requiredNodes = ordered.map((node) => ({
      templateId: node.template.id,
      existedAtPlan: Boolean(node.existing),
      operationId: node.operationId,
      template: assignmentTemplateSnapshot(
        node.template,
        node.dependencyTemplateIds,
      ),
    }));
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) VALUES (
           ?, ?, ?, ?,
           CASE WHEN
             ${targetGuard.sql}
             AND EXISTS (
               SELECT 1 FROM task_instances task
                WHERE task.id = ? AND task.event_id = ?
                  AND task.last_operation_id = ?
             )
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?) required
                WHERE NOT EXISTS (
                  SELECT 1 FROM task_instances task
                  JOIN task_templates template
                    ON template.id = task.template_id
                   AND template.event_id = task.event_id
                   AND template.status = 'active'
                   AND template.target_type = task.target_type
                   WHERE task.event_id = ? AND task.target_type = ?
                     AND task.target_id = ?
                     AND task.template_id = json_extract(required.value, '$.templateId')
                     AND template.updated_at = json_extract(required.value, '$.template.updatedAt')
                     AND template.name IS json_extract(required.value, '$.template.name')
                     AND template.description IS json_extract(required.value, '$.template.description')
                     AND template.task_type IS json_extract(required.value, '$.template.taskType')
                     AND template.impact IS json_extract(required.value, '$.template.impact')
                     AND template.evidence_mode IS json_extract(required.value, '$.template.evidenceMode')
                     AND template.due_anchor IS json_extract(required.value, '$.template.dueAnchor')
                     AND template.due_offset_minutes IS json_extract(required.value, '$.template.dueOffsetMinutes')
                     AND template.fixed_due_at IS json_extract(required.value, '$.template.fixedDueAt')
                     AND template.auto_assign_on_acceptance IS json_extract(required.value, '$.template.autoAssignOnAcceptance')
                     AND template.configuration_json IS json_extract(required.value, '$.template.configurationJson')
                     AND (
                       json_extract(required.value, '$.existedAtPlan') = 1
                       OR task.last_operation_id = json_extract(required.value, '$.operationId')
                     )
                )
             )
             AND NOT EXISTS (
               SELECT 1 FROM json_each(?) required_edge
                WHERE NOT EXISTS (
                  SELECT 1 FROM task_instance_dependencies dependency
                  JOIN task_instances task ON task.id = dependency.task_id
                  JOIN task_instances prerequisite
                    ON prerequisite.id = dependency.depends_on_task_id
                   WHERE task.event_id = ? AND task.target_type = ?
                     AND task.target_id = ?
                     AND task.template_id = json_extract(required_edge.value, '$.templateId')
                     AND prerequisite.event_id = task.event_id
                     AND prerequisite.target_type = task.target_type
                     AND prerequisite.target_id = task.target_id
                     AND prerequisite.template_id = json_extract(required_edge.value, '$.dependencyTemplateId')
                )
             )
             AND (
               SELECT COUNT(*) FROM task_template_dependencies dependency
                WHERE dependency.template_id IN (
                  SELECT json_extract(required.value, '$.templateId')
                    FROM json_each(?) required
                )
             ) = ?
             AND NOT EXISTS (
               SELECT 1 FROM task_template_dependencies dependency
                WHERE dependency.template_id IN (
                  SELECT json_extract(required.value, '$.templateId')
                    FROM json_each(?) required
                )
                  AND NOT EXISTS (
                    SELECT 1 FROM json_each(?) required_edge
                     WHERE json_extract(required_edge.value, '$.templateId') =
                           dependency.template_id
                       AND json_extract(required_edge.value, '$.dependencyTemplateId') =
                           dependency.depends_on_template_id
                  )
             )
           THEN 'task.assigned' ELSE NULL END,
           'task_instance', ?, ?, ?, unixepoch()
         )`,
      ).bind(
        root.auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        ...targetGuard.bindings,
        root.taskId,
        viewer.eventId,
        root.operationId,
        JSON.stringify(requiredNodes),
        viewer.eventId,
        root.template.targetType,
        targetId,
        JSON.stringify(edges),
        viewer.eventId,
        root.template.targetType,
        targetId,
        JSON.stringify(requiredNodes),
        edges.length,
        JSON.stringify(requiredNodes),
        JSON.stringify(edges),
        root.taskId,
        root.operationId,
        JSON.stringify({
          templateId: root.template.id,
          targetType: root.template.targetType,
          targetId,
        }),
      ),
      ...requirePreparedTaskWebhook(preparedWebhooks, root.template.id)
        .statements,
    );

    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const staleOrLoserSentinel = message.includes("audit_events.action");
      const exactIntentCollision = message.includes("audit_events.id");
      if (!staleOrLoserSentinel && !exactIntentCollision) throw error;
      for (const node of missing) {
        const duplicate = await this.env.DB.prepare(
          `SELECT duplicate.id
             FROM task_instances duplicate
             JOIN task_templates duplicate_template
               ON duplicate_template.id = duplicate.template_id
              AND duplicate_template.event_id = duplicate.event_id
            WHERE duplicate.event_id = ?
              AND duplicate.target_type = ? AND duplicate.target_id = ?
              AND ${matchingActiveTaskDefinitionSql}
            LIMIT 1`,
        )
          .bind(
            viewer.eventId,
            node.template.targetType,
            targetId,
            ...matchingActiveTaskDefinitionBindings(node.template, node.dueAt),
          )
          .first<{ id: string }>();
        if (duplicate) {
          throw new TaskStateError(
            `“${node.template.name}” with the same instructions, type, evidence, impact and due date was assigned concurrently. Use the existing task instead of creating a duplicate.`,
          );
        }
      }
      const winner = await this.env.DB.prepare(
        `SELECT id, title, status, last_operation_id AS lastOperationId
           FROM task_instances
          WHERE event_id = ? AND template_id = ?
            AND target_type = ? AND target_id = ?
          LIMIT 1`,
      )
        .bind(
          viewer.eventId,
          root.template.id,
          root.template.targetType,
          targetId,
        )
        .first<NonNullable<PlannedTaskNode["existing"]>>();
      if (winner && !expectedSnapshot) {
        await this.assertTaskTarget(
          viewer.eventId,
          root.template.targetType,
          targetId,
          expectedTargetRevision,
        );
        root.existing = winner;
        return this.returnExistingAssignment(
          viewer,
          root,
          targetId,
          assignmentIntentId,
          webhookWarnings,
        );
      }
      if (staleOrLoserSentinel) {
        throw new TaskStateError(
          "The task assignment changed before it could be created.",
        );
      }
      throw error;
    }

    for (const node of missing) {
      const deliveries = await webhookService.resumePreparedEventForAudit(
        viewer,
        webhookInput(node),
        node.auditEventId,
      );
      if (deliveries.some((delivery) => delivery.status === "queue_failed")) {
        webhookWarnings.push(
          "The task change was saved, but one or more outbound webhooks need a queue retry.",
        );
      }
    }
    return root.taskId;
  }

  async assignTemplate(
    viewer: Viewer,
    templateId: string,
    targetId: string,
    intentId?: string,
    expectedSnapshot?: TaskAssignmentSnapshot,
  ) {
    const execute = () =>
      this.assignTemplateD1(
        viewer,
        templateId,
        targetId,
        intentId,
        expectedSnapshot,
      );
    return intentId
      ? this.projectIntentCommand(
          viewer,
          "task.template.assign",
          intentId,
          { templateId, targetId, expectedSnapshot },
          execute,
        )
      : this.projectCommand(
          viewer,
          "task.template.assign",
          { templateId, targetId, expectedSnapshot },
          execute,
        );
  }

  protected async assignTemplateD1(
    viewer: Viewer,
    templateId: string,
    targetId: string,
    intentId?: string,
    expectedSnapshot?: TaskAssignmentSnapshot,
  ) {
    await this.assertEvent(viewer);
    const parsedTemplateId = z.string().min(1).parse(templateId);
    const parsedTargetId = z.string().min(1).parse(targetId);
    const template = await this.getTemplate(viewer.eventId, parsedTemplateId);
    if (!template || template.status !== "active")
      throw new TaskStateError("Task template not found or archived.");
    const targetRevision = await this.assertTaskTarget(
      viewer.eventId,
      template.targetType,
      parsedTargetId,
      expectedSnapshot?.targetRevision,
    );
    const webhookWarnings: string[] = [];
    const taskId = await this.materializeTemplate(
      viewer,
      parsedTemplateId,
      parsedTargetId,
      webhookWarnings,
      intentId,
      expectedSnapshot,
      targetRevision ?? undefined,
    );
    return {
      taskId,
      webhookWarning: [...new Set(webhookWarnings)].join(" ") || null,
    };
  }
}
