import { z } from "zod";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import {
  reviewerVisibleAnswers,
  submittedSnapshotSchema,
} from "~/modules/submissions/submission-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import type { WebhookEventResult } from "~/platform/operations/webhook-service.server";
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

export type EvaluationReviewCycleResult = {
  archivedPlanId: string;
  planId: string;
  roundId: string;
  unfinishedAssignmentCount: number;
  unfinishedReviewCount: number;
};

export type EvaluationRoundReviewerResult = {
  roundId: string;
  personId: string;
  operation: "add" | "remove";
  cancelledAssignmentCount: number;
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
  | "evaluation.round_reviewer.change"
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

export const roundReviewerCommandResultSchema = z.object({
  roundId: z.string().min(1),
  personId: z.string().min(1),
  operation: z.enum(["add", "remove"]),
  cancelledAssignmentCount: z.number().int().nonnegative(),
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
    ? {
        personId: null,
        actorId: actor.actorId,
        actorKind: "api_key" as const,
        origin: "api" as const,
      }
    : {
        personId: actor.personId,
        actorId: null,
        actorKind: "person" as const,
        origin: "admin_ui" as const,
      };
}

export type Criterion = {
  id: string;
  name: string;
  description: string | null;
  weightPercent: number;
  inputType: "scale_5" | "scale_10" | "yes_no" | "free_text" | "dropdown";
  options: string[];
  required: boolean;
  position: number;
};

export type RubricShape = {
  name: string;
  description: string | null;
  inputType: string;
  options: readonly string[];
  weightPercent: number;
  required: boolean | number;
  position: number;
};

export type PersistedRubricShape = Omit<RubricShape, "options"> & {
  optionsJson: string;
};

export function rubricSignature(criteria: readonly RubricShape[]) {
  return JSON.stringify(
    [...criteria]
      .sort((left, right) => left.position - right.position)
      .map((criterion) => ({
        name: criterion.name.trim(),
        description: criterion.description?.trim() ?? "",
        inputType: criterion.inputType,
        options: criterion.options.map((option) => option.trim()),
        weightPercent: Number(criterion.weightPercent),
        required: Boolean(criterion.required),
        position: criterion.position,
      })),
  );
}

export function parsePersistedRubricOptions(
  optionsJson: string,
  criterionName: string,
  inputType: string,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(optionsJson);
  } catch {
    throw new EvaluationStateError(
      `Criterion ${criterionName} has invalid persisted scorecard options.`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((option) => typeof option !== "string" || !option.trim())
  ) {
    throw new EvaluationStateError(
      `Criterion ${criterionName} has invalid persisted scorecard options.`,
    );
  }
  if (inputType === "dropdown" && parsed.length === 0) {
    throw new EvaluationStateError(
      `Criterion ${criterionName} has no persisted dropdown options.`,
    );
  }
  if (inputType !== "dropdown" && parsed.length > 0) {
    throw new EvaluationStateError(
      `Criterion ${criterionName} has options but is not a dropdown.`,
    );
  }
  return parsed as string[];
}

export function persistedRubricSignature(
  criteria: readonly PersistedRubricShape[],
) {
  return rubricSignature(
    criteria.map((criterion) => ({
      ...criterion,
      options: parsePersistedRubricOptions(
        criterion.optionsJson,
        criterion.name,
        criterion.inputType,
      ),
    })),
  );
}

export function assertPlanScorecardConsistency(
  rounds: ReadonlyArray<{
    id: string;
    scorecardId?: string;
    scorecardVersion: number;
    criteria: readonly RubricShape[];
  }>,
) {
  const scorecards = new Map<string, string>();
  for (const round of rounds) {
    const scorecardId = round.scorecardId ?? round.id;
    const key = `${scorecardId}:${round.scorecardVersion}`;
    const signature = rubricSignature(round.criteria);
    const previous = scorecards.get(key);
    if (previous && previous !== signature) {
      throw new EvaluationStateError(
        `Scorecard ${scorecardId} version ${round.scorecardVersion} is linked to different rubrics. Choose a new scorecard version before saving.`,
      );
    }
    scorecards.set(key, signature);
  }
}

export type Round = {
  id: string;
  name: string;
  roundNumber: number;
  status: string;
  revision: number;
  anonymous: boolean;
  opensAt: number | null;
  closesAt: number | null;
  scorecardId: string;
  scorecardVersion: number;
  runningAiAssessmentCount: number;
  reviewers: Array<{ personId: string; name: string; email: string }>;
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

/**
 * Return the server-side blind projection of reviewer-visible answers. The
 * submitted snapshot is immutable source data, but this projection is the
 * only answer shape exposed to a blinded reviewer. Unknown or legacy fields
 * fail closed because labels and IDs are not a reliable privacy boundary.
 */
export function blindReviewerVisibleAnswers(
  snapshot: ReturnType<typeof requireSubmittedSnapshot>,
) {
  const reviewerAnswers = reviewerVisibleAnswers(
    snapshot.schema,
    snapshot.answers,
  );
  const allowedFields = snapshot.schema.fields.filter((field) => {
    return (
      field.reviewVisibility === "reviewers" &&
      field.blindReviewVisibility === "content"
    );
  });
  const allowedIds = new Set(allowedFields.map((field) => field.id));
  return Object.fromEntries(
    Object.entries(reviewerAnswers).filter(([fieldId]) =>
      allowedIds.has(fieldId),
    ),
  );
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

export class EvaluationServiceFoundation {
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
      !command?.idempotencyKey.trim() ||
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
    viewer: Pick<Viewer, "eventId" | "organisationId">,
    roundId: string,
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
          JOIN evaluation_round_reviewers pool
            ON pool.event_id = tm.event_id
           AND pool.round_id = ?
           AND pool.person_id = tm.person_id
          JOIN events e
            ON e.id = tm.event_id AND e.organisation_id = ?
         WHERE tm.event_id = ? AND tm.team_id = ? AND tm.removed_at IS NULL
           AND t.status = 'active' AND m.accepted_at IS NOT NULL
           AND m.revoked_at IS NULL
           AND m.role IN ('evaluator','committee_chair')
         ORDER BY tm.person_id
      `,
      )
        .bind(roundId, viewer.organisationId, viewer.eventId, teamId)
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
    if (evaluatorPersonIds.length === 0) {
      throw new EvaluationStateError("Choose at least one round reviewer.");
    }
    const validEvaluators = await this.env.DB.prepare(
      `
      SELECT DISTINCT membership.person_id AS id
        FROM memberships membership
        JOIN evaluation_round_reviewers pool
          ON pool.event_id = membership.event_id
         AND pool.round_id = ?
         AND pool.person_id = membership.person_id
        JOIN events e
          ON e.id = membership.event_id AND e.organisation_id = ?
       WHERE membership.event_id = ? AND membership.accepted_at IS NOT NULL
         AND membership.revoked_at IS NULL
         AND membership.role IN ('evaluator','committee_chair')
         AND membership.person_id IN (${evaluatorPersonIds.map(() => "?").join(",")})
    `,
    )
      .bind(
        roundId,
        viewer.organisationId,
        viewer.eventId,
        ...evaluatorPersonIds,
      )
      .all<{ id: string }>();
    if (validEvaluators.results.length !== evaluatorPersonIds.length) {
      throw new EvaluationStateError(
        "One or more evaluators are not authorised for this event.",
      );
    }
    return evaluatorPersonIds;
  }
}
