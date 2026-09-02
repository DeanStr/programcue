import { z } from "zod";

export const taskBulkActionSchema = z.enum([
  "assign_template",
  "waive",
  "reopen",
]);
export type TaskBulkAction = z.infer<typeof taskBulkActionSchema>;

export const storedTemplateSnapshotSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  description: z.string().nullable(),
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
  dueOffsetMinutes: z.number().int().nullable(),
  fixedDueAt: z.number().int().nullable(),
  autoAssignOnAcceptance: z.number().int().min(0).max(1),
  configurationJson: z.string(),
  updatedAt: z.number().int().positive(),
  dependencyIds: z.array(z.string().min(1)),
});

export const taskBulkPreviewInputSchema = z
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

export const storedTaskBulkItemSchema = z.object({
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

export const storedTaskBulkSummarySchema = z.object({
  action: taskBulkActionSchema,
  label: z.string().min(1),
  templateId: z.string().min(1).nullable(),
  templateName: z.string().min(1).nullable(),
  reason: z.string(),
  changeCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  invalidCount: z.number().int().nonnegative(),
});

export const storedTaskBulkOperationResultSchema =
  storedTaskBulkSummarySchema.extend({
    expectedTemplates: z.array(storedTemplateSnapshotSchema),
  });

export type TaskBulkItem = z.infer<typeof storedTaskBulkItemSchema>;
export type TaskBulkSummary = z.infer<typeof storedTaskBulkSummarySchema>;
export type StoredTemplateSnapshot = z.infer<
  typeof storedTemplateSnapshotSchema
>;

export type TaskRow = {
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

export const taskBulkActionLabels: Record<TaskBulkAction, string> = {
  assign_template: "Assign task plan",
  waive: "Waive requirements",
  reopen: "Reopen requirements",
};

export function parseTaskBulkJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${context} contains invalid JSON.`, { cause: error });
  }
}
