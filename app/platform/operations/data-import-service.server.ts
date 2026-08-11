import { z } from "zod";

import { parseSessionFormatsConfiguration } from "~/modules/events/event-configuration";
import {
  roomInputSchema,
  sessionFormatInputSchema,
} from "~/modules/events/event-schema";
import { parseCsv } from "./csv";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  eventExportResources,
  type EventExportResource,
} from "~/platform/operations/data-export-service.server";
import {
  WebhookService,
  type PreparedWebhookEvent,
} from "~/platform/operations/webhook-service.server";

const importResources = eventExportResources.filter(
  (resource): resource is Exclude<EventExportResource, "audit"> =>
    resource !== "audit",
);
const importResourceSchema = z.enum(importResources);
export type EventImportResource = z.infer<typeof importResourceSchema>;

const IMPORT_BYTES_LIMIT = 512_000;
// Leave headroom below Workers' 1,000 D1-query invocation limit for framework
// and post-commit bookkeeping that is outside this service's estimate.
const TASK_IMPORT_D1_QUERY_BUDGET = 800;
const TASK_IMPORT_FIXED_QUERY_ALLOWANCE = 20;
const rfc3339DateTime = z.iso.datetime({ offset: true });

function requestedPersonEmails(
  resource: EventImportResource,
  rows: ReadonlyArray<Record<string, unknown>>,
) {
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

function requestedSpeakerTargetIds(
  resource: EventImportResource,
  rows: ReadonlyArray<Record<string, unknown>>,
) {
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

const importSchemas = {
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

type ImportScalar = string | number | boolean | null;
type ValidationContextRecord = {
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
type NormalizedImportRow = {
  rowNumber: number;
  action: "create" | "update" | "link";
  values: Record<string, ImportScalar>;
};
type InvalidImportRow = {
  rowNumber: number;
  errors: string[];
  raw: Record<string, string>;
};

const storedPreviewSchema = z.object({
  rowNumber: z.number().int().min(2),
  action: z.enum(["create", "update", "link"]),
  values: z.record(
    z.string(),
    z.union([z.string(), z.number(), z.boolean(), z.null()]),
  ),
});

function issueMessages(error: z.ZodError) {
  return error.issues.map((issue) => {
    const field = issue.path.length ? `${issue.path.join(".")} ` : "";
    return `${field}${issue.message}`;
  });
}

function readiness(status: string) {
  if (status === "completed" || status === "waived")
    return { state: "on_track", percent: 100 };
  if (status === "blocked") return { state: "blocked", percent: 0 };
  if (status === "overdue") return { state: "overdue", percent: 0 };
  if (status === "submitted") return { state: "on_track", percent: 80 };
  if (status === "in_progress") return { state: "at_risk", percent: 40 };
  return { state: "on_track", percent: 0 };
}

type TaskStatusTransition =
  "none" | "progress" | "complete" | "approve" | "waive" | "reopen";

const taskProgressStatuses = [
  "not_started",
  "in_progress",
  "blocked",
  "overdue",
] as const;

function importedTaskStatusTransition(
  task: ValidationContextRecord,
  requestedStatus: string,
  reason: string,
): { transition: TaskStatusTransition } | { error: string } {
  const currentStatus = task.status;
  if (!currentStatus) return { error: "the existing task status is invalid" };
  if (requestedStatus === "blocked" && (task.dependenciesBlocked ?? 0) === 0) {
    return {
      error:
        "blocked status requires at least one unfinished prerequisite task",
    };
  }
  if (currentStatus === requestedStatus) return { transition: "none" };

  if (requestedStatus === "submitted") {
    return {
      error:
        "submitted status requires participant evidence and cannot be created by CSV import",
    };
  }
  if (requestedStatus === "completed") {
    if (
      !taskProgressStatuses.includes(
        currentStatus as (typeof taskProgressStatuses)[number],
      ) &&
      currentStatus !== "submitted"
    ) {
      return {
        error: `a ${currentStatus.replaceAll("_", " ")} task cannot be completed`,
      };
    }
    if ((task.dependenciesBlocked ?? 0) !== 0) {
      return {
        error:
          "prerequisite tasks must be completed or waived before this task can be completed",
      };
    }
    if (
      task.taskType === "file_upload" &&
      (task.safeSubmittedEvidence ?? 0) === 0
    ) {
      return {
        error:
          "file evidence must be submitted, scanned, signature-valid and released before this task can be completed",
      };
    }
    return {
      transition: currentStatus === "submitted" ? "approve" : "complete",
    };
  }
  if (requestedStatus === "waived") {
    if (
      !taskProgressStatuses.includes(
        currentStatus as (typeof taskProgressStatuses)[number],
      ) &&
      currentStatus !== "submitted"
    ) {
      return {
        error: `a ${currentStatus.replaceAll("_", " ")} task cannot be waived`,
      };
    }
    if (reason.length < 5) {
      return {
        error:
          "statusReason must explain in at least 5 characters why the task is waived",
      };
    }
    return { transition: "waive" };
  }
  if (
    requestedStatus === "not_started" &&
    (currentStatus === "completed" || currentStatus === "waived")
  ) {
    if ((task.dependentAdvanced ?? 0) !== 0) {
      return {
        error:
          "a dependent task was submitted or completed; reopen that work first",
      };
    }
    return { transition: "reopen" };
  }
  if (
    taskProgressStatuses.includes(
      requestedStatus as (typeof taskProgressStatuses)[number],
    ) &&
    taskProgressStatuses.includes(
      currentStatus as (typeof taskProgressStatuses)[number],
    )
  ) {
    if (
      requestedStatus !== "blocked" &&
      (task.dependenciesBlocked ?? 0) !== 0
    ) {
      return {
        error:
          "this task must remain blocked until every prerequisite is completed or waived",
      };
    }
    return { transition: "progress" };
  }
  return {
    error: `a ${currentStatus.replaceAll("_", " ")} task cannot transition to ${requestedStatus.replaceAll("_", " ")} by CSV import`,
  };
}

function roomScheduleErrors(
  values: Record<string, ImportScalar>,
  existing: ValidationContextRecord,
) {
  const errors: string[] = [];
  if (
    values.status === "retired" &&
    existing.status !== "retired" &&
    (existing.scheduleReferences ?? 0) > 0
  ) {
    errors.push(
      "an active room referenced by a draft, publishing or published schedule cannot be retired",
    );
  }
  if (
    existing.requiredCapacity !== null &&
    existing.requiredCapacity !== undefined &&
    Number(values.capacity) < existing.requiredCapacity
  ) {
    errors.push(
      `capacity cannot be lower than the published schedule requirement of ${existing.requiredCapacity}`,
    );
  }
  return errors;
}

export class DataImportStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataImportStateError";
  }
}

export class DataImportService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async preview(
    viewer: Viewer,
    input: { resource: unknown; fileName: string; csv: string },
  ) {
    const resource = importResourceSchema.parse(input.resource);
    await this.assertSupportedAuthority(viewer, resource);
    if (new TextEncoder().encode(input.csv).byteLength > IMPORT_BYTES_LIMIT) {
      throw new Error("CSV import files cannot exceed 512 KB.");
    }
    const parsed = parseCsv(input.csv);
    const context = await this.validationContext(viewer, resource, {
      requestedTaskIds:
        resource === "tasks"
          ? parsed.rows
              .map((row) => row.id?.trim())
              .filter((id): id is string => Boolean(id))
          : [],
      requestedPersonEmails: requestedPersonEmails(resource, parsed.rows),
      requestedSpeakerTargetIds: requestedSpeakerTargetIds(
        resource,
        parsed.rows,
      ),
    });
    const valid: NormalizedImportRow[] = [];
    const invalid: InvalidImportRow[] = [];
    const fileKeys = new Set<string>();

    for (const [index, raw] of parsed.rows.entries()) {
      const rowNumber = index + 2;
      const result = importSchemas[resource].safeParse(raw);
      if (!result.success) {
        invalid.push({ rowNumber, errors: issueMessages(result.error), raw });
        continue;
      }
      const normalized = this.normalizeRow(
        viewer,
        resource,
        result.data as Record<string, ImportScalar>,
        context,
        rowNumber,
      );
      if ("errors" in normalized) {
        invalid.push({ rowNumber, errors: normalized.errors, raw });
        continue;
      }
      const duplicateKey = `${resource}:${String(normalized.values.importKey)}`;
      if (fileKeys.has(duplicateKey)) {
        invalid.push({
          rowNumber,
          errors: ["duplicates another row in this import"],
          raw,
        });
        continue;
      }
      fileKeys.add(duplicateKey);
      delete normalized.values.importKey;
      valid.push(normalized);
    }

    if (resource === "tasks" && invalid.length === 0) {
      const changedTaskStatusCount = valid.filter(
        (row) => row.values.statusTransition !== "none",
      ).length;
      await this.assertTaskImportQueryBudget(
        viewer,
        valid.length,
        changedTaskStatusCount,
      );
    }

    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const items = [
      ...valid.map((row) => ({
        id: crypto.randomUUID(),
        itemKey: `row:${row.rowNumber}`,
        status: "pending",
        result: row,
        errorCode: null,
        errorMessage: null,
      })),
      ...invalid.map((row) => ({
        id: crypto.randomUUID(),
        itemKey: `row:${row.rowNumber}`,
        status: "failed",
        result: row,
        errorCode: "VALIDATION_ERROR",
        errorMessage: row.errors.join("; "),
      })),
    ].sort(
      (left, right) =>
        Number(left.itemKey.slice(4)) - Number(right.itemKey.slice(4)),
    );
    const resultJson = JSON.stringify({
      resource,
      fileName: input.fileName.slice(0, 255),
      headers: parsed.headers,
      validCount: valid.length,
      invalidCount: invalid.length,
    });
    const itemJson = JSON.stringify(items);
    const entityType = {
      people: "person",
      submissions: "submission",
      sessions: "session",
      rooms: "room",
      tracks: "track",
      tasks: "task_instance",
    }[resource];
    const [created] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json, result_json,
          progress_total, progress_completed, progress_failed, cancellable,
          created_at, updated_at
        ) SELECT ?, ?, ?, ?, 'data.import', ?, ?, 'received', ?, ?, ?, 0, ?, 1,
                 unixepoch(), unixepoch()
            FROM events e
           WHERE e.id = ? AND e.organisation_id = ?
             AND e.repository_provider = 'd1'
      `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `data-import:${operationId}`,
        correlationId,
        JSON.stringify({ type: "data.import", operationId, resource }),
        resultJson,
        items.length,
        invalid.length,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO operation_items (
          id, operation_id, item_key, entity_type, entity_id, status, result_json,
          error_code, error_message, completed_at, updated_at
        )
        SELECT json_extract(value, '$.id'), ?, json_extract(value, '$.itemKey'),
               ?, json_extract(value, '$.result.values.id'),
               json_extract(value, '$.status'),
               json(json_extract(value, '$.result')),
               json_extract(value, '$.errorCode'),
               json_extract(value, '$.errorMessage'),
               CASE WHEN json_extract(value, '$.status') = 'failed' THEN unixepoch() ELSE NULL END,
               unixepoch()
          FROM json_each(?)
         WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
      `,
      ).bind(operationId, entityType, itemJson, operationId),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'data_import.previewed', 'operation', ?, ?, ?, unixepoch()
           WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        correlationId,
        resultJson,
        operationId,
      ),
    ]);
    if ((created.meta.changes ?? 0) !== 1) {
      await this.assertSupportedAuthority(viewer, resource);
      throw new Error("The import preview could not be recorded.");
    }
    return {
      operationId,
      resource,
      validCount: valid.length,
      invalidCount: invalid.length,
    };
  }

  async confirm(viewer: Viewer, operationId: string) {
    const operation = await this.env.DB.prepare(
      `
      SELECT o.status, o.result_json AS resultJson, o.progress_failed AS failed
        FROM operation_jobs o
        JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
       WHERE o.id = ? AND o.event_id = ? AND o.type = 'data.import'
       LIMIT 1
    `,
    )
      .bind(viewer.organisationId, operationId, viewer.eventId)
      .first<{ status: string; resultJson: string; failed: number }>();
    if (!operation) throw new DataImportStateError("Import preview not found.");
    if (operation.status !== "received") {
      throw new DataImportStateError(
        "Only an uncommitted import preview can be confirmed.",
      );
    }
    if (operation.failed > 0) {
      throw new DataImportStateError(
        "Resolve every invalid CSV row before confirming this import.",
      );
    }
    const summary = z
      .object({
        resource: importResourceSchema,
        validCount: z.number().int().min(1),
      })
      .passthrough()
      .parse(JSON.parse(operation.resultJson));
    await this.assertSupportedAuthority(viewer, summary.resource);
    const itemRows = await this.env.DB.prepare(
      `SELECT result_json AS resultJson FROM operation_items
         WHERE operation_id = ? AND status = 'pending'
         ORDER BY CAST(substr(item_key, 5) AS INTEGER)`,
    )
      .bind(operationId)
      .all<{ resultJson: string }>();
    const rows = itemRows.results.map((item) =>
      storedPreviewSchema.parse(JSON.parse(item.resultJson)),
    );
    if (rows.length !== summary.validCount || rows.length === 0) {
      throw new Error(
        "The import preview row count no longer matches its durable summary.",
      );
    }
    await this.revalidate(viewer, summary.resource, rows);
    const changedTaskStatusRows =
      summary.resource === "tasks"
        ? rows.filter((row) => row.values.statusTransition !== "none")
        : [];
    const taskWebhookEndpointCount =
      summary.resource === "tasks"
        ? await this.assertTaskImportQueryBudget(
            viewer,
            rows.length,
            changedTaskStatusRows.length,
          )
        : 0;
    const completionAuditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhooks: PreparedWebhookEvent[] = [];
    if (taskWebhookEndpointCount > 0) {
      for (const row of changedTaskStatusRows) {
        const taskId = String(row.values.id);
        preparedWebhooks.push(
          await webhookService.prepareEventForAudit(
            viewer,
            {
              eventType: "task.updated",
              entityType: "task",
              entityId: taskId,
              idempotencyKey: `task.updated:${taskId}:${operationId}`,
              correlationId: operationId,
              data: {
                action: "csv_import",
                status: row.values.status,
              },
            },
            completionAuditEventId,
          ),
        );
      }
    }
    const mutations = rows.flatMap((row) =>
      this.mutationStatements(viewer, operationId, summary.resource, row),
    );
    const taskStateRefreshes =
      summary.resource === "tasks"
        ? this.taskStateRefreshStatements(viewer, operationId)
        : [];
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `UPDATE operation_jobs SET status = 'running', started_at = unixepoch(),
                attempt_count = attempt_count + 1, updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'data.import' AND status = 'received' AND progress_failed = 0
            AND EXISTS (
              SELECT 1 FROM events e
               WHERE e.id = operation_jobs.event_id
                 AND e.organisation_id = operation_jobs.organisation_id
                 AND e.repository_provider = 'd1'
            )
            ${this.confirmationFreshnessGuard(summary.resource)}`,
      ).bind(operationId, viewer.eventId, viewer.organisationId),
      ...mutations,
      ...taskStateRefreshes,
      this.env.DB.prepare(
        `UPDATE operation_items SET status = 'completed', completed_at = unixepoch(),
                updated_at = unixepoch()
          WHERE operation_id = ? AND status = 'pending'
            AND EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'running')`,
      ).bind(operationId, operationId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT lower(hex(randomblob(16))), ?, ?, ?, 'data_import.record_upserted',
                item.entity_type, item.entity_id, operation.correlation_id,
                json_object(
                  'operationId', ?,
                  'rowNumber', json_extract(item.result_json, '$.rowNumber'),
                  'action', json_extract(item.result_json, '$.action'),
                  'resource', ?
                ), unixepoch()
           FROM operation_items item
           JOIN operation_jobs operation
             ON operation.id = item.operation_id AND operation.status = 'running'
          WHERE item.operation_id = ? AND item.status = 'completed'`,
      ).bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        summary.resource,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         )
         SELECT ?, item.entity_type, item.entity_id,
                CASE WHEN json_extract(item.result_json, '$.action') = 'create'
                     THEN 'created' ELSE 'updated' END,
                operation.correlation_id, unixepoch()
           FROM operation_items item
           JOIN operation_jobs operation
             ON operation.id = item.operation_id AND operation.status = 'running'
          WHERE item.operation_id = ? AND item.status = 'completed'`,
      ).bind(viewer.eventId, operationId),
      this.env.DB.prepare(
        `UPDATE operation_jobs SET status = 'completed', progress_completed = progress_total,
                progress_failed = 0, completed_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND organisation_id = ? AND status = 'running'`,
      ).bind(operationId, viewer.eventId, viewer.organisationId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'data_import.completed', 'operation', ?, ?, unixepoch()
          WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND status = 'completed')`,
      ).bind(
        completionAuditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        JSON.stringify({ resource: summary.resource, rowCount: rows.length }),
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         ) SELECT ?, 'operation', ?, 'progress', correlation_id, unixepoch()
             FROM operation_jobs WHERE id = ? AND status = 'completed'`,
      ).bind(viewer.eventId, operationId, operationId),
    ];
    const completionResultIndex = statements.length - 3;
    statements.push(
      ...preparedWebhooks.flatMap((webhook) => webhook.statements),
    );
    this.assertPreparedTaskImportQueryBudget(
      rows.length,
      changedTaskStatusRows.length,
      preparedWebhooks,
      statements.length,
    );
    const results = await this.env.DB.batch(statements);
    if ((results[0].meta.changes ?? 0) !== 1) {
      await this.assertSupportedAuthority(viewer, summary.resource);
      throw new DataImportStateError(
        "The import changed before it could be confirmed.",
      );
    }
    const completion = results[completionResultIndex];
    if ((completion?.meta.changes ?? 0) !== 1) {
      throw new Error("The confirmed import did not reach a completed state.");
    }
    const webhookWarning = await this.dispatchTaskStatusWebhooks(
      webhookService,
      preparedWebhooks,
    );
    return {
      operationId,
      resource: summary.resource,
      rowCount: rows.length,
      ...(webhookWarning ? { webhookWarning } : {}),
    };
  }

  private taskStateRefreshStatements(
    viewer: Viewer,
    operationId: string,
  ): D1PreparedStatement[] {
    const operationGuard = `EXISTS (
      SELECT 1 FROM operation_jobs operation
       WHERE operation.id = ? AND operation.event_id = ?
         AND operation.organisation_id = ? AND operation.status = 'running'
    )`;
    return [
      this.env.DB.prepare(
        `UPDATE task_instances AS task
            SET status = 'blocked', readiness_state = 'blocked',
                readiness_percent = 0, updated_at = unixepoch()
          WHERE task.event_id = ?
            AND task.status IN ('not_started','in_progress','overdue')
            AND ${operationGuard}
            AND EXISTS (
              SELECT 1
                FROM task_instance_dependencies dependency
                JOIN task_instances prerequisite
                  ON prerequisite.id = dependency.depends_on_task_id
               WHERE dependency.task_id = task.id
                 AND prerequisite.status NOT IN ('completed','waived')
            )`,
      ).bind(
        viewer.eventId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE task_instances AS task
            SET status = CASE
                  WHEN due_at IS NOT NULL AND due_at < unixepoch()
                    THEN 'overdue' ELSE 'not_started'
                END,
                readiness_state = CASE
                  WHEN due_at IS NOT NULL AND due_at < unixepoch()
                    THEN 'overdue' ELSE 'on_track'
                END,
                readiness_percent = 0, updated_at = unixepoch()
          WHERE task.event_id = ? AND task.status = 'blocked'
            AND ${operationGuard}
            AND NOT EXISTS (
              SELECT 1
                FROM task_instance_dependencies dependency
                JOIN task_instances prerequisite
                  ON prerequisite.id = dependency.depends_on_task_id
               WHERE dependency.task_id = task.id
                 AND prerequisite.status NOT IN ('completed','waived')
            )`,
      ).bind(
        viewer.eventId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `UPDATE task_instances
            SET status = 'overdue', readiness_state = 'overdue',
                readiness_percent = 0, updated_at = unixepoch()
          WHERE event_id = ? AND due_at IS NOT NULL AND due_at < unixepoch()
            AND status IN ('not_started','in_progress')
            AND ${operationGuard}`,
      ).bind(
        viewer.eventId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      ),
    ];
  }

  private async dispatchTaskStatusWebhooks(
    webhookService: WebhookService,
    preparedWebhooks: readonly PreparedWebhookEvent[],
  ) {
    if (preparedWebhooks.length === 0) return null;
    try {
      const results = await Promise.all(
        preparedWebhooks.map((prepared) =>
          webhookService.dispatchPreparedEvent(prepared),
        ),
      );
      return results
        .flat()
        .some((delivery) =>
          ["queue_failed", "failed", "partially_failed", "cancelled"].includes(
            delivery.status,
          ),
        )
        ? "Task statuses were imported, but one or more outbound webhooks need attention in the Operation Centre."
        : null;
    } catch (error) {
      console.error("Failed to dispatch imported task status webhooks", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return "Task statuses were imported, but their durable outbound webhook events could not all be dispatched.";
    }
  }

  private async activeTaskWebhookEndpointCount(viewer: Viewer) {
    const row = await this.env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM webhook_endpoints endpoint
         JOIN events event
           ON event.id = endpoint.event_id AND event.organisation_id = ?
        WHERE endpoint.event_id = ? AND endpoint.status IN ('active','failing')
          AND EXISTS (
            SELECT 1 FROM json_each(endpoint.event_types_json)
             WHERE value = 'task.updated'
          )`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .first<{ count: number }>();
    return row?.count ?? 0;
  }

  private taskImportQueryEstimate(
    rowCount: number,
    changedTaskStatusCount: number,
    endpointCount: number,
  ) {
    return (
      TASK_IMPORT_FIXED_QUERY_ALLOWANCE +
      rowCount * 3 +
      changedTaskStatusCount * (1 + endpointCount * 8)
    );
  }

  private taskImportBudgetError(
    rowCount: number,
    changedTaskStatusCount: number,
    endpointCount: number,
  ) {
    const available =
      TASK_IMPORT_D1_QUERY_BUDGET -
      TASK_IMPORT_FIXED_QUERY_ALLOWANCE -
      rowCount * 3;
    const perChangedTask = 1 + endpointCount * 8;
    const maximumChangedTasks = Math.max(
      0,
      Math.floor(available / perChangedTask),
    );
    return new DataImportStateError(
      `This import changes ${changedTaskStatusCount} task statuses with ${endpointCount} subscribed webhook endpoint${endpointCount === 1 ? "" : "s"}, which exceeds the safe D1 query budget. Split it so each file changes at most ${maximumChangedTasks} task statuses.`,
    );
  }

  private async assertTaskImportQueryBudget(
    viewer: Viewer,
    rowCount: number,
    changedTaskStatusCount: number,
  ) {
    const endpointCount =
      changedTaskStatusCount > 0
        ? await this.activeTaskWebhookEndpointCount(viewer)
        : 0;
    if (
      this.taskImportQueryEstimate(
        rowCount,
        changedTaskStatusCount,
        endpointCount,
      ) > TASK_IMPORT_D1_QUERY_BUDGET
    ) {
      throw this.taskImportBudgetError(
        rowCount,
        changedTaskStatusCount,
        endpointCount,
      );
    }
    return endpointCount;
  }

  private assertPreparedTaskImportQueryBudget(
    rowCount: number,
    changedTaskStatusCount: number,
    preparedWebhooks: readonly PreparedWebhookEvent[],
    statementCount: number,
  ) {
    const deliveryCount = preparedWebhooks.reduce(
      (total, prepared) =>
        total + prepared.existingResults.length + prepared.candidates.length,
      0,
    );
    const candidateCount = preparedWebhooks.reduce(
      (total, prepared) => total + prepared.candidates.length,
      0,
    );
    const estimate =
      TASK_IMPORT_FIXED_QUERY_ALLOWANCE +
      changedTaskStatusCount +
      deliveryCount +
      statementCount +
      candidateCount * 2;
    if (estimate <= TASK_IMPORT_D1_QUERY_BUDGET) return;
    const endpointCount =
      changedTaskStatusCount === 0
        ? 0
        : Math.ceil(deliveryCount / changedTaskStatusCount);
    throw this.taskImportBudgetError(
      rowCount,
      changedTaskStatusCount,
      endpointCount,
    );
  }

  private async assertSupportedAuthority(
    viewer: Viewer,
    resource: EventImportResource,
  ) {
    const event = await this.env.DB.prepare(
      `SELECT repository_provider AS repositoryProvider
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ repositoryProvider: string }>();
    if (!event) {
      throw new DataImportStateError(
        "The import event is unavailable in the authorised organisation.",
      );
    }
    if (event.repositoryProvider === "d1") return;
    if (event.repositoryProvider !== "airtable") {
      throw new Error("The event repository provider is invalid.");
    }
    throw new DataImportStateError(
      `CSV import for ${resource} is unavailable while Airtable is authoritative. Make canonical programme changes through the Airtable-aware Event Setup and programme screens.`,
    );
  }

  private async validationContext(
    viewer: Viewer,
    resource: EventImportResource,
    options: {
      requestedTaskIds?: readonly string[];
      requestedPersonEmails?: readonly string[];
      requestedSpeakerTargetIds?: readonly string[];
    } = {},
  ) {
    const context: Record<string, Record<string, ValidationContextRecord>> = {};
    if (
      resource === "people" ||
      resource === "submissions" ||
      resource === "tasks"
    ) {
      const emails = [...new Set(options.requestedPersonEmails ?? [])].slice(
        0,
        200,
      );
      const people = emails.length
        ? await this.env.DB.prepare(
            `SELECT p.id, lower(p.email) AS key, p.profile_revision AS revision,
                p.display_name AS name, p.organisation_name AS organisation,
                p.job_title AS jobTitle, p.profile_status AS profileStatus,
                EXISTS(
                  SELECT 1 FROM memberships m
                   WHERE m.person_id = p.id AND m.event_id = ?
                     AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
                ) AS linked
           FROM people p
          WHERE p.email IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
          )
            .bind(viewer.eventId, JSON.stringify(emails))
            .all<{
              id: string;
              key: string;
              revision: number;
              name: string;
              organisation: string | null;
              jobTitle: string | null;
              profileStatus: string;
              linked: number;
            }>()
        : { results: [] };
      context.people = Object.fromEntries(
        people.results.map((row) => [row.key, row]),
      );
      const memberships = emails.length
        ? await this.env.DB.prepare(
            `SELECT lower(person.email) || char(0) || membership.role AS key,
                membership.id
           FROM memberships membership
           JOIN people person ON person.id = membership.person_id
          WHERE membership.event_id = ? AND membership.revoked_at IS NULL
            AND person.email IN (
              SELECT CAST(value AS TEXT) FROM json_each(?)
            )`,
          )
            .bind(viewer.eventId, JSON.stringify(emails))
            .all<{ id: string; key: string }>()
        : { results: [] };
      context.memberships = Object.fromEntries(
        memberships.results.map((row) => [row.key, row]),
      );
      if (resource === "tasks") {
        const speakerTargetIds = [
          ...new Set(options.requestedSpeakerTargetIds ?? []),
        ].slice(0, 200);
        const speakerTargets = speakerTargetIds.length
          ? await this.env.DB.prepare(
              `SELECT person.id
                 FROM people person
                WHERE person.id IN (
                  SELECT CAST(value AS TEXT) FROM json_each(?)
                )
                  AND EXISTS (
                    SELECT 1 FROM memberships membership
                     WHERE membership.event_id = ?
                       AND membership.person_id = person.id
                       AND membership.accepted_at IS NOT NULL
                       AND membership.revoked_at IS NULL
                  )`,
            )
              .bind(JSON.stringify(speakerTargetIds), viewer.eventId)
              .all<{ id: string }>()
          : { results: [] };
        context.speakerTargets = Object.fromEntries(
          speakerTargets.results.map((row) => [row.id, row]),
        );
      }
    }
    if (resource === "submissions") {
      const rows = await this.env.DB.prepare(
        `SELECT id, public_reference AS key, revision, status
           FROM submissions WHERE event_id = ?`,
      )
        .bind(viewer.eventId)
        .all<{ id: string; key: string; revision: number }>();
      context.submissions = Object.fromEntries(
        rows.results.map((row) => [row.key, row]),
      );
    }
    if (resource === "sessions" || resource === "tasks") {
      const rows = await this.env.DB.prepare(
        "SELECT id, slug AS key, status, revision FROM sessions WHERE event_id = ?",
      )
        .bind(viewer.eventId)
        .all<{ id: string; key: string; status: string; revision: number }>();
      context.sessions = Object.fromEntries(
        rows.results.map((row) => [row.key, row]),
      );
      context.sessionIds = Object.fromEntries(
        rows.results.map((row) => [row.id, row]),
      );
    }
    if (resource === "sessions") {
      const formats = await this.configuredSessionFormats(viewer);
      context.sessionFormats = Object.fromEntries(
        formats.map((format) => [format.key, { id: format.key }]),
      );
    }
    if (resource === "sessions" || resource === "tracks") {
      const rows = await this.env.DB.prepare(
        `SELECT id, slug AS key, name, colour_token AS colour, position,
                exclusive, is_public AS public
           FROM tracks WHERE event_id = ?`,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          key: string;
          name: string;
          colour: string | null;
          position: number;
          exclusive: number;
          public: number;
        }>();
      context.tracks = Object.fromEntries(
        rows.results.map((row) => [row.key, row]),
      );
    }
    if (resource === "rooms") {
      const rows = await this.env.DB.prepare(
        `SELECT room.id, lower(room.name) AS key, room.name, room.building,
                room.level, room.capacity, room.position, room.status,
                (SELECT COUNT(*)
                   FROM schedule_entries entry
                   JOIN schedule_versions version
                     ON version.id = entry.schedule_version_id
                    AND version.event_id = entry.event_id
                  WHERE entry.event_id = room.event_id
                    AND entry.room_id = room.id
                    AND version.status IN ('draft','publishing','published')
                ) AS scheduleReferences,
                (SELECT MAX(session.expected_attendance)
                   FROM schedule_entries entry
                   JOIN schedule_versions version
                     ON version.id = entry.schedule_version_id
                    AND version.event_id = entry.event_id
                    AND version.status = 'published'
                   JOIN sessions session
                     ON session.id = entry.session_id
                    AND session.event_id = entry.event_id
                   JOIN schedule_policies policy
                     ON policy.event_id = entry.event_id
                    AND policy.capacity_action = 'block'
                  WHERE entry.event_id = room.event_id
                    AND entry.room_id = room.id
                    AND session.expected_attendance IS NOT NULL
                ) AS requiredCapacity
           FROM rooms room WHERE room.event_id = ?
           ORDER BY room.id`,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          key: string;
          name: string;
          building: string | null;
          level: string | null;
          capacity: number;
          position: number;
          status: string;
          scheduleReferences: number;
          requiredCapacity: number | null;
        }>();
      context.rooms = {};
      for (const row of rows.results) {
        const existing = context.rooms[row.key];
        if (existing) {
          existing.ambiguous = true;
          continue;
        }
        context.rooms[row.key] = { ...row, ambiguous: false };
      }
    }
    if (resource === "tasks") {
      const taskIds = [...new Set(options.requestedTaskIds ?? [])].slice(
        0,
        200,
      );
      const rows = taskIds.length
        ? await this.env.DB.prepare(
            `SELECT task.id, task.id AS key, task.event_id AS eventId,
                    task.revision, task.status, task.task_type AS taskType,
                    EXISTS (
                      SELECT 1
                        FROM task_instance_dependencies dependency
                        JOIN task_instances prerequisite
                          ON prerequisite.id = dependency.depends_on_task_id
                       WHERE dependency.task_id = task.id
                         AND prerequisite.status NOT IN ('completed','waived')
                    ) AS dependenciesBlocked,
                    EXISTS (
                      SELECT 1
                        FROM task_instance_dependencies dependency
                        JOIN task_instances dependent
                          ON dependent.id = dependency.task_id
                       WHERE dependency.depends_on_task_id = task.id
                         AND dependent.status IN ('submitted','completed')
                    ) AS dependentAdvanced,
                    EXISTS (
                      SELECT 1
                        FROM task_evidence evidence
                        JOIN file_assets asset
                          ON asset.id = evidence.file_asset_id
                         AND asset.event_id = evidence.event_id
                        JOIN file_versions version
                          ON version.id = json_extract(evidence.evidence_json, '$.fileVersionId')
                         AND version.asset_id = asset.id
                         AND version.event_id = asset.event_id
                       WHERE evidence.task_id = task.id
                         AND evidence.status = 'submitted'
                         AND asset.status = 'active'
                         AND version.scan_status = 'clean'
                         AND version.signature_status = 'valid'
                         AND version.released_at IS NOT NULL
                    ) AS safeSubmittedEvidence
               FROM task_instances task
              WHERE task.id IN (${taskIds.map(() => "?").join(", ")})`,
          )
            .bind(...taskIds)
            .all<{
              id: string;
              key: string;
              eventId: string;
              revision: number;
              status: string;
              taskType: string;
              dependenciesBlocked: number;
              dependentAdvanced: number;
              safeSubmittedEvidence: number;
            }>()
        : { results: [] };
      context.tasks = Object.fromEntries(
        rows.results.map((row) => [row.key, row]),
      );
    }
    return context;
  }

  private normalizeRow(
    viewer: Viewer,
    resource: EventImportResource,
    values: Record<string, ImportScalar>,
    context: Record<string, Record<string, ValidationContextRecord>>,
    rowNumber: number,
  ): NormalizedImportRow | { errors: string[] } {
    if (resource === "people") {
      const key = String(values.email).toLowerCase();
      const existing = context.people?.[key];
      if (
        existing &&
        (existing.name !== values.name ||
          existing.organisation !== values.organisation ||
          existing.jobTitle !== values.jobTitle ||
          existing.profileStatus !== values.profileStatus)
      ) {
        return {
          errors: [
            "email identifies an existing person; profile fields must match the existing identity because CSV imports can only link its event membership",
          ],
        };
      }
      return {
        rowNumber,
        action: existing ? "link" : "create",
        values: {
          ...values,
          importKey: key,
          id: existing?.id ?? crypto.randomUUID(),
          membershipId: crypto.randomUUID(),
          expectedRevision: existing?.revision ?? null,
          expectedLinked: existing?.linked ?? null,
          expectedRoleLinked: existing
            ? Boolean(
                context.memberships?.[`${key}\u0000${String(values.role)}`],
              )
            : null,
        },
      };
    }
    if (resource === "submissions") {
      const key = String(values.publicReference);
      const existing = context.submissions?.[key];
      if (existing && existing.status !== "draft") {
        return {
          errors: [
            "an existing non-draft submission must be changed through the submission, evaluation or decision workflow",
          ],
        };
      }
      const submitterEmail = values.submitterEmail
        ? String(values.submitterEmail).toLowerCase()
        : null;
      const submitter = submitterEmail
        ? context.people?.[submitterEmail]
        : null;
      if (submitterEmail && (!submitter || !submitter.linked)) {
        return {
          errors: [
            "submitterEmail must identify a person already linked to this event",
          ],
        };
      }
      return {
        rowNumber,
        action: existing ? "update" : "create",
        values: {
          ...values,
          importKey: key,
          id: existing?.id ?? crypto.randomUUID(),
          submitterPersonId: submitter?.id ?? null,
          expectedRevision: existing?.revision ?? null,
          expectedStatus: existing?.status ?? null,
        },
      };
    }
    if (resource === "sessions") {
      const key = String(values.slug);
      const existing = context.sessions?.[key];
      if (!context.sessionFormats?.[String(values.format)]) {
        return { errors: ["format is not configured for this event"] };
      }
      if (
        existing &&
        ["scheduled", "published", "archived"].includes(existing.status ?? "")
      ) {
        return {
          errors: [
            "the existing session is scheduled, published or archived; change its lifecycle through the schedule or bulk session workflow first",
          ],
        };
      }
      const trackSlug = values.trackSlug ? String(values.trackSlug) : null;
      if (trackSlug && !context.tracks?.[trackSlug]) {
        return { errors: ["trackSlug does not match a track in this event"] };
      }
      return {
        rowNumber,
        action: existing ? "update" : "create",
        values: {
          ...values,
          importKey: key,
          id: existing?.id ?? crypto.randomUUID(),
          trackId: trackSlug ? (context.tracks?.[trackSlug]?.id ?? null) : null,
          expectedRevision: existing?.revision ?? null,
          expectedStatus: existing?.status ?? null,
        },
      };
    }
    if (resource === "rooms") {
      const key = String(values.name).toLowerCase();
      const existing = context.rooms?.[key];
      if (existing?.ambiguous) {
        return {
          errors: [
            "name matches multiple existing rooms; make room names unique before importing",
          ],
        };
      }
      if (existing) {
        const errors = roomScheduleErrors(values, existing);
        if (errors.length) return { errors };
      }
      return {
        rowNumber,
        action: existing ? "update" : "create",
        values: {
          ...values,
          importKey: key,
          id: existing?.id ?? crypto.randomUUID(),
          expectedName: existing?.name ?? null,
          expectedBuilding: existing?.building ?? null,
          expectedLevel: existing?.level ?? null,
          expectedCapacity: existing?.capacity ?? null,
          expectedPosition: existing?.position ?? null,
          expectedStatus: existing?.status ?? null,
        },
      };
    }
    if (resource === "tracks") {
      const key = String(values.slug);
      return {
        rowNumber,
        action: context.tracks?.[key] ? "update" : "create",
        values: {
          ...values,
          importKey: key,
          id: context.tracks?.[key]?.id ?? crypto.randomUUID(),
          expectedName: context.tracks?.[key]?.name ?? null,
          expectedColour: context.tracks?.[key]?.colour ?? null,
          expectedPosition: context.tracks?.[key]?.position ?? null,
          expectedExclusive: context.tracks?.[key]?.exclusive ?? null,
          expectedPublic: context.tracks?.[key]?.public ?? null,
        },
      };
    }
    const key = values.id ? String(values.id) : crypto.randomUUID();
    const existingTask = context.tasks?.[key];
    if (existingTask && existingTask.eventId !== viewer.eventId) {
      return { errors: ["id is already owned by a task in another event"] };
    }
    if (!existingTask && values.status !== "not_started") {
      return {
        errors: [
          "a new task must start in not_started status; import later lifecycle changes against its assigned id",
        ],
      };
    }
    const statusTransition = existingTask
      ? importedTaskStatusTransition(
          existingTask,
          String(values.status),
          String(values.statusReason),
        )
      : ({ transition: "none" } as const);
    if ("error" in statusTransition) {
      return { errors: [statusTransition.error] };
    }
    const ownerEmail = values.ownerEmail
      ? String(values.ownerEmail).toLowerCase()
      : null;
    const owner = ownerEmail ? context.people?.[ownerEmail] : null;
    if (ownerEmail && (!owner || !owner.linked)) {
      return {
        errors: [
          "ownerEmail must identify a person already linked to this event",
        ],
      };
    }
    const targetType = String(values.targetType);
    const targetId = String(values.targetId);
    if (targetType === "event" && targetId !== viewer.eventId) {
      return { errors: [`event task targetId must be ${viewer.eventId}`] };
    }
    if (targetType === "session" && !context.sessionIds?.[targetId]) {
      return { errors: ["session task targetId does not match this event"] };
    }
    if (targetType === "speaker" && !context.speakerTargets?.[targetId]) {
      return {
        errors: [
          "speaker task targetId does not match a person linked to this event",
        ],
      };
    }
    return {
      rowNumber,
      action: existingTask ? "update" : "create",
      values: {
        ...values,
        importKey: key,
        id: key,
        ownerPersonId: owner?.id ?? null,
        expectedRevision: existingTask?.revision ?? null,
        expectedStatus: existingTask?.status ?? null,
        expectedTaskType: existingTask?.taskType ?? null,
        expectedDependenciesBlocked: existingTask?.dependenciesBlocked ?? null,
        expectedDependentAdvanced: existingTask?.dependentAdvanced ?? null,
        expectedSafeSubmittedEvidence:
          existingTask?.safeSubmittedEvidence ?? null,
        statusTransition: statusTransition.transition,
      },
    };
  }

  private async revalidate(
    viewer: Viewer,
    resource: EventImportResource,
    rows: NormalizedImportRow[],
  ) {
    const event = await this.env.DB.prepare(
      `SELECT session_formats_json AS sessionFormatsJson
         FROM events WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ sessionFormatsJson: string }>();
    if (!event)
      throw new DataImportStateError("The import event no longer exists.");
    const context = await this.validationContext(viewer, resource, {
      requestedTaskIds:
        resource === "tasks" ? rows.map((row) => String(row.values.id)) : [],
      requestedPersonEmails: requestedPersonEmails(
        resource,
        rows.map((row) => row.values),
      ),
      requestedSpeakerTargetIds: requestedSpeakerTargetIds(
        resource,
        rows.map((row) => row.values),
      ),
    });
    if (
      resource === "sessions" &&
      rows.some((row) => !context.sessionFormats?.[String(row.values.format)])
    ) {
      throw new DataImportStateError(
        "An imported session format was removed after preview. Create a new preview before confirming.",
      );
    }
    const changed = rows.some((row) => {
      const values = row.values;
      if (resource === "people") {
        const key = String(values.email).toLowerCase();
        const current = context.people?.[key];
        if (row.action === "create") return current !== undefined;
        return (
          !current ||
          current.id !== values.id ||
          current.revision !== values.expectedRevision ||
          current.linked !== values.expectedLinked ||
          Boolean(
            context.memberships?.[`${key}\u0000${String(values.role)}`],
          ) !== values.expectedRoleLinked
        );
      }
      if (resource === "submissions") {
        const current = context.submissions?.[String(values.publicReference)];
        const stale =
          row.action === "create"
            ? current !== undefined
            : !current ||
              current.id !== values.id ||
              current.revision !== values.expectedRevision ||
              current.status !== values.expectedStatus;
        const submitter = values.submitterEmail
          ? context.people?.[String(values.submitterEmail).toLowerCase()]
          : null;
        return (
          stale ||
          (values.submitterPersonId !== null &&
            (!submitter ||
              !submitter.linked ||
              submitter.id !== values.submitterPersonId))
        );
      }
      if (resource === "sessions") {
        const current = context.sessions?.[String(values.slug)];
        const formatExists = Boolean(
          context.sessionFormats?.[String(values.format)],
        );
        const track = values.trackSlug
          ? context.tracks?.[String(values.trackSlug)]
          : null;
        return (
          !formatExists ||
          (values.trackId !== null && track?.id !== values.trackId) ||
          (row.action === "create"
            ? current !== undefined
            : !current ||
              current.id !== values.id ||
              current.revision !== values.expectedRevision ||
              current.status !== values.expectedStatus ||
              !["unscheduled", "cancelled"].includes(current.status ?? ""))
        );
      }
      if (resource === "rooms") {
        const current = context.rooms?.[String(values.name).toLowerCase()];
        return row.action === "create"
          ? current !== undefined
          : !current ||
              current.ambiguous ||
              current.id !== values.id ||
              current.name !== values.expectedName ||
              current.building !== values.expectedBuilding ||
              current.level !== values.expectedLevel ||
              current.capacity !== values.expectedCapacity ||
              current.position !== values.expectedPosition ||
              current.status !== values.expectedStatus;
      }
      if (resource === "tracks") {
        const current = context.tracks?.[String(values.slug)];
        return row.action === "create"
          ? current !== undefined
          : !current ||
              current.id !== values.id ||
              current.name !== values.expectedName ||
              current.colour !== values.expectedColour ||
              current.position !== values.expectedPosition ||
              current.exclusive !== values.expectedExclusive ||
              current.public !== values.expectedPublic;
      }
      const current = context.tasks?.[String(values.id)];
      const owner = values.ownerEmail
        ? context.people?.[String(values.ownerEmail).toLowerCase()]
        : null;
      const targetExists =
        values.targetType === "event"
          ? values.targetId === viewer.eventId
          : values.targetType === "session"
            ? Boolean(context.sessionIds?.[String(values.targetId)])
            : Boolean(context.speakerTargets?.[String(values.targetId)]);
      return (
        (row.action === "create"
          ? current !== undefined
          : !current ||
            current.eventId !== viewer.eventId ||
            current.id !== values.id ||
            current.revision !== values.expectedRevision ||
            current.status !== values.expectedStatus ||
            current.taskType !== values.expectedTaskType ||
            current.dependenciesBlocked !==
              values.expectedDependenciesBlocked ||
            current.dependentAdvanced !== values.expectedDependentAdvanced ||
            current.safeSubmittedEvidence !==
              values.expectedSafeSubmittedEvidence) ||
        (values.ownerPersonId !== null &&
          (!owner || !owner.linked || owner.id !== values.ownerPersonId)) ||
        !targetExists
      );
    });
    if (changed) {
      throw new DataImportStateError(
        `An imported ${resource} record changed after preview. Create a new preview before confirming.`,
      );
    }
    if (resource === "rooms") {
      for (const row of rows) {
        if (row.action !== "update") continue;
        const current = context.rooms?.[String(row.values.name).toLowerCase()];
        if (!current) continue;
        const errors = roomScheduleErrors(row.values, current);
        if (errors.length) {
          throw new DataImportStateError(
            `An imported room no longer satisfies schedule constraints: ${errors.join("; ")}. Create a new preview before confirming.`,
          );
        }
      }
    }
  }

  private async configuredSessionFormats(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      `SELECT session_formats_json AS sessionFormatsJson
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ sessionFormatsJson: string }>();
    if (!event) {
      throw new DataImportStateError(
        "The import event is unavailable in the authorised organisation.",
      );
    }
    return this.parseConfiguredSessionFormats(event.sessionFormatsJson);
  }

  private parseConfiguredSessionFormats(value: string) {
    try {
      return parseSessionFormatsConfiguration(value);
    } catch (error) {
      throw new DataImportStateError(
        error instanceof Error
          ? error.message
          : "The event has invalid session-format configuration.",
      );
    }
  }

  private confirmationFreshnessGuard(resource: EventImportResource) {
    const itemScope = `item.operation_id = operation_jobs.id AND item.status = 'pending'`;
    if (resource === "people") {
      return `AND NOT EXISTS (
        SELECT 1
          FROM operation_items item
          LEFT JOIN people current
            ON lower(current.email) = lower(json_extract(item.result_json, '$.values.email'))
         WHERE ${itemScope}
           AND (
             (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
             OR
             (json_extract(item.result_json, '$.action') IN ('link','update') AND (
               current.id IS NULL
               OR current.id <> json_extract(item.result_json, '$.values.id')
               OR current.profile_revision <> json_extract(item.result_json, '$.values.expectedRevision')
               OR EXISTS (
                    SELECT 1 FROM memberships linked
                     WHERE linked.person_id = current.id
                       AND linked.event_id = operation_jobs.event_id
                       AND linked.accepted_at IS NOT NULL
                       AND linked.revoked_at IS NULL
                  ) <> json_extract(item.result_json, '$.values.expectedLinked')
               OR EXISTS (
                    SELECT 1 FROM memberships role_membership
                     WHERE role_membership.person_id = current.id
                       AND role_membership.event_id = operation_jobs.event_id
                       AND role_membership.role = json_extract(item.result_json, '$.values.role')
                       AND role_membership.revoked_at IS NULL
                  ) <> json_extract(item.result_json, '$.values.expectedRoleLinked')
             ))
           )
      )`;
    }
    if (resource === "submissions") {
      return `AND NOT EXISTS (
        SELECT 1
          FROM operation_items item
          LEFT JOIN submissions current
            ON current.event_id = operation_jobs.event_id
           AND current.public_reference = json_extract(item.result_json, '$.values.publicReference')
         WHERE ${itemScope}
           AND (
             (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
             OR
             (json_extract(item.result_json, '$.action') = 'update' AND (
               current.id IS NULL
               OR current.id <> json_extract(item.result_json, '$.values.id')
               OR current.revision <> json_extract(item.result_json, '$.values.expectedRevision')
               OR current.status <> 'draft'
               OR current.status <> json_extract(item.result_json, '$.values.expectedStatus')
             ))
             OR
             (json_extract(item.result_json, '$.values.submitterPersonId') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM memberships submitter_membership
                 WHERE submitter_membership.event_id = operation_jobs.event_id
                   AND submitter_membership.person_id = json_extract(item.result_json, '$.values.submitterPersonId')
                   AND submitter_membership.accepted_at IS NOT NULL
                   AND submitter_membership.revoked_at IS NULL
              ))
           )
      )`;
    }
    if (resource === "sessions") {
      return `AND NOT EXISTS (
        SELECT 1
          FROM operation_items item
          LEFT JOIN sessions current
            ON current.event_id = operation_jobs.event_id
           AND current.slug = json_extract(item.result_json, '$.values.slug')
         WHERE ${itemScope}
           AND (
             (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
             OR
             (json_extract(item.result_json, '$.action') = 'update' AND (
               current.id IS NULL
               OR current.id <> json_extract(item.result_json, '$.values.id')
               OR current.revision <> json_extract(item.result_json, '$.values.expectedRevision')
               OR current.status <> json_extract(item.result_json, '$.values.expectedStatus')
               OR current.status NOT IN ('unscheduled','cancelled')
             ))
             OR NOT EXISTS (
               SELECT 1 FROM events event, json_each(event.session_formats_json) format
                WHERE event.id = operation_jobs.event_id
                  AND event.organisation_id = operation_jobs.organisation_id
                  AND json_extract(format.value, '$.key') = json_extract(item.result_json, '$.values.format')
             )
             OR
             (json_extract(item.result_json, '$.values.trackId') IS NOT NULL
              AND NOT EXISTS (
                SELECT 1 FROM tracks track
                 WHERE track.event_id = operation_jobs.event_id
                   AND track.id = json_extract(item.result_json, '$.values.trackId')
                   AND track.slug = json_extract(item.result_json, '$.values.trackSlug')
              ))
           )
      )`;
    }
    if (resource === "rooms") {
      return `AND NOT EXISTS (
        SELECT 1
          FROM operation_items item
          LEFT JOIN rooms current
            ON current.event_id = operation_jobs.event_id
           AND lower(current.name) = lower(json_extract(item.result_json, '$.values.name'))
         WHERE ${itemScope}
           AND (
             (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
             OR
             (json_extract(item.result_json, '$.action') = 'update' AND (
               current.id IS NULL
               OR current.id <> json_extract(item.result_json, '$.values.id')
               OR current.name IS NOT json_extract(item.result_json, '$.values.expectedName')
               OR current.building IS NOT json_extract(item.result_json, '$.values.expectedBuilding')
               OR current.level IS NOT json_extract(item.result_json, '$.values.expectedLevel')
               OR current.capacity IS NOT json_extract(item.result_json, '$.values.expectedCapacity')
               OR current.position IS NOT json_extract(item.result_json, '$.values.expectedPosition')
               OR current.status IS NOT json_extract(item.result_json, '$.values.expectedStatus')
             ))
             OR
             (json_extract(item.result_json, '$.action') = 'update'
              AND json_extract(item.result_json, '$.values.status') = 'retired'
              AND json_extract(item.result_json, '$.values.expectedStatus') <> 'retired'
              AND EXISTS (
                SELECT 1
                  FROM schedule_entries entry
                  JOIN schedule_versions version
                    ON version.id = entry.schedule_version_id
                   AND version.event_id = entry.event_id
                 WHERE entry.event_id = operation_jobs.event_id
                   AND entry.room_id = json_extract(item.result_json, '$.values.id')
                   AND version.status IN ('draft','publishing','published')
              ))
             OR
             (json_extract(item.result_json, '$.action') = 'update'
              AND EXISTS (
                SELECT 1
                  FROM schedule_entries entry
                  JOIN schedule_versions version
                    ON version.id = entry.schedule_version_id
                   AND version.event_id = entry.event_id
                   AND version.status = 'published'
                  JOIN sessions session
                    ON session.id = entry.session_id
                   AND session.event_id = entry.event_id
                  JOIN schedule_policies policy
                    ON policy.event_id = entry.event_id
                   AND policy.capacity_action = 'block'
                 WHERE entry.event_id = operation_jobs.event_id
                   AND entry.room_id = json_extract(item.result_json, '$.values.id')
                   AND session.expected_attendance IS NOT NULL
                   AND session.expected_attendance > json_extract(item.result_json, '$.values.capacity')
              ))
           )
      )`;
    }
    if (resource === "tracks") {
      return `AND NOT EXISTS (
        SELECT 1
          FROM operation_items item
          LEFT JOIN tracks current
            ON current.event_id = operation_jobs.event_id
           AND current.slug = json_extract(item.result_json, '$.values.slug')
         WHERE ${itemScope}
           AND (
             (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
             OR
             (json_extract(item.result_json, '$.action') = 'update' AND (
               current.id IS NULL
               OR current.id <> json_extract(item.result_json, '$.values.id')
               OR current.name IS NOT json_extract(item.result_json, '$.values.expectedName')
               OR current.colour_token IS NOT json_extract(item.result_json, '$.values.expectedColour')
               OR current.position IS NOT json_extract(item.result_json, '$.values.expectedPosition')
               OR current.exclusive IS NOT json_extract(item.result_json, '$.values.expectedExclusive')
               OR current.is_public IS NOT json_extract(item.result_json, '$.values.expectedPublic')
             ))
           )
      )`;
    }
    return `AND NOT EXISTS (
      SELECT 1
        FROM operation_items item
        LEFT JOIN task_instances current
          ON current.event_id = operation_jobs.event_id
         AND current.id = json_extract(item.result_json, '$.values.id')
       WHERE ${itemScope}
         AND (
           (json_extract(item.result_json, '$.action') = 'create' AND EXISTS (
             SELECT 1 FROM task_instances collision
              WHERE collision.id = json_extract(item.result_json, '$.values.id')
           ))
           OR
           (json_extract(item.result_json, '$.action') = 'create' AND current.id IS NOT NULL)
           OR
           (json_extract(item.result_json, '$.action') = 'update' AND (
             current.id IS NULL
             OR current.revision <> json_extract(item.result_json, '$.values.expectedRevision')
             OR current.status <> json_extract(item.result_json, '$.values.expectedStatus')
             OR current.task_type <> json_extract(item.result_json, '$.values.expectedTaskType')
             OR EXISTS (
               SELECT 1
                 FROM task_instance_dependencies dependency
                 JOIN task_instances prerequisite
                   ON prerequisite.id = dependency.depends_on_task_id
                WHERE dependency.task_id = current.id
                  AND prerequisite.status NOT IN ('completed','waived')
             ) <> json_extract(item.result_json, '$.values.expectedDependenciesBlocked')
             OR EXISTS (
               SELECT 1
                 FROM task_instance_dependencies dependency
                 JOIN task_instances dependent ON dependent.id = dependency.task_id
                WHERE dependency.depends_on_task_id = current.id
                  AND dependent.status IN ('submitted','completed')
             ) <> json_extract(item.result_json, '$.values.expectedDependentAdvanced')
             OR EXISTS (
               SELECT 1
                 FROM task_evidence evidence
                 JOIN file_assets asset
                   ON asset.id = evidence.file_asset_id
                  AND asset.event_id = evidence.event_id
                 JOIN file_versions version
                   ON version.id = json_extract(evidence.evidence_json, '$.fileVersionId')
                  AND version.asset_id = asset.id
                  AND version.event_id = asset.event_id
                WHERE evidence.task_id = current.id
                  AND evidence.status = 'submitted'
                  AND asset.status = 'active'
                  AND version.scan_status = 'clean'
                  AND version.signature_status = 'valid'
                  AND version.released_at IS NOT NULL
             ) <> json_extract(item.result_json, '$.values.expectedSafeSubmittedEvidence')
           ))
           OR
           (json_extract(item.result_json, '$.values.ownerPersonId') IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM memberships owner_membership
               WHERE owner_membership.event_id = operation_jobs.event_id
                 AND owner_membership.person_id = json_extract(item.result_json, '$.values.ownerPersonId')
                 AND owner_membership.accepted_at IS NOT NULL
                 AND owner_membership.revoked_at IS NULL
            ))
           OR
           (json_extract(item.result_json, '$.values.targetType') = 'event'
            AND json_extract(item.result_json, '$.values.targetId') <> operation_jobs.event_id)
           OR
           (json_extract(item.result_json, '$.values.targetType') = 'session'
            AND NOT EXISTS (
              SELECT 1 FROM sessions target_session
               WHERE target_session.event_id = operation_jobs.event_id
                 AND target_session.id = json_extract(item.result_json, '$.values.targetId')
            ))
           OR
           (json_extract(item.result_json, '$.values.targetType') = 'speaker'
            AND NOT EXISTS (
              SELECT 1 FROM memberships target_membership
               WHERE target_membership.event_id = operation_jobs.event_id
                 AND target_membership.person_id = json_extract(item.result_json, '$.values.targetId')
                 AND target_membership.accepted_at IS NOT NULL
                 AND target_membership.revoked_at IS NULL
            ))
         )
    )`;
  }

  private mutationStatements(
    viewer: Viewer,
    operationId: string,
    resource: EventImportResource,
    row: NormalizedImportRow,
  ): D1PreparedStatement[] {
    const value = row.values;
    const operationGuard = `EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND event_id = ? AND organisation_id = ? AND status = 'running')`;
    if (resource === "people") {
      const person = this.env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, organisation_name, job_title,
           profile_status, last_operation_id, created_at, updated_at
         ) SELECT ?, ?, ?, 0, ?, ?, ?, ?, unixepoch(), unixepoch()
          WHERE ${operationGuard}
         ON CONFLICT(email) DO NOTHING`,
      ).bind(
        value.id,
        value.email,
        value.name,
        value.organisation,
        value.jobTitle,
        value.profileStatus,
        operationId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      );
      const membership = this.env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           invitation_expires_at, accepted_at, revoked_at, last_operation_id,
           created_at
         ) SELECT ?, ?, ?, ?, ?, unixepoch(), unixepoch() + 604800, NULL,
                  NULL, ?, unixepoch()
          WHERE ${operationGuard}
         ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
         DO UPDATE SET invited_at = unixepoch(),
                       invitation_expires_at = unixepoch() + 604800,
                       accepted_at = NULL, revoked_at = NULL,
                       last_operation_id = excluded.last_operation_id
          WHERE memberships.organisation_id = excluded.organisation_id
            AND (memberships.revoked_at IS NOT NULL
                 OR (memberships.accepted_at IS NULL
                     AND (memberships.invitation_expires_at IS NULL
                          OR memberships.invitation_expires_at <= unixepoch())))`,
      ).bind(
        value.membershipId,
        viewer.organisationId,
        viewer.eventId,
        value.id,
        value.role,
        operationId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
      );
      return [person, membership];
    }
    if (resource === "submissions") {
      return [
        this.env.DB.prepare(
          `INSERT INTO submissions (
           id, event_id, submitter_person_id, submitter_email, public_reference,
           title, category, format, status, answers_json, submitted_snapshot_json,
           revision, last_operation_id, submitted_at, created_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, 1, ?, ?, unixepoch(), unixepoch()
          WHERE ${operationGuard}
         ON CONFLICT(event_id, public_reference) DO UPDATE SET
           submitter_person_id = excluded.submitter_person_id,
           submitter_email = excluded.submitter_email, title = excluded.title,
           category = excluded.category, format = excluded.format,
           status = excluded.status, submitted_snapshot_json = excluded.submitted_snapshot_json,
           submitted_at = excluded.submitted_at, withdrawn_at = CASE WHEN excluded.status = 'withdrawn' THEN unixepoch() ELSE NULL END,
           revision = submissions.revision + 1, last_operation_id = excluded.last_operation_id,
           updated_at = unixepoch()
         WHERE submissions.id = excluded.id
           AND submissions.status = 'draft' AND excluded.status = 'draft'`,
        ).bind(
          value.id,
          viewer.eventId,
          value.submitterPersonId,
          value.submitterEmail,
          value.publicReference,
          value.title,
          value.category,
          value.format,
          value.status,
          null,
          operationId,
          null,
          operationId,
          viewer.eventId,
          viewer.organisationId,
        ),
      ];
    }
    if (resource === "sessions") {
      return [
        this.env.DB.prepare(
          `INSERT INTO sessions (
           id, event_id, track_id, title, slug, description, format,
           duration_minutes, expected_attendance, status, visibility,
           revision, created_at, updated_at
         ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, unixepoch(), unixepoch()
          WHERE ${operationGuard}
         ON CONFLICT(event_id, slug) DO UPDATE SET track_id = excluded.track_id,
           title = excluded.title, description = excluded.description,
           format = excluded.format, duration_minutes = excluded.duration_minutes,
           expected_attendance = excluded.expected_attendance, status = excluded.status,
           visibility = excluded.visibility, revision = sessions.revision + 1,
           updated_at = unixepoch()
         WHERE ? = 'update' AND sessions.id = excluded.id
           AND sessions.event_id = excluded.event_id
           AND sessions.revision = ? AND sessions.status = ?
           AND sessions.status IN ('unscheduled','cancelled')`,
        ).bind(
          value.id,
          viewer.eventId,
          value.trackId,
          value.title,
          value.slug,
          value.description,
          value.format,
          value.durationMinutes,
          value.expectedAttendance,
          value.status,
          value.visibility,
          operationId,
          viewer.eventId,
          viewer.organisationId,
          row.action,
          value.expectedRevision,
          value.expectedStatus,
        ),
      ];
    }
    if (resource === "rooms") {
      return [
        this.env.DB.prepare(
          `INSERT INTO rooms (id, event_id, name, building, level, capacity, resources_json, position, status)
         SELECT ?, ?, ?, ?, ?, ?, '[]', ?, ? WHERE ${operationGuard}
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, building = excluded.building,
           level = excluded.level, capacity = excluded.capacity, position = excluded.position,
           status = excluded.status WHERE rooms.event_id = excluded.event_id`,
        ).bind(
          value.id,
          viewer.eventId,
          value.name,
          value.building,
          value.level,
          value.capacity,
          value.position,
          value.status,
          operationId,
          viewer.eventId,
          viewer.organisationId,
        ),
      ];
    }
    if (resource === "tracks") {
      return [
        this.env.DB.prepare(
          `INSERT INTO tracks (id, event_id, name, slug, colour_token, position, exclusive, is_public)
         SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE ${operationGuard}
         ON CONFLICT(event_id, slug) DO UPDATE SET name = excluded.name,
           colour_token = excluded.colour_token, position = excluded.position,
           exclusive = excluded.exclusive, is_public = excluded.is_public`,
        ).bind(
          value.id,
          viewer.eventId,
          value.name,
          value.slug,
          value.colour,
          value.position,
          value.exclusive ? 1 : 0,
          value.public ? 1 : 0,
          operationId,
          viewer.eventId,
          viewer.organisationId,
        ),
      ];
    }
    const taskReadiness = readiness(String(value.status));
    const statusTransition = String(
      value.statusTransition,
    ) as TaskStatusTransition;
    const taskStatusAction =
      statusTransition === "progress"
        ? "task.status_imported"
        : `task.${statusTransition}`;
    return [
      this.env.DB.prepare(
        `INSERT INTO task_instances (
         id, event_id, target_type, target_id, owner_person_id, title, description,
         task_type, impact, status, readiness_state, readiness_percent, revision,
         last_operation_id, due_at, completed_at, completed_by_person_id,
         created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, 'checklist', ?, ?, ?, ?, 1, ?, ?,
                CASE WHEN ? IN ('completed','waived') THEN unixepoch() ELSE NULL END,
                CASE WHEN ? IN ('completed','waived') THEN ? ELSE NULL END,
                unixepoch(), unixepoch() WHERE ${operationGuard}
       ON CONFLICT(id) DO UPDATE SET target_type = excluded.target_type,
         target_id = excluded.target_id, owner_person_id = excluded.owner_person_id,
         title = excluded.title, description = excluded.description,
         impact = excluded.impact,
         status = CASE WHEN ? = 'none' THEN task_instances.status ELSE excluded.status END,
         readiness_state = CASE WHEN ? = 'none' THEN task_instances.readiness_state ELSE excluded.readiness_state END,
         readiness_percent = CASE WHEN ? = 'none' THEN task_instances.readiness_percent ELSE excluded.readiness_percent END,
         waiver_json = CASE
           WHEN ? = 'waive' THEN json_object('reason', ?, 'by', ?)
           WHEN ? IN ('complete','approve','reopen') THEN NULL
           ELSE task_instances.waiver_json
         END,
         completed_at = CASE
           WHEN ? IN ('complete','approve','waive') THEN unixepoch()
           WHEN ? = 'reopen' THEN NULL
           ELSE task_instances.completed_at
         END,
         completed_by_person_id = CASE
           WHEN ? IN ('complete','approve','waive') THEN ?
           WHEN ? = 'reopen' THEN NULL
           ELSE task_instances.completed_by_person_id
         END,
         last_operation_id = excluded.last_operation_id, due_at = excluded.due_at,
         revision = task_instances.revision + 1, updated_at = unixepoch()
         WHERE task_instances.event_id = excluded.event_id
           AND task_instances.revision = ? AND task_instances.status = ?`,
      ).bind(
        value.id,
        viewer.eventId,
        value.targetType,
        value.targetId,
        value.ownerPersonId,
        value.title,
        value.description,
        value.impact,
        value.status,
        taskReadiness.state,
        taskReadiness.percent,
        operationId,
        value.dueAt,
        value.status,
        value.status,
        viewer.personId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        statusTransition,
        statusTransition,
        statusTransition,
        statusTransition,
        value.statusReason,
        viewer.personId,
        statusTransition,
        statusTransition,
        statusTransition,
        statusTransition,
        viewer.personId,
        statusTransition,
        value.expectedRevision,
        value.expectedStatus,
      ),
      this.env.DB.prepare(
        `UPDATE task_evidence
            SET status = 'approved', reviewed_by_person_id = ?, reviewed_at = unixepoch()
          WHERE task_id = ? AND event_id = ? AND status = 'submitted'
            AND ? = 'approve'
            AND EXISTS (
              SELECT 1 FROM task_instances task
               WHERE task.id = task_evidence.task_id
                 AND task.event_id = task_evidence.event_id
                 AND task.revision = ? AND task.last_operation_id = ?
            )`,
      ).bind(
        viewer.personId,
        value.id,
        viewer.eventId,
        statusTransition,
        Number(value.expectedRevision) + 1,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, ?, 'task_instance', ?, ?, ?, unixepoch()
          WHERE ? <> 'none'
            AND EXISTS (
              SELECT 1 FROM task_instances task
               WHERE task.id = ? AND task.event_id = ?
                 AND task.revision = ? AND task.last_operation_id = ?
            )`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        taskStatusAction,
        value.id,
        operationId,
        JSON.stringify({
          source: "csv_import",
          beforeStatus: value.expectedStatus,
          afterStatus: value.status,
          reason: value.statusReason,
        }),
        statusTransition,
        value.id,
        viewer.eventId,
        Number(value.expectedRevision) + 1,
        operationId,
      ),
    ];
  }
}
