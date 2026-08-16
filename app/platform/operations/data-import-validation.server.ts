import { z } from "zod";
import {
  roomInputSchema,
  sessionFormatInputSchema,
} from "~/modules/events/event-schema";
import {
  type EventExportResource,
  eventExportResources,
} from "~/platform/operations/data-export-service.server";

const importResources = eventExportResources.filter(
  (resource): resource is Exclude<EventExportResource, "audit"> =>
    resource !== "audit",
);
export type EventImportResource = Exclude<EventExportResource, "audit">;
export type ImportScalar = string | number | boolean | null;

export const importResourceSchema: z.ZodType<EventImportResource> =
  z.enum(importResources);

export function requestedPersonEmails(
  resource: EventImportResource,
  rows: ReadonlyArray<Record<string, unknown>>,
): string[] {
  const field =
    resource === "people"
      ? "email"
      : resource === "submissions"
        ? "submitterEmail"
        : resource === "tasks"
          ? "ownerEmail"
          : null;
  if (!field) return [];
  return [
    ...new Set(
      rows
        .map((row) =>
          typeof row[field] === "string" ? row[field].trim().toLowerCase() : "",
        )
        .filter(Boolean),
    ),
  ];
}

export function requestedSpeakerTargetIds(
  resource: EventImportResource,
  rows: ReadonlyArray<Record<string, unknown>>,
): string[] {
  if (resource !== "tasks") return [];
  return [
    ...new Set(
      rows
        .filter((row) => row.targetType === "speaker")
        .map((row) =>
          typeof row.targetId === "string" ? row.targetId.trim() : "",
        )
        .filter(Boolean),
    ),
  ];
}

const rfc3339DateTime = z.iso.datetime({ offset: true });

const blankToNull = z
  .string()
  .trim()
  .transform((value) => value || null);
const blankToInteger = z
  .string()
  .trim()
  .transform((value, context) => {
    if (!value) return null;
    if (!/^-?\d+$/u.test(value)) {
      context.addIssue({ code: "custom", message: "must be a whole number" });
      return z.NEVER;
    }
    return Number(value);
  });
const blankToBoolean = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value, context) => {
    if (["1", "true", "yes"].includes(value)) return true;
    if (["0", "false", "no"].includes(value)) return false;
    context.addIssue({
      code: "custom",
      message: "must be true/false, yes/no or 1/0",
    });
    return z.NEVER;
  });
const blankToEpoch = z
  .string()
  .trim()
  .transform((value, context) => {
    if (!value) return null;
    const parsed = rfc3339DateTime.safeParse(value);
    if (!parsed.success) {
      context.addIssue({
        code: "custom",
        message: "must be an RFC 3339 date and time",
      });
      return z.NEVER;
    }
    return Math.floor(Date.parse(parsed.data) / 1_000);
  });

export const importSchemas: Record<
  EventImportResource,
  z.ZodType<Record<string, ImportScalar>>
