import { z } from "zod";

export const sessionBulkActionSchema = z.enum([
  "add_tag",
  "remove_tag",
  "archive",
  "restore",
]);
export type SessionBulkAction = z.infer<typeof sessionBulkActionSchema>;

export const sessionBulkPreviewInputSchema = z
  .object({
    action: sessionBulkActionSchema,
    sessionIds: z
      .array(z.string().trim().min(1).max(200))
      .min(1, "Select at least one session.")
      .max(100, "A bulk update is limited to 100 sessions."),
    tagId: z.string().trim().max(200).nullish(),
    tagName: z.string().trim().max(80).nullish(),
    colourToken: z
      .enum(["slate", "indigo", "emerald", "amber", "rose"])
      .nullish(),
  })
  .transform((value) => ({
    ...value,
    sessionIds: [...new Set(value.sessionIds)],
    tagId: value.tagId || null,
    tagName: value.tagName || null,
    colourToken: value.colourToken ?? "indigo",
  }))
  .superRefine((value, context) => {
    if (value.action === "add_tag" && !value.tagId && !value.tagName) {
      context.addIssue({
        code: "custom",
        path: ["tagName"],
        message: "Choose an existing tag or enter a new tag name.",
      });
    }
    if (value.action === "add_tag" && value.tagId && value.tagName) {
      context.addIssue({
        code: "custom",
        path: ["tagName"],
        message: "Choose an existing tag or create a new one, not both.",
      });
    }
    if (value.action === "remove_tag" && !value.tagId) {
      context.addIssue({
        code: "custom",
        path: ["tagId"],
        message: "Choose the tag to remove.",
      });
    }
    if (
      (value.action === "archive" || value.action === "restore") &&
      (value.tagId || value.tagName)
    ) {
      context.addIssue({
        code: "custom",
        message: "Archive and restore actions do not accept tag settings.",
      });
    }
  });

export const storedSessionBulkItemSchema = z.object({
  sessionId: z.string().min(1),
  title: z.string().min(1),
  expectedRevision: z.number().int().positive(),
  archivePreviousStatus: z.enum(["unscheduled", "cancelled"]).nullable(),
  before: z.object({
    status: z.enum([
      "unscheduled",
      "scheduled",
      "published",
      "cancelled",
      "archived",
    ]),
    tags: z.array(z.string()),
  }),
  after: z.object({
    status: z.enum([
      "unscheduled",
      "scheduled",
      "published",
      "cancelled",
      "archived",
    ]),
    tags: z.array(z.string()),
  }),
});

export const storedSessionBulkSummarySchema = z.object({
  action: sessionBulkActionSchema,
  label: z.string(),
  tagId: z.string().nullable(),
  tagName: z.string().nullable(),
  colourToken: z.string().nullable(),
  createsTag: z.boolean(),
  changeCount: z.number().int().nonnegative(),
  skippedCount: z.number().int().nonnegative(),
  invalidCount: z.number().int().nonnegative(),
  undoOf: z.string().nullable(),
  undoDeadline: z.number().int().nullable(),
  deleteTagAfterRemoval: z.boolean(),
  undoExpiresAt: z.number().int().nullable().optional(),
  undoneBy: z.string().nullable().optional(),
});

export type SessionBulkItem = z.infer<typeof storedSessionBulkItemSchema>;
export type SessionBulkSummary = z.infer<typeof storedSessionBulkSummarySchema>;

export type SessionRow = {
  id: string;
  title: string;
  status: "unscheduled" | "scheduled" | "published" | "cancelled" | "archived";
  revision: number;
  previousStatus: "unscheduled" | "cancelled" | null;
};

export type SessionBulkPreviewOptions = {
  undoOf?: string;
  undoDeadline?: number;
  deleteTagAfterRemoval?: boolean;
  operationId?: string;
  idempotencyKey?: string;
};

export const sessionBulkActionLabels: Record<SessionBulkAction, string> = {
  add_tag: "Add tag",
  remove_tag: "Remove tag",
  archive: "Archive sessions",
  restore: "Restore sessions",
};

export function parseSessionBulkJson(value: string, context: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${context} contains invalid JSON.`);
  }
}

export function sortedSessionValues(values: string[]) {
  return [...values].sort((left, right) => left.localeCompare(right));
}
