import type { Viewer } from "~/platform/auth/authorize.server";
import { z } from "zod";
import { createAuth } from "~/platform/auth/auth.server";
import {
  WebhookService,
  type WebhookEventResult,
} from "~/platform/operations/webhook-service.server";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import {
  reviewerVisibleAnswers,
  submittedSnapshotSchema,
} from "~/modules/submissions/submission-schema";
import { calculateRubricWeightedScore } from "./evaluation-rules";
import { EvaluationDecisionService } from "./evaluation-decision-service.server";
import { resendAcceptedSpeakerInvitation } from "./accepted-speaker-invitation.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
  EvaluationInvitationDeliveryError,
} from "./evaluation-errors";
export {
  EvaluationDecisionAuthorityError,
  EvaluationDecisionFinalError,
  EvaluationInvitationDeliveryError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
import {
  assignmentBatchSchema,
  assignmentUndoSchema,
  committeeChairAccessSchema,
  conflictDeclarationSchema,
  draftRoundUpdateSchema,
  evaluationPlanSchema,
  evaluationTeamMemberSchema,
  evaluationTeamSchema,
  evaluationMemberInvitationSchema,
  moderationSchema,
  nextRoundSchema,
  reviewReopenSchema,
  reviewDraftSchema,
  roundAdvancementSchema,
} from "./evaluation-schema";

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

type EvaluationCommandScope =
  | "evaluation.plan.save"
  | "evaluation.round.add"
  | "evaluation.assign"
  | "evaluation.advance";

type PreparedEvaluationCommand<T> = {
  actor: EvaluationApiActor;
  input: EvaluationApiCommand;
  recordId: string;
  scope: EvaluationCommandScope;
  resultSchema: z.ZodType<T>;
};

const planCommandResultSchema = z.object({ planId: z.string().min(1) });
const roundCommandResultSchema = z.object({ roundId: z.string().min(1) });
const assignmentCommandResultSchema = z.object({
  createdAssignmentCount: z.number().int().nonnegative(),
  requestedAssignmentCount: z.number().int().positive(),
  undoOperationId: z.string().min(1).nullable(),
  undoExpiresAt: z.number().int().positive().nullable(),
});
const advancementCommandResultSchema = z.object({
  advancedSubmissionCount: z.number().int().positive(),
  assignmentCount: z.number().int().positive(),
});

function evaluationAuditActor(actor: EvaluationAdminActor) {
  return "kind" in actor
    ? { personId: null, actorId: actor.actorId }
    : { personId: actor.personId, actorId: null };
}

type Criterion = {
  id: string;
  name: string;
  description: string | null;
  weightPercent: number;
  inputType: "scale_5" | "scale_10" | "yes_no" | "free_text";
  required: boolean;
  position: number;
};
type Round = {
  id: string;
  name: string;
  roundNumber: number;
  status: string;
  revision: number;
  anonymous: boolean;
  criteria: Criterion[];
};

function parseSubmittedSnapshot(snapshotJson: string | null) {
  let value: unknown;
  try {
    value = snapshotJson ? JSON.parse(snapshotJson) : null;
  } catch {
    value = null;
  }
  const snapshot = submittedSnapshotSchema.safeParse(value);
  return snapshot.success ? snapshot.data : null;
}
function requireSubmittedSnapshot(
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

function reviewerCanSeeSubmissionAttachment(
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

function summaryAnswer(value: unknown) {
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

function requireSessionReviewSnapshot(
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

export class EvaluationService {
  private readonly airtable;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  private async readAuthoritative<T>(
    actor: EvaluationAdminActor,
    read: () => Promise<T>,
  ) {
    await this.airtable.assertReadable(actor);
    return read();
  }

  private async projectCommand<T>(
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

  private async prepareApiCommand<T>(
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

  private async readApiCommand<T>(
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

  private commandClaimStatements<T>(
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

  private commandGuard<T>(command: PreparedEvaluationCommand<T> | null) {
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

  private async recoverApiCommand<T>(
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

  private async assertViewerEvent(
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

  private assertEvaluationManager(viewer: EvaluationAdminActor) {
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

  private assertEvaluationAccessAdministrator(viewer: Viewer) {
    if (viewer.role !== "owner" && viewer.role !== "administrator") {
      throw new Response(
        "Evaluation access administration is not authorised.",
        {
          status: 403,
        },
      );
    }
  }

  private async resolveEvaluatorTarget(
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

  async getAdminWorkspace(viewer: Viewer) {
    return this.readAuthoritative(viewer, () =>
      this.getAdminWorkspaceD1(viewer),
    );
  }

  private async getAdminWorkspaceD1(viewer: Viewer) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const [
      planRow,
      teamRows,
      teamMemberRows,
      evaluatorRows,
      evaluatorInvitationRows,
      submissionRows,
      sessionRows,
      acceptedSpeakerInvitationRows,
      assignmentRows,
      moderationRows,
    ] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT p.id, p.name, p.status, p.revision,
               p.blinded_reviewing AS blindedReviewing,
               p.decision_role AS decisionRole
          FROM evaluation_plans p JOIN events e ON e.id = p.event_id
         WHERE p.event_id = ? AND e.organisation_id = ? AND p.status <> 'archived'
         ORDER BY p.created_at DESC LIMIT 1
      `,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{
          id: string;
          name: string;
          status: string;
          revision: number;
          blindedReviewing: number | boolean;
          decisionRole: "administrator" | "committee_chair";
        }>(),
      this.env.DB.prepare(
        `
        SELECT t.id, t.name, t.description,
               t.chair_person_id AS chairPersonId, t.status,
               COUNT(tm.person_id) AS memberCount,
               SUM(CASE WHEN tm.person_id IS NOT NULL AND EXISTS (
                 SELECT 1 FROM memberships active_membership
                  WHERE active_membership.event_id = t.event_id
                    AND active_membership.person_id = tm.person_id
                    AND active_membership.accepted_at IS NOT NULL
                    AND active_membership.revoked_at IS NULL
                    AND active_membership.role IN ('evaluator','committee_chair')
               ) THEN 1 ELSE 0 END) AS eligibleMemberCount
          FROM evaluation_teams t
          LEFT JOIN evaluation_team_members tm ON tm.team_id = t.id AND tm.event_id = t.event_id AND tm.removed_at IS NULL
         WHERE t.event_id = ? GROUP BY t.id ORDER BY t.name
      `,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          name: string;
          description: string | null;
          chairPersonId: string | null;
          status: string;
          memberCount: number;
          eligibleMemberCount: number;
        }>(),
      this.env.DB.prepare(
        `
        SELECT tm.team_id AS teamId, tm.person_id AS personId,
               tm.role, p.display_name AS name, p.email,
               EXISTS (
                 SELECT 1 FROM memberships active_membership
                  WHERE active_membership.event_id = tm.event_id
                    AND active_membership.person_id = tm.person_id
                    AND active_membership.accepted_at IS NOT NULL
                    AND active_membership.revoked_at IS NULL
                    AND active_membership.role IN ('evaluator','committee_chair')
               ) AS authorised
          FROM evaluation_team_members tm
          JOIN evaluation_teams t
            ON t.id = tm.team_id AND t.event_id = tm.event_id
          JOIN people p ON p.id = tm.person_id
         WHERE tm.event_id = ? AND tm.removed_at IS NULL
           AND t.status = 'active'
         ORDER BY p.display_name
      `,
      )
        .bind(viewer.eventId)
        .all<{
          teamId: string;
          personId: string;
          role: "chair" | "evaluator";
          name: string;
          email: string;
          authorised: number | boolean;
        }>(),
      this.env.DB.prepare(
        `
        SELECT p.id, p.display_name AS name, p.email,
               CASE WHEN MAX(CASE WHEN m.role = 'committee_chair' THEN 1 ELSE 0 END) = 1
                    THEN 'committee_chair' ELSE 'evaluator' END AS role,
               MAX(CASE WHEN m.role = 'committee_chair' THEN m.id END)
                 AS chairMembershipId
          FROM memberships m JOIN people p ON p.id = m.person_id
         WHERE m.event_id = ? AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
           AND m.role IN ('evaluator','committee_chair')
         GROUP BY p.id, p.display_name, p.email
         ORDER BY p.display_name
      `,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          name: string;
          email: string;
          role: string;
          chairMembershipId: string | null;
        }>(),
      this.env.DB.prepare(
        `
        SELECT m.id, p.display_name AS name, p.email, m.role,
               m.invited_at AS invitedAt,
               m.invitation_expires_at AS expiresAt,
               CASE
                 WHEN m.invitation_expires_at IS NOT NULL
                  AND m.invitation_expires_at <= unixepoch() THEN 'expired'
                 ELSE 'pending'
               END AS status
          FROM memberships m
          JOIN people p ON p.id = m.person_id
         WHERE m.event_id = ? AND m.role IN ('evaluator','committee_chair')
           AND m.accepted_at IS NULL AND m.invited_at IS NOT NULL
           AND m.revoked_at IS NULL
         ORDER BY m.invited_at DESC, p.display_name
      `,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          name: string;
          email: string;
          role: "evaluator" | "committee_chair";
          invitedAt: number;
          expiresAt: number | null;
          status: "pending" | "expired";
        }>(),
      this.env.DB.prepare(
        `
        SELECT s.id, s.public_reference AS reference, s.title,
               (
                 SELECT group_concat(selected.track_name_snapshot, ', ')
                   FROM (
                     SELECT selection.track_name_snapshot
                       FROM submission_track_selections selection
                      WHERE selection.submission_id = s.id
                        AND selection.event_id = s.event_id
                      ORDER BY selection.position
                   ) selected
               ) AS category,
               s.format, s.status,
               s.routed_team_id AS routedTeamId,
               COALESCE((
                 SELECT json_group_array(routed.team_id)
                   FROM (
                     SELECT route.team_id
                       FROM submission_routing_teams route
                      WHERE route.submission_id = s.id
                        AND route.event_id = s.event_id
                      ORDER BY route.team_id
                   ) routed
               ), '[]') AS routedTeamIdsJson,
               (
                 SELECT group_concat(routed.name, ', ')
                   FROM (
                     SELECT team.name
                       FROM submission_routing_teams route
                       JOIN evaluation_teams team
                         ON team.id = route.team_id AND team.event_id = route.event_id
                      WHERE route.submission_id = s.id
                        AND route.event_id = s.event_id
                      ORDER BY team.name, team.id
                   ) routed
               ) AS routedTeamName,
               s.submitter_email AS submitterEmail,
               (SELECT COUNT(*) FROM submission_speakers ss
                 WHERE ss.event_id = s.event_id AND ss.submission_id = s.id
                   AND ss.person_id IS NULL) AS unclaimedSpeakerCount,
               COUNT(DISTINCT a.id) AS assignmentCount,
               COUNT(DISTINCT CASE WHEN a.status = 'submitted' THEN a.id END) AS completedReviewCount,
               AVG(r.weighted_score) AS averageScore
          FROM submissions s
          JOIN events e ON e.id = s.event_id
          LEFT JOIN evaluator_assignments a ON a.submission_id = s.id AND a.event_id = s.event_id
          LEFT JOIN reviews r ON r.assignment_id = a.id AND r.status IN ('submitted','locked')
         WHERE s.event_id = ? AND e.organisation_id = ? AND s.status <> 'draft'
         GROUP BY s.id ORDER BY s.updated_at DESC
      `,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .all<{
          id: string;
          reference: string;
          title: string;
          category: string | null;
          format: string | null;
          status: string;
          routedTeamId: string | null;
          routedTeamIdsJson: string;
          routedTeamName: string | null;
          submitterEmail: string | null;
          unclaimedSpeakerCount: number;
          assignmentCount: number;
          completedReviewCount: number;
          averageScore: number | null;
        }>(),
      this.env.DB.prepare(
        `
        SELECT session.id, session.slug AS reference, session.title,
               session.description, session.format,
               session.duration_minutes AS durationMinutes, session.status,
               track.name AS trackName,
               COUNT(DISTINCT assignment.id) AS assignmentCount,
               COUNT(DISTINCT CASE WHEN assignment.status = 'submitted'
                              THEN assignment.id END) AS completedReviewCount,
               AVG(review.weighted_score) AS averageScore
          FROM sessions session
          JOIN events event ON event.id = session.event_id
          LEFT JOIN tracks track
            ON track.id = session.track_id AND track.event_id = session.event_id
          LEFT JOIN evaluator_assignments assignment
            ON assignment.session_id = session.id
           AND assignment.event_id = session.event_id
          LEFT JOIN reviews review
            ON review.assignment_id = assignment.id
           AND review.status IN ('submitted','locked')
         WHERE session.event_id = ? AND event.organisation_id = ?
           AND session.status NOT IN ('cancelled','archived')
         GROUP BY session.id
         ORDER BY session.updated_at DESC, session.id
      `,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .all<{
          id: string;
          reference: string;
          title: string;
          description: string | null;
          format: string;
          durationMinutes: number;
          status: string;
          trackName: string | null;
          assignmentCount: number;
          completedReviewCount: number;
          averageScore: number | null;
        }>(),
      this.env.DB.prepare(
        `SELECT membership.id AS membershipId,
                membership.invitation_expires_at AS expiresAt,
                CASE WHEN membership.invitation_expires_at <= unixepoch()
                     THEN 'expired' ELSE 'pending' END AS status,
                person.id AS personId, person.display_name AS name, person.email,
                decision.id AS decisionId, decision.submission_id AS submissionId,
                session.id AS sessionId, session.title AS sessionTitle
           FROM submission_decisions decision
           JOIN events event
             ON event.id = decision.event_id AND event.organisation_id = ?
           JOIN sessions session
             ON session.source_submission_id = decision.submission_id
            AND session.event_id = decision.event_id
           JOIN session_speakers relationship
             ON relationship.session_id = session.id
            AND relationship.event_id = session.event_id
           JOIN people person ON person.id = relationship.person_id
           JOIN memberships membership
             ON membership.organisation_id = event.organisation_id
            AND membership.event_id = decision.event_id
            AND membership.person_id = person.id
            AND membership.role = 'speaker'
          WHERE decision.event_id = ? AND decision.status = 'published'
            AND decision.decision = 'accepted'
            AND membership.accepted_at IS NULL
            AND membership.revoked_at IS NULL
          ORDER BY session.title COLLATE NOCASE, person.display_name COLLATE NOCASE,
                   membership.id`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<{
          membershipId: string;
          expiresAt: number;
          status: "pending" | "expired";
          personId: string;
          name: string;
          email: string;
          decisionId: string;
          submissionId: string;
          sessionId: string;
          sessionTitle: string;
        }>(),
      this.env.DB.prepare(
        `
        SELECT a.id, a.round_id AS roundId,
               a.submission_id AS submissionId, a.session_id AS sessionId,
               CASE WHEN a.submission_id IS NOT NULL THEN 'submission'
                    ELSE 'session' END AS targetType,
               COALESCE(submission.title, session.title) AS targetTitle,
               a.evaluator_person_id AS evaluatorPersonId,
               p.display_name AS evaluatorName, a.team_id AS teamId,
               t.name AS teamName, a.status, a.revision,
               r.id AS reviewId, r.status AS reviewStatus,
               r.weighted_score AS weightedScore,
               r.recommendation, r.confidence,
               r.submitter_feedback AS submitterFeedback,
               r.private_notes AS privateNotes,
               conflict.notes AS conflictNotes,
               conflict.status AS conflictStatus
          FROM evaluator_assignments a
          JOIN people p ON p.id = a.evaluator_person_id
          LEFT JOIN evaluation_teams t
            ON t.id = a.team_id AND t.event_id = a.event_id
          LEFT JOIN submissions submission
            ON submission.id = a.submission_id
           AND submission.event_id = a.event_id
          LEFT JOIN sessions session
            ON session.id = a.session_id AND session.event_id = a.event_id
          LEFT JOIN reviews r
            ON r.assignment_id = a.id AND r.event_id = a.event_id
          LEFT JOIN evaluator_conflicts conflict
           ON conflict.event_id = a.event_id
           AND conflict.round_id = a.round_id
           AND conflict.evaluator_person_id = a.evaluator_person_id
           AND (
             (a.submission_id IS NOT NULL
              AND conflict.submission_id = a.submission_id)
             OR
             (a.session_id IS NOT NULL AND conflict.session_id = a.session_id)
           )
         WHERE a.event_id = ?
         ORDER BY a.assigned_at, p.display_name
      `,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          roundId: string;
          submissionId: string | null;
          sessionId: string | null;
          targetType: "submission" | "session";
          targetTitle: string;
          evaluatorPersonId: string;
          evaluatorName: string;
          teamId: string | null;
          teamName: string | null;
          status: string;
          revision: number;
          reviewId: string | null;
          reviewStatus: string | null;
          weightedScore: number | null;
          recommendation: string | null;
          confidence: number | null;
          submitterFeedback: string | null;
          privateNotes: string | null;
          conflictNotes: string | null;
          conflictStatus: string | null;
        }>(),
      this.env.DB.prepare(
        `
        SELECT m.id, m.round_id AS roundId, m.submission_id AS submissionId,
               m.status, m.recommendation,
               m.moderated_score AS moderatedScore, m.notes,
               m.moderator_person_id AS moderatorPersonId,
               p.display_name AS moderatorName
          FROM review_moderations m
          JOIN people p ON p.id = m.moderator_person_id
         WHERE m.event_id = ? AND m.status IN ('draft','confirmed')
      `,
      )
        .bind(viewer.eventId)
        .all<{
          id: string;
          roundId: string;
          submissionId: string;
          status: "draft" | "confirmed";
          recommendation: "accept" | "waitlist" | "reject" | "advance";
          moderatedScore: number | null;
          notes: string | null;
          moderatorPersonId: string;
          moderatorName: string;
        }>(),
    ]);
    const rounds = planRow
      ? await this.getRounds(
          viewer.eventId,
          planRow.id,
          Boolean(planRow.blindedReviewing),
        )
      : [];
    const submissions = submissionRows.results.map(
      ({ routedTeamIdsJson, ...submission }) => {
        if (!submission.category) {
          throw new EvaluationStateError(
            `Submission ${submission.id} is missing persisted track selections.`,
          );
        }
        const routedTeamIds = z
          .array(z.string())
          .parse(JSON.parse(routedTeamIdsJson));
        if (routedTeamIds.length === 0) {
          if (submission.routedTeamId) {
            throw new EvaluationStateError(
              `Submission ${submission.id} has incomplete persisted routing teams.`,
            );
          }
        } else if (
          !submission.routedTeamId ||
          !routedTeamIds.includes(submission.routedTeamId) ||
          !submission.routedTeamName
        ) {
          throw new EvaluationStateError(
            `Submission ${submission.id} has inconsistent persisted routing teams.`,
          );
        }
        return submission;
      },
    );
    return {
      plan: planRow
        ? {
            ...planRow,
            blindedReviewing: Boolean(planRow.blindedReviewing),
            rounds,
          }
        : null,
      teams: teamRows.results.map((team) => ({
        ...team,
        members: teamMemberRows.results
          .filter((member) => member.teamId === team.id)
          .map((member) => ({
            ...member,
            authorised: Boolean(member.authorised),
          })),
      })),
      evaluators: evaluatorRows.results,
      evaluationInvitations: evaluatorInvitationRows.results,
      submissions,
      acceptedSpeakerInvitations: acceptedSpeakerInvitationRows.results,
      sessions: sessionRows.results,
      assignments: assignmentRows.results,
      moderations: moderationRows.results,
    };
  }

  private async getRounds(
    eventId: string,
    planId: string,
    anonymous: boolean,
  ): Promise<Round[]> {
    const [roundRows, criterionRows] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT id, name, round_number AS roundNumber, status, revision
          FROM evaluation_rounds WHERE event_id = ? AND plan_id = ? ORDER BY round_number
      `,
      )
        .bind(eventId, planId)
        .all<Omit<Round, "criteria" | "anonymous">>(),
      this.env.DB.prepare(
        `
        SELECT c.id, c.round_id AS roundId, c.name, c.description,
               c.input_type AS inputType, c.weight_percent AS weightPercent,
               c.required, c.position
          FROM evaluation_criteria c JOIN evaluation_rounds r ON r.id = c.round_id AND r.event_id = c.event_id
         WHERE c.event_id = ? AND r.plan_id = ? ORDER BY r.round_number, c.position
      `,
      )
        .bind(eventId, planId)
        .all<Criterion & { roundId: string }>(),
    ]);
    return roundRows.results.map((round) => ({
      ...round,
      anonymous,
      criteria: criterionRows.results
        .filter((criterion) => criterion.roundId === round.id)
        .map((criterion) => ({
          ...criterion,
          required: Boolean(criterion.required),
        })),
    }));
  }

  async savePlan(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.plan.save",
      input,
      command,
      () => this.savePlanD1(viewer, input, command),
    );
  }

  private async savePlanD1(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const auditActor = evaluationAuditActor(viewer);
    const commandState = await this.prepareApiCommand(
      viewer,
      "evaluation.plan.save",
      command,
      planCommandResultSchema,
    );
    if (commandState.replay) return commandState.replay.planId;
    const commandGuard = this.commandGuard(commandState.prepared);
    const parsed = evaluationPlanSchema.parse(input);
    const blindedReviewing = parsed.rounds[0].anonymous ? 1 : 0;
    const existing = await this.env.DB.prepare(
      `
      SELECT id, revision, decision_role AS decisionRole
        FROM evaluation_plans
       WHERE event_id = ? AND status <> 'archived' ORDER BY created_at DESC LIMIT 1
    `,
    )
      .bind(viewer.eventId)
      .first<{
        id: string;
        revision: number;
        decisionRole: "administrator" | "committee_chair";
      }>();
    if (existing && existing.revision !== parsed.revision)
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed after it was loaded.",
      );
    if (
      !("kind" in viewer) &&
      viewer.role === "committee_chair" &&
      parsed.decisionRole !== (existing?.decisionRole ?? "administrator")
    ) {
      throw new Response(
        "Only an owner or administrator can change final decision authority.",
        { status: 403 },
      );
    }
    if (existing) {
      const assignment = await this.env.DB.prepare(
        `
        SELECT a.id FROM evaluator_assignments a JOIN evaluation_rounds r ON r.id = a.round_id
         WHERE r.plan_id = ? LIMIT 1
      `,
      )
        .bind(existing.id)
        .first();
      if (assignment)
        throw new EvaluationStateError(
          "A plan with assignments cannot have its rounds or rubric replaced. Create the next round instead.",
        );
    }
    const planId = existing?.id ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const planHasNoAssignments = `
      NOT EXISTS (
        SELECT 1
          FROM evaluator_assignments assignment
          JOIN evaluation_rounds assigned_round
            ON assigned_round.id = assignment.round_id
           AND assigned_round.event_id = assignment.event_id
         WHERE assigned_round.plan_id = ?
           AND assigned_round.event_id = ?
      )
    `;
    const commandStatements = this.commandClaimStatements(
      commandState.prepared,
    );
    const domainStatementIndex = commandStatements.length;
    const statements: D1PreparedStatement[] = [
      ...commandStatements,
      existing
        ? this.env.DB.prepare(
            `
            UPDATE events
               SET last_operation_id = ?, updated_at = unixepoch()
             WHERE id = ? AND organisation_id = ?
               AND EXISTS (
                 SELECT 1 FROM evaluation_plans plan
                  WHERE plan.id = ? AND plan.event_id = events.id
                    AND plan.revision = ? AND ${planHasNoAssignments}
               )
               ${commandGuard.sql}
          `,
          ).bind(
            operationId,
            viewer.eventId,
            viewer.organisationId,
            planId,
            parsed.revision,
            planId,
            viewer.eventId,
            ...commandGuard.bindings,
          )
        : this.env.DB.prepare(
            `
            UPDATE events
               SET last_operation_id = ?, updated_at = unixepoch()
             WHERE id = ? AND organisation_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM evaluation_plans plan
                  WHERE plan.event_id = events.id AND plan.status <> 'archived'
               )
               ${commandGuard.sql}
          `,
          ).bind(
            operationId,
            viewer.eventId,
            viewer.organisationId,
            ...commandGuard.bindings,
          ),
      ...(existing
        ? [
            this.env.DB.prepare(
              `
        UPDATE evaluation_plans SET name = ?, status = ?, blinded_reviewing = ?, decision_role = ?, revision = revision + 1,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND ${planHasNoAssignments}
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
            ).bind(
              parsed.name,
              parsed.status,
              blindedReviewing,
              parsed.decisionRole,
              planId,
              viewer.eventId,
              parsed.revision,
              planId,
              viewer.eventId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
            this.env.DB.prepare(
              `
        DELETE FROM evaluation_rounds
         WHERE plan_id = ? AND event_id = ?
           AND ${planHasNoAssignments}
           AND EXISTS (
             SELECT 1 FROM evaluation_plans
              WHERE id = ? AND event_id = ? AND revision = ? AND name = ? AND status = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
            ).bind(
              planId,
              viewer.eventId,
              planId,
              viewer.eventId,
              planId,
              viewer.eventId,
              parsed.revision + 1,
              parsed.name,
              parsed.status,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
          ]
        : [
            this.env.DB.prepare(
              `
        INSERT INTO evaluation_plans (
          id, event_id, name, status, blinded_reviewing, decision_role, revision,
          created_by_person_id, created_at, updated_at
        ) SELECT ?, e.id, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch()
          FROM events e
         WHERE e.id = ? AND e.organisation_id = ? AND e.last_operation_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM evaluation_plans current_plan
              WHERE current_plan.event_id = e.id AND current_plan.status <> 'archived'
           )
      `,
            ).bind(
              planId,
              parsed.name,
              parsed.status,
              blindedReviewing,
              parsed.decisionRole,
              auditActor.personId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
          ]),
    ];
    for (const [roundIndex, round] of parsed.rounds.entries()) {
      statements.push(
        this.env.DB.prepare(
          `
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status, closes_at,
          advancement_rule_json, revision, created_at, updated_at
        )
        SELECT ?, p.event_id, p.id, ?, ?, ?, ?, '{}', 1, unixepoch(), unixepoch()
          FROM evaluation_plans p
         WHERE p.id = ? AND p.event_id = ? AND p.revision = ? AND p.name = ? AND p.status = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
        ).bind(
          round.id,
          roundIndex + 1,
          round.name,
          parsed.status === "active" && roundIndex === 0 ? "active" : "draft",
          round.dueAt ? Math.floor(Date.parse(round.dueAt) / 1_000) : null,
          planId,
          viewer.eventId,
          parsed.revision + 1,
          parsed.name,
          parsed.status,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        ),
      );
      for (const criterion of round.criteria) {
        statements.push(
          this.env.DB.prepare(
            `
          INSERT INTO evaluation_criteria (
            id, event_id, round_id, name, description, input_type, weight_percent, required, position
          )
          SELECT ?, r.event_id, r.id, ?, ?, ?, ?, ?, ?
            FROM evaluation_rounds r
            JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id
           WHERE r.id = ? AND r.event_id = ? AND p.id = ? AND p.revision = ? AND p.name = ? AND p.status = ?
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
             )
        `,
          ).bind(
            criterion.id,
            criterion.name,
            criterion.description || null,
            criterion.inputType,
            criterion.weightPercent,
            criterion.required ? 1 : 0,
            criterion.position,
            round.id,
            viewer.eventId,
            planId,
            parsed.revision + 1,
            parsed.name,
            parsed.status,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
        );
      }
    }
    statements.push(
      this.env.DB.prepare(
        `
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, actor_id, action, entity_type, entity_id, metadata_json, created_at
      )
      SELECT ?, ?, ?, ?, ?, 'evaluation.plan.saved', 'evaluation_plan', ?, ?, unixepoch()
       WHERE EXISTS (
         SELECT 1 FROM evaluation_plans
          WHERE id = ? AND event_id = ? AND revision = ? AND name = ? AND status = ?
       )
       AND EXISTS (
         SELECT 1 FROM events
          WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
       )
    `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        planId,
        JSON.stringify({
          rounds: parsed.rounds.length,
          blindedReviewing: Boolean(blindedReviewing),
        }),
        planId,
        viewer.eventId,
        parsed.revision + 1,
        parsed.name,
        parsed.status,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    );
    if (commandState.prepared) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE idempotency_records
             SET status = 'completed', response_status = 200,
                 response_json = json_object('planId', ?),
                 entity_type = 'evaluation_plan', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'evaluation.plan.save'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND EXISTS (
               SELECT 1 FROM evaluation_plans committed_plan
                WHERE committed_plan.id = ?
                  AND committed_plan.event_id = idempotency_records.event_id
                  AND committed_plan.revision = ?
             )
             AND EXISTS (
               SELECT 1 FROM events committed_event
                WHERE committed_event.id = idempotency_records.event_id
                  AND committed_event.organisation_id = idempotency_records.organisation_id
                  AND committed_event.last_operation_id = ?
             )
        `,
        ).bind(
          planId,
          planId,
          commandState.prepared.recordId,
          viewer.organisationId,
          viewer.eventId,
          commandState.prepared.actor.actorId,
          commandState.prepared.input.idempotencyKey,
          commandState.prepared.input.requestHash,
          planId,
          parsed.revision + 1,
          operationId,
        ),
      );
    }
    const results = await this.env.DB.batch(statements);
    const claimed = results[domainStatementIndex]!;
    if ((claimed.meta.changes ?? 0) !== 1) {
      const replay = await this.recoverApiCommand(commandState.prepared);
      if (replay) return replay.planId;
      if (existing) {
        const assignment = await this.env.DB.prepare(
          `
          SELECT a.id FROM evaluator_assignments a
          JOIN evaluation_rounds r
            ON r.id = a.round_id AND r.event_id = a.event_id
         WHERE r.plan_id = ? AND r.event_id = ? LIMIT 1
        `,
        )
          .bind(existing.id, viewer.eventId)
          .first();
        if (assignment) {
          throw new EvaluationStateError(
            "A plan with assignments cannot have its rounds or rubric replaced. Create the next round instead.",
          );
        }
      }
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed after it was loaded.",
      );
    }
    if (commandState.prepared) {
      const replay = await this.readApiCommand(commandState.prepared);
      if (!replay) {
        throw new Error(
          "The evaluation plan command did not commit an idempotency result.",
        );
      }
      return replay.planId;
    }
    return planId;
  }

  async saveTeam(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.team.save",
      input,
      undefined,
      () => this.saveTeamD1(viewer, input),
    );
  }

  private async saveTeamD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = evaluationTeamSchema.parse(input);
    if (parsed.chairPersonId) {
      const chair = await this.env.DB.prepare(
        `
        SELECT 1 FROM memberships
         WHERE event_id = ? AND person_id = ?
           AND role = 'committee_chair' AND accepted_at IS NOT NULL
           AND revoked_at IS NULL
      `,
      )
        .bind(viewer.eventId, parsed.chairPersonId)
        .first();
      if (!chair) {
        throw new EvaluationStateError(
          "The team chair must have an active committee-chair membership for this event.",
        );
      }
    }
    const duplicate = await this.env.DB.prepare(
      `
      SELECT id FROM evaluation_teams
       WHERE event_id = ? AND name = ? AND (? IS NULL OR id <> ?)
      `,
    )
      .bind(viewer.eventId, parsed.name, parsed.teamId, parsed.teamId)
      .first();
    if (duplicate) {
      throw new EvaluationStateError(
        "An evaluation team with that name already exists.",
      );
    }
    const teamId = parsed.teamId ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const mutation = parsed.teamId
      ? this.env.DB.prepare(
          `
          UPDATE evaluation_teams
             SET name = ?, description = ?, chair_person_id = ?, status = ?,
                 updated_at = unixepoch()
           WHERE id = ? AND event_id = ?
             AND (
               ? IS NULL OR EXISTS (
                 SELECT 1 FROM memberships chair_membership
                  WHERE chair_membership.event_id = evaluation_teams.event_id
                    AND chair_membership.person_id = ?
                    AND chair_membership.role = 'committee_chair'
                    AND chair_membership.accepted_at IS NOT NULL
                    AND chair_membership.revoked_at IS NULL
               )
             )
        `,
        ).bind(
          parsed.name,
          parsed.description || null,
          parsed.chairPersonId,
          parsed.status,
          teamId,
          viewer.eventId,
          parsed.chairPersonId,
          parsed.chairPersonId,
        )
      : this.env.DB.prepare(
          `
          INSERT INTO evaluation_teams (
            id, event_id, name, description, chair_person_id, status,
            created_at, updated_at
          )
          SELECT ?, event.id, ?, ?, ?, ?, unixepoch(), unixepoch()
            FROM events event
           WHERE event.id = ? AND event.organisation_id = ?
             AND (
               ? IS NULL OR EXISTS (
                 SELECT 1 FROM memberships chair_membership
                  WHERE chair_membership.event_id = event.id
                    AND chair_membership.person_id = ?
                    AND chair_membership.role = 'committee_chair'
                    AND chair_membership.accepted_at IS NOT NULL
                    AND chair_membership.revoked_at IS NULL
               )
             )
        `,
        ).bind(
          teamId,
          parsed.name,
          parsed.description || null,
          parsed.chairPersonId,
          parsed.status,
          viewer.eventId,
          viewer.organisationId,
          parsed.chairPersonId,
          parsed.chairPersonId,
        );
    const statements = [mutation];
    statements.push(
      this.env.DB.prepare(
        `
        UPDATE evaluation_team_members SET role = 'evaluator'
         WHERE team_id = ? AND event_id = ? AND role = 'chair'
           AND removed_at IS NULL
           AND (? IS NULL OR person_id <> ?)
      `,
      ).bind(
        teamId,
        viewer.eventId,
        parsed.chairPersonId,
        parsed.chairPersonId,
      ),
    );
    if (parsed.chairPersonId) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO evaluation_team_members (
            team_id, event_id, person_id, role, joined_at, removed_at
          ) VALUES (?, ?, ?, 'chair', unixepoch(), NULL)
          ON CONFLICT(team_id, person_id) DO UPDATE SET
            role = 'chair', joined_at = unixepoch(), removed_at = NULL
        `,
        ).bind(teamId, viewer.eventId, parsed.chairPersonId),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'evaluation_team', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_teams
            WHERE id = ? AND event_id = ? AND name = ? AND status = ?
         )
      `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.teamId ? "evaluation.team.updated" : "evaluation.team.created",
        teamId,
        JSON.stringify({ status: parsed.status }),
        teamId,
        viewer.eventId,
        parsed.name,
        parsed.status,
      ),
    );
    const [changed] = await this.env.DB.batch(statements);
    if ((changed.meta.changes ?? 0) !== 1) {
      if (parsed.chairPersonId) {
        const chairStillAuthorised = await this.env.DB.prepare(
          `
          SELECT 1 FROM memberships
           WHERE event_id = ? AND person_id = ?
             AND role = 'committee_chair' AND accepted_at IS NOT NULL
             AND revoked_at IS NULL
        `,
        )
          .bind(viewer.eventId, parsed.chairPersonId)
          .first();
        if (!chairStillAuthorised) {
          throw new EvaluationStateError(
            "The selected team chair no longer has active committee-chair access.",
          );
        }
      }
      throw new EvaluationStateError(
        "The evaluation team was not found in this event.",
      );
    }
    return teamId;
  }

  async inviteEvaluationMember(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.member.invite",
      input,
      undefined,
      () => this.inviteEvaluationMemberD1(viewer, input),
    );
  }

  private async inviteEvaluationMemberD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = evaluationMemberInvitationSchema.parse(input);
    if (parsed.role === "committee_chair") {
      this.assertEvaluationAccessAdministrator(viewer);
    }
    const roleLabel =
      parsed.role === "committee_chair" ? "committee chair" : "evaluator";
    const proposedPersonId = crypto.randomUUID();
    await this.env.DB.prepare(
      `
      INSERT INTO people (
        id, email, display_name, email_verified, profile_status,
        created_at, updated_at
      ) VALUES (?, ?, ?, 0, 'draft', unixepoch(), unixepoch())
      ON CONFLICT(email) DO NOTHING
    `,
    )
      .bind(proposedPersonId, parsed.email, parsed.name)
      .run();
    const person = await this.env.DB.prepare(
      `
      SELECT p.id
        FROM people p
        JOIN events e ON e.id = ? AND e.organisation_id = ?
       WHERE p.email = ? COLLATE NOCASE
    `,
    )
      .bind(viewer.eventId, viewer.organisationId, parsed.email)
      .first<{ id: string }>();
    if (!person) {
      throw new EvaluationStateError(
        "The participant could not be added to the authorised event.",
      );
    }
    const existing = await this.env.DB.prepare(
      `
      SELECT id, accepted_at AS acceptedAt, revoked_at AS revokedAt
        FROM memberships
       WHERE organisation_id = ? AND event_id = ? AND person_id = ?
         AND role = ?
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, person.id, parsed.role)
      .first<{
        id: string;
        acceptedAt: number | null;
        revokedAt: number | null;
      }>();
    if (existing?.acceptedAt && !existing.revokedAt) {
      throw new EvaluationStateError(
        `This person already has active ${roleLabel} access for the event.`,
      );
    }
    if (parsed.teamId) {
      const team = await this.env.DB.prepare(
        `
        SELECT id FROM evaluation_teams
         WHERE id = ? AND event_id = ? AND status = 'active'
      `,
      )
        .bind(parsed.teamId, viewer.eventId)
        .first();
      if (!team) {
        throw new EvaluationStateError(
          "The selected evaluation team is not active in this event.",
        );
      }
    }
    const membershipId = existing?.id ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const membershipMutation = existing
      ? this.env.DB.prepare(
          `
          UPDATE memberships
             SET invited_at = unixepoch(),
                 invitation_expires_at = unixepoch() + 604800,
                 accepted_at = NULL, revoked_at = NULL
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND person_id = ? AND role = ?
             AND (accepted_at IS NULL OR revoked_at IS NOT NULL)
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ?
                  AND last_operation_id = ?
             )
        `,
        ).bind(
          membershipId,
          viewer.organisationId,
          viewer.eventId,
          person.id,
          parsed.role,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        )
      : this.env.DB.prepare(
          `
          INSERT INTO memberships (
            id, organisation_id, event_id, person_id, role, invited_at,
            invitation_expires_at, accepted_at, created_at
          )
          SELECT ?, ?, ?, ?, ?, unixepoch(),
                 unixepoch() + 604800, NULL, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ?
                AND last_operation_id = ?
           )
             AND NOT EXISTS (
               SELECT 1 FROM memberships
                WHERE organisation_id = ? AND event_id = ? AND person_id = ?
                  AND role = ?
             )
        `,
        ).bind(
          membershipId,
          viewer.organisationId,
          viewer.eventId,
          person.id,
          parsed.role,
          viewer.eventId,
          viewer.organisationId,
          operationId,
          viewer.organisationId,
          viewer.eventId,
          person.id,
          parsed.role,
        );
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM memberships active_member
              WHERE active_member.organisation_id = events.organisation_id
                AND active_member.event_id = events.id
                AND active_member.person_id = ?
                AND active_member.role = ?
                AND active_member.accepted_at IS NOT NULL
                AND active_member.revoked_at IS NULL
           )
           AND (
             ? IS NULL OR EXISTS (
               SELECT 1 FROM evaluation_teams team
                WHERE team.id = ? AND team.event_id = events.id
                  AND team.status = 'active'
             )
           )
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        person.id,
        parsed.role,
        parsed.teamId,
        parsed.teamId,
      ),
      membershipMutation,
    ];
    if (parsed.teamId) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO evaluation_team_members (
            team_id, event_id, person_id, role, joined_at, removed_at
          )
          SELECT ?, ?, ?, 'evaluator', unixepoch(), NULL
           WHERE EXISTS (
             SELECT 1 FROM memberships invited_membership
              WHERE invited_membership.id = ?
                AND invited_membership.organisation_id = ?
                AND invited_membership.event_id = ?
                AND invited_membership.person_id = ?
                AND invited_membership.role = 'evaluator'
                AND invited_membership.invited_at IS NOT NULL
                AND invited_membership.revoked_at IS NULL
           )
          ON CONFLICT(team_id, person_id) DO UPDATE SET
            role = 'evaluator', joined_at = unixepoch(), removed_at = NULL
        `,
        ).bind(
          parsed.teamId,
          viewer.eventId,
          person.id,
          membershipId,
          viewer.organisationId,
          viewer.eventId,
          person.id,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?,
               'membership', invited_membership.id, ?, unixepoch()
          FROM memberships invited_membership
         WHERE invited_membership.id = ?
           AND invited_membership.organisation_id = ?
           AND invited_membership.event_id = ?
           AND invited_membership.person_id = ?
           AND invited_membership.role = ?
           AND invited_membership.accepted_at IS NULL
           AND invited_membership.revoked_at IS NULL
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ?
                AND last_operation_id = ?
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `membership.${parsed.role}.invited`,
        JSON.stringify({ email: parsed.email, teamId: parsed.teamId }),
        membershipId,
        viewer.organisationId,
        viewer.eventId,
        person.id,
        parsed.role,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    );
    const results = await this.env.DB.batch(statements);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1 ||
      (results.at(-1)?.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationRevisionConflictError(
        "Evaluation access or team membership changed before the invitation could be saved.",
      );
    }
    if (String(this.env.DEMO_MODE) === "true") {
      return { membershipId, delivery: "demo_not_sent" as const };
    }
    try {
      await createAuth(this.env).api.signInMagicLink({
        body: {
          email: parsed.email,
          callbackURL:
            parsed.role === "committee_chair"
              ? "/admin/review"
              : "/review/workbench",
        },
        headers: new Headers({ origin: this.env.BETTER_AUTH_URL }),
      });
    } catch (error) {
      throw new EvaluationInvitationDeliveryError(
        membershipId,
        roleLabel,
        error,
      );
    }
    return { membershipId, delivery: "sent" as const };
  }

  async changeCommitteeChairAccess(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.committee_chair.access",
      input,
      undefined,
      () => this.changeCommitteeChairAccessD1(viewer, input),
    );
  }

  private async changeCommitteeChairAccessD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationAccessAdministrator(viewer);
    const parsed = committeeChairAccessSchema.parse(input);
    const current = await this.env.DB.prepare(
      `
      SELECT id, accepted_at AS acceptedAt, revoked_at AS revokedAt
        FROM memberships
       WHERE organisation_id = ? AND event_id = ? AND person_id = ?
         AND role = 'committee_chair'
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, parsed.personId)
      .first<{
        id: string;
        acceptedAt: number | null;
        revokedAt: number | null;
      }>();
    const active = Boolean(current?.acceptedAt && !current.revokedAt);
    if (parsed.operation === "promote") {
      if (active) {
        throw new EvaluationStateError(
          "This person already has active committee-chair access.",
        );
      }
      const evaluator = await this.env.DB.prepare(
        `
        SELECT 1 FROM memberships
         WHERE organisation_id = ? AND event_id = ? AND person_id = ?
           AND role = 'evaluator' AND accepted_at IS NOT NULL
           AND revoked_at IS NULL
      `,
      )
        .bind(viewer.organisationId, viewer.eventId, parsed.personId)
        .first();
      if (!evaluator) {
        throw new EvaluationStateError(
          "Only an active evaluator can be promoted directly. Invite a new committee chair instead.",
        );
      }
    } else if (!active || !current) {
      throw new EvaluationStateError(
        "Active committee-chair access was not found.",
      );
    }

    const membershipId = current?.id ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const expectedAccessSql =
      parsed.operation === "promote"
        ? `NOT EXISTS (
             SELECT 1 FROM memberships active_chair
              WHERE active_chair.event_id = events.id
                AND active_chair.person_id = ?
                AND active_chair.role = 'committee_chair'
                AND active_chair.accepted_at IS NOT NULL
                AND active_chair.revoked_at IS NULL
           )
           AND EXISTS (
             SELECT 1 FROM memberships active_evaluator
              WHERE active_evaluator.event_id = events.id
                AND active_evaluator.person_id = ?
                AND active_evaluator.role = 'evaluator'
                AND active_evaluator.accepted_at IS NOT NULL
                AND active_evaluator.revoked_at IS NULL
           )`
        : `EXISTS (
             SELECT 1 FROM memberships active_chair
              WHERE active_chair.id = ?
                AND active_chair.event_id = events.id
                AND active_chair.person_id = ?
                AND active_chair.role = 'committee_chair'
                AND active_chair.accepted_at IS NOT NULL
                AND active_chair.revoked_at IS NULL
           )`;
    const expectedAccessBindings =
      parsed.operation === "promote"
        ? [parsed.personId, parsed.personId]
        : [membershipId, parsed.personId];
    const accessMutation =
      parsed.operation === "promote"
        ? current
          ? this.env.DB.prepare(
              `
              UPDATE memberships
                 SET invited_at = COALESCE(invited_at, unixepoch()),
                     invitation_expires_at = NULL, accepted_at = unixepoch(),
                     revoked_at = NULL
               WHERE id = ? AND organisation_id = ? AND event_id = ?
                 AND person_id = ? AND role = 'committee_chair'
                 AND EXISTS (
                   SELECT 1 FROM events
                    WHERE id = ? AND organisation_id = ?
                      AND last_operation_id = ?
                 )
            `,
            ).bind(
              membershipId,
              viewer.organisationId,
              viewer.eventId,
              parsed.personId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            )
          : this.env.DB.prepare(
              `
              INSERT INTO memberships (
                id, organisation_id, event_id, person_id, role, invited_at,
                invitation_expires_at, accepted_at, created_at
              )
              SELECT ?, ?, ?, ?, 'committee_chair', unixepoch(), NULL,
                     unixepoch(), unixepoch()
               WHERE EXISTS (
                 SELECT 1 FROM events
                  WHERE id = ? AND organisation_id = ?
                    AND last_operation_id = ?
               )
            `,
            ).bind(
              membershipId,
              viewer.organisationId,
              viewer.eventId,
              parsed.personId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            )
        : this.env.DB.prepare(
            `
            UPDATE memberships SET revoked_at = unixepoch()
             WHERE id = ? AND organisation_id = ? AND event_id = ?
               AND person_id = ? AND role = 'committee_chair'
               AND accepted_at IS NOT NULL AND revoked_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM events
                  WHERE id = ? AND organisation_id = ?
                    AND last_operation_id = ?
               )
          `,
          ).bind(
            membershipId,
            viewer.organisationId,
            viewer.eventId,
            parsed.personId,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          );
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ? AND ${expectedAccessSql}
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        ...expectedAccessBindings,
      ),
      accessMutation,
    ];
    if (parsed.operation === "revoke") {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE evaluation_teams
             SET chair_person_id = NULL, updated_at = unixepoch()
           WHERE event_id = ? AND chair_person_id = ?
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ?
                  AND last_operation_id = ?
             )
        `,
        ).bind(
          viewer.eventId,
          parsed.personId,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        ),
        this.env.DB.prepare(
          `
          UPDATE evaluation_team_members SET role = 'evaluator'
           WHERE event_id = ? AND person_id = ? AND removed_at IS NULL
             AND role = 'chair'
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ?
                  AND last_operation_id = ?
             )
        `,
        ).bind(
          viewer.eventId,
          parsed.personId,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'membership', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
           AND EXISTS (
             SELECT 1 FROM memberships membership
              WHERE membership.id = ? AND membership.event_id = ?
                AND membership.person_id = ?
                AND membership.role = 'committee_chair'
                AND (
                  (? = 'promote' AND membership.accepted_at IS NOT NULL
                    AND membership.revoked_at IS NULL)
                  OR
                  (? = 'revoke' AND membership.revoked_at IS NOT NULL)
                )
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `membership.committee_chair.${
          parsed.operation === "promote" ? "promoted" : "revoked"
        }`,
        membershipId,
        JSON.stringify({ personId: parsed.personId }),
        viewer.eventId,
        viewer.organisationId,
        operationId,
        membershipId,
        viewer.eventId,
        parsed.personId,
        parsed.operation,
        parsed.operation,
      ),
    );
    const results = await this.env.DB.batch(statements);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1 ||
      (results.at(-1)?.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationRevisionConflictError(
        "Committee-chair access changed before this operation could be committed.",
      );
    }
    return { membershipId, operation: parsed.operation };
  }

  async changeTeamMember(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.team_member.change",
      input,
      undefined,
      () => this.changeTeamMemberD1(viewer, input),
    );
  }

  private async changeTeamMemberD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = evaluationTeamMemberSchema.parse(input);
    const authorisedPerson =
      parsed.operation === "add"
        ? await this.env.DB.prepare(
            `
            SELECT 1 FROM memberships m
            JOIN evaluation_teams t ON t.event_id = m.event_id
             WHERE t.id = ? AND t.event_id = ? AND t.status = 'active'
               AND m.person_id = ? AND m.accepted_at IS NOT NULL
               AND m.revoked_at IS NULL
               AND m.role IN ('evaluator','committee_chair')
          `,
          )
            .bind(parsed.teamId, viewer.eventId, parsed.personId)
            .first()
        : await this.env.DB.prepare(
            `
            SELECT 1 FROM evaluation_team_members tm
            JOIN evaluation_teams t
              ON t.id = tm.team_id AND t.event_id = tm.event_id
             WHERE tm.team_id = ? AND tm.event_id = ? AND tm.person_id = ?
               AND tm.removed_at IS NULL AND t.status = 'active'
          `,
          )
            .bind(parsed.teamId, viewer.eventId, parsed.personId)
            .first();
    if (!authorisedPerson) {
      throw new EvaluationStateError(
        "The person or active team was not found in this event.",
      );
    }
    if (parsed.operation === "add" && parsed.role === "chair") {
      const membership = await this.env.DB.prepare(
        `
        SELECT 1 FROM memberships
         WHERE event_id = ? AND person_id = ? AND role = 'committee_chair'
           AND accepted_at IS NOT NULL AND revoked_at IS NULL
      `,
      )
        .bind(viewer.eventId, parsed.personId)
        .first();
      if (!membership) {
        throw new EvaluationStateError(
          "Only an active committee chair can be the chair of an evaluation team.",
        );
      }
    }
    const operationId = crypto.randomUUID();
    const mutation =
      parsed.operation === "add"
        ? this.env.DB.prepare(
            `
            INSERT INTO evaluation_team_members (
              team_id, event_id, person_id, role, joined_at, removed_at
            )
            SELECT t.id, t.event_id, ?, ?, unixepoch(), NULL
              FROM evaluation_teams t
             WHERE t.id = ? AND t.event_id = ? AND t.status = 'active'
               AND EXISTS (
                 SELECT 1 FROM memberships m
                  WHERE m.event_id = t.event_id AND m.person_id = ?
                    AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
                    AND m.role ${
                      parsed.role === "chair"
                        ? "= 'committee_chair'"
                        : "IN ('evaluator','committee_chair')"
                    }
               )
            ON CONFLICT(team_id, person_id) DO UPDATE SET
              role = excluded.role, joined_at = unixepoch(), removed_at = NULL
          `,
          ).bind(
            parsed.personId,
            parsed.role,
            parsed.teamId,
            viewer.eventId,
            parsed.personId,
          )
        : this.env.DB.prepare(
            `
            UPDATE evaluation_team_members SET removed_at = unixepoch()
             WHERE team_id = ? AND event_id = ? AND person_id = ?
               AND removed_at IS NULL
               AND EXISTS (
                 SELECT 1 FROM evaluation_teams t
                  WHERE t.id = evaluation_team_members.team_id
                    AND t.event_id = evaluation_team_members.event_id
                    AND t.status = 'active'
               )
          `,
          ).bind(parsed.teamId, viewer.eventId, parsed.personId);
    const statements: D1PreparedStatement[] = [mutation];
    if (parsed.operation === "add" && parsed.role === "chair") {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE evaluation_team_members SET role = 'evaluator'
           WHERE team_id = ? AND event_id = ? AND person_id <> ?
             AND role = 'chair' AND removed_at IS NULL
        `,
        ).bind(parsed.teamId, viewer.eventId, parsed.personId),
        this.env.DB.prepare(
          `
          UPDATE evaluation_teams SET chair_person_id = ?, updated_at = unixepoch()
           WHERE id = ? AND event_id = ? AND status = 'active'
             AND EXISTS (
               SELECT 1 FROM evaluation_team_members tm
                WHERE tm.team_id = evaluation_teams.id
                  AND tm.event_id = evaluation_teams.event_id
                  AND tm.person_id = ? AND tm.role = 'chair'
                  AND tm.removed_at IS NULL
             )
        `,
        ).bind(parsed.personId, parsed.teamId, viewer.eventId, parsed.personId),
      );
    } else if (parsed.operation === "add") {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE evaluation_teams SET chair_person_id = NULL,
                 updated_at = unixepoch()
           WHERE id = ? AND event_id = ? AND chair_person_id = ?
             AND EXISTS (
               SELECT 1 FROM evaluation_team_members tm
                WHERE tm.team_id = evaluation_teams.id
                  AND tm.event_id = evaluation_teams.event_id
                  AND tm.person_id = ? AND tm.role = 'evaluator'
                  AND tm.removed_at IS NULL
             )
        `,
        ).bind(parsed.teamId, viewer.eventId, parsed.personId, parsed.personId),
      );
    } else if (parsed.operation === "remove") {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE evaluation_teams SET chair_person_id = NULL,
                 updated_at = unixepoch()
           WHERE id = ? AND event_id = ? AND chair_person_id = ?
        `,
        ).bind(parsed.teamId, viewer.eventId, parsed.personId),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'evaluation_team', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_teams
            WHERE id = ? AND event_id = ? AND status = 'active'
         )
           AND (
             (? = 'add' AND EXISTS (
               SELECT 1 FROM evaluation_team_members
                WHERE team_id = ? AND event_id = ? AND person_id = ?
                  AND role = ? AND removed_at IS NULL
             ))
             OR
             (? = 'remove' AND NOT EXISTS (
               SELECT 1 FROM evaluation_team_members
                WHERE team_id = ? AND event_id = ? AND person_id = ?
                  AND removed_at IS NULL
             ))
           )
      `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.operation === "add"
          ? "evaluation.team.member.added"
          : "evaluation.team.member.removed",
        parsed.teamId,
        JSON.stringify({
          personId: parsed.personId,
          role: parsed.role,
        }),
        parsed.teamId,
        viewer.eventId,
        parsed.operation,
        parsed.teamId,
        viewer.eventId,
        parsed.personId,
        parsed.role,
        parsed.operation,
        parsed.teamId,
        viewer.eventId,
        parsed.personId,
      ),
    );
    const results = await this.env.DB.batch(statements);
    const changed = results[0];
    const audited = results.at(-1);
    if (
      (changed?.meta.changes ?? 0) !== 1 ||
      (audited?.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationStateError(
        parsed.operation === "remove"
          ? "The person is not an active member of this team."
          : "The team member could not be saved.",
      );
    }
  }

  async addNextRound(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.round.add",
      input,
      command,
      () => this.addNextRoundD1(viewer, input, command),
    );
  }

  private async addNextRoundD1(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const auditActor = evaluationAuditActor(viewer);
    const commandState = await this.prepareApiCommand(
      viewer,
      "evaluation.round.add",
      command,
      roundCommandResultSchema,
    );
    if (commandState.replay) return commandState.replay.roundId;
    const commandGuard = this.commandGuard(commandState.prepared);
    const parsed = nextRoundSchema.parse(input);
    const [plan, clone, criteria] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT id, revision FROM evaluation_plans
         WHERE id = ? AND event_id = ? AND status IN ('draft','active')
      `,
      )
        .bind(parsed.planId, viewer.eventId)
        .first<{ id: string; revision: number }>(),
      this.env.DB.prepare(
        `
        SELECT id FROM evaluation_rounds
         WHERE id = ? AND event_id = ? AND plan_id = ?
      `,
      )
        .bind(parsed.cloneRoundId, viewer.eventId, parsed.planId)
        .first<{ id: string }>(),
      this.env.DB.prepare(
        `
        SELECT name, description, input_type AS inputType,
               weight_percent AS weightPercent, required, position
          FROM evaluation_criteria
         WHERE event_id = ? AND round_id = ? ORDER BY position
      `,
      )
        .bind(viewer.eventId, parsed.cloneRoundId)
        .all<Omit<Criterion, "id">>(),
    ]);
    if (!plan || !clone || criteria.results.length === 0) {
      throw new EvaluationStateError(
        "The plan or source rubric is no longer available.",
      );
    }
    if (plan.revision !== parsed.planRevision) {
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed before the round could be added.",
      );
    }
    const roundId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const dueAt = parsed.dueAt
      ? Math.floor(Date.parse(parsed.dueAt) / 1_000)
      : null;
    const commandStatements = this.commandClaimStatements(
      commandState.prepared,
    );
    const domainStatementIndex = commandStatements.length;
    const statements: D1PreparedStatement[] = [
      ...commandStatements,
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1 FROM evaluation_plans p
              WHERE p.id = ? AND p.event_id = events.id
                AND p.revision = ? AND p.status IN ('draft','active')
                AND (SELECT COUNT(*) FROM evaluation_rounds r
                      WHERE r.plan_id = p.id AND r.event_id = p.event_id) < 10
           )
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds source_round
              WHERE source_round.id = ? AND source_round.event_id = events.id
                AND source_round.plan_id = ?
           )
           ${commandGuard.sql}
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.planId,
        parsed.planRevision,
        parsed.cloneRoundId,
        parsed.planId,
        ...commandGuard.bindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_plans
           SET revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.planId,
        viewer.eventId,
        parsed.planRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status, closes_at,
          advancement_rule_json, revision, created_at, updated_at
        )
        SELECT ?, p.event_id, p.id,
               COALESCE((SELECT MAX(round_number) FROM evaluation_rounds
                          WHERE event_id = p.event_id AND plan_id = p.id), 0) + 1,
               ?, 'draft', ?,
               '{}', 1, unixepoch(), unixepoch()
          FROM evaluation_plans p
         WHERE p.id = ? AND p.event_id = ? AND p.revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        roundId,
        parsed.name,
        dueAt,
        parsed.planId,
        viewer.eventId,
        parsed.planRevision + 1,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ];
    for (const criterion of criteria.results) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO evaluation_criteria (
            id, event_id, round_id, name, description, input_type,
            weight_percent, required, position
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM evaluation_rounds
              WHERE id = ? AND event_id = ? AND plan_id = ?
           )
        `,
        ).bind(
          crypto.randomUUID(),
          viewer.eventId,
          roundId,
          criterion.name,
          criterion.description,
          criterion.inputType,
          criterion.weightPercent,
          criterion.required ? 1 : 0,
          criterion.position,
          roundId,
          viewer.eventId,
          parsed.planId,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, actor_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'evaluation.round.created',
               'evaluation_round', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_rounds WHERE id = ? AND event_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        roundId,
        JSON.stringify({ clonedFromRoundId: parsed.cloneRoundId }),
        roundId,
        viewer.eventId,
      ),
    );
    if (commandState.prepared) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE idempotency_records
             SET status = 'completed', response_status = 201,
                 response_json = json_object('roundId', ?),
                 entity_type = 'evaluation_round', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'evaluation.round.add'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND EXISTS (
               SELECT 1 FROM evaluation_rounds committed_round
                WHERE committed_round.id = ?
                  AND committed_round.event_id = idempotency_records.event_id
                  AND committed_round.plan_id = ?
             )
             AND EXISTS (
               SELECT 1 FROM events committed_event
                WHERE committed_event.id = idempotency_records.event_id
                  AND committed_event.organisation_id = idempotency_records.organisation_id
                  AND committed_event.last_operation_id = ?
             )
        `,
        ).bind(
          roundId,
          roundId,
          commandState.prepared.recordId,
          viewer.organisationId,
          viewer.eventId,
          commandState.prepared.actor.actorId,
          commandState.prepared.input.idempotencyKey,
          commandState.prepared.input.requestHash,
          roundId,
          parsed.planId,
          operationId,
        ),
      );
    }
    const results = await this.env.DB.batch(statements);
    const claimed = results[domainStatementIndex]!;
    if ((claimed.meta.changes ?? 0) !== 1) {
      const replay = await this.recoverApiCommand(commandState.prepared);
      if (replay) return replay.roundId;
      throw new EvaluationRevisionConflictError(
        "The evaluation plan changed before the round could be added.",
      );
    }
    if (commandState.prepared) {
      const replay = await this.readApiCommand(commandState.prepared);
      if (!replay) {
        throw new Error(
          "The evaluation round command did not commit an idempotency result.",
        );
      }
      return replay.roundId;
    }
    return roundId;
  }

  async updateDraftRound(
    viewer: Viewer,
    input: unknown,
    operation?: { operationId: string; auditId: string },
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.round.update",
      operation ? { operationId: operation.operationId, input } : input,
      undefined,
      () => this.updateDraftRoundD1(viewer, input, operation),
    );
  }

  private async updateDraftRoundD1(
    viewer: Viewer,
    input: unknown,
    operation?: { operationId: string; auditId: string },
  ) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = draftRoundUpdateSchema.parse(input);
    const recover = operation
      ? () =>
          this.env.DB.prepare(
            `SELECT round.id
               FROM evaluation_rounds round
               JOIN events event
                 ON event.id = round.event_id AND event.organisation_id = ?
              WHERE round.id = ? AND round.event_id = ?
                AND round.last_operation_id = ?
                AND round.revision = ?
                AND (SELECT COUNT(*) FROM evaluation_criteria criterion
                      WHERE criterion.event_id = round.event_id
                        AND criterion.round_id = round.id) = ?`,
          )
            .bind(
              viewer.organisationId,
              parsed.roundId,
              viewer.eventId,
              operation.operationId,
              parsed.revision + 1,
              parsed.criteria.length,
            )
            .first()
      : null;
    if (await recover?.()) return;
    const operationId = operation?.operationId ?? crypto.randomUUID();
    const dueAt = parsed.dueAt
      ? Math.floor(Date.parse(parsed.dueAt) / 1_000)
      : null;
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds draft_round
              WHERE draft_round.id = ? AND draft_round.event_id = events.id
                AND draft_round.status = 'draft'
                AND draft_round.revision = ?
                AND NOT EXISTS (
                  SELECT 1 FROM evaluator_assignments assignment
                   WHERE assignment.event_id = draft_round.event_id
                     AND assignment.round_id = draft_round.id
                )
           )
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.roundId,
        parsed.revision,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_rounds SET name = ?, closes_at = ?,
               revision = revision + 1, last_operation_id = ?,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ? AND status = 'draft'
           AND NOT EXISTS (
             SELECT 1 FROM evaluator_assignments
              WHERE event_id = ? AND round_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.name,
        dueAt,
        operationId,
        parsed.roundId,
        viewer.eventId,
        parsed.revision,
        viewer.eventId,
        parsed.roundId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_plans SET revision = revision + 1,
               updated_at = unixepoch()
         WHERE event_id = ? AND id = (
           SELECT plan_id FROM evaluation_rounds
            WHERE id = ? AND event_id = ? AND revision = ?
         )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        parsed.roundId,
        viewer.eventId,
        parsed.revision + 1,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        DELETE FROM evaluation_criteria
         WHERE event_id = ? AND round_id = ?
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds
              WHERE id = ? AND event_id = ? AND revision = ?
                AND name = ? AND status = 'draft'
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        parsed.roundId,
        parsed.roundId,
        viewer.eventId,
        parsed.revision + 1,
        parsed.name,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ];
    for (const criterion of parsed.criteria) {
      statements.push(
        this.env.DB.prepare(
          `
          INSERT INTO evaluation_criteria (
            id, event_id, round_id, name, description, input_type,
            weight_percent, required, position
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM evaluation_rounds
              WHERE id = ? AND event_id = ? AND revision = ?
                AND name = ? AND status = 'draft'
           )
             AND EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
             )
        `,
        ).bind(
          criterion.id,
          viewer.eventId,
          parsed.roundId,
          criterion.name,
          criterion.description || null,
          criterion.inputType,
          criterion.weightPercent,
          criterion.required ? 1 : 0,
          criterion.position,
          parsed.roundId,
          viewer.eventId,
          parsed.revision + 1,
          parsed.name,
          viewer.eventId,
          viewer.organisationId,
          operationId,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'evaluation.round.updated',
               'evaluation_round', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_rounds
            WHERE id = ? AND event_id = ? AND revision = ?
              AND name = ? AND status = 'draft'
         )
           AND (SELECT COUNT(*) FROM evaluation_criteria
                 WHERE event_id = ? AND round_id = ?) = ?
      `,
      ).bind(
        operation?.auditId ?? crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.roundId,
        JSON.stringify({ criterionCount: parsed.criteria.length }),
        parsed.roundId,
        viewer.eventId,
        parsed.revision + 1,
        parsed.name,
        viewer.eventId,
        parsed.roundId,
        parsed.criteria.length,
      ),
    );
    let claimed: D1Result<unknown>;
    try {
      [claimed] = await this.env.DB.batch(statements);
    } catch (error) {
      if (await recover?.()) return;
      throw error;
    }
    if ((claimed.meta.changes ?? 0) !== 1) {
      if (await recover?.()) return;
      throw new EvaluationRevisionConflictError(
        "The draft round changed or received assignments before it could be updated.",
      );
    }
  }

  async advanceRound(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ): Promise<EvaluationAdvancementExecutionResult> {
    return this.projectCommand(
      viewer,
      "evaluation.advance",
      input,
      command,
      () => this.advanceRoundD1(viewer, input, command),
    );
  }

  private async advanceRoundD1(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ): Promise<EvaluationAdvancementExecutionResult> {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const auditActor = evaluationAuditActor(viewer);
    const commandState = await this.prepareApiCommand(
      viewer,
      "evaluation.advance",
      command,
      advancementCommandResultSchema,
    );
    if (commandState.replay) return commandState.replay;
    const commandGuard = this.commandGuard(commandState.prepared);
    const parsed = roundAdvancementSchema.parse(input);
    const evaluatorPersonIds = await this.resolveEvaluatorTarget(
      viewer,
      parsed.teamId,
      parsed.evaluatorPersonIds,
    );
    const submissionPlaceholders = parsed.submissionIds
      .map(() => "?")
      .join(",");
    const evaluatorPlaceholders = evaluatorPersonIds.map(() => "?").join(",");
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const result: EvaluationAdvancementResult = {
      advancedSubmissionCount: parsed.submissionIds.length,
      assignmentCount: parsed.submissionIds.length * evaluatorPersonIds.length,
    };
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "round.advanced",
        entityType: "evaluation_round",
        entityId: parsed.toRoundId,
        idempotencyKey: `round.advanced:${parsed.toRoundId}:${parsed.toRoundRevision + 1}`,
        correlationId: operationId,
        data: {
          fromRoundId: parsed.fromRoundId,
          toRoundId: parsed.toRoundId,
          advancedSubmissionCount: result.advancedSubmissionCount,
          assignmentCount: result.assignmentCount,
        },
      },
      auditEventId,
    );
    const eligibilitySql = `
      EXISTS (
        SELECT 1
          FROM evaluation_rounds source_round
          JOIN evaluation_rounds target_round
            ON target_round.plan_id = source_round.plan_id
           AND target_round.event_id = source_round.event_id
           AND target_round.round_number = source_round.round_number + 1
         WHERE source_round.id = ? AND source_round.event_id = ?
           AND source_round.status = 'active' AND source_round.revision = ?
           AND target_round.id = ? AND target_round.status = 'draft'
           AND target_round.revision = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM evaluator_assignments unfinished
         WHERE unfinished.event_id = ? AND unfinished.round_id = ?
           AND unfinished.status IN ('assigned','in_progress','reopened')
      )
      AND NOT EXISTS (
        SELECT 1 FROM evaluator_assignments existing_target_assignment
         WHERE existing_target_assignment.event_id = ?
           AND existing_target_assignment.round_id = ?
      )
      AND (
        SELECT COUNT(DISTINCT eligible.submission_id)
          FROM evaluator_assignments eligible
          JOIN reviews completed_review
            ON completed_review.assignment_id = eligible.id
           AND completed_review.event_id = eligible.event_id
           AND completed_review.status IN ('submitted','locked')
          JOIN submissions candidate
            ON candidate.id = eligible.submission_id
           AND candidate.event_id = eligible.event_id
         WHERE eligible.event_id = ? AND eligible.round_id = ?
           AND eligible.submission_id IN (${submissionPlaceholders})
           AND candidate.status IN ('assigned','in_review','decision_ready')
           AND NOT EXISTS (
             SELECT 1 FROM submission_decisions final_decision
              WHERE final_decision.event_id = candidate.event_id
                AND final_decision.submission_id = candidate.id
                AND final_decision.status = 'published'
           )
      ) = ?
      AND (
        SELECT COUNT(DISTINCT m.person_id) FROM memberships m
         WHERE m.event_id = ? AND m.accepted_at IS NOT NULL
           AND m.revoked_at IS NULL
           AND m.role IN ('evaluator','committee_chair')
           AND m.person_id IN (${evaluatorPlaceholders})
      ) = ?
      ${
        parsed.teamId
          ? `AND (
        SELECT COUNT(DISTINCT tm.person_id)
          FROM evaluation_team_members tm
          JOIN evaluation_teams t
            ON t.id = tm.team_id AND t.event_id = tm.event_id
          JOIN memberships team_membership
            ON team_membership.event_id = tm.event_id
           AND team_membership.person_id = tm.person_id
           AND team_membership.accepted_at IS NOT NULL
           AND team_membership.revoked_at IS NULL
           AND team_membership.role IN ('evaluator','committee_chair')
         WHERE tm.event_id = ? AND tm.team_id = ? AND tm.removed_at IS NULL
           AND t.status = 'active'
           AND tm.person_id IN (${evaluatorPlaceholders})
      ) = ?
      AND (
        SELECT COUNT(DISTINCT tm.person_id)
          FROM evaluation_team_members tm
          JOIN evaluation_teams t
            ON t.id = tm.team_id AND t.event_id = tm.event_id
          JOIN memberships team_membership
            ON team_membership.event_id = tm.event_id
           AND team_membership.person_id = tm.person_id
           AND team_membership.accepted_at IS NOT NULL
           AND team_membership.revoked_at IS NULL
           AND team_membership.role IN ('evaluator','committee_chair')
         WHERE tm.event_id = ? AND tm.team_id = ? AND tm.removed_at IS NULL
           AND t.status = 'active'
      ) = ?`
          : ""
      }
    `;
    const eligibilityBindings: unknown[] = [
      parsed.fromRoundId,
      viewer.eventId,
      parsed.fromRoundRevision,
      parsed.toRoundId,
      parsed.toRoundRevision,
      viewer.eventId,
      parsed.fromRoundId,
      viewer.eventId,
      parsed.toRoundId,
      viewer.eventId,
      parsed.fromRoundId,
      ...parsed.submissionIds,
      parsed.submissionIds.length,
      viewer.eventId,
      ...evaluatorPersonIds,
      evaluatorPersonIds.length,
      ...(parsed.teamId
        ? [
            viewer.eventId,
            parsed.teamId,
            ...evaluatorPersonIds,
            evaluatorPersonIds.length,
            viewer.eventId,
            parsed.teamId,
            evaluatorPersonIds.length,
          ]
        : []),
    ];
    const commandStatements = this.commandClaimStatements(
      commandState.prepared,
    );
    const domainStatementIndex = commandStatements.length;
    const statements: D1PreparedStatement[] = [
      ...commandStatements,
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ? AND ${eligibilitySql}
           ${commandGuard.sql}
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        ...eligibilityBindings,
        ...commandGuard.bindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_rounds SET status = 'closed',
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.fromRoundId,
        viewer.eventId,
        parsed.fromRoundRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_rounds SET status = 'active', opens_at = unixepoch(),
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ? AND status = 'draft'
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.toRoundId,
        viewer.eventId,
        parsed.toRoundRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE reviews SET status = 'locked', locked_at = unixepoch(),
               updated_at = unixepoch()
         WHERE event_id = ? AND status = 'submitted'
           AND assignment_id IN (
             SELECT id FROM evaluator_assignments
              WHERE event_id = ? AND round_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        viewer.eventId,
        parsed.fromRoundId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'decision_ready',
               revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND status IN ('assigned','in_review')
           AND id IN (
             SELECT submission_id FROM evaluator_assignments
              WHERE event_id = ? AND round_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        viewer.eventId,
        parsed.fromRoundId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ];
    for (const submissionId of parsed.submissionIds) {
      for (const evaluatorPersonId of evaluatorPersonIds) {
        statements.push(
          this.env.DB.prepare(
            `
            INSERT INTO evaluator_assignments (
              id, event_id, round_id, submission_id, evaluator_person_id,
              team_id, status, revision, last_operation_id, assigned_at
            )
            SELECT ?, ?, ?, ?, ?, ?, 'assigned', 1, ?, unixepoch()
             WHERE EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
             )
          `,
          ).bind(
            crypto.randomUUID(),
            viewer.eventId,
            parsed.toRoundId,
            submissionId,
            evaluatorPersonId,
            parsed.teamId,
            operationId,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
        );
      }
    }
    statements.push(
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'assigned',
               revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND id IN (${submissionPlaceholders})
           AND status = 'decision_ready'
           AND (
             SELECT COUNT(*) FROM evaluator_assignments next_assignment
              WHERE next_assignment.event_id = submissions.event_id
                AND next_assignment.round_id = ?
                AND next_assignment.submission_id = submissions.id
                AND next_assignment.last_operation_id = ?
           ) = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        ...parsed.submissionIds,
        parsed.toRoundId,
        operationId,
        evaluatorPersonIds.length,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, actor_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'evaluation.round.advanced',
               'evaluation_round', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_rounds
            WHERE id = ? AND event_id = ? AND status = 'active'
         )
           AND (
             SELECT COUNT(*) FROM submissions
              WHERE event_id = ? AND id IN (${submissionPlaceholders})
                AND status = 'assigned'
           ) = ?
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        parsed.toRoundId,
        JSON.stringify({
          fromRoundId: parsed.fromRoundId,
          submissionIds: parsed.submissionIds,
          evaluatorPersonIds,
          teamId: parsed.teamId,
        }),
        parsed.toRoundId,
        viewer.eventId,
        viewer.eventId,
        ...parsed.submissionIds,
        parsed.submissionIds.length,
      ),
    );
    if (commandState.prepared) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE idempotency_records
             SET status = 'completed', response_status = 200,
                 response_json = json_object(
                   'advancedSubmissionCount', ?,
                   'assignmentCount', ?
                 ),
                 entity_type = 'evaluation_round', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'evaluation.advance'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND EXISTS (
               SELECT 1 FROM evaluation_rounds committed_round
                WHERE committed_round.id = ?
                  AND committed_round.event_id = idempotency_records.event_id
                  AND committed_round.status = 'active'
             )
             AND (
               SELECT COUNT(*) FROM evaluator_assignments committed_assignment
                WHERE committed_assignment.event_id = idempotency_records.event_id
                  AND committed_assignment.round_id = ?
                  AND committed_assignment.last_operation_id = ?
             ) = ?
        `,
        ).bind(
          result.advancedSubmissionCount,
          result.assignmentCount,
          parsed.toRoundId,
          commandState.prepared.recordId,
          viewer.organisationId,
          viewer.eventId,
          commandState.prepared.actor.actorId,
          commandState.prepared.input.idempotencyKey,
          commandState.prepared.input.requestHash,
          parsed.toRoundId,
          parsed.toRoundId,
          operationId,
          result.assignmentCount,
        ),
      );
    }
    statements.push(...preparedWebhook.statements);
    const results = await this.env.DB.batch(statements);
    const claimed = results[domainStatementIndex]!;
    if ((claimed.meta.changes ?? 0) !== 1) {
      const replay = await this.recoverApiCommand(commandState.prepared);
      if (replay) return replay;
      throw new EvaluationRevisionConflictError(
        "Round advancement could not be committed. Complete all current assignments and refresh the plan before trying again.",
      );
    }
    const webhookDeliveries =
      await webhookService.dispatchPreparedEvent(preparedWebhook);
    if (commandState.prepared) {
      const replay = await this.readApiCommand(commandState.prepared);
      if (!replay) {
        throw new Error(
          "The evaluation advancement command did not commit an idempotency result.",
        );
      }
      return replay;
    }
    return { ...result, webhookDeliveries };
  }

  async assign(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ): Promise<EvaluationAssignmentResult> {
    return this.projectCommand(
      viewer,
      "evaluation.assign",
      input,
      command,
      () => this.assignD1(viewer, input, command),
    );
  }

  private async assignD1(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ): Promise<EvaluationAssignmentResult> {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const auditActor = evaluationAuditActor(viewer);
    const commandState = await this.prepareApiCommand(
      viewer,
      "evaluation.assign",
      command,
      assignmentCommandResultSchema,
    );
    if (commandState.replay) return commandState.replay;
    const commandGuard = this.commandGuard(commandState.prepared);
    const parsed = assignmentBatchSchema.parse(input);
    const evaluatorPersonIds = await this.resolveEvaluatorTarget(
      viewer,
      parsed.teamId,
      parsed.evaluatorPersonIds,
    );
    const round = await this.env.DB.prepare(
      `
      SELECT r.id FROM evaluation_rounds r JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id
      JOIN events e ON e.id = r.event_id WHERE r.id = ? AND r.event_id = ? AND e.organisation_id = ? AND r.status = 'active'
    `,
    )
      .bind(parsed.roundId, viewer.eventId, viewer.organisationId)
      .first();
    if (!round)
      throw new EvaluationStateError("Active evaluation round not found.");
    const targetTable =
      parsed.targetType === "submission" ? "submissions" : "sessions";
    const targetStatus =
      parsed.targetType === "submission"
        ? "status IN ('submitted','assigned','in_review')"
        : "status NOT IN ('cancelled','archived')";
    const targetColumn =
      parsed.targetType === "submission" ? "submission_id" : "session_id";
    const targetPlaceholders = parsed.targetIds.map(() => "?").join(",");
    const validTargets = await this.env.DB.prepare(
      `SELECT id FROM ${targetTable} WHERE event_id = ? AND id IN (${targetPlaceholders}) AND ${targetStatus}`,
    )
      .bind(viewer.eventId, ...parsed.targetIds)
      .all<{ id: string }>();
    if (validTargets.results.length !== parsed.targetIds.length)
      throw new EvaluationStateError(
        `One or more ${parsed.targetType}s cannot be assigned.`,
      );
    const operationId = crypto.randomUUID();
    const evaluatorPlaceholders = evaluatorPersonIds.map(() => "?").join(",");
    const eligibilitySql = `
      EXISTS (
        SELECT 1
          FROM evaluation_rounds current_round
          JOIN evaluation_plans current_plan
            ON current_plan.id = current_round.plan_id
           AND current_plan.event_id = current_round.event_id
          JOIN events current_event ON current_event.id = current_round.event_id
         WHERE current_round.id = ? AND current_round.event_id = ?
           AND current_event.organisation_id = ? AND current_round.status = 'active'
      )
      AND (
        SELECT COUNT(*) FROM ${targetTable} current_target
         WHERE current_target.event_id = ?
           AND current_target.id IN (${targetPlaceholders})
           AND current_target.${targetStatus}
      ) = ?
      AND (
        SELECT COUNT(DISTINCT current_membership.person_id)
          FROM memberships current_membership
         WHERE current_membership.event_id = ?
           AND current_membership.accepted_at IS NOT NULL
           AND current_membership.revoked_at IS NULL
           AND current_membership.role IN ('evaluator','committee_chair')
           AND current_membership.person_id IN (${evaluatorPlaceholders})
      ) = ?
      ${
        parsed.teamId
          ? `AND (
        SELECT COUNT(DISTINCT current_team_member.person_id)
          FROM evaluation_team_members current_team_member
          JOIN evaluation_teams current_team
            ON current_team.id = current_team_member.team_id
           AND current_team.event_id = current_team_member.event_id
          JOIN memberships current_team_membership
            ON current_team_membership.event_id = current_team_member.event_id
           AND current_team_membership.person_id = current_team_member.person_id
           AND current_team_membership.accepted_at IS NOT NULL
           AND current_team_membership.revoked_at IS NULL
           AND current_team_membership.role IN ('evaluator','committee_chair')
         WHERE current_team_member.event_id = ?
           AND current_team_member.team_id = ?
           AND current_team_member.removed_at IS NULL
           AND current_team.status = 'active'
           AND current_team_member.person_id IN (${evaluatorPlaceholders})
      ) = ?
      AND (
        SELECT COUNT(DISTINCT current_team_member.person_id)
          FROM evaluation_team_members current_team_member
          JOIN evaluation_teams current_team
            ON current_team.id = current_team_member.team_id
           AND current_team.event_id = current_team_member.event_id
          JOIN memberships current_team_membership
            ON current_team_membership.event_id = current_team_member.event_id
           AND current_team_membership.person_id = current_team_member.person_id
           AND current_team_membership.accepted_at IS NOT NULL
           AND current_team_membership.revoked_at IS NULL
           AND current_team_membership.role IN ('evaluator','committee_chair')
         WHERE current_team_member.event_id = ?
           AND current_team_member.team_id = ?
           AND current_team_member.removed_at IS NULL
           AND current_team.status = 'active'
      ) = ?`
          : ""
      }
      AND NOT EXISTS (
        SELECT 1 FROM evaluator_assignments blocked_assignment
         WHERE blocked_assignment.event_id = ?
           AND blocked_assignment.round_id = ?
           AND blocked_assignment.${targetColumn} IN (${targetPlaceholders})
           AND blocked_assignment.evaluator_person_id IN (${evaluatorPlaceholders})
           AND blocked_assignment.status IN ('recused','cancelled')
      )
      ${commandGuard.sql}
    `;
    const eligibilityBindings = [
      parsed.roundId,
      viewer.eventId,
      viewer.organisationId,
      viewer.eventId,
      ...parsed.targetIds,
      parsed.targetIds.length,
      viewer.eventId,
      ...evaluatorPersonIds,
      evaluatorPersonIds.length,
      ...(parsed.teamId
        ? [
            viewer.eventId,
            parsed.teamId,
            ...evaluatorPersonIds,
            evaluatorPersonIds.length,
            viewer.eventId,
            parsed.teamId,
            evaluatorPersonIds.length,
          ]
        : []),
      viewer.eventId,
      parsed.roundId,
      ...parsed.targetIds,
      ...evaluatorPersonIds,
      ...commandGuard.bindings,
    ];
    const coverageSql = `
      (
        SELECT COUNT(*) FROM evaluator_assignments requested_assignment
         WHERE requested_assignment.event_id = ?
           AND requested_assignment.round_id = ?
           AND requested_assignment.${targetColumn} IN (${targetPlaceholders})
           AND requested_assignment.evaluator_person_id IN (${evaluatorPlaceholders})
           AND requested_assignment.status NOT IN ('recused','cancelled')
      ) = ?
    `;
    const coverageBindings = [
      viewer.eventId,
      parsed.roundId,
      ...parsed.targetIds,
      ...evaluatorPersonIds,
      parsed.targetIds.length * evaluatorPersonIds.length,
    ];
    const commandStatements = this.commandClaimStatements(
      commandState.prepared,
    );
    const domainStatementIndex = commandStatements.length;
    const statements: D1PreparedStatement[] = [...commandStatements];
    const assignmentTargetSelect =
      parsed.targetType === "submission"
        ? "target.id, NULL, NULL"
        : `NULL, target.id,
           json_object(
             'schemaVersion', 1,
             'sessionId', target.id,
             'title', target.title,
             'description', target.description,
             'format', target.format,
             'durationMinutes', target.duration_minutes,
             'trackName', (
               SELECT track.name FROM tracks track
                WHERE track.id = target.track_id AND track.event_id = target.event_id
             ),
             'speakers', json(COALESCE((
               SELECT json_group_array(json(ordered_speaker.snapshot))
                 FROM (
                   SELECT json_object(
                            'name', person.display_name,
                            'roleLabel', session_speaker.role_label
                          ) AS snapshot
                     FROM session_speakers session_speaker
                     JOIN people person ON person.id = session_speaker.person_id
                    WHERE session_speaker.session_id = target.id
                      AND session_speaker.event_id = target.event_id
                    ORDER BY session_speaker.position
                 ) ordered_speaker
             ), '[]'))
           )`;
    const conflictTarget = `ON CONFLICT(round_id, ${targetColumn}, evaluator_person_id)
      WHERE ${targetColumn} IS NOT NULL DO NOTHING`;
    for (const targetId of parsed.targetIds)
      for (const evaluatorId of evaluatorPersonIds) {
        statements.push(
          this.env.DB.prepare(
            `
        INSERT INTO evaluator_assignments (
          id, event_id, round_id, submission_id, session_id,
          session_snapshot_json, evaluator_person_id, status, team_id,
          revision, last_operation_id, assigned_at
        )
        SELECT ?, ?, ?, ${assignmentTargetSelect}, ?, 'assigned', ?, 1, ?, unixepoch()
          FROM ${targetTable} target
         WHERE target.id = ? AND target.event_id = ? AND target.${targetStatus}
           AND ${eligibilitySql}
        ${conflictTarget}
      `,
          ).bind(
            crypto.randomUUID(),
            viewer.eventId,
            parsed.roundId,
            evaluatorId,
            parsed.teamId,
            operationId,
            targetId,
            viewer.eventId,
            ...eligibilityBindings,
          ),
        );
      }
    if (parsed.targetType === "submission") {
      statements.push(
        this.env.DB.prepare(
          `
      UPDATE submissions
         SET status = 'assigned', revision = revision + 1,
             last_operation_id = ?, updated_at = unixepoch()
       WHERE event_id = ? AND id IN (${targetPlaceholders})
         AND status = 'submitted'
         AND ${eligibilitySql}
         AND ${coverageSql}
    `,
        ).bind(
          operationId,
          viewer.eventId,
          ...parsed.targetIds,
          ...eligibilityBindings,
          ...coverageBindings,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, actor_id, action,
        entity_type, metadata_json, created_at
      )
      SELECT ?, ?, ?, ?, ?, 'evaluation.assignments.created',
             'evaluator_assignment', ?, unixepoch()
       WHERE ${eligibilitySql} AND ${coverageSql}
         AND EXISTS (
           SELECT 1 FROM evaluator_assignments created_assignment
            WHERE created_assignment.event_id = ?
              AND created_assignment.round_id = ?
              AND created_assignment.last_operation_id = ?
         )
    `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        JSON.stringify({
          targetType: parsed.targetType,
          targetCount: parsed.targetIds.length,
          evaluatorCount: evaluatorPersonIds.length,
          teamId: parsed.teamId,
        }),
        ...eligibilityBindings,
        ...coverageBindings,
        viewer.eventId,
        parsed.roundId,
        operationId,
      ),
    );
    statements.push(
      this.env.DB.prepare(
        `
      SELECT CASE WHEN ${eligibilitySql} AND ${coverageSql}
                  THEN 1 ELSE 0 END AS valid
    `,
      ).bind(...eligibilityBindings, ...coverageBindings),
    );
    const validationStatementIndex = statements.length - 1;
    const requestedAssignmentCount =
      parsed.targetIds.length * evaluatorPersonIds.length;
    if (commandState.prepared) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE idempotency_records
             SET status = 'completed', response_status = 200,
                 response_json = json_object(
                   'createdAssignmentCount', (
                     SELECT COUNT(*) FROM evaluator_assignments created
                      WHERE created.event_id = idempotency_records.event_id
                        AND created.round_id = ?
                        AND created.last_operation_id = ?
                   ),
                   'requestedAssignmentCount', ?,
                   'undoOperationId', CASE WHEN EXISTS (
                     SELECT 1 FROM evaluator_assignments created
                      WHERE created.event_id = idempotency_records.event_id
                        AND created.round_id = ?
                        AND created.last_operation_id = ?
                   ) THEN ? ELSE NULL END,
                   'undoExpiresAt', CASE WHEN EXISTS (
                     SELECT 1 FROM evaluator_assignments created
                      WHERE created.event_id = idempotency_records.event_id
                        AND created.round_id = ?
                        AND created.last_operation_id = ?
                   ) THEN unixepoch() + 300 ELSE NULL END
                 ),
                 entity_type = 'evaluator_assignment', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'evaluation.assign'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND ${eligibilitySql} AND ${coverageSql}
        `,
        ).bind(
          parsed.roundId,
          operationId,
          requestedAssignmentCount,
          parsed.roundId,
          operationId,
          operationId,
          parsed.roundId,
          operationId,
          operationId,
          commandState.prepared.recordId,
          viewer.organisationId,
          viewer.eventId,
          commandState.prepared.actor.actorId,
          commandState.prepared.input.idempotencyKey,
          commandState.prepared.input.requestHash,
          ...eligibilityBindings,
          ...coverageBindings,
        ),
      );
    }
    const results = await this.env.DB.batch(statements);
    const validation = results[validationStatementIndex]?.results?.[0] as
      { valid?: number | boolean } | undefined;
    if (Number(validation?.valid ?? 0) !== 1) {
      const replay = await this.recoverApiCommand(commandState.prepared);
      if (replay) return replay;
      throw new EvaluationRevisionConflictError(
        "The round, evaluation targets, or evaluators changed before the assignments were created. Refresh before trying again.",
      );
    }
    const createdAssignmentCount = results
      .slice(
        domainStatementIndex,
        domainStatementIndex + requestedAssignmentCount,
      )
      .reduce((count, result) => count + (result.meta.changes ?? 0), 0);
    const result: EvaluationAssignmentResult = {
      createdAssignmentCount,
      requestedAssignmentCount,
      undoOperationId: createdAssignmentCount > 0 ? operationId : null,
      undoExpiresAt:
        createdAssignmentCount > 0
          ? Math.floor(Date.now() / 1_000) + 5 * 60
          : null,
    };
    if (commandState.prepared) {
      const replay = await this.readApiCommand(commandState.prepared);
      if (!replay) {
        throw new Error(
          "The evaluation assignment command did not commit an idempotency result.",
        );
      }
      return replay;
    }
    return result;
  }

  async undoAssignments(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.assign.undo",
      input,
      undefined,
      () => this.undoAssignmentsD1(viewer, input),
    );
  }

  private async undoAssignmentsD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = assignmentUndoSchema.parse(input);
    const operation = await this.env.DB.prepare(
      `
      SELECT COUNT(*) AS assignmentCount,
             SUM(CASE
               WHEN a.status <> 'assigned'
                 OR a.assigned_at < unixepoch() - 300
                 OR round.status <> 'active'
                 OR EXISTS (
                   SELECT 1 FROM reviews review
                    WHERE review.event_id = a.event_id
                      AND review.assignment_id = a.id
                 )
               THEN 1 ELSE 0 END) AS blockedCount
        FROM evaluator_assignments a
        JOIN evaluation_rounds round
          ON round.id = a.round_id AND round.event_id = a.event_id
       WHERE a.event_id = ? AND a.last_operation_id = ?
         AND EXISTS (
           SELECT 1 FROM audit_events original
            WHERE original.id = ?
              AND original.organisation_id = ?
              AND original.event_id = a.event_id
              AND original.action = 'evaluation.assignments.created'
         )
    `,
    )
      .bind(
        viewer.eventId,
        parsed.operationId,
        parsed.operationId,
        viewer.organisationId,
      )
      .first<{ assignmentCount: number; blockedCount: number | null }>();
    const assignmentCount = Number(operation?.assignmentCount ?? 0);
    if (assignmentCount === 0) {
      const auditState = await this.env.DB.prepare(
        `
        SELECT
          EXISTS (
            SELECT 1 FROM audit_events original
             WHERE original.id = ? AND original.organisation_id = ?
               AND original.event_id = ?
               AND original.action = 'evaluation.assignments.created'
          ) AS originalExists,
          EXISTS (
            SELECT 1 FROM audit_events undone
             WHERE undone.organisation_id = ? AND undone.event_id = ?
               AND undone.action = 'evaluation.assignments.undone'
               AND undone.entity_id = ?
          ) AS alreadyUndone
      `,
      )
        .bind(
          parsed.operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.organisationId,
          viewer.eventId,
          parsed.operationId,
        )
        .first<{
          originalExists: number | boolean;
          alreadyUndone: number | boolean;
        }>();
      if (auditState?.originalExists && !auditState.alreadyUndone) {
        throw new EvaluationStateError(
          "These assignments can no longer be undone because five minutes elapsed, the round changed, or review work started.",
        );
      }
      throw new EvaluationStateError(
        "The assignment operation was not found or has already been undone.",
      );
    }
    if (Number(operation?.blockedCount ?? 0) > 0) {
      throw new EvaluationStateError(
        "These assignments can no longer be undone because five minutes elapsed, the round changed, or review work started.",
      );
    }

    const undoAuditId = crypto.randomUUID();
    const [deleted, , audited] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        DELETE FROM evaluator_assignments
         WHERE event_id = ? AND last_operation_id = ?
           AND EXISTS (
             SELECT 1 FROM audit_events original
              WHERE original.id = ?
                AND original.organisation_id = ?
                AND original.event_id = evaluator_assignments.event_id
                AND original.action = 'evaluation.assignments.created'
           )
           AND NOT EXISTS (
             SELECT 1
               FROM evaluator_assignments blocked
               JOIN evaluation_rounds blocked_round
                 ON blocked_round.id = blocked.round_id
                AND blocked_round.event_id = blocked.event_id
              WHERE blocked.event_id = evaluator_assignments.event_id
                AND blocked.last_operation_id = ?
                AND (
                  blocked.status <> 'assigned'
                  OR blocked.assigned_at < unixepoch() - 300
                  OR blocked_round.status <> 'active'
                  OR EXISTS (
                    SELECT 1 FROM reviews review
                     WHERE review.event_id = blocked.event_id
                       AND review.assignment_id = blocked.id
                  )
                )
           )
      `,
      ).bind(
        viewer.eventId,
        parsed.operationId,
        parsed.operationId,
        viewer.organisationId,
        parsed.operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submissions
           SET status = 'submitted', revision = revision + 1,
               last_operation_id = ?, updated_at = unixepoch()
         WHERE event_id = ? AND status = 'assigned'
           AND last_operation_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM evaluator_assignments remaining
              WHERE remaining.event_id = submissions.event_id
                AND remaining.submission_id = submissions.id
                AND remaining.status NOT IN ('recused','cancelled')
           )
           AND NOT EXISTS (
             SELECT 1 FROM evaluator_assignments original
              WHERE original.event_id = submissions.event_id
                AND original.last_operation_id = ?
           )
      `,
      ).bind(
        undoAuditId,
        viewer.eventId,
        parsed.operationId,
        parsed.operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'evaluation.assignments.undone',
               'evaluator_assignment', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM audit_events original
            WHERE original.id = ? AND original.organisation_id = ?
              AND original.event_id = ?
              AND original.action = 'evaluation.assignments.created'
         )
           AND NOT EXISTS (
             SELECT 1 FROM evaluator_assignments remaining
              WHERE remaining.event_id = ?
                AND remaining.last_operation_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM audit_events prior_undo
              WHERE prior_undo.event_id = ?
                AND prior_undo.action = 'evaluation.assignments.undone'
                AND prior_undo.entity_id = ?
           )
      `,
      ).bind(
        undoAuditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.operationId,
        JSON.stringify({ assignmentCount }),
        parsed.operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.eventId,
        parsed.operationId,
        viewer.eventId,
        parsed.operationId,
      ),
    ]);
    if (
      (deleted.meta.changes ?? 0) !== assignmentCount ||
      (audited.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationRevisionConflictError(
        "The assignments changed before the undo could be committed. Refresh before trying again.",
      );
    }
    return { undoneAssignmentCount: assignmentCount };
  }

  async getReviewerWorkspace(viewer: Viewer, selectedAssignmentId?: string) {
    return this.readAuthoritative(viewer, () =>
      this.getReviewerWorkspaceD1(viewer, selectedAssignmentId),
    );
  }

  async getReviewerWorkbench(viewer: Viewer, selectedAssignmentId?: string) {
    return this.readAuthoritative(viewer, async () => {
      let workspace;
      try {
        workspace = await this.getReviewerWorkspaceD1(
          viewer,
          selectedAssignmentId,
        );
      } catch (error) {
        if (
          !(error instanceof Response) ||
          error.status !== 404 ||
          selectedAssignmentId === undefined
        ) {
          throw error;
        }
        const recused = await this.env.DB.prepare(
          `SELECT 1
             FROM evaluator_assignments assignment
             JOIN events event
               ON event.id = assignment.event_id
              AND event.organisation_id = ?
            WHERE assignment.id = ? AND assignment.event_id = ?
              AND assignment.evaluator_person_id = ?
              AND assignment.status = 'recused'`,
        )
          .bind(
            viewer.organisationId,
            selectedAssignmentId,
            viewer.eventId,
            viewer.personId,
          )
          .first();
        if (recused) return { kind: "selection_recused" as const };
        throw error;
      }

      const event = await this.env.DB.prepare(
        `SELECT name
           FROM events
          WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{ name: string }>();
      if (!event) throw new Response("Event not found", { status: 404 });
      return {
        kind: "ready" as const,
        eventName: event.name,
        workspace,
      };
    });
  }

  private async getReviewerWorkspaceD1(
    viewer: Viewer,
    selectedAssignmentId?: string,
  ) {
    await this.assertViewerEvent(viewer);
    const assignments = await this.env.DB.prepare(
      `
      SELECT a.id, a.status, a.revision, a.due_at AS dueAt,
             a.submission_id AS submissionId, a.session_id AS sessionId,
             submission.public_reference AS submissionReference,
             submission.submitted_snapshot_json AS submissionSnapshotJson,
             session.slug AS sessionReference,
             a.session_snapshot_json AS sessionSnapshotJson,
             p.blinded_reviewing AS blindedReviewing
        FROM evaluator_assignments a
        LEFT JOIN submissions submission
          ON submission.id = a.submission_id
         AND submission.event_id = a.event_id
        LEFT JOIN sessions session
          ON session.id = a.session_id AND session.event_id = a.event_id
        JOIN evaluation_rounds r ON r.id = a.round_id AND r.event_id = a.event_id
        JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id
       WHERE a.event_id = ? AND a.evaluator_person_id = ?
         AND a.status NOT IN ('recused','cancelled')
       ORDER BY CASE a.status WHEN 'in_progress' THEN 0 WHEN 'reopened' THEN 0 WHEN 'assigned' THEN 1 ELSE 2 END,
                a.due_at, a.assigned_at
    `,
    )
      .bind(viewer.eventId, viewer.personId)
      .all<{
        id: string;
        status: string;
        revision: number;
        dueAt: number | null;
        submissionId: string | null;
        sessionId: string | null;
        submissionReference: string | null;
        submissionSnapshotJson: string | null;
        sessionReference: string | null;
        sessionSnapshotJson: string | null;
        blindedReviewing: number | boolean;
      }>();
    const reviewerAssignments = assignments.results.map(
      ({ submissionSnapshotJson, sessionSnapshotJson, ...assignment }) => {
        const blindedReviewing = Boolean(assignment.blindedReviewing);
        if (assignment.submissionId) {
          const snapshot = requireSubmittedSnapshot(
            assignment.submissionId,
            submissionSnapshotJson,
          );
          const answers = reviewerVisibleAnswers(
            snapshot.schema,
            snapshot.answers,
          );
          return {
            ...assignment,
            targetType: "submission" as const,
            targetId: assignment.submissionId,
            reference: assignment.submissionReference!,
            title:
              summaryAnswer(answers.title) ??
              (blindedReviewing
                ? "Blinded proposal"
                : "Proposal title restricted"),
            category: summaryAnswer(answers.category),
            format: summaryAnswer(answers.format),
            blindedReviewing,
          };
        }
        if (!assignment.sessionId) {
          throw new Error(
            `Evaluation assignment ${assignment.id} has no source target.`,
          );
        }
        const snapshot = requireSessionReviewSnapshot(
          assignment.id,
          sessionSnapshotJson,
        );
        return {
          ...assignment,
          targetType: "session" as const,
          targetId: assignment.sessionId,
          reference: `Session · ${assignment.sessionReference!}`,
          title: snapshot.title,
          category: snapshot.trackName,
          format: snapshot.format,
          blindedReviewing,
        };
      },
    );
    const selected =
      selectedAssignmentId === undefined
        ? (reviewerAssignments[0] ?? null)
        : (reviewerAssignments.find(
            (assignment) => assignment.id === selectedAssignmentId,
          ) ?? null);
    if (selectedAssignmentId !== undefined && !selected) {
      throw new Response("Review assignment not found", { status: 404 });
    }
    if (!selected)
      return {
        assignments: [],
        selected: null,
        criteria: [],
        submission: null,
        review: null,
        attachments: [],
      };
    const [criteria, source, review, attachments] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT c.id, c.name, c.description, c.input_type AS inputType,
               c.weight_percent AS weightPercent, c.required, c.position
          FROM evaluation_criteria c JOIN evaluator_assignments a ON a.round_id = c.round_id AND a.event_id = c.event_id
         WHERE a.id = ? AND a.event_id = ? ORDER BY c.position
      `,
      )
        .bind(selected.id, viewer.eventId)
        .all<Criterion>(),
      this.env.DB.prepare(
        `
        SELECT a.submission_id AS submissionId, a.session_id AS sessionId,
               submission.submitted_snapshot_json AS submissionSnapshotJson,
               a.session_snapshot_json AS sessionSnapshotJson
          FROM evaluator_assignments a
          LEFT JOIN submissions submission
            ON submission.id = a.submission_id
           AND submission.event_id = a.event_id
         WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ?
      `,
      )
        .bind(selected.id, viewer.eventId, viewer.personId)
        .first<{
          submissionId: string | null;
          sessionId: string | null;
          submissionSnapshotJson: string | null;
          sessionSnapshotJson: string | null;
        }>(),
      this.env.DB.prepare(
        `
        SELECT r.id, r.status, r.scores_json AS scoresJson, r.weighted_score AS weightedScore,
               r.recommendation, r.confidence, r.submitter_feedback AS submitterFeedback,
               r.private_notes AS privateNotes, r.revision
          FROM reviews r JOIN evaluator_assignments a ON a.id = r.assignment_id AND a.event_id = r.event_id
         WHERE r.assignment_id = ? AND r.event_id = ? AND a.evaluator_person_id = ?
      `,
      )
        .bind(selected.id, viewer.eventId, viewer.personId)
        .first<{
          id: string;
          status: string;
          scoresJson: string;
          weightedScore: number | null;
          recommendation: string | null;
          confidence: number | null;
          submitterFeedback: string | null;
          privateNotes: string | null;
          revision: number;
        }>(),
      this.env.DB.prepare(
        `
        SELECT fa.id, fv.id AS versionId, fa.asset_kind AS kind,
               fv.original_filename AS filename,
               COALESCE(fv.detected_content_type, fv.declared_content_type) AS contentType,
               fv.size_bytes AS sizeBytes
          FROM file_assets fa
          JOIN file_versions fv
            ON fv.id = fa.current_version_id AND fv.event_id = fa.event_id
          JOIN evaluator_assignments a
            ON a.event_id = fa.event_id
           AND (
             (fa.target_type = 'submission' AND a.submission_id = fa.target_id)
             OR
             (fa.target_type = 'session' AND a.session_id = fa.target_id)
           )
         WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ?
           AND a.status NOT IN ('recused','cancelled')
           AND fa.status = 'active'
           AND fv.upload_status = 'uploaded'
           AND fv.signature_status = 'valid' AND fv.scan_status = 'clean'
           AND fv.released_at IS NOT NULL AND fv.deleted_at IS NULL
         ORDER BY fa.created_at, fa.id
      `,
      )
        .bind(selected.id, viewer.eventId, viewer.personId)
        .all<{
          id: string;
          versionId: string;
          kind: string;
          filename: string;
          contentType: string;
          sizeBytes: number;
        }>(),
    ]);
    if (!source) {
      throw new Error(
        `Evaluation assignment ${selected.id} lost its source target.`,
      );
    }
    let submissionView;
    let selectedSubmissionSnapshot: ReturnType<
      typeof requireSubmittedSnapshot
    > | null = null;
    if (source.submissionId) {
      const snapshot = requireSubmittedSnapshot(
        source.submissionId,
        source.submissionSnapshotJson,
      );
      selectedSubmissionSnapshot = snapshot;
      const answers = reviewerVisibleAnswers(snapshot.schema, snapshot.answers);
      submissionView = {
        sourceType: "submission" as const,
        id: source.submissionId,
        title:
          summaryAnswer(answers.title) ??
          (selected.blindedReviewing
            ? "Blinded proposal"
            : "Proposal title restricted"),
        category: summaryAnswer(answers.category),
        format: summaryAnswer(answers.format),
        answers,
        answerFields: snapshot.schema.fields
          .filter((field) => Object.hasOwn(answers, field.id))
          .map((field) => ({
            id: field.id,
            label: field.label,
            value: answers[field.id],
          })),
        blindedReviewing: Boolean(selected.blindedReviewing),
        submitterEmail: selected.blindedReviewing
          ? null
          : (snapshot.speakers[0]?.email ?? null),
        speakerNames: selected.blindedReviewing
          ? []
          : snapshot.speakers.map((speaker) => speaker.name),
      };
    } else if (source.sessionId) {
      const snapshot = requireSessionReviewSnapshot(
        selected.id,
        source.sessionSnapshotJson,
      );
      const sessionAnswers = {
        description: snapshot.description ?? "",
        format: snapshot.format,
        durationMinutes: snapshot.durationMinutes,
        track: snapshot.trackName ?? "Unassigned",
      };
      submissionView = {
        sourceType: "session" as const,
        id: source.sessionId,
        title: snapshot.title,
        category: snapshot.trackName,
        format: snapshot.format,
        answers: sessionAnswers,
        answerFields: [
          {
            id: "description",
            label: "Description",
            value: sessionAnswers.description,
          },
          { id: "format", label: "Format", value: sessionAnswers.format },
          {
            id: "durationMinutes",
            label: "Duration",
            value: `${sessionAnswers.durationMinutes} minutes`,
          },
          { id: "track", label: "Track", value: sessionAnswers.track },
        ],
        blindedReviewing: Boolean(selected.blindedReviewing),
        submitterEmail: null,
        speakerNames: selected.blindedReviewing
          ? []
          : snapshot.speakers.map((speaker) => speaker.name),
      };
    } else {
      throw new Error(
        `Evaluation assignment ${selected.id} has no source target.`,
      );
    }
    return {
      assignments: reviewerAssignments,
      selected,
      criteria: criteria.results.map((criterion) => ({
        ...criterion,
        required: Boolean(criterion.required),
      })),
      submission: submissionView,
      review: review
        ? {
            ...review,
            scores: JSON.parse(review.scoresJson) as Record<
              string,
              string | number | boolean
            >,
          }
        : null,
      attachments: attachments.results
        .filter(
          (attachment) =>
            !selectedSubmissionSnapshot ||
            reviewerCanSeeSubmissionAttachment(
              selectedSubmissionSnapshot,
              attachment.id,
              attachment.versionId,
            ),
        )
        .map(({ versionId: _versionId, ...attachment }) => ({
          ...attachment,
          downloadHref: `/review/files/${encodeURIComponent(attachment.id)}`,
        })),
    };
  }

  async downloadReviewerAttachment(viewer: Viewer, assetId: string) {
    return this.readAuthoritative(viewer, () =>
      this.downloadReviewerAttachmentD1(viewer, assetId),
    );
  }

  private async downloadReviewerAttachmentD1(viewer: Viewer, assetId: string) {
    await this.assertViewerEvent(viewer);
    const manager =
      viewer.role === "owner" ||
      viewer.role === "administrator" ||
      viewer.role === "committee_chair";
    const version = await this.env.DB.prepare(
      `
      SELECT fv.id AS versionId, fv.object_key AS objectKey,
             fv.object_etag AS objectEtag, fa.target_type AS targetType,
             fa.target_id AS targetId,
             submission.submitted_snapshot_json AS submissionSnapshotJson,
             fv.original_filename AS filename,
             COALESCE(fv.detected_content_type, fv.declared_content_type) AS contentType
        FROM file_assets fa
        JOIN file_versions fv
          ON fv.id = fa.current_version_id AND fv.event_id = fa.event_id
        JOIN events e ON e.id = fa.event_id AND e.organisation_id = ?
        LEFT JOIN submissions submission
          ON submission.id = fa.target_id
         AND submission.event_id = fa.event_id
         AND fa.target_type = 'submission'
       WHERE fa.id = ? AND fa.event_id = ?
         AND fa.target_type IN ('submission','session')
         AND fa.status = 'active' AND fv.upload_status = 'uploaded'
         AND fv.signature_status = 'valid' AND fv.scan_status = 'clean'
         AND fv.released_at IS NOT NULL AND fv.deleted_at IS NULL
         AND (
           ? = 1 OR EXISTS (
             SELECT 1 FROM evaluator_assignments a
              WHERE a.event_id = fa.event_id
                AND (
                  (fa.target_type = 'submission'
                   AND a.submission_id = fa.target_id)
                  OR
                  (fa.target_type = 'session' AND a.session_id = fa.target_id)
                )
                AND a.evaluator_person_id = ?
                AND a.status NOT IN ('recused','cancelled')
           )
         )
    `,
    )
      .bind(
        viewer.organisationId,
        assetId,
        viewer.eventId,
        manager ? 1 : 0,
        viewer.personId,
      )
      .first<{
        versionId: string;
        objectKey: string;
        objectEtag: string | null;
        targetType: "submission" | "session";
        targetId: string;
        submissionSnapshotJson: string | null;
        filename: string;
        contentType: string;
      }>();
    if (!version) {
      throw new Response("Review attachment not found.", { status: 404 });
    }
    if (!manager && version.targetType === "submission") {
      const snapshot = parseSubmittedSnapshot(version.submissionSnapshotJson);
      if (
        !snapshot ||
        !reviewerCanSeeSubmissionAttachment(
          snapshot,
          assetId,
          version.versionId,
        )
      ) {
        throw new Response("Review attachment not found.", { status: 404 });
      }
    }
    const object = await this.env.FILES.get(version.objectKey);
    if (
      !object ||
      !version.objectEtag ||
      object.httpEtag !== version.objectEtag
    ) {
      throw new Error(
        `Released review attachment ${assetId} is missing or differs from its scanned object.`,
      );
    }
    const filename = version.filename.replace(/[\r\n"\\]/gu, "_");
    const headers = new Headers();
    headers.set("Content-Type", version.contentType);
    headers.set(
      "Content-Disposition",
      `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(version.filename)}`,
    );
    headers.set("Cache-Control", "private, no-store");
    headers.set("X-Content-Type-Options", "nosniff");
    if (object.httpEtag) headers.set("ETag", object.httpEtag);
    return new Response(object.body, { headers });
  }

  async saveReview(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.review.save",
      input,
      undefined,
      () => this.saveReviewD1(viewer, input),
    );
  }

  private async saveReviewD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    const parsed = reviewDraftSchema.parse(input);
    const assignment = await this.env.DB.prepare(
      `
      SELECT a.id, a.status, a.revision,
             a.submission_id AS submissionId, a.session_id AS sessionId,
             a.round_id AS roundId
        FROM evaluator_assignments a
        JOIN evaluation_rounds r ON r.id = a.round_id AND r.event_id = a.event_id
        LEFT JOIN submissions submission
          ON submission.id = a.submission_id
         AND submission.event_id = a.event_id
        LEFT JOIN sessions session
          ON session.id = a.session_id AND session.event_id = a.event_id
       WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ? AND a.status IN ('assigned','in_progress','reopened') AND r.status = 'active'
         AND (
           (a.submission_id IS NOT NULL
            AND submission.status IN ('submitted','assigned','in_review','decision_ready'))
           OR
           (a.session_id IS NOT NULL
            AND session.status NOT IN ('cancelled','archived'))
         )
    `,
    )
      .bind(parsed.assignmentId, viewer.eventId, viewer.personId)
      .first<{
        id: string;
        status: string;
        revision: number;
        submissionId: string | null;
        sessionId: string | null;
        roundId: string;
      }>();
    if (!assignment)
      throw new EvaluationStateError(
        "This assignment is unavailable or already submitted.",
      );
    const criteria = await this.env.DB.prepare(
      `SELECT id, input_type AS inputType, weight_percent AS weightPercent, required FROM evaluation_criteria WHERE event_id = ? AND round_id = ? ORDER BY position`,
    )
      .bind(viewer.eventId, assignment.roundId)
      .all<{
        id: string;
        inputType: "scale_5" | "scale_10" | "yes_no" | "free_text";
        weightPercent: number;
        required: number | boolean;
      }>();
    const criterionIds = new Set(
      criteria.results.map((criterion) => criterion.id),
    );
    const unknownScoreIds = Object.keys(parsed.scores).filter(
      (criterionId) => !criterionIds.has(criterionId),
    );
    if (unknownScoreIds.length) {
      throw new EvaluationValidationError(
        "The review contains scores for criteria that are not in this evaluation round. Refresh before saving.",
      );
    }
    const responses: Record<string, string | number | boolean> = {};
    for (const criterion of criteria.results) {
      const raw = parsed.scores[criterion.id];
      const empty =
        raw === undefined || (typeof raw === "string" && raw.trim() === "");
      if (empty) {
        if (parsed.intent === "submit" && Boolean(criterion.required)) {
          throw new EvaluationValidationError(
            "Complete every required rubric criterion before submitting the review.",
          );
        }
        continue;
      }
      if (
        criterion.inputType === "scale_5" ||
        criterion.inputType === "scale_10"
      ) {
        const value = typeof raw === "number" ? raw : Number(raw);
        const maximum = criterion.inputType === "scale_10" ? 10 : 5;
        if (!Number.isInteger(value) || value < 1 || value > maximum) {
          throw new EvaluationValidationError(
            `A rubric score must be a whole number from 1 to ${maximum}.`,
          );
        }
        responses[criterion.id] = value;
      } else if (criterion.inputType === "yes_no") {
        if (raw !== "yes" && raw !== "no" && typeof raw !== "boolean") {
          throw new EvaluationValidationError(
            "A yes/no rubric response must be yes or no.",
          );
        }
        responses[criterion.id] =
          typeof raw === "boolean" ? raw : raw === "yes";
      } else {
        if (typeof raw !== "string") {
          throw new EvaluationValidationError(
            "A free-text rubric response must be text.",
          );
        }
        responses[criterion.id] = raw.trim();
      }
    }
    const scaledCriteria = criteria.results
      .filter(
        (criterion) =>
          criterion.inputType === "scale_5" ||
          criterion.inputType === "scale_10",
      )
      .map((criterion) => ({
        id: criterion.id,
        weightPercent: criterion.weightPercent,
        inputType: criterion.inputType as "scale_5" | "scale_10",
      }));
    const weightedScore =
      parsed.intent === "submit"
        ? calculateRubricWeightedScore(scaledCriteria, responses)
        : null;
    const existing = await this.env.DB.prepare(
      "SELECT id, revision, status FROM reviews WHERE event_id = ? AND assignment_id = ?",
    )
      .bind(viewer.eventId, assignment.id)
      .first<{ id: string; revision: number; status: string }>();
    if ((existing?.revision ?? 0) !== parsed.revision)
      throw new EvaluationRevisionConflictError();
    const reviewId = existing?.id ?? crypto.randomUUID();
    const nextRevision = parsed.revision + 1;
    const operationId = crypto.randomUUID();
    const status = parsed.intent === "submit" ? "submitted" : "draft";
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook =
      parsed.intent === "submit"
        ? await webhookService.prepareEventForAudit(
            viewer,
            {
              eventType: "review.submitted",
              entityType: "review",
              entityId: reviewId,
              idempotencyKey: `review.submitted:${reviewId}:${nextRevision}`,
              correlationId: operationId,
              data: {
                assignmentId: assignment.id,
                revision: nextRevision,
                weightedScore,
              },
            },
            auditEventId,
          )
        : null;
    const reviewMutation = existing
      ? this.env.DB.prepare(
          `
      UPDATE reviews SET status = ?, scores_json = ?, weighted_score = ?, recommendation = ?, confidence = ?,
             submitter_feedback = ?, private_notes = ?, revision = revision + 1, last_operation_id = ?,
             updated_at = unixepoch(), submitted_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE submitted_at END,
             locked_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE locked_at END
       WHERE id = ? AND event_id = ? AND revision = ? AND status IN ('draft','reopened')
         AND EXISTS (
           SELECT 1 FROM evaluator_assignments assignment
           LEFT JOIN submissions active_submission
             ON active_submission.id = assignment.submission_id
            AND active_submission.event_id = assignment.event_id
           LEFT JOIN sessions active_session
             ON active_session.id = assignment.session_id
            AND active_session.event_id = assignment.event_id
            WHERE assignment.id = ? AND assignment.event_id = ?
              AND assignment.evaluator_person_id = ? AND assignment.revision = ?
              AND assignment.status IN ('assigned','in_progress','reopened')
              AND (
                (assignment.submission_id IS NOT NULL
                 AND active_submission.status IN ('submitted','assigned','in_review','decision_ready'))
                OR
                (assignment.session_id IS NOT NULL
                 AND active_session.status NOT IN ('cancelled','archived'))
              )
         )
    `,
        ).bind(
          status,
          JSON.stringify(responses),
          weightedScore,
          parsed.recommendation,
          parsed.confidence,
          parsed.submitterFeedback || null,
          parsed.privateNotes || null,
          operationId,
          status,
          status,
          reviewId,
          viewer.eventId,
          parsed.revision,
          assignment.id,
          viewer.eventId,
          viewer.personId,
          assignment.revision,
        )
      : this.env.DB.prepare(
          `
      INSERT INTO reviews (id, event_id, assignment_id, status, scores_json, weighted_score, recommendation, confidence, submitter_feedback, private_notes, revision, last_operation_id, created_at, updated_at, submitted_at, locked_at)
      SELECT ?, ?, assignment.id, ?, ?, ?, ?, ?, ?, ?, 1, ?, unixepoch(), unixepoch(),
             CASE WHEN ? = 'submitted' THEN unixepoch() END,
             CASE WHEN ? = 'submitted' THEN unixepoch() END
        FROM evaluator_assignments assignment
        LEFT JOIN submissions active_submission
          ON active_submission.id = assignment.submission_id
         AND active_submission.event_id = assignment.event_id
        LEFT JOIN sessions active_session
          ON active_session.id = assignment.session_id
         AND active_session.event_id = assignment.event_id
       WHERE assignment.id = ? AND assignment.event_id = ?
         AND assignment.evaluator_person_id = ? AND assignment.revision = ?
         AND assignment.status IN ('assigned','in_progress','reopened')
         AND (
           (assignment.submission_id IS NOT NULL
            AND active_submission.status IN ('submitted','assigned','in_review','decision_ready'))
           OR
           (assignment.session_id IS NOT NULL
            AND active_session.status NOT IN ('cancelled','archived'))
         )
    `,
        ).bind(
          reviewId,
          viewer.eventId,
          status,
          JSON.stringify(responses),
          weightedScore,
          parsed.recommendation,
          parsed.confidence,
          parsed.submitterFeedback || null,
          parsed.privateNotes || null,
          operationId,
          status,
          status,
          assignment.id,
          viewer.eventId,
          viewer.personId,
          assignment.revision,
        );
    const [saved, assignmentUpdated] = await this.env.DB.batch([
      reviewMutation,
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = ?, revision = revision + 1, last_operation_id = ?,
               submitted_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE submitted_at END
         WHERE id = ? AND event_id = ? AND evaluator_person_id = ? AND revision = ?
           AND status IN ('assigned','in_progress','reopened')
           AND EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?)
      `,
      ).bind(
        parsed.intent === "submit" ? "submitted" : "in_progress",
        operationId,
        status,
        assignment.id,
        viewer.eventId,
        viewer.personId,
        assignment.revision,
        reviewId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO review_revisions (id, event_id, review_id, revision_number, scores_json, content_json, save_kind, saved_by_person_id, idempotency_key, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?)
           AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.eventId,
        reviewId,
        nextRevision,
        JSON.stringify(responses),
        JSON.stringify({
          recommendation: parsed.recommendation,
          confidence: parsed.confidence,
          submitterFeedback: parsed.submitterFeedback,
          privateNotes: parsed.privateNotes,
        }),
        parsed.intent === "submit" ? "submitted" : "manual",
        viewer.personId,
        operationId,
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE submissions SET status = 'in_review', revision = revision + 1, updated_at = unixepoch() WHERE id = ? AND event_id = ? AND status IN ('assigned','submitted') AND EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?) AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        assignment.submissionId,
        viewer.eventId,
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at) SELECT ?, ?, ?, ?, ?, 'review', ?, ?, unixepoch() WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?) AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.intent === "submit" ? "review.submitted" : "review.saved",
        reviewId,
        JSON.stringify({ revision: nextRevision }),
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
      ...(preparedWebhook?.statements ?? []),
    ]);
    if (
      (saved.meta.changes ?? 0) !== 1 ||
      (assignmentUpdated.meta.changes ?? 0) !== 1
    )
      throw new EvaluationRevisionConflictError();
    const webhookDeliveries = preparedWebhook
      ? await webhookService.dispatchPreparedEvent(preparedWebhook)
      : [];
    const nextAssignment =
      parsed.intent === "submit"
        ? await this.env.DB.prepare(
            `
            SELECT a.id
              FROM evaluator_assignments a
              JOIN evaluation_rounds r
                ON r.id = a.round_id AND r.event_id = a.event_id
             WHERE a.event_id = ? AND a.evaluator_person_id = ?
               AND a.id <> ? AND a.status IN ('assigned','in_progress','reopened')
               AND r.status = 'active'
             ORDER BY CASE a.status WHEN 'in_progress' THEN 0 WHEN 'reopened' THEN 1 ELSE 2 END,
                      a.due_at, a.assigned_at
             LIMIT 1
          `,
          )
            .bind(viewer.eventId, viewer.personId, assignment.id)
            .first<{ id: string }>()
        : null;
    return {
      reviewId,
      revision: nextRevision,
      weightedScore,
      nextAssignmentId: nextAssignment?.id ?? null,
      webhookDeliveries,
    };
  }

  async declareConflict(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.conflict.declare",
      input,
      undefined,
      () => this.declareConflictD1(viewer, input),
    );
  }

  private async declareConflictD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    const parsed = conflictDeclarationSchema.parse(input);
    const assignment = await this.env.DB.prepare(
      `SELECT id, revision, round_id AS roundId,
              submission_id AS submissionId, session_id AS sessionId
         FROM evaluator_assignments
        WHERE id = ? AND event_id = ? AND evaluator_person_id = ?
          AND status IN ('assigned','in_progress')`,
    )
      .bind(parsed.assignmentId, viewer.eventId, viewer.personId)
      .first<{
        id: string;
        revision: number;
        roundId: string;
        submissionId: string | null;
        sessionId: string | null;
      }>();
    if (!assignment)
      throw new EvaluationStateError(
        "Assignment not found or cannot be recused.",
      );
    const operationId = crypto.randomUUID();
    const conflictTargetColumn = assignment.submissionId
      ? "submission_id"
      : "session_id";
    const conflictTargetId = assignment.submissionId ?? assignment.sessionId;
    if (!conflictTargetId) {
      throw new Error(`Evaluation assignment ${assignment.id} has no target.`);
    }
    const [recused] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = 'recused', conflict_declared_at = unixepoch(),
               revision = revision + 1, last_operation_id = ?
         WHERE id = ? AND event_id = ? AND evaluator_person_id = ?
           AND revision = ? AND status IN ('assigned','in_progress')
      `,
      ).bind(
        operationId,
        assignment.id,
        viewer.eventId,
        viewer.personId,
        assignment.revision,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO evaluator_conflicts (
          id, event_id, round_id, submission_id, session_id,
          evaluator_person_id,
          relationship, notes, status, declared_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'declared', ?, 'recused', unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluator_assignments
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
        ON CONFLICT(round_id, ${conflictTargetColumn}, evaluator_person_id)
        WHERE ${conflictTargetColumn} IS NOT NULL DO UPDATE SET
          notes = excluded.notes, status = 'recused', declared_at = unixepoch()
        WHERE EXISTS (
          SELECT 1 FROM evaluator_assignments
           WHERE id = ? AND event_id = ? AND last_operation_id = ?
        )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.eventId,
        assignment.roundId,
        assignment.submissionId,
        assignment.sessionId,
        viewer.personId,
        parsed.reason,
        assignment.id,
        viewer.eventId,
        operationId,
        assignment.id,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at) SELECT ?, ?, ?, ?, 'review.conflict.declared', 'evaluator_assignment', ?, '{}', unixepoch() WHERE EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND event_id = ? AND last_operation_id = ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        assignment.id,
        assignment.id,
        viewer.eventId,
        operationId,
      ),
    ]);
    if ((recused.meta.changes ?? 0) !== 1) {
      throw new EvaluationRevisionConflictError(
        "This assignment changed before the conflict could be recorded.",
      );
    }
  }

  async moderate(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.review.moderate",
      input,
      undefined,
      () => this.moderateD1(viewer, input),
    );
  }

  private async moderateD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = moderationSchema.parse(input);
    if (parsed.status === "confirmed" && !parsed.confirmed) {
      throw new EvaluationValidationError(
        "Confirm the moderation effect before locking it.",
      );
    }
    const current = await this.env.DB.prepare(
      `
      SELECT id, status FROM review_moderations
       WHERE event_id = ? AND round_id = ? AND submission_id = ?
         AND status IN ('draft','confirmed')
    `,
    )
      .bind(viewer.eventId, parsed.roundId, parsed.submissionId)
      .first<{ id: string; status: "draft" | "confirmed" }>();
    if ((current?.id ?? null) !== parsed.expectedModerationId) {
      throw new EvaluationRevisionConflictError(
        "The moderation changed after it was loaded. Refresh before saving again.",
      );
    }
    if (
      current?.status === "confirmed" &&
      (parsed.status !== "confirmed" || !parsed.confirmed)
    ) {
      throw new EvaluationStateError(
        "A confirmed moderation can only be replaced by another explicitly confirmed moderation.",
      );
    }
    const moderationId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const currentPredicate = current
      ? `EXISTS (
           SELECT 1 FROM review_moderations current_moderation
            WHERE current_moderation.id = ?
              AND current_moderation.event_id = events.id
              AND current_moderation.round_id = ?
              AND current_moderation.submission_id = ?
              AND current_moderation.status IN ('draft','confirmed')
         )`
      : `NOT EXISTS (
           SELECT 1 FROM review_moderations current_moderation
            WHERE current_moderation.event_id = events.id
              AND current_moderation.round_id = ?
              AND current_moderation.submission_id = ?
              AND current_moderation.status IN ('draft','confirmed')
         )`;
    const currentBindings = current
      ? [current.id, parsed.roundId, parsed.submissionId]
      : [parsed.roundId, parsed.submissionId];
    const [claimed] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds active_round
              WHERE active_round.id = ? AND active_round.event_id = events.id
                AND active_round.status = 'active'
           )
           AND EXISTS (
             SELECT 1 FROM submissions candidate
              WHERE candidate.id = ? AND candidate.event_id = events.id
                AND candidate.status IN ('assigned','in_review','decision_ready')
           )
           AND EXISTS (
             SELECT 1 FROM evaluator_assignments assignment
             JOIN reviews completed_review
               ON completed_review.assignment_id = assignment.id
              AND completed_review.event_id = assignment.event_id
              AND completed_review.status IN ('submitted','locked')
              WHERE assignment.event_id = events.id
                AND assignment.round_id = ?
                AND assignment.submission_id = ?
           )
           AND ${currentPredicate}
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.roundId,
        parsed.submissionId,
        parsed.roundId,
        parsed.submissionId,
        ...currentBindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE review_moderations SET status = 'superseded',
               updated_at = unixepoch()
         WHERE event_id = ? AND round_id = ? AND submission_id = ?
           AND status IN ('draft','confirmed')
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        parsed.roundId,
        parsed.submissionId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO review_moderations (
          id, event_id, round_id, submission_id, moderator_person_id,
          status, recommendation, moderated_score, notes,
          created_at, updated_at, confirmed_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(),
               CASE WHEN ? = 'confirmed' THEN unixepoch() END
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        moderationId,
        viewer.eventId,
        parsed.roundId,
        parsed.submissionId,
        viewer.personId,
        parsed.status,
        parsed.recommendation,
        parsed.moderatedScore,
        parsed.notes,
        parsed.status,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'decision_ready',
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status IN ('assigned','in_review')
           AND ? = 'confirmed'
           AND EXISTS (
             SELECT 1 FROM review_moderations
              WHERE id = ? AND event_id = ? AND status = 'confirmed'
           )
      `,
      ).bind(
        parsed.submissionId,
        viewer.eventId,
        parsed.status,
        moderationId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'review_moderation', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM review_moderations WHERE id = ? AND event_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.status === "confirmed"
          ? "review.moderation.confirmed"
          : "review.moderation.saved",
        moderationId,
        JSON.stringify({
          submissionId: parsed.submissionId,
          roundId: parsed.roundId,
          recommendation: parsed.recommendation,
          supersededModerationId: current?.id ?? null,
        }),
        moderationId,
        viewer.eventId,
      ),
    ]);
    if ((claimed.meta.changes ?? 0) !== 1) {
      throw new EvaluationRevisionConflictError(
        "The round, submission, reviews, or moderation changed before the moderation could be saved.",
      );
    }
    return moderationId;
  }

  async reopenReview(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.review.reopen",
      input,
      undefined,
      () => this.reopenReviewD1(viewer, input),
    );
  }

  private async reopenReviewD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = reviewReopenSchema.parse(input);
    const state = await this.env.DB.prepare(
      `
      SELECT a.id, a.revision AS assignmentRevision,
             a.round_id AS roundId, a.submission_id AS submissionId,
             r.id AS reviewId, r.revision AS reviewRevision,
             r.scores_json AS scoresJson, r.recommendation, r.confidence,
             r.submitter_feedback AS submitterFeedback,
             r.private_notes AS privateNotes
        FROM evaluator_assignments a
        JOIN reviews r ON r.assignment_id = a.id AND r.event_id = a.event_id
        JOIN evaluation_rounds round
          ON round.id = a.round_id AND round.event_id = a.event_id
       WHERE a.id = ? AND a.event_id = ?
         AND a.status = 'submitted' AND r.status IN ('submitted','locked')
         AND round.status = 'active'
         AND NOT EXISTS (
           SELECT 1 FROM submission_decisions final_decision
            WHERE final_decision.event_id = a.event_id
              AND final_decision.submission_id = a.submission_id
              AND final_decision.status = 'published'
         )
    `,
    )
      .bind(parsed.assignmentId, viewer.eventId)
      .first<{
        id: string;
        assignmentRevision: number;
        roundId: string;
        submissionId: string | null;
        reviewId: string;
        reviewRevision: number;
        scoresJson: string;
        recommendation: string | null;
        confidence: number | null;
        submitterFeedback: string | null;
        privateNotes: string | null;
      }>();
    if (!state) {
      throw new EvaluationStateError(
        "Only a submitted review in the active round can be reopened, and released decisions remain final.",
      );
    }
    const operationId = crypto.randomUUID();
    const nextRevision = state.reviewRevision + 1;
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "review.reopened",
        entityType: "review",
        entityId: state.reviewId,
        idempotencyKey: `review.reopened:${state.reviewId}:${nextRevision}`,
        correlationId: operationId,
        data: { assignmentId: state.id, revision: nextRevision },
      },
      auditEventId,
    );
    const [assignmentUpdated, reviewUpdated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = 'reopened', revision = revision + 1,
               last_operation_id = ?
         WHERE id = ? AND event_id = ? AND revision = ? AND status = 'submitted'
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds
              WHERE id = ? AND event_id = ? AND status = 'active'
           )
           AND NOT EXISTS (
             SELECT 1 FROM submission_decisions
              WHERE event_id = ? AND submission_id = ? AND status = 'published'
           )
      `,
      ).bind(
        operationId,
        state.id,
        viewer.eventId,
        state.assignmentRevision,
        state.roundId,
        viewer.eventId,
        viewer.eventId,
        state.submissionId,
      ),
      this.env.DB.prepare(
        `
        UPDATE reviews SET status = 'reopened', revision = revision + 1,
               locked_at = NULL, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND status IN ('submitted','locked')
           AND EXISTS (
             SELECT 1 FROM evaluator_assignments
              WHERE id = ? AND event_id = ? AND status = 'reopened'
                AND last_operation_id = ?
           )
      `,
      ).bind(
        operationId,
        state.reviewId,
        viewer.eventId,
        state.reviewRevision,
        state.id,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json,
          content_json, save_kind, saved_by_person_id, idempotency_key,
          created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'reopened', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM reviews
            WHERE id = ? AND event_id = ? AND status = 'reopened'
              AND revision = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.eventId,
        state.reviewId,
        nextRevision,
        state.scoresJson,
        JSON.stringify({
          recommendation: state.recommendation,
          confidence: state.confidence,
          submitterFeedback: state.submitterFeedback,
          privateNotes: state.privateNotes,
          reopenReason: parsed.reason,
        }),
        viewer.personId,
        operationId,
        state.reviewId,
        viewer.eventId,
        nextRevision,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE review_moderations SET status = 'superseded',
               updated_at = unixepoch()
         WHERE event_id = ? AND round_id = ? AND submission_id = ?
           AND status IN ('draft','confirmed')
           AND EXISTS (
             SELECT 1 FROM reviews
              WHERE id = ? AND event_id = ? AND status = 'reopened'
                AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        state.roundId,
        state.submissionId,
        state.reviewId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'in_review',
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status = 'decision_ready'
           AND EXISTS (
             SELECT 1 FROM reviews
              WHERE id = ? AND event_id = ? AND status = 'reopened'
                AND last_operation_id = ?
           )
      `,
      ).bind(
        state.submissionId,
        viewer.eventId,
        state.reviewId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'review.reopened', 'review', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM reviews
            WHERE id = ? AND event_id = ? AND status = 'reopened'
              AND last_operation_id = ?
         )
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        state.reviewId,
        JSON.stringify({
          assignmentId: state.id,
          reason: parsed.reason,
          revision: nextRevision,
        }),
        state.reviewId,
        viewer.eventId,
        operationId,
      ),
      ...preparedWebhook.statements,
    ]);
    if (
      (assignmentUpdated.meta.changes ?? 0) !== 1 ||
      (reviewUpdated.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationRevisionConflictError(
        "The review or assignment changed before it could be reopened.",
      );
    }
    const webhookDeliveries =
      await webhookService.dispatchPreparedEvent(preparedWebhook);
    return {
      reviewId: state.reviewId,
      revision: nextRevision,
      webhookDeliveries,
    };
  }

  async decide(
    viewer: Viewer,
    input: unknown,
    command?: EvaluationApiCommand & { commandId: string },
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.decision.save",
      input,
      command,
      () =>
        new EvaluationDecisionService(this.env).decide(
          viewer,
          input,
          command?.commandId,
        ),
    );
  }

  async resendAcceptedSpeakerInvitation(viewer: Viewer, input: unknown) {
    return resendAcceptedSpeakerInvitation({
      env: this.env,
      viewer,
      value: input,
    });
  }
}
