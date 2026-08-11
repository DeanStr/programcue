import { z } from "zod";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { submittedSnapshotSchema } from "~/modules/submissions/submission-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import { type WebhookEventResult } from "~/platform/operations/webhook-service.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
export {
  EvaluationDecisionAuthorityError,
  EvaluationDecisionFinalError,
  EvaluationInvitationDeliveryError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";

export type EvaluationApiActor = {
  kind: "api_key";
  organisationId: string;
  eventId: string;
  personId: null;
  actorId: string;
};

export type EvaluationAdminActor = Viewer | EvaluationApiActor;

export type EvaluationApiCommand = {
  idempotencyKey: string;
  requestHash: string;
  /** Internal authenticated callers may bind retries to the current person. */
  actorId?: string;
};

export type EvaluationAssignmentResult = {
  createdAssignmentCount: number;
  requestedAssignmentCount: number;
  undoOperationId: string | null;
  undoExpiresAt: number | null;
};

export type EvaluationAdvancementResult = {
  advancedSubmissionCount: number;
  assignmentCount: number;
};

export type EvaluationAdvancementExecutionResult =
  EvaluationAdvancementResult & {
    /** Missing for durable API commands so their route can reconcile retries. */
    webhookDeliveries?: WebhookEventResult[];
  };

export type EvaluationCommandScope =
  | "evaluation.plan.save"
  | "evaluation.round.add"
  | "evaluation.assign"
  | "evaluation.advance";

export type PreparedEvaluationCommand<T> = {
  actor: EvaluationApiActor;
  input: EvaluationApiCommand;
  recordId: string;
  scope: EvaluationCommandScope;
  resultSchema: z.ZodType<T>;
};

export const planCommandResultSchema = z.object({ planId: z.string().min(1) });

export const roundCommandResultSchema = z.object({
  roundId: z.string().min(1),
});

export const assignmentCommandResultSchema = z.object({
  createdAssignmentCount: z.number().int().nonnegative(),
  requestedAssignmentCount: z.number().int().positive(),
  undoOperationId: z.string().min(1).nullable(),
  undoExpiresAt: z.number().int().positive().nullable(),
});

export const advancementCommandResultSchema = z.object({
  advancedSubmissionCount: z.number().int().positive(),
  assignmentCount: z.number().int().positive(),
});

export function evaluationAuditActor(actor: EvaluationAdminActor) {
  return "kind" in actor
    ? { personId: null, actorId: actor.actorId }
    : { personId: actor.personId, actorId: null };
}

export type Criterion = {
  id: string;
  name: string;
  description: string | null;
  weightPercent: number;
  inputType: "scale_5" | "scale_10" | "yes_no" | "free_text";
  required: boolean;
  position: number;
};

export type Round = {
  id: string;
  name: string;
  roundNumber: number;
  status: string;
  revision: number;
  anonymous: boolean;
  criteria: Criterion[];
};

export function parseSubmittedSnapshot(snapshotJson: string | null) {
  let value: unknown;
  try {
    value = snapshotJson ? JSON.parse(snapshotJson) : null;
  } catch {
    value = null;
  }
  const snapshot = submittedSnapshotSchema.safeParse(value);
  return snapshot.success ? snapshot.data : null;
}

export function requireSubmittedSnapshot(
  submissionId: string,
  snapshotJson: string | null,
) {
  const snapshot = parseSubmittedSnapshot(snapshotJson);
  if (!snapshot) {
    throw new Error(
      `Submission ${submissionId} is missing its valid immutable submitted snapshot.`,
    );
  }
  return snapshot;
}

export function reviewerCanSeeSubmissionAttachment(
  snapshot: ReturnType<typeof requireSubmittedSnapshot>,
  assetId: string,
  versionId: string,
) {
  const uploadFields = Object.entries(snapshot.uploads).filter(
    ([, upload]) => upload.assetId === assetId,
  );
  return uploadFields.some(
    ([fieldId, upload]) =>
      upload.versionId === versionId &&
      snapshot.schema.fields.some(
        (field) =>
          field.id === fieldId && field.reviewVisibility === "reviewers",
      ),
  );
}

export function summaryAnswer(value: unknown) {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) {
    const items = value.filter(
      (item): item is string =>
        typeof item === "string" && Boolean(item.trim()),
    );
    return items.length ? items.join(", ") : null;
  }
  return null;
}

