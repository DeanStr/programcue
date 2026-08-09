import { z } from "zod";

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
    targetType: z.literal("speaker", {
      error: "Only speaker-scoped task templates can currently be assigned.",
    }),
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
    dependencyIds: z.array(z.string().min(1)).max(30).default([]),
  })
  .superRefine((input, context) => {
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
});

export type TaskTemplateInput = z.infer<typeof taskTemplateInputSchema>;
