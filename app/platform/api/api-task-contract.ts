import { z } from "zod";
import { requireValue } from "~/lib/required-value";
import {
  assignedTaskConfigurationSchema,
  taskDestinationUrlSchema,
  taskFileKindSchema,
  taskFileScopeSchema,
} from "~/modules/tasks/task-schema";
import { ApiError, type ApiPrincipal } from "./api.server";

const taskTypes = [
  "checklist",
  "acknowledgement",
  "short_form",
  "file_upload",
  "link_visit",
  "administrator_only",
] as const;
const taskImpacts = ["critical", "high", "medium", "low"] as const;
const taskTargetTypes = ["speaker", "session", "event"] as const;
const apiTimestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => Math.floor(Date.parse(value) / 1_000));
const apiTaskConfigurationSchema = z
  .object({
    destinationUrl: taskDestinationUrlSchema.optional(),
    fileScope: taskFileScopeSchema.optional(),
    fileKind: taskFileKindSchema.optional(),
  })
  .strict();

export const apiTaskCreateSchema = z
  .object({
    title: z.string().trim().min(3).max(200),
    description: z.string().trim().max(2_000).nullable().default(null),
    targetType: z.enum(taskTargetTypes),
    targetId: z.string().trim().min(1).max(200),
    ownerPersonId: z.string().trim().min(1).max(200).nullable().default(null),
    taskType: z.enum(taskTypes),
    configuration: apiTaskConfigurationSchema.default({}),
    impact: z.enum(taskImpacts),
    dueAt: apiTimestampSchema.nullable().default(null),
    dependencyIds: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .default([])
      .refine(
        (ids) => new Set(ids).size === ids.length,
        "dependencyIds must contain unique task IDs",
      ),
  })
  .strict()
  .superRefine((input, context) => {
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
    if (input.taskType !== "file_upload" && input.configuration.fileScope) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "fileScope"],
        message: "File scope is only supported by file-upload tasks.",
      });
    }
    if (input.taskType === "file_upload" && !input.configuration.fileKind) {
      context.addIssue({
        code: "custom",
        path: ["configuration", "fileKind"],
        message: "File-upload tasks must identify the accepted file type.",
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
  });

export const apiTaskListQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d+$/, "limit must be a whole number from 1 to 200")
      .transform(Number)
      .pipe(z.number().int().min(1).max(200))
      .default(100),
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export type ApiTaskCreateInput = z.infer<typeof apiTaskCreateSchema>;

export type ApiTaskRow = {
  id: string;
  templateId: string | null;
  targetType: (typeof taskTargetTypes)[number];
  targetId: string;
  ownerPersonId: string | null;
  ownerName: string | null;
  title: string;
  description: string | null;
  taskType: (typeof taskTypes)[number];
  impact: (typeof taskImpacts)[number];
  configurationJson: string;
  status:
    | "not_started"
    | "in_progress"
    | "blocked"
    | "submitted"
    | "completed"
    | "waived"
    | "overdue";
  readinessState: "on_track" | "at_risk" | "blocked" | "overdue";
  readinessPercent: number;
  revision: number;
  dueAt: number | null;
  evidenceJson: string | null;
  waiverJson: string | null;
  submittedAt: number | null;
  completedAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type ApiTask = Omit<
  ApiTaskRow,
  | "configurationJson"
  | "dueAt"
  | "submittedAt"
  | "completedAt"
  | "createdAt"
  | "updatedAt"
> & {
  configuration: z.infer<typeof assignedTaskConfigurationSchema>;
  dueAt: string | null;
  submittedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  dependencyIds: string[];
};

export type ApiTaskPage = {
  tasks: ApiTask[];
  nextCursor: string | null;
};

export type ApiTaskMutation = {
  task: ApiTask;
  changeSequence: number;
  webhookDeliveries: Array<{
    endpointId: string;
    deliveryId: string;
    operationId: string;
    status:
      | "queued"
      | "queue_failed"
      | "completed"
      | "partially_failed"
      | "failed"
      | "cancelled";
    duplicate: boolean;
  }>;
};

export type TaskCreationCommand = {
  requestHash: string;
  status: string;
  responseJson: string | null;
  entityId: string | null;
};

export type RecoveredTaskCreation = Omit<
  ApiTaskMutation,
  "webhookDeliveries"
> & {
  correlationId: string;
};

export type EventPrincipal = ApiPrincipal & { eventId: string };

export function apiActorId(keyId: string) {
  return `api_key:${keyId}`;
}

type TaskCursor = {
  version: 1;
  dueAt: number | null;
  createdAt: number;
  id: string;
};

const taskCursorSchema = z.object({
  version: z.literal(1),
  dueAt: z.number().int().nonnegative().nullable(),
  createdAt: z.number().int().nonnegative(),
  id: z.string().min(1).max(200),
});

export function encodeTaskCursor(row: ApiTaskRow) {
  const value = JSON.stringify({
    version: 1,
    dueAt: row.dueAt,
    createdAt: row.createdAt,
    id: row.id,
  } satisfies TaskCursor);
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function decodeTaskCursor(value: string): TaskCursor {
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    return taskCursorSchema.parse(JSON.parse(atob(padded)));
  } catch {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      "cursor is invalid or no longer supported",
    );
  }
}

function apiTimestamp(value: number | null) {
  return value === null ? null : new Date(value * 1_000).toISOString();
}

export function toApiTask(row: ApiTaskRow, dependencyIds: string[]): ApiTask {
  const { configurationJson, ...task } = row;
  return {
    ...task,
    configuration: assignedTaskConfigurationSchema.parse(
      JSON.parse(configurationJson),
    ),
    dueAt: apiTimestamp(row.dueAt),
    submittedAt: apiTimestamp(row.submittedAt),
    completedAt: apiTimestamp(row.completedAt),
    createdAt: requireValue(
      apiTimestamp(row.createdAt),
      "Required apiTimestamp(row.createdAt) is unavailable.",
    ),
    updatedAt: requireValue(
      apiTimestamp(row.updatedAt),
      "Required apiTimestamp(row.updatedAt) is unavailable.",
    ),
    dependencyIds,
  };
}
