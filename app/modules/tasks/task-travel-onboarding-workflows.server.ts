import { requireValue } from "~/lib/required-value";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  taskTemplateConfigurationSchema,
  taskTemplateInputSchema,
} from "./task-schema";
import {
  TaskStateError,
  type TemplateRow,
  TRAVEL_ONBOARDING_TEMPLATE_INTENTS,
  taskConfiguration,
} from "./task-service-foundation.server";
import { TaskTemplateWorkflows } from "./task-template-workflows.server";

const travelOnboardingCommon = {
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

const travelOnboardingPresets = [
  {
    preset: "speaker_travel_hotel_v1" as const,
    intent: TRAVEL_ONBOARDING_TEMPLATE_INTENTS.hotel,
    input: {
      ...travelOnboardingCommon,
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
      ...travelOnboardingCommon,
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

function storedTravelOnboardingInput(template: TemplateRow) {
  return taskTemplateInputSchema.parse({
    name: template.name,
    description: template.description ?? "",
    targetType: template.targetType,
    taskType: template.taskType,
    impact: template.impact,
    evidenceMode: template.evidenceMode,
    dueAnchor: template.dueAnchor,
    dueOffsetDays:
      template.dueOffsetMinutes === null
        ? null
        : template.dueOffsetMinutes / 1_440,
    fixedDueDate: null,
    autoAssignOnAcceptance: Boolean(template.autoAssignOnAcceptance),
    dependencyIds: [],
    configuration: JSON.parse(template.configurationJson),
  });
}

export function travelOnboardingTemplatesAreReady(
  templates: ReadonlyArray<TemplateRow & { dependencies: readonly string[] }>,
) {
  try {
    return travelOnboardingPresets.every((preset) => {
      const matches = templates.filter(
        (template) =>
          taskConfiguration(template.configurationJson).preset ===
          preset.preset,
      );
      if (matches.length !== 1) return false;
      const template = matches[0];
      const stored = JSON.stringify(storedTravelOnboardingInput(template));
      const expected = JSON.stringify(
        taskTemplateInputSchema.parse(preset.input),
      );
      return (
        template.status === "active" &&
        template.dependencies.length === 0 &&
        stored === expected
      );
    });
  } catch {
    return false;
  }
}

export class TaskTravelOnboardingWorkflows extends TaskTemplateWorkflows {
  async createTravelOnboardingTemplates(viewer: Viewer, confirmed: unknown) {
    if (confirmed !== true) {
      throw new TaskStateError(
        "Review and confirm the two automatically assigned travel onboarding forms before creating them.",
      );
    }
    const presets = travelOnboardingPresets;
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
      let storedInput: ReturnType<typeof taskTemplateInputSchema.parse>;
      try {
        storedInput = storedTravelOnboardingInput(existing);
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
    const hotel = requireValue(
      resolved.get("speaker_travel_hotel_v1"),
      'Required resolved.get("speaker_travel_hotel_v1") is unavailable.',
    );
    const flight = requireValue(
      resolved.get("speaker_travel_flight_v1"),
      'Required resolved.get("speaker_travel_flight_v1") is unavailable.',
    );
    return {
      hotelTemplateId: hotel.id,
      flightTemplateId: flight.id,
      createdTemplateIds: [hotel, flight]
        .filter((template) => template.created)
        .map((template) => template.id),
    };
  }
}