export const sessionReviewSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  sessionId: z.string().min(1),
  title: z.string().trim().min(1),
  description: z.string().nullable(),
  format: z.string().trim().min(1),
  durationMinutes: z.number().int().positive(),
  trackName: z.string().nullable(),
  speakers: z.array(
    z.object({
      name: z.string().trim().min(1),
      roleLabel: z.string().nullable(),
    }),
  ),
});

export function requireSessionReviewSnapshot(
  assignmentId: string,
  snapshotJson: string | null,
) {
  let value: unknown;
  try {
    value = snapshotJson ? JSON.parse(snapshotJson) : null;
  } catch {
    throw new Error(
      `Session assignment ${assignmentId} has an invalid immutable source snapshot.`,
    );
  }
  const snapshot = sessionReviewSnapshotSchema.safeParse(value);
  if (!snapshot.success) {
    throw new Error(
      `Session assignment ${assignmentId} is missing its valid immutable source snapshot.`,
    );
  }
  return snapshot.data;
}

export abstract class EvaluationServiceFoundation {
  protected readonly airtable;
  constructor(
    protected readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  protected async readAuthoritative<T>(
    actor: EvaluationAdminActor,
    read: () => Promise<T>,
  ) {
    await this.airtable.assertReadable(actor);
    return read();
  }

  protected async projectCommand<T>(
    actor: EvaluationAdminActor,
    operation: string,
    input: unknown,
    command: EvaluationApiCommand | undefined,
    execute: () => Promise<T>,
  ) {
    const idempotencyKey = command
      ? `airtable:${actor.eventId}:${operation}:api:${"kind" in actor ? actor.actorId : (command.actorId ?? actor.personId)}:${command.idempotencyKey}`
      : await airtableCommandKey(operation, actor, input);
    return this.airtable.executeIdempotent(
      {
        organisationId: actor.organisationId,
        eventId: actor.eventId,
        personId: actor.personId,
      },
      {
        idempotencyKey,
        operation,
        ...(command ? { requestHash: command.requestHash } : {}),
      },
      execute,
    );
  }

  protected async prepareApiCommand<T>(
    actor: EvaluationAdminActor,
    scope: EvaluationCommandScope,
    command: EvaluationApiCommand | undefined,
    resultSchema: z.ZodType<T>,
  ): Promise<{
    prepared: PreparedEvaluationCommand<T> | null;
    replay: T | null;
  }> {
    let idempotencyActor: EvaluationApiActor;
    if (!("kind" in actor)) {
      if (!command) return { prepared: null, replay: null };
      if (command.actorId !== `assistant:${actor.personId}`) {
        throw new EvaluationValidationError(
          "Internal evaluation idempotency must be bound to the authenticated person.",
        );
      }
      idempotencyActor = {
        kind: "api_key",
        organisationId: actor.organisationId,
        eventId: actor.eventId,
        personId: null,
        actorId: command.actorId,
      };
    } else {
      if (command?.actorId && command.actorId !== actor.actorId) {
        throw new EvaluationValidationError(
          "The evaluation idempotency actor does not match the authenticated API key.",
        );
      }
      idempotencyActor = actor;
    }
    if (
      !command ||
      !command.idempotencyKey.trim() ||
      command.idempotencyKey.length > 255 ||
      !command.requestHash.trim() ||
      command.requestHash.length > 255
    ) {
      throw new EvaluationValidationError(
        "API evaluation mutations require a valid Idempotency-Key and request hash.",
      );
    }
    const prepared: PreparedEvaluationCommand<T> = {
      actor: idempotencyActor,
      input: {
        idempotencyKey: command.idempotencyKey.trim(),
        requestHash: command.requestHash.trim(),
      },
      recordId: crypto.randomUUID(),
      scope,
      resultSchema,
    };
    const replay = await this.readApiCommand(prepared);
    return replay === null
      ? { prepared, replay: null }
      : { prepared: null, replay };
  }

  protected async readApiCommand<T>(
    command: PreparedEvaluationCommand<T>,
  ): Promise<T | null> {
    const row = await this.env.DB.prepare(
      `
      SELECT id, request_hash AS requestHash, status,
             response_json AS responseJson
        FROM idempotency_records
       WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
         AND scope = ? AND idempotency_key = ?
         AND expires_at > unixepoch()
    `,
    )
      .bind(
        command.actor.organisationId,
        command.actor.eventId,
        command.actor.actorId,
        command.scope,
        command.input.idempotencyKey,
      )
      .first<{
        id: string;
        requestHash: string;
        status: "processing" | "completed" | "failed";
        responseJson: string | null;
      }>();
    if (!row) return null;
    if (row.requestHash !== command.input.requestHash) {
      throw new EvaluationRevisionConflictError(
        "This Idempotency-Key was already used with a different evaluation request.",
      );
    }
    if (row.status !== "completed") {
      throw new EvaluationRevisionConflictError(
        "The evaluation request with this Idempotency-Key is still being processed.",
      );
    }
    let response: unknown;
    try {
      response = row.responseJson ? JSON.parse(row.responseJson) : null;
    } catch {
      throw new Error(
        "A completed evaluation idempotency record contains invalid JSON.",
      );
    }
    const parsed = command.resultSchema.safeParse(response);
    if (!parsed.success) {
      throw new Error(
        "A completed evaluation idempotency record is missing its durable result.",
      );
    }
    return parsed.data;
  }

  protected commandClaimStatements<T>(
    command: PreparedEvaluationCommand<T> | null,
  ) {
    if (!command) return [];
    return [
      this.env.DB.prepare(
        `
        DELETE FROM idempotency_records
         WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
           AND scope = ? AND idempotency_key = ?
           AND expires_at <= unixepoch()
      `,
      ).bind(
        command.actor.organisationId,
        command.actor.eventId,
        command.actor.actorId,
        command.scope,
        command.input.idempotencyKey,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO idempotency_records (
          id, organisation_id, event_id, actor_id, scope, idempotency_key,
          request_hash, status, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'processing',
                  unixepoch() + 2592000, unixepoch())
      `,
      ).bind(
        command.recordId,
        command.actor.organisationId,
        command.actor.eventId,
        command.actor.actorId,
        command.scope,
        command.input.idempotencyKey,
        command.input.requestHash,
      ),
    ];
  }

  protected commandGuard<T>(command: PreparedEvaluationCommand<T> | null) {
    return command
      ? {
          sql: `AND EXISTS (
            SELECT 1 FROM idempotency_records command
             WHERE command.id = ? AND command.organisation_id = ?
               AND command.event_id = ? AND command.actor_id = ?
               AND command.scope = ? AND command.idempotency_key = ?
               AND command.request_hash = ? AND command.status = 'processing'
          )`,
          bindings: [
            command.recordId,
            command.actor.organisationId,
            command.actor.eventId,
            command.actor.actorId,
            command.scope,
            command.input.idempotencyKey,
            command.input.requestHash,
          ],
        }
      : { sql: "", bindings: [] };
  }

  protected async recoverApiCommand<T>(
    command: PreparedEvaluationCommand<T> | null,
  ) {
    if (!command) return null;
    const row = await this.env.DB.prepare(
      `
      SELECT id, request_hash AS requestHash, status,
             response_json AS responseJson
        FROM idempotency_records
       WHERE organisation_id = ? AND event_id = ? AND actor_id = ?
         AND scope = ? AND idempotency_key = ?
         AND expires_at > unixepoch()
    `,
    )
      .bind(
        command.actor.organisationId,
        command.actor.eventId,
        command.actor.actorId,
        command.scope,
        command.input.idempotencyKey,
      )
      .first<{
        id: string;
        requestHash: string;
        status: "processing" | "completed" | "failed";
        responseJson: string | null;
      }>();
    if (row?.id === command.recordId && row.status === "processing") {
      await this.env.DB.prepare(
        `DELETE FROM idempotency_records
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND actor_id = ? AND status = 'processing'`,
      )
        .bind(
          command.recordId,
          command.actor.organisationId,
          command.actor.eventId,
          command.actor.actorId,
        )
        .run();
      return null;
    }
    return this.readApiCommand(command);
  }

  protected async assertViewerEvent(
    viewer: Pick<Viewer, "eventId" | "organisationId">,
  ) {
    const event = await this.env.DB.prepare(
      "SELECT id FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!event)
      throw new Error("Event not found in the authorised organisation.");
  }

  protected assertEvaluationManager(viewer: EvaluationAdminActor) {
    if ("kind" in viewer) {
      if (
        viewer.kind !== "api_key" ||
        !viewer.actorId.startsWith("api_key:") ||
        viewer.personId !== null
      ) {
        throw new Response("Invalid evaluation API actor.", { status: 403 });
      }
      return;
    }
    if (
      viewer.role !== "owner" &&
      viewer.role !== "administrator" &&
      viewer.role !== "committee_chair"
    ) {
      throw new Response("Evaluation administration is not authorised.", {
        status: 403,
      });
    }
  }

  protected assertEvaluationAccessAdministrator(viewer: Viewer) {
    if (viewer.role !== "owner" && viewer.role !== "administrator") {
      throw new Response(
        "Evaluation access administration is not authorised.",
        {
          status: 403,
        },
      );
    }
  }

  protected async resolveEvaluatorTarget(
    viewer: Pick<Viewer, "eventId">,
    teamId: string | null,
    explicitPersonIds: string[],
  ) {
    if (teamId) {
      const members = await this.env.DB.prepare(
        `
        SELECT tm.person_id AS personId
          FROM evaluation_team_members tm
          JOIN evaluation_teams t
            ON t.id = tm.team_id AND t.event_id = tm.event_id
          JOIN memberships m
            ON m.event_id = tm.event_id AND m.person_id = tm.person_id
         WHERE tm.event_id = ? AND tm.team_id = ? AND tm.removed_at IS NULL
           AND t.status = 'active' AND m.accepted_at IS NOT NULL
           AND m.revoked_at IS NULL
           AND m.role IN ('evaluator','committee_chair')
         ORDER BY tm.person_id
      `,
      )
        .bind(viewer.eventId, teamId)
        .all<{ personId: string }>();
      const evaluatorPersonIds = members.results.map(
        (member) => member.personId,
      );
      if (evaluatorPersonIds.length === 0) {
        throw new EvaluationStateError(
          "The selected evaluation team has no active authorised members.",
        );
      }
      return evaluatorPersonIds;
    }
    const evaluatorPersonIds = [...new Set(explicitPersonIds)];
    const validEvaluators = await this.env.DB.prepare(
      `SELECT DISTINCT person_id AS id FROM memberships WHERE event_id = ? AND accepted_at IS NOT NULL AND revoked_at IS NULL AND role IN ('evaluator','committee_chair') AND person_id IN (${evaluatorPersonIds.map(() => "?").join(",")})`,
    )
      .bind(viewer.eventId, ...evaluatorPersonIds)
      .all<{ id: string }>();
    if (validEvaluators.results.length !== evaluatorPersonIds.length) {
      throw new EvaluationStateError(
        "One or more evaluators are not authorised for this event.",
      );
    }
    return evaluatorPersonIds;
  }
}
