import { z } from "zod";

export const taskFormFieldSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    label: z.string().trim().min(1).max(120),
    type: z.enum(["short_text", "long_text", "date", "boolean", "select"]),
    required: z.boolean().default(false),
    help: z.string().trim().max(300).default(""),
    options: z.array(z.string().trim().min(1).max(100)).max(20).default([]),
    requiredWhen: z
      .object({
        fieldId: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
        equals: z.union([z.string().max(100), z.boolean()]),
      })
      .optional(),
  })
  .superRefine((field, context) => {
    if (field.type === "select" && field.options.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Select fields need at least one option.",
      });
    }
    if (new Set(field.options).size !== field.options.length) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Select options must be unique.",
      });
    }
  });

export const taskTemplatePresetSchema = z.enum([
  "speaker_travel_hotel_v1",
  "speaker_travel_flight_v1",
]);

export const taskTemplateConfigurationSchema = z.object({
  preset: taskTemplatePresetSchema.optional(),
  form: z
    .object({
      fields: z.array(taskFormFieldSchema).min(1).max(20),
    })
    .optional(),
});

export const taskEvidenceUrlSchema = z
  .string()
  .trim()
  .url()
  .max(1_000)
  .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
    message: "Evidence links must use HTTP or HTTPS.",
  });

export const taskTemplateInputSchema = z
  .object({
    name: z.string().trim().min(3).max(160),
    description: z.string().trim().max(1_000),
    targetType: z.enum(["speaker", "session", "event"]),
    taskType: z.enum([
      "checklist",
      "acknowledgement",
      "short_form",
      "file_upload",
      "link_visit",
      "administrator_only",
    ]),
    impact: z.enum(["critical", "high", "medium", "low"]),
    evidenceMode: z.enum([
      "none",
      "checkbox",
      "file",
      "text",
      "link",
      "admin_approval",
    ]),
    dueAnchor: z.enum(["none", "acceptance", "session_start", "fixed"]),
    dueOffsetDays: z.coerce.number().int().min(-365).max(365).nullable(),
    fixedDueDate: z.string().date().nullable(),
    autoAssignOnAcceptance: z.boolean(),
    dependencyIds: z.array(z.string().min(1)).max(30).default([]),
    configuration: taskTemplateConfigurationSchema.default({}),
  })
  .superRefine((input, context) => {
    if (input.configuration.form && input.taskType !== "short_form") {
      context.addIssue({
        code: "custom",
        path: ["configuration", "form"],
        message: "Structured forms are only supported by short-form tasks.",
      });
    }
    const fieldIds = input.configuration.form?.fields.map((field) => field.id);
    if (fieldIds && new Set(fieldIds).size !== fieldIds.length) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "form", "fields"],
        message: "Structured task-form field IDs must be unique.",
      });
    }
    input.configuration.form?.fields.forEach((field, index, fields) => {
      if (!field.requiredWhen) return;
      const dependencyIndex = fields.findIndex(
        (candidate) => candidate.id === field.requiredWhen?.fieldId,
      );
      const dependency = fields[dependencyIndex];
      if (dependencyIndex < 0 || dependencyIndex >= index || !dependency) {
        context.addIssue({
          code: "custom",
          path: ["configuration", "form", "fields", index, "requiredWhen"],
          message: "Conditional requirements must reference an earlier field.",
        });
      } else if (
        dependency.type !== "boolean" &&
        dependency.type !== "select"
      ) {
        context.addIssue({
          code: "custom",
          path: ["configuration", "form", "fields", index, "requiredWhen"],
          message:
            "Conditional requirements must reference a yes/no or select field.",
        });
      } else if (
        dependency.type === "boolean" &&
        typeof field.requiredWhen.equals !== "boolean"
      ) {
        context.addIssue({
          code: "custom",
          path: ["configuration", "form", "fields", index, "requiredWhen"],
          message: "Yes/no requirements must compare with true or false.",
        });
      } else if (
        dependency.type === "select" &&
        (typeof field.requiredWhen.equals !== "string" ||
          !dependency.options.includes(field.requiredWhen.equals))
      ) {
        context.addIssue({
          code: "custom",
          path: ["configuration", "form", "fields", index, "requiredWhen"],
          message: "Select requirements must compare with an available option.",
        });
      }
    });
    const compatibleEvidenceModes = {
      checklist: ["checkbox", "admin_approval"],
      acknowledgement: ["checkbox", "admin_approval"],
      short_form: ["text", "admin_approval"],
      file_upload: ["file"],
      link_visit: ["link", "admin_approval"],
      administrator_only: ["none"],
    } satisfies Record<
      typeof input.taskType,
      ReadonlyArray<typeof input.evidenceMode>
    >;
    const allowedEvidenceModes = compatibleEvidenceModes[
      input.taskType
    ] as ReadonlyArray<typeof input.evidenceMode>;
    if (!allowedEvidenceModes.includes(input.evidenceMode)) {
      context.addIssue({
        code: "custom",
        path: ["evidenceMode"],
        message: `The selected evidence mode is not supported for ${input.taskType.replaceAll("_", " ")} tasks.`,
      });
    }
    if (input.dueAnchor === "fixed" && !input.fixedDueDate) {
      context.addIssue({
        code: "custom",
        path: ["fixedDueDate"],
        message: "Choose a fixed due date.",
      });
    }
    if (
      ["acceptance", "session_start"].includes(input.dueAnchor) &&
      input.dueOffsetDays === null
    ) {
      context.addIssue({
        code: "custom",
        path: ["dueOffsetDays"],
        message: "Set the number of days relative to the anchor.",
      });
    }
    if (input.autoAssignOnAcceptance && input.dueAnchor === "session_start") {
      context.addIssue({
        code: "custom",
        path: ["dueAnchor"],
        message:
          "Automatic acceptance tasks cannot use session start because accepted sessions are initially unscheduled.",
      });
    }
  });

export const participantEvidenceSchema = z.object({
  taskId: z.string().min(1),
  revision: z.coerce.number().int().positive(),
  confirmed: z
    .union([
      z.literal("true"),
      z.literal("on"),
      z.literal("false"),
      z.boolean(),
    ])
    .optional(),
  text: z.string().trim().max(4_000).optional(),
  url: taskEvidenceUrlSchema.optional(),
  responses: z
    .record(z.string(), z.union([z.string().max(4_000), z.boolean()]))
    .default({}),
});

export type TaskTemplateInput = z.infer<typeof taskTemplateInputSchema>;
export type TaskFormField = z.infer<typeof taskFormFieldSchema>;
