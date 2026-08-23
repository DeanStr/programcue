import { z } from "zod";

import { isCredentialFreeHttpsUrl } from "~/modules/events/https-url";

export const taskCompatibleEvidenceModes = {
  checklist: ["checkbox", "admin_approval"],
  acknowledgement: ["checkbox", "admin_approval"],
  short_form: ["text", "admin_approval"],
  file_upload: ["file"],
  link_visit: ["link", "admin_approval"],
  administrator_only: ["none"],
} as const;

export type TaskType = keyof typeof taskCompatibleEvidenceModes;
export type TaskEvidenceMode =
  (typeof taskCompatibleEvidenceModes)[TaskType][number];

export function suggestedTaskEvidenceMode(taskType: TaskType) {
  return taskCompatibleEvidenceModes[taskType][0];
}

export const taskFormFieldSchema = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
    label: z.string().trim().min(1).max(120),
    type: z.enum(["short_text", "long_text", "date", "boolean", "select"]),
    required: z.boolean().default(false),
    help: z.string().trim().max(300).default(""),
    options: z
      .array(z.string().trim().min(1).max(100))
      .max(20, "Select fields support at most 20 options.")
      .default([]),
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

export const taskFormFieldsJsonSchema = z
  .string()
  .transform((value, context) => {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      context.addIssue({
        code: "custom",
        message: "Structured task-form fields could not be read.",
      });
      return z.NEVER;
    }
  })
  .pipe(z.array(taskFormFieldSchema).min(1).max(20));

export const taskTemplatePresetSchema = z.enum([
  "speaker_travel_hotel_v1",
  "speaker_travel_flight_v1",
  "session_details_review_v1",
]);

export const taskDestinationUrlSchema = z
  .string()
  .trim()
  .url("Enter a valid destination URL.")
  .max(2_048, "Destination URLs must contain at most 2,048 characters.")
  .refine(isCredentialFreeHttpsUrl, {
    message: "Destination URLs must use HTTPS without embedded credentials.",
  });

export const taskFileScopeSchema = z.enum([
  "participant_document",
  "session_deliverable",
]);
export const taskFileKindSchema = z.enum([
  "slides",
  "video",
  "supporting_document",
]);

export const taskTemplateConfigurationSchema = z
  .object({
    preset: taskTemplatePresetSchema.optional(),
    form: z
      .object({
        fields: z.array(taskFormFieldSchema).min(1).max(20),
      })
      .optional(),
    destinationUrl: taskDestinationUrlSchema.optional(),
    fileScope: taskFileScopeSchema.optional(),
    fileKind: taskFileKindSchema.optional(),
  })
  .strict();

export const assignedTaskConfigurationSchema =
  taskTemplateConfigurationSchema.extend({
    resourcePageId: z.string().trim().min(1).max(160).optional(),
  });

const taskTargetTypeSchema = z.enum(["speaker", "session", "event"]);
const taskTypeSchema = z.enum([
  "checklist",
  "acknowledgement",
  "short_form",
  "file_upload",
  "link_visit",
  "administrator_only",
]);
const taskImpactSchema = z.enum(["critical", "high", "medium", "low"]);
const taskEvidenceModeSchema = z.enum([
  "none",
  "checkbox",
  "file",
  "text",
  "link",
  "admin_approval",
]);
const taskDueAnchorSchema = z.enum([
  "none",
  "acceptance",
  "session_start",
  "fixed",
]);

