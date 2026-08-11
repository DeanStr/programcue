import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
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

export abstract class TaskTemplateWorkflows extends TaskServiceFoundation {
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
             configuration_json AS configurationJson, status
        FROM task_templates WHERE id = ? AND event_id = ?
    `,
    )
      .bind(templateId, eventId)
      .first<TemplateRow>();
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

  protected async recordAssignmentAudit(
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

  protected async materializeTemplate(
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

  protected async assignTemplateD1(
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

  protected taskAccessClause() {
    return `(
      ti.owner_person_id = ?
      OR (ti.target_type = 'speaker' AND ti.target_id = ?)
      OR (ti.target_type = 'session' AND EXISTS (
        SELECT 1 FROM session_speakers ss
         WHERE ss.event_id = ti.event_id AND ss.session_id = ti.target_id AND ss.person_id = ?
      ))
    )`;
  }
}