> = {
  people: z
    .object({
      email: z
        .email()
        .max(320)
        .transform((value) => value.toLowerCase()),
      name: z.string().trim().min(1).max(200),
      organisation: blankToNull.optional().default(""),
      jobTitle: blankToNull.optional().default(""),
      profileStatus: z
        .enum(["draft", "published", "archived"])
        .optional()
        .default("draft"),
      role: z.enum([
        "administrator",
        "committee_chair",
        "evaluator",
        "submitter",
        "speaker",
      ]),
    })
    .strict(),
  submissions: z
    .object({
      publicReference: z.string().trim().min(1).max(100),
      title: z.string().trim().min(1).max(300),
      category: blankToNull.optional().default(""),
      format: blankToNull.optional().default(""),
      status: z.literal("draft", {
        error:
          "must be draft; use the submission, evaluation and decision workflows for lifecycle changes",
      }),
      submitterEmail: blankToNull.optional().default(""),
      submittedAt: blankToEpoch.optional().default(null),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.submittedAt !== null) {
        context.addIssue({
          code: "custom",
          path: ["submittedAt"],
          message: "must be empty for a draft submission import",
        });
      }
    }),
  sessions: z
    .object({
      slug: z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
        .max(120),
      title: z.string().trim().min(1).max(300),
      description: blankToNull.optional().default(""),
      trackSlug: blankToNull.optional().default(""),
      format: sessionFormatInputSchema.shape.key,
      durationMinutes: z.coerce.number().int().min(1).max(1_440),
      expectedAttendance: blankToInteger
        .pipe(z.number().int().nonnegative().nullable())
        .optional()
        .default(null),
      status: z.enum([
        "unscheduled",
        "scheduled",
        "published",
        "cancelled",
        "archived",
      ]),
      visibility: z.enum(["public", "private", "hidden"]),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.status === "scheduled" ||
        value.status === "published" ||
        value.status === "archived"
      ) {
        context.addIssue({
          code: "custom",
          path: ["status"],
          message:
            "must be unscheduled or cancelled; use the schedule workflow to schedule or publish sessions and the bulk workflow to archive them",
        });
      }
    }),
  rooms: z
    .object({
      name: roomInputSchema.shape.name,
      building: blankToNull.optional().default(""),
      level: blankToNull.optional().default(""),
      capacity: roomInputSchema.shape.capacity,
      position: z.coerce
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .default(0),
      status: z.enum(["active", "retired"]).optional().default("active"),
    })
    .strict(),
  tracks: z
    .object({
      slug: z
        .string()
        .trim()
        .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u)
        .max(120),
      name: z.string().trim().min(1).max(200),
      colour: blankToNull.optional().default(""),
      position: z.coerce
        .number()
        .int()
        .min(0)
        .max(10_000)
        .optional()
        .default(0),
      exclusive: blankToBoolean.optional().default(false),
      public: blankToBoolean.optional().default(true),
    })
    .strict(),
  tasks: z
    .object({
      id: blankToNull.optional().default(""),
      title: z.string().trim().min(1).max(200),
      description: blankToNull.optional().default(""),
      targetType: z.enum(["speaker", "session", "event"]),
      targetId: z.string().trim().min(1).max(200),
      ownerEmail: blankToNull.optional().default(""),
      status: z.enum([
        "not_started",
        "in_progress",
        "blocked",
        "submitted",
        "completed",
        "waived",
        "overdue",
      ]),
      statusReason: z.string().trim().max(1_000).optional().default(""),
      impact: z.enum(["critical", "high", "medium", "low"]),
      dueAt: blankToEpoch.optional().default(null),
    })
    .strict(),
} as const;

export type ValidationContextRecord = {
  id: string;
  eventId?: string;
  linked?: number;
  status?: string;
  revision?: number;
  name?: string;
  organisation?: string | null;
  jobTitle?: string | null;
  profileStatus?: string;
  building?: string | null;
  level?: string | null;
  capacity?: number;
  position?: number;
  colour?: string | null;
  exclusive?: number;
  public?: number;
  scheduleReferences?: number;
  requiredCapacity?: number | null;
  ambiguous?: boolean;
  taskType?: string;
  dependenciesBlocked?: number;
  dependentAdvanced?: number;
  safeSubmittedEvidence?: number;
};
export type DataImportValidationRecords = Record<
  string,
  Record<string, ValidationContextRecord>
>;
export type NormalizedImportRow = {
  rowNumber: number;
  action: "create" | "update" | "link";
  values: Record<string, ImportScalar>;
};
export type InvalidImportRow = {
  rowNumber: number;
  errors: string[];
  raw: Record<string, string>;
};

export const storedPreviewSchema: z.ZodType<NormalizedImportRow> = z.object({
  rowNumber: z.number().int().min(2),
  action: z.enum(["create", "update", "link"]),
  values: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
});

export function issueMessages(error: z.ZodError): string[] {
  return error.issues.map((issue) => {
    const field = issue.path.length ? `${issue.path.join(".")} ` : "";
    return `${field}${issue.message}`;
  });
}

export class DataImportStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataImportStateError";
  }
}