export const taskTemplateInputSchema = z
  .object({
    name: z.string().trim().min(3).max(160),
    description: z.string().trim().max(1_000),
    targetType: taskTargetTypeSchema,
    taskType: taskTypeSchema,
    impact: taskImpactSchema,
    evidenceMode: taskEvidenceModeSchema,
    dueAnchor: taskDueAnchorSchema,
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
    if (
      input.taskType === "link_visit" &&
      !input.configuration.destinationUrl
    ) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "destinationUrl"],
        message: "Link-visit tasks require an HTTPS destination URL.",
      });
    }
    if (input.taskType !== "link_visit" && input.configuration.destinationUrl) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "destinationUrl"],
        message: "Destination URLs are only supported by link-visit tasks.",
      });
    }
    if (input.taskType === "file_upload" && !input.configuration.fileScope) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "fileScope"],
        message:
          "File-upload tasks must identify a participant document or session deliverable.",
      });
    }
    if (input.taskType === "file_upload" && !input.configuration.fileKind) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "fileKind"],
        message: "File-upload tasks must identify the accepted file type.",
      });
    }
    if (input.taskType !== "file_upload" && input.configuration.fileScope) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "fileScope"],
        message: "File scope is only supported by file-upload tasks.",
      });
    }
    if (input.taskType !== "file_upload" && input.configuration.fileKind) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "fileKind"],
        message: "File type is only supported by file-upload tasks.",
      });
    }
    if (
      input.configuration.fileScope === "participant_document" &&
      input.configuration.fileKind &&
      input.configuration.fileKind !== "supporting_document"
    ) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "fileKind"],
        message:
          "Participant documents must use the supporting-document policy.",
      });
    }
    if (
      input.configuration.fileScope === "participant_document" &&
      input.targetType !== "speaker"
    ) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "fileScope"],
        message: "Participant documents must use speaker scope.",
      });
    }
    if (
      input.configuration.fileScope === "session_deliverable" &&
      input.targetType !== "session"
    ) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "fileScope"],
        message: "Session deliverables must use session scope.",
      });
    }
    if (
      input.configuration.preset === "session_details_review_v1" &&
      (input.targetType !== "session" ||
        input.taskType !== "acknowledgement" ||
        input.impact !== "high" ||
        input.evidenceMode !== "checkbox" ||
        input.dueAnchor !== "none" ||
        input.dueOffsetDays !== null ||
        input.fixedDueDate !== null ||
        !input.autoAssignOnAcceptance ||
        input.dependencyIds.length !== 0 ||
        input.configuration.form !== undefined ||
        input.configuration.destinationUrl !== undefined ||
        input.configuration.fileScope !== undefined ||
        input.configuration.fileKind !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "preset"],
        message:
          "The session-details review preset must use the fixed high-impact, automatically assigned session acknowledgement without a due date or prerequisites.",
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
    const allowedEvidenceModes = taskCompatibleEvidenceModes[
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
    .transform((value) => value === true || value === "true" || value === "on")
    .optional(),
  text: z.string().trim().max(4_000).optional(),
  responses: z
    .record(z.string(), z.union([z.string().max(4_000), z.boolean()]))
    .default({}),
  sessionDetailsFingerprint: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  sessionDetailsRevision: z.coerce.number().int().positive().optional(),
});

export type TaskTemplateInput = z.infer<typeof taskTemplateInputSchema>;
export type TaskFormField = z.infer<typeof taskFormFieldSchema>;

export type TaskTemplateDraftValues = {
  name: string;
  description: string;
  targetType: TaskTemplateInput["targetType"];
  taskType: TaskTemplateInput["taskType"];
  impact: TaskTemplateInput["impact"];
  evidenceMode: TaskTemplateInput["evidenceMode"];
  dueAnchor: TaskTemplateInput["dueAnchor"];
  dueOffsetDays: string;
  fixedDueDate: string;
  destinationUrl: string;
  fileScope: "" | z.infer<typeof taskFileScopeSchema>;
  fileKind: "" | z.infer<typeof taskFileKindSchema>;
  formFields: TaskFormField[];
  autoAssignOnAcceptance: boolean;
  dependencyIds: string[];
};

const taskTemplateDraftSchema = z.object({
  name: z.string().catch(""),
  description: z.string().catch(""),
  targetType: taskTargetTypeSchema.catch("speaker"),
  taskType: taskTypeSchema.catch("checklist"),
  impact: taskImpactSchema.catch("medium"),
  evidenceMode: taskEvidenceModeSchema.catch("checkbox"),
  dueAnchor: taskDueAnchorSchema.catch("none"),
  dueOffsetDays: z.string().catch(""),
  fixedDueDate: z.string().catch(""),
  destinationUrl: z.string().catch(""),
  fileScope: z.union([z.literal(""), taskFileScopeSchema]).catch(""),
  fileKind: z.union([z.literal(""), taskFileKindSchema]).catch(""),
  formFields: z.array(taskFormFieldSchema).catch([]),
  autoAssignOnAcceptance: z.boolean().catch(false),
  dependencyIds: z.array(z.string()).catch([]),
});

export function normalizeTaskTemplateDraft(
  input: unknown = {},
): TaskTemplateDraftValues {
  const candidate =
    typeof input === "object" && input !== null && !Array.isArray(input)
      ? input
      : {};
  return taskTemplateDraftSchema.parse(candidate);
}
