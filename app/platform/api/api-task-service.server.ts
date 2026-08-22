import { z } from "zod";
import { requireValue } from "~/lib/required-value";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import {
  assignedTaskConfigurationSchema,
  suggestedTaskEvidenceMode,
  taskDestinationUrlSchema,
  taskFileKindSchema,
  taskFileScopeSchema,
} from "~/modules/tasks/task-schema";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { ApiError, type ApiPrincipal, apiRequestHash } from "./api.server";

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

type ApiTaskRow = {
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

type TaskCreationCommand = {
  requestHash: string;
  status: string;
  responseJson: string | null;
  entityId: string | null;
};

type RecoveredTaskCreation = Omit<ApiTaskMutation, "webhookDeliveries"> & {
  correlationId: string;
};

type EventPrincipal = ApiPrincipal & { eventId: string };

function apiActorId(keyId: string) {
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

function encodeTaskCursor(row: ApiTaskRow) {
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

function decodeTaskCursor(value: string): TaskCursor {
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

function toApiTask(row: ApiTaskRow, dependencyIds: string[]): ApiTask {
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

export class ApiTaskService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  private async taskCreationCommand(
    principal: EventPrincipal,
    idempotencyKey: string,
  ) {
    return this.env.DB.prepare(
      `
      SELECT request_hash AS requestHash, status, response_json AS responseJson,
             entity_id AS entityId
        FROM idempotency_records
       WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
         AND scope = 'task.create' AND idempotency_key = ?
         AND expires_at > unixepoch()
    `,
    )
      .bind(
        principal.organisationId,
        principal.eventId,
        apiActorId(principal.keyId),
        idempotencyKey,
      )
      .first<TaskCreationCommand>();
  }

  private async replayTaskCreation(
    principal: EventPrincipal,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<RecoveredTaskCreation | null> {
    const command = await this.taskCreationCommand(principal, idempotencyKey);
    if (!command) return null;
    if (command.requestHash !== requestHash) {
      throw new ApiError(
        409,
        "IDEMPOTENCY_KEY_REUSED",
        "This Idempotency-Key was already used with a different task request",
      );
    }
    if (command.status !== "completed") {
      throw new ApiError(
        409,
        "IDEMPOTENCY_REQUEST_IN_PROGRESS",
        "The task request with this Idempotency-Key is still being processed",
      );
    }
    const response = z
      .object({
        changeSequence: z.number().int().positive(),
        correlationId: z.string().min(1).max(200),
      })
      .safeParse(
        command.responseJson ? JSON.parse(command.responseJson) : null,
      );
    if (!response.success || !command.entityId) {
      throw new Error(
        "The completed task idempotency record is missing its durable result.",
      );
    }
    const task = await this.getD1(principal, command.entityId);
    if (!task) {
      throw new Error(
        "The task recorded by the completed idempotency request no longer exists.",
      );
    }
    return {
      task,
      changeSequence: response.data.changeSequence,
      correlationId: response.data.correlationId,
    };
  }

  private taskCreatedWebhook(
    principal: EventPrincipal,
    task: Pick<ApiTask, "id" | "title" | "targetType" | "targetId">,
    correlationId: string,
  ) {
    return {
      actor: {
        organisationId: principal.organisationId,
        eventId: principal.eventId,
        personId: null,
        actorId: apiActorId(principal.keyId),
      },
      event: {
        eventType: "task.created" as const,
        entityType: "task",
        entityId: task.id,
        idempotencyKey: `task.created:${task.id}:1`,
        correlationId,
        data: {
          title: task.title,
          targetType: task.targetType,
          targetId: task.targetId,
        },
      },
    };
  }

  async list(
    principal: EventPrincipal,
    input: { limit: number; cursor?: string },
  ): Promise<ApiTaskPage> {
    await this.airtable.assertReadable(principal);
    const { limit } = input;
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ApiError(
        422,
        "VALIDATION_ERROR",
        "limit must be a whole number from 1 to 200",
      );
    }
    const cursor = input.cursor ? decodeTaskCursor(input.cursor) : null;
    const cursorPredicate = cursor
      ? cursor.dueAt === null
        ? `AND ti.due_at IS NULL
             AND (ti.created_at > ? OR (ti.created_at = ? AND ti.id > ?))`
        : `AND (
               ti.due_at IS NULL OR ti.due_at > ?
               OR (ti.due_at = ? AND (
                 ti.created_at > ? OR (ti.created_at = ? AND ti.id > ?)
               ))
             )`
      : "";
    const cursorBindings = cursor
      ? cursor.dueAt === null
        ? [cursor.createdAt, cursor.createdAt, cursor.id]
        : [
            cursor.dueAt,
            cursor.dueAt,
            cursor.createdAt,
            cursor.createdAt,
            cursor.id,
          ]
      : [];
    const tasks = await this.env.DB.prepare(
      `
      SELECT ti.id, ti.template_id AS templateId, ti.target_type AS targetType,
             ti.target_id AS targetId, ti.owner_person_id AS ownerPersonId,
             p.display_name AS ownerName, ti.title, ti.description,
             ti.task_type AS taskType, ti.impact,
             ti.configuration_json AS configurationJson,
             CASE
               WHEN ti.status IN ('not_started','in_progress')
                 AND ti.due_at IS NOT NULL AND ti.due_at < unixepoch()
               THEN 'overdue' ELSE ti.status
             END AS status,
             CASE
               WHEN ti.status IN ('not_started','in_progress')
                 AND ti.due_at IS NOT NULL AND ti.due_at < unixepoch()
               THEN 'overdue' ELSE ti.readiness_state
             END AS readinessState,
             CASE
               WHEN ti.status IN ('not_started','in_progress')
                 AND ti.due_at IS NOT NULL AND ti.due_at < unixepoch()
               THEN 0 ELSE ti.readiness_percent
             END AS readinessPercent, ti.revision,
             ti.due_at AS dueAt, ti.evidence_json AS evidenceJson,
             ti.waiver_json AS waiverJson, ti.submitted_at AS submittedAt,
             ti.completed_at AS completedAt, ti.created_at AS createdAt,
             ti.updated_at AS updatedAt
        FROM task_instances ti
        JOIN events e ON e.id = ti.event_id AND e.organisation_id = ?
        LEFT JOIN people p ON p.id = ti.owner_person_id
       WHERE ti.event_id = ?
       ${cursorPredicate}
       ORDER BY ti.due_at IS NULL, ti.due_at, ti.created_at, ti.id
       LIMIT ?
    `,
    )
      .bind(
        principal.organisationId,
        principal.eventId,
        ...cursorBindings,
        limit + 1,
      )
      .all<ApiTaskRow>();
    const pageRows = tasks.results.slice(0, limit);
    const ids = pageRows.map((task) => task.id);
    const dependencies = ids.length
      ? await this.env.DB.prepare(
          `
          SELECT task_id AS taskId, depends_on_task_id AS dependencyId
            FROM task_instance_dependencies
           WHERE task_id IN (
             SELECT CAST(value AS TEXT) FROM json_each(?)
           )
           ORDER BY task_id, depends_on_task_id
        `,
        )
          .bind(JSON.stringify(ids))
          .all<{ taskId: string; dependencyId: string }>()
      : { results: [] as Array<{ taskId: string; dependencyId: string }> };
    return {
      tasks: pageRows.map((task) =>
        toApiTask(
          task,
          dependencies.results
            .filter((dependency) => dependency.taskId === task.id)
            .map((dependency) => dependency.dependencyId),
        ),
      ),
      nextCursor:
        tasks.results.length > limit
          ? encodeTaskCursor(
              requireValue(
                pageRows.at(-1),
                "Required pageRows.at(-1) is unavailable.",
              ),
            )
          : null,
    };
  }

  async get(principal: EventPrincipal, id: string): Promise<ApiTask | null> {
    await this.airtable.assertReadable(principal);
    return this.getD1(principal, id);
  }

  private async getD1(
    principal: EventPrincipal,
    id: string,
  ): Promise<ApiTask | null> {
    const task = await this.env.DB.prepare(
      `
      SELECT ti.id, ti.template_id AS templateId, ti.target_type AS targetType,
             ti.target_id AS targetId, ti.owner_person_id AS ownerPersonId,
             p.display_name AS ownerName, ti.title, ti.description,
             ti.task_type AS taskType, ti.impact,
             ti.configuration_json AS configurationJson, ti.status,
             ti.readiness_state AS readinessState,
             ti.readiness_percent AS readinessPercent, ti.revision,
             ti.due_at AS dueAt, ti.evidence_json AS evidenceJson,
             ti.waiver_json AS waiverJson, ti.submitted_at AS submittedAt,
             ti.completed_at AS completedAt, ti.created_at AS createdAt,
             ti.updated_at AS updatedAt
        FROM task_instances ti
        JOIN events e ON e.id = ti.event_id AND e.organisation_id = ?
        LEFT JOIN people p ON p.id = ti.owner_person_id
       WHERE ti.event_id = ? AND ti.id = ?
    `,
    )
      .bind(principal.organisationId, principal.eventId, id)
      .first<ApiTaskRow>();
    if (!task) return null;
    const dependencies = await this.env.DB.prepare(
      `
      SELECT depends_on_task_id AS dependencyId
        FROM task_instance_dependencies
       WHERE task_id = ?
       ORDER BY depends_on_task_id
    `,
    )
      .bind(id)
      .all<{ dependencyId: string }>();
    return toApiTask(
      task,
      dependencies.results.map((row) => row.dependencyId),
    );
  }

  async create(
    principal: EventPrincipal,
    rawInput: unknown,
    correlationId: string,
    idempotencyKey: string,
  ): Promise<ApiTaskMutation> {
    const input = apiTaskCreateSchema.parse(rawInput);
    const requestHash = await apiRequestHash(input);
    return this.airtable.executeIdempotent(
      {
        organisationId: principal.organisationId,
        eventId: principal.eventId,
        personId: null,
      },
      {
        idempotencyKey: `airtable:${principal.eventId}:task.api.create:api-key:${principal.keyId}:${idempotencyKey}`,
        operation: "task.api.create",
        requestHash,
      },
      () =>
        this.createD1(
          principal,
          input,
          correlationId,
          idempotencyKey,
          requestHash,
        ),
    );
  }

  private async createD1(
    principal: EventPrincipal,
    input: ApiTaskCreateInput,
    correlationId: string,
    idempotencyKey: string,
    requestHash: string,
  ): Promise<ApiTaskMutation> {
    const replay = await this.replayTaskCreation(
      principal,
      idempotencyKey,
      requestHash,
    );
    if (replay) {
      const webhook = this.taskCreatedWebhook(
        principal,
        replay.task,
        replay.correlationId,
      );
      return {
        task: replay.task,
        changeSequence: replay.changeSequence,
        webhookDeliveries: await new WebhookService(this.env).queueEvent(
          webhook.actor,
          webhook.event,
        ),
      };
    }
    await this.assertReferences(principal, input);
    const id = crypto.randomUUID();
    const commandId = crypto.randomUUID();
    const actorId = apiActorId(principal.keyId);
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const taskWebhook = this.taskCreatedWebhook(
      principal,
      {
        id,
        targetType: input.targetType,
        targetId: input.targetId,
        title: input.title,
      },
      correlationId,
    );
    const preparedWebhook = await webhookService.prepareEventForAudit(
      taskWebhook.actor,
      taskWebhook.event,
      auditEventId,
    );
    const now = Math.floor(Date.now() / 1_000);
    const dependencyStateSql = input.dependencyIds.length
      ? `EXISTS (
          SELECT 1 FROM task_instances dependency
           WHERE dependency.event_id = ?
             AND dependency.id IN (
               SELECT CAST(value AS TEXT) FROM json_each(?)
             )
             AND dependency.status NOT IN ('completed','waived')
        )`
      : "0";
    const dependencyStateBindings = input.dependencyIds.length
      ? [principal.eventId, JSON.stringify(input.dependencyIds)]
      : [];
    const targetGuardSql =
      input.targetType === "session"
        ? `AND EXISTS (
             SELECT 1 FROM sessions current_target
              WHERE current_target.event_id = ? AND current_target.id = ?
           )`
        : input.targetType === "speaker"
          ? `AND (
               EXISTS (
                 SELECT 1 FROM memberships current_target_membership
                  WHERE current_target_membership.event_id = ?
                    AND current_target_membership.person_id = ?
                    AND current_target_membership.role = 'speaker'
                    AND current_target_membership.accepted_at IS NOT NULL
                    AND current_target_membership.revoked_at IS NULL
               )
               OR EXISTS (
                 SELECT 1 FROM session_speakers current_target_relationship
                  WHERE current_target_relationship.event_id = ?
                    AND current_target_relationship.person_id = ?
                    AND current_target_relationship.participation_status IN ('pending','confirmed')
               )
             )`
          : "";
    const targetGuardBindings =
      input.targetType === "session"
        ? [principal.eventId, input.targetId]
        : input.targetType === "speaker"
          ? [
              principal.eventId,
              input.targetId,
              principal.eventId,
              input.targetId,
            ]
          : [];
    const ownerGuardSql = input.ownerPersonId
      ? input.targetType === "session"
        ? `AND EXISTS (
             SELECT 1 FROM session_speakers current_owner_relationship
              WHERE current_owner_relationship.event_id = ?
                AND current_owner_relationship.session_id = ?
                AND current_owner_relationship.person_id = ?
                AND current_owner_relationship.participation_status IN ('pending','confirmed')
           )`
        : `AND (
             EXISTS (
               SELECT 1 FROM memberships current_owner_membership
                WHERE current_owner_membership.event_id = ?
                  AND current_owner_membership.person_id = ?
                  AND current_owner_membership.accepted_at IS NOT NULL
                  AND current_owner_membership.revoked_at IS NULL
             )
             OR EXISTS (
               SELECT 1 FROM session_speakers current_owner_relationship
                WHERE current_owner_relationship.event_id = ?
                  AND current_owner_relationship.person_id = ?
                  AND current_owner_relationship.participation_status IN ('pending','confirmed')
             )
           )`
      : "";
    const ownerGuardBindings = input.ownerPersonId
      ? input.targetType === "session"
        ? [principal.eventId, input.targetId, input.ownerPersonId]
        : [
            principal.eventId,
            input.ownerPersonId,
            principal.eventId,
            input.ownerPersonId,
          ]
      : [];
    const statements = [
      this.env.DB.prepare(
        `
        DELETE FROM idempotency_records
         WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
           AND scope = 'task.create' AND idempotency_key = ?
           AND expires_at <= unixepoch()
      `,
      ).bind(
        principal.organisationId,
        principal.eventId,
        actorId,
        idempotencyKey,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO idempotency_records (
          id, organisation_id, event_id, actor_id, scope, idempotency_key,
          request_hash, status, expires_at, created_at
        ) VALUES (?, ?, ?, ?, 'task.create', ?, ?, 'processing',
                  unixepoch() + 2592000, unixepoch())
      `,
      ).bind(
        commandId,
        principal.organisationId,
        principal.eventId,
        actorId,
        idempotencyKey,
        requestHash,
      ),
      this.env.DB.prepare(
        `
        WITH dependency_state(blocked) AS (SELECT ${dependencyStateSql})
        INSERT INTO task_instances (
          id, event_id, target_type, target_id, owner_person_id, title,
          description, task_type, impact, evidence_mode, configuration_json,
          status, readiness_state,
          readiness_percent, revision, idempotency_key, due_at, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
               CASE
                 WHEN blocked THEN 'blocked'
                 WHEN ? IS NOT NULL AND ? < ? THEN 'overdue'
                 ELSE 'not_started'
               END,
               CASE
                 WHEN blocked THEN 'blocked'
                 WHEN ? IS NOT NULL AND ? < ? THEN 'overdue'
                 ELSE 'on_track'
               END,
               0, 1, ?, ?, unixepoch(), unixepoch()
          FROM dependency_state
         WHERE EXISTS (
           SELECT 1 FROM idempotency_records command
            WHERE command.id = ? AND command.organisation_id = ?
              AND command.event_id = ? AND command.actor_id = ?
              AND command.scope = 'task.create'
              AND command.idempotency_key = ?
              AND command.request_hash = ? AND command.status = 'processing'
         )
         ${targetGuardSql}
         ${ownerGuardSql}
      `,
      ).bind(
        ...dependencyStateBindings,
        id,
        principal.eventId,
        input.targetType,
        input.targetId,
        input.ownerPersonId,
        input.title,
        input.description,
        input.taskType,
        input.impact,
        suggestedTaskEvidenceMode(input.taskType),
        JSON.stringify(input.configuration),
        input.dueAt,
        input.dueAt,
        now,
        input.dueAt,
        input.dueAt,
        now,
        commandId,
        input.dueAt,
        commandId,
        principal.organisationId,
        principal.eventId,
        actorId,
        idempotencyKey,
        requestHash,
        ...targetGuardBindings,
        ...ownerGuardBindings,
      ),
      atomicBatchGuardStatement(
        this.env,
        `EXISTS (
           SELECT 1 FROM idempotency_records command
            WHERE command.id = ? AND command.organisation_id = ?
              AND command.event_id = ? AND command.actor_id = ?
              AND command.scope = 'task.create'
              AND command.idempotency_key = ?
              AND command.request_hash = ? AND command.status = 'processing'
         ) AND NOT EXISTS (
           SELECT 1 FROM task_instances task
            WHERE task.id = ? AND task.event_id = ?
              AND task.idempotency_key = ?
         )`,
        [
          commandId,
          principal.organisationId,
          principal.eventId,
          actorId,
          idempotencyKey,
          requestHash,
          id,
          principal.eventId,
          commandId,
        ],
      ),
      ...(input.dependencyIds.length
        ? [
            this.env.DB.prepare(
              `
              INSERT INTO task_instance_dependencies (
                task_id, depends_on_task_id, created_at
              )
              SELECT ?, CAST(requested.value AS TEXT), unixepoch()
                FROM json_each(?) requested
               WHERE EXISTS (
                 SELECT 1 FROM task_instances
                  WHERE id = ? AND event_id = ? AND idempotency_key = ?
               )
            `,
            ).bind(
              id,
              JSON.stringify(input.dependencyIds),
              id,
              principal.eventId,
              commandId,
            ),
          ]
        : []),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id,
          action, entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, 'api_key', 'api', 1, ?, ?, NULL, ?, 'task.created', 'task_instance', ?, ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM task_instances
              WHERE id = ? AND event_id = ? AND idempotency_key = ?
           )
      `,
      ).bind(
        auditEventId,
        principal.organisationId,
        principal.eventId,
        actorId,
        id,
        correlationId,
        JSON.stringify({
          targetType: input.targetType,
          targetId: input.targetId,
          ownerPersonId: input.ownerPersonId,
          taskType: input.taskType,
          impact: input.impact,
          dependencyIds: input.dependencyIds,
        }),
        id,
        principal.eventId,
        commandId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO event_changes (
          event_id, entity_type, entity_id, change_type, correlation_id, created_at
        ) SELECT ?, 'task_instance', ?, 'created', ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM task_instances
              WHERE id = ? AND event_id = ? AND idempotency_key = ?
           )
        RETURNING sequence
      `,
      ).bind(
        principal.eventId,
        id,
        correlationId,
        id,
        principal.eventId,
        commandId,
      ),
      this.env.DB.prepare(
        `
        UPDATE idempotency_records
           SET status = (
                 SELECT 'completed'
                   FROM task_instances task
                   JOIN event_changes committed_change
                     ON committed_change.event_id = task.event_id
                    AND committed_change.entity_type = 'task_instance'
                    AND committed_change.entity_id = task.id
                    AND committed_change.change_type = 'created'
                    AND committed_change.correlation_id = ?
                  WHERE task.id = ? AND task.event_id = ?
                    AND task.idempotency_key = idempotency_records.id
               ),
               response_status = 201,
               response_json = json_object(
                 'changeSequence', (
                   SELECT sequence FROM event_changes
                    WHERE event_id = ? AND entity_type = 'task_instance'
                      AND entity_id = ? AND change_type = 'created'
                      AND correlation_id = ?
                    ORDER BY sequence DESC LIMIT 1
                 ),
                 'correlationId', ?
               ),
               entity_type = 'task_instance', entity_id = ?,
               completed_at = unixepoch()
         WHERE id = ? AND organisation_id = ? AND event_id = ?
           AND actor_id = ? AND scope = 'task.create'
           AND idempotency_key = ? AND request_hash = ?
           AND status = 'processing'
      `,
      ).bind(
        correlationId,
        id,
        principal.eventId,
        principal.eventId,
        id,
        correlationId,
        correlationId,
        id,
        commandId,
        principal.organisationId,
        principal.eventId,
        actorId,
        idempotencyKey,
        requestHash,
      ),
    ];
    statements.push(...preparedWebhook.statements);
    try {
      await this.env.DB.batch(statements);
    } catch (error) {
      if (isAtomicBatchGuardError(error)) {
        throw new ApiError(
          409,
          "TASK_REFERENCE_CONFLICT",
          "The task target or owner changed while the task was being created. Refresh and try again.",
        );
      }
      throw error;
    }
    const committed = await this.replayTaskCreation(
      principal,
      idempotencyKey,
      requestHash,
    );
    if (!committed) {
      throw new Error("Task creation did not commit an idempotency result.");
    }
    const webhookDeliveries =
      await webhookService.dispatchPreparedEvent(preparedWebhook);
    return {
      task: committed.task,
      changeSequence: committed.changeSequence,
      webhookDeliveries,
    };
  }

  private async assertReferences(
    principal: EventPrincipal,
    input: ApiTaskCreateInput,
  ) {
    const event = await this.env.DB.prepare(
      `
      SELECT id FROM events WHERE id = ? AND organisation_id = ?
    `,
    )
      .bind(principal.eventId, principal.organisationId)
      .first<{ id: string }>();
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");

    let targetExists = false;
    if (input.targetType === "event")
      targetExists = input.targetId === principal.eventId;
    if (input.targetType === "session") {
      targetExists = Boolean(
        await this.env.DB.prepare(
          "SELECT 1 FROM sessions WHERE id = ? AND event_id = ?",
        )
          .bind(input.targetId, principal.eventId)
          .first(),
      );
    }
    if (input.targetType === "speaker") {
      targetExists = Boolean(
        await this.env.DB.prepare(
          `
        SELECT 1 FROM memberships
         WHERE event_id = ? AND person_id = ? AND role = 'speaker'
           AND accepted_at IS NOT NULL AND revoked_at IS NULL
        UNION
        SELECT 1 FROM session_speakers
         WHERE event_id = ? AND person_id = ?
           AND participation_status IN ('pending','confirmed')
        LIMIT 1
      `,
        )
          .bind(
            principal.eventId,
            input.targetId,
            principal.eventId,
            input.targetId,
          )
          .first(),
      );
    }
    if (!targetExists)
      throw new ApiError(
        422,
        "INVALID_TASK_TARGET",
        "The task target is not available in the authorised event",
      );

    if (input.ownerPersonId) {
      const sessionTarget = input.targetType === "session";
      const owner = sessionTarget
        ? await this.env.DB.prepare(
            `SELECT 1 FROM session_speakers
              WHERE event_id = ? AND session_id = ? AND person_id = ?
                AND participation_status IN ('pending','confirmed')
              LIMIT 1`,
          )
            .bind(principal.eventId, input.targetId, input.ownerPersonId)
            .first()
        : await this.env.DB.prepare(
            `SELECT 1 FROM memberships
              WHERE event_id = ? AND person_id = ?
                AND accepted_at IS NOT NULL AND revoked_at IS NULL
             UNION
             SELECT 1 FROM session_speakers
              WHERE event_id = ? AND person_id = ?
                AND participation_status IN ('pending','confirmed')
             LIMIT 1`,
          )
            .bind(
              principal.eventId,
              input.ownerPersonId,
              principal.eventId,
              input.ownerPersonId,
            )
            .first();
      if (!owner)
        throw new ApiError(
          422,
          "INVALID_TASK_OWNER",
          sessionTarget
            ? "A session-targeted task owner must be assigned to the target session"
            : "The task owner is not available in the authorised event",
        );
    }

    if (input.dependencyIds.length) {
      const dependencies = await this.env.DB.prepare(
        `
        SELECT COUNT(*) AS count FROM task_instances
         WHERE event_id = ?
           AND id IN (SELECT CAST(value AS TEXT) FROM json_each(?))
      `,
      )
        .bind(principal.eventId, JSON.stringify(input.dependencyIds))
        .first<{ count: number }>();
      if (Number(dependencies?.count ?? 0) !== input.dependencyIds.length) {
        throw new ApiError(
          422,
          "INVALID_TASK_DEPENDENCY",
          "One or more task dependencies are not available in the authorised event",
        );
      }
    }
  }
}
