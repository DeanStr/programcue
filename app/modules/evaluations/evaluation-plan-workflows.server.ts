import { z } from "zod";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { routingSchema } from "~/modules/submissions/submission-schema";
import { createAuth } from "~/platform/auth/auth.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluationInvitationDeliveryError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import {
  committeeChairAccessSchema,
  evaluationMemberInvitationSchema,
  evaluationPlanSchema,
  reviewCycleStartSchema,
  evaluationTeamMemberSchema,
  evaluationTeamSchema,
} from "./evaluation-schema";
import {
  EvaluationServiceFoundation,
  assertPlanScorecardConsistency,
  evaluationAuditActor,
  planCommandResultSchema,
  persistedRubricSignature,
  rubricSignature,
  type Criterion,
  type EvaluationAdminActor,
  type EvaluationApiCommand,
  type EvaluationReviewCycleResult,
  type PersistedRubricShape,
  type RubricShape,
  type Round,
  requireSubmittedSnapshot,
} from "./evaluation-service-foundation.server";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

const reviewerReminderSchema = z
  .object({
    roundId: z.string().trim().min(1).max(80),
    reviewerPersonIds: z
      .array(z.string().trim().min(1).max(120))
      .min(1, "Select at least one reviewer.")
      .max(100, "Prepare reminders for at most 100 reviewers at a time."),
    templateVersionId: z.string().trim().min(1).max(120),
  })
  .superRefine((input, context) => {
    if (
      new Set(input.reviewerPersonIds).size !== input.reviewerPersonIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["reviewerPersonIds"],
        message: "Reviewer selections must not contain duplicates.",
      });
    }
  });

function parseCriterionOptions(
  value: string,
  criterionId: string,
  inputType: string,
) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new EvaluationStateError(
      `Criterion ${criterionId} has invalid persisted dropdown options.`,
    );
  }
  if (
    !Array.isArray(parsed) ||
    parsed.some((option) => typeof option !== "string" || !option.trim())
  ) {
    throw new EvaluationStateError(
      `Criterion ${criterionId} has invalid persisted dropdown options.`,
    );
  }
  if (inputType === "dropdown" && parsed.length === 0) {
    throw new EvaluationStateError(
      `Criterion ${criterionId} has no persisted dropdown options.`,
    );
  }
  if (inputType !== "dropdown" && parsed.length > 0) {
    throw new EvaluationStateError(
      `Criterion ${criterionId} has options but is not a dropdown.`,
    );
  }
  return parsed as string[];
}

async function assertPersistedScorecardConsistency(
  db: D1Database,
  organisationId: string,
  eventId: string,
  planId: string,
  rounds: ReadonlyArray<{
    id: string;
    scorecardId?: string;
    scorecardVersion: number;
    criteria: readonly RubricShape[];
  }>,
) {
  const persisted = await db
    .prepare(
      `
      SELECT r.id AS roundId, r.scorecard_id AS scorecardId,
             r.scorecard_version AS scorecardVersion,
             c.name, c.description, c.input_type AS inputType,
             c.options_json AS optionsJson, c.weight_percent AS weightPercent,
             c.required, c.position
        FROM evaluation_rounds r
        JOIN evaluation_criteria c
          ON c.round_id = r.id AND c.event_id = r.event_id
        JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
       WHERE r.id IN (
         SELECT id FROM evaluation_rounds
          WHERE plan_id = ? AND event_id = ?
       )
       ORDER BY r.id, c.position
    `,
    )
    .bind(organisationId, planId, eventId)
    .all<
      PersistedRubricShape & {
        roundId: string;
        scorecardId: string;
        scorecardVersion: number;
      }
    >();
  const persistedByRound = new Map<
    string,
    {
      key: string;
      criteria: PersistedRubricShape[];
    }
  >();
  for (const criterion of persisted.results) {
    const key = `${criterion.scorecardId}:${criterion.scorecardVersion}`;
    const round = persistedByRound.get(criterion.roundId) ?? {
      key,
      criteria: [],
    };
    round.criteria.push(criterion);
    persistedByRound.set(criterion.roundId, round);
  }
  const signatures = new Map<string, string>();
  for (const { key, criteria } of persistedByRound.values()) {
    const signature = persistedRubricSignature(criteria);
    const previous = signatures.get(key);
    if (previous && previous !== signature) {
      throw new EvaluationStateError(
        `Scorecard ${key.replace(":", " version ")} is already linked to different persisted rubrics. Choose a new scorecard version before saving.`,
      );
    }
    signatures.set(key, signature);
  }
  const persistedRoundIds = new Set(persistedByRound.keys());
  const persistedRoundRows = await db
    .prepare(
      `
      SELECT r.id
        FROM evaluation_rounds r
        JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
       WHERE r.plan_id = ? AND r.event_id = ?
    `,
    )
    .bind(organisationId, planId, eventId)
    .all<{ id: string }>();
  for (const round of persistedRoundRows.results) {
    if (!persistedRoundIds.has(round.id)) {
      throw new EvaluationStateError(
        `Evaluation round ${round.id} is missing its persisted scorecard rubric.`,
      );
    }
  }
  for (const round of rounds) {
    const key = `${round.scorecardId ?? round.id}:${round.scorecardVersion}`;
    const previous = signatures.get(key);
    if (previous && previous !== rubricSignature(round.criteria)) {
      throw new EvaluationStateError(
        `Scorecard ${key.replace(":", " version ")} is already linked to a different persisted rubric. Choose a new scorecard version before saving.`,
      );
    }
  }
}

export abstract class EvaluationPlanWorkflows extends EvaluationServiceFoundation {
  async getAdminWorkspace(viewer: Viewer) {
    return this.readAuthoritative(viewer, () =>
      this.getAdminWorkspaceD1(viewer),
    );
  }

  protected async getAdminWorkspaceD1(viewer: Viewer) {
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
               COUNT(tm.person_id) AS memberCount
          FROM evaluation_teams t
          JOIN events event
            ON event.id = t.event_id AND event.organisation_id = ?
          LEFT JOIN evaluation_team_members tm ON tm.team_id = t.id AND tm.event_id = t.event_id AND tm.removed_at IS NULL
         WHERE t.event_id = ? GROUP BY t.id ORDER BY t.name
      `,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<{
          id: string;
          name: string;
          description: string | null;
          chairPersonId: string | null;
          status: string;
          memberCount: number;
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
          JOIN events event
            ON event.id = tm.event_id AND event.organisation_id = ?
         WHERE tm.event_id = ? AND tm.removed_at IS NULL
           AND t.status = 'active'
         ORDER BY p.display_name
      `,
      )
        .bind(viewer.organisationId, viewer.eventId)
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
          FROM memberships m
          JOIN people p ON p.id = m.person_id
          JOIN events event
            ON event.id = m.event_id AND event.organisation_id = ?
         WHERE m.event_id = ? AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
           AND m.role IN ('evaluator','committee_chair')
         GROUP BY p.id, p.display_name, p.email
         ORDER BY p.display_name
      `,
      )
        .bind(viewer.organisationId, viewer.eventId)
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
          JOIN events event
            ON event.id = m.event_id AND event.organisation_id = ?
         WHERE m.event_id = ? AND m.role IN ('evaluator','committee_chair')
           AND m.accepted_at IS NULL AND m.invited_at IS NOT NULL
           AND m.revoked_at IS NULL
         ORDER BY m.invited_at DESC, p.display_name
      `,
      )
        .bind(viewer.organisationId, viewer.eventId)
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
               COALESCE((
                 SELECT json_group_array(json(selected.track))
                   FROM (
                     SELECT json_object(
                              'id', selection.track_id,
                              'name', track.name,
                              'submittedName', selection.track_name_snapshot,
                              'position', selection.position
                            ) AS track
                       FROM submission_track_selections selection
                       JOIN tracks track
                         ON track.id = selection.track_id
                        AND track.event_id = selection.event_id
                      WHERE selection.submission_id = s.id
                        AND selection.event_id = s.event_id
                      ORDER BY selection.position
                   ) selected
               ), '[]') AS tracksJson,
               s.format, s.status,
               ${reviewableSubmissionSql("s")} AS reviewableInCurrentCycle,
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
               COALESCE(
                 form_version.routing_json,
                 json_extract(s.submitted_snapshot_json, '$.routing')
               ) AS routingJson,
               s.submitter_email AS submitterEmail,
               s.submitted_snapshot_json AS submittedSnapshotJson,
               COALESCE((
                 SELECT json_group_array(json_object(
                          'name', speaker.display_name,
                          'email', speaker.email
                        ))
                   FROM submission_speakers speaker
                  WHERE speaker.event_id = s.event_id
                    AND speaker.submission_id = s.id
               ), '[]') AS speakersJson,
               (SELECT COUNT(*) FROM submission_speakers ss
                 WHERE ss.event_id = s.event_id AND ss.submission_id = s.id
                   AND ss.person_id IS NULL) AS unclaimedSpeakerCount,
               COUNT(DISTINCT a.id) AS assignmentCount,
               COUNT(DISTINCT CASE WHEN a.status = 'submitted' THEN a.id END) AS completedReviewCount,
               AVG(r.weighted_score) AS averageScore
          FROM submissions s
          JOIN events e ON e.id = s.event_id
          LEFT JOIN form_versions form_version
            ON form_version.id = s.form_version_id
           AND form_version.event_id = s.event_id
          LEFT JOIN evaluator_assignments a
            ON a.submission_id = s.id AND a.event_id = s.event_id
           AND EXISTS (
             SELECT 1
               FROM evaluation_rounds assignment_round
               JOIN evaluation_plans assignment_plan
                 ON assignment_plan.id = assignment_round.plan_id
                AND assignment_plan.event_id = assignment_round.event_id
              WHERE assignment_round.id = a.round_id
                AND assignment_round.event_id = a.event_id
                AND assignment_plan.status <> 'archived'
           )
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
          tracksJson: string;
          format: string | null;
          status: string;
          reviewableInCurrentCycle: number | boolean;
          routedTeamIdsJson: string;
          routingJson: string | null;
          submitterEmail: string | null;
          submittedSnapshotJson: string | null;
          speakersJson: string;
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
           AND EXISTS (
             SELECT 1
               FROM evaluation_rounds assignment_round
               JOIN evaluation_plans assignment_plan
                 ON assignment_plan.id = assignment_round.plan_id
                AND assignment_plan.event_id = assignment_round.event_id
              WHERE assignment_round.id = assignment.round_id
                AND assignment_round.event_id = assignment.event_id
                AND assignment_plan.status <> 'archived'
           )
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
          JOIN events event
            ON event.id = a.event_id AND event.organisation_id = ?
          JOIN evaluation_rounds assignment_round
            ON assignment_round.id = a.round_id
           AND assignment_round.event_id = a.event_id
          JOIN evaluation_plans assignment_plan
            ON assignment_plan.id = assignment_round.plan_id
           AND assignment_plan.event_id = assignment_round.event_id
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
         WHERE a.event_id = ? AND assignment_plan.status <> 'archived'
           AND (
             a.submission_id IS NOT NULL
             OR (
               a.session_id IS NOT NULL
               AND session.status NOT IN ('cancelled','archived')
             )
           )
         ORDER BY a.assigned_at, p.display_name
      `,
      )
        .bind(viewer.organisationId, viewer.eventId)
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
          JOIN events event
            ON event.id = m.event_id AND event.organisation_id = ?
         WHERE m.event_id = ? AND m.status IN ('draft','confirmed')
      `,
      )
        .bind(viewer.organisationId, viewer.eventId)
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
      ? await this.getRounds(viewer.eventId, viewer.organisationId, planRow.id)
      : [];
    const reviewCyclePreview = planRow
      ? await this.env.DB.prepare(
          `SELECT
             COUNT(DISTINCT CASE
               WHEN assignment.status IN ('assigned','in_progress','reopened')
               THEN assignment.id END) AS unfinishedAssignmentCount,
             COUNT(DISTINCT CASE
               WHEN review.status IN ('draft','reopened')
               THEN review.id END) AS unfinishedReviewCount,
             (SELECT COUNT(*)
                FROM operation_jobs operation
                JOIN evaluation_rounds operation_round
                  ON operation_round.id = json_extract(
                       operation.payload_json,
                       '$.roundId'
                     )
                 AND operation_round.event_id = operation.event_id
               WHERE operation.event_id = plan.event_id
                 AND operation.organisation_id = event.organisation_id
                 AND operation.type = 'ai.review_assessment.generate'
                 AND operation.status = 'running'
                 AND operation_round.plan_id = plan.id)
               AS runningAssessmentOperationCount
             FROM evaluation_plans plan
             JOIN events event
               ON event.id = plan.event_id AND event.organisation_id = ?
             LEFT JOIN evaluation_rounds round
               ON round.plan_id = plan.id AND round.event_id = plan.event_id
             LEFT JOIN evaluator_assignments assignment
               ON assignment.round_id = round.id
              AND assignment.event_id = round.event_id
             LEFT JOIN reviews review
               ON review.assignment_id = assignment.id
              AND review.event_id = assignment.event_id
            WHERE plan.id = ? AND plan.event_id = ?
              AND plan.status <> 'archived'`,
        )
          .bind(viewer.organisationId, planRow.id, viewer.eventId)
          .first<{
            unfinishedAssignmentCount: number;
            unfinishedReviewCount: number;
            runningAssessmentOperationCount: number;
          }>()
      : null;
    if (planRow && !reviewCyclePreview) {
      throw new EvaluationStateError(
        "The current evaluation plan could not be inspected for a new review cycle.",
      );
    }
    const assignmentRowsByRoundAndReviewer = new Map<
      string,
      Map<string, typeof assignmentRows.results>
    >();
    for (const assignment of assignmentRows.results) {
      const roundAssignments =
        assignmentRowsByRoundAndReviewer.get(assignment.roundId) ?? new Map();
      const existing = roundAssignments.get(assignment.evaluatorPersonId) ?? [];
      existing.push(assignment);
      roundAssignments.set(assignment.evaluatorPersonId, existing);
      assignmentRowsByRoundAndReviewer.set(
        assignment.roundId,
        roundAssignments,
      );
    }
    const reviewerProgress = rounds.flatMap((round) =>
      round.reviewers.map((reviewer) => {
        const assignments =
          assignmentRowsByRoundAndReviewer
            .get(round.id)
            ?.get(reviewer.personId) ?? [];
        const pendingCount = assignments.filter(
          (assignment) => assignment.status === "assigned",
        ).length;
        const inProgressCount = assignments.filter(
          (assignment) =>
            assignment.status === "in_progress" ||
            assignment.status === "reopened",
        ).length;
        const completedCount = assignments.filter(
          (assignment) => assignment.status === "submitted",
        ).length;
        const recusedCount = assignments.filter(
          (assignment) => assignment.status === "recused",
        ).length;
        return {
          roundId: round.id,
          reviewerPersonId: reviewer.personId,
          reviewerName: reviewer.name,
          reviewerEmail: reviewer.email,
          assignedCount: pendingCount + inProgressCount + completedCount,
          completedCount,
          inProgressCount,
          pendingCount,
          recusedCount,
        };
      }),
    );
    const submissions = submissionRows.results.map(
      ({
        routedTeamIdsJson,
        routingJson,
        tracksJson,
        speakersJson,
        submittedSnapshotJson,
        ...submission
      }) => {
        if (!submission.category) {
          throw new EvaluationStateError(
            `Submission ${submission.id} is missing persisted track selections.`,
          );
        }
        const routedTeamIds = z
          .array(z.string())
          .parse(JSON.parse(routedTeamIdsJson));
        if (!routingJson) {
          throw new EvaluationStateError(
            `Submission ${submission.id} is missing its immutable routing snapshot.`,
          );
        }
        const routing = routingSchema.parse(JSON.parse(routingJson));
        const routedTeamNames = routedTeamIds.map((teamId) => {
          const name = routing.teamNames[teamId];
          if (!name) {
            throw new EvaluationStateError(
              `Submission ${submission.id} has inconsistent persisted routing teams.`,
            );
          }
          return name;
        });
        const tracks = z
          .array(
            z.object({
              id: z.string(),
              name: z.string(),
              submittedName: z.string(),
              position: z.number().int().nonnegative(),
            }),
          )
          .min(1)
          .parse(JSON.parse(tracksJson));
        const speakers = z
          .array(z.object({ name: z.string(), email: z.string() }))
          .parse(JSON.parse(speakersJson));
        const submittedSnapshot = requireSubmittedSnapshot(
          submission.id,
          submittedSnapshotJson,
        );
        return {
          ...submission,
          reviewableInCurrentCycle: Boolean(
            submission.reviewableInCurrentCycle,
          ),
          speakers,
          identityAnswers: submittedSnapshot.answers,
          routedTeamIds,
          routedTeamName:
            routedTeamNames.length > 0 ? routedTeamNames.join(", ") : null,
          tracks,
        };
      },
    );
    return {
      plan: planRow
        ? {
            ...planRow,
            blindedReviewing: rounds.some((round) => round.anonymous),
            rounds,
          }
        : null,
      reviewCyclePreview,
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
      reviewerProgress,
      moderations: moderationRows.results,
    };
  }

  async prepareReviewerReminder(viewer: Viewer, input: unknown) {
    return this.readAuthoritative(viewer, () =>
      this.prepareReviewerReminderD1(viewer, input),
    );
  }

  protected async prepareReviewerReminderD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationAccessAdministrator(viewer);
    const parsed = reviewerReminderSchema.parse(input);
    const template = await this.env.DB.prepare(
      `SELECT version.id
         FROM communication_template_versions version
         JOIN communication_templates template
           ON template.id = version.template_id
          AND template.event_id = version.event_id
         JOIN events event
           ON event.id = version.event_id AND event.organisation_id = ?
        WHERE version.id = ? AND version.event_id = ?
          AND version.status = 'published' AND version.channel = 'email'
          AND version.category = 'ad_hoc'
          AND template.status = 'active' AND template.category = 'ad_hoc'`,
    )
      .bind(viewer.organisationId, parsed.templateVersionId, viewer.eventId)
      .first<{ id: string }>();
    if (!template) {
      throw new EvaluationStateError(
        "Choose a published ad hoc email template from this event.",
      );
    }

    const reviewerPlaceholders = parsed.reviewerPersonIds
      .map(() => "?")
      .join(", ");
    const reviewers = await this.env.DB.prepare(
      `SELECT person.id AS personId, person.email
         FROM evaluation_round_reviewers pool
         JOIN evaluation_rounds round
           ON round.id = pool.round_id AND round.event_id = pool.event_id
         JOIN evaluation_plans plan
           ON plan.id = round.plan_id AND plan.event_id = round.event_id
         JOIN people person ON person.id = pool.person_id
         JOIN events event
           ON event.id = pool.event_id AND event.organisation_id = ?
        WHERE pool.event_id = ? AND pool.round_id = ?
          AND pool.person_id IN (${reviewerPlaceholders})
          AND plan.status = 'active' AND round.status = 'active'
          AND (round.opens_at IS NULL OR round.opens_at <= unixepoch())
          AND (round.closes_at IS NULL OR round.closes_at > unixepoch())
          AND EXISTS (
            SELECT 1
              FROM memberships membership
             WHERE membership.event_id = pool.event_id
               AND membership.person_id = pool.person_id
               AND membership.role IN ('evaluator', 'committee_chair')
               AND membership.accepted_at IS NOT NULL
               AND membership.revoked_at IS NULL
          )
          AND EXISTS (
            SELECT 1
              FROM evaluator_assignments assignment
              LEFT JOIN submissions submission
                ON submission.id = assignment.submission_id
               AND submission.event_id = assignment.event_id
              LEFT JOIN sessions session
                ON session.id = assignment.session_id
               AND session.event_id = assignment.event_id
             WHERE assignment.event_id = pool.event_id
               AND assignment.round_id = pool.round_id
               AND assignment.evaluator_person_id = pool.person_id
               AND assignment.status IN ('assigned', 'in_progress', 'reopened')
               AND (
                 (assignment.submission_id IS NOT NULL
                  AND ${reviewableSubmissionSql("submission", "review")})
                 OR
                 (assignment.session_id IS NOT NULL
                  AND session.status NOT IN ('cancelled','archived'))
               )
          )
        ORDER BY person.id`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        parsed.roundId,
        ...parsed.reviewerPersonIds,
      )
      .all<{ personId: string; email: string }>();
    if (reviewers.results.length !== parsed.reviewerPersonIds.length) {
      throw new EvaluationStateError(
        "Every selected reviewer must be an accepted member of this round's pool with unfinished work in the currently open round.",
      );
    }

    return new CommunicationService(this.env).createDraft(viewer, {
      templateVersionId: parsed.templateVersionId,
      audienceType: "manual",
      manualRecipients: reviewers.results
        .map((reviewer) => reviewer.email)
        .join("\n"),
      kind: "transactional",
      scheduledAt: null,
    });
  }

  async startReviewCycle(
    viewer: Viewer,
    input: unknown,
  ): Promise<EvaluationReviewCycleResult> {
    return this.projectCommand(
      viewer,
      "evaluation.review_cycle.start",
      input,
      undefined,
      () => this.startReviewCycleD1(viewer, input),
    );
  }

  protected async startReviewCycleD1(
    viewer: Viewer,
    input: unknown,
  ): Promise<EvaluationReviewCycleResult> {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationAccessAdministrator(viewer);
    const parsed = reviewCycleStartSchema.parse(input);
    const current = await this.env.DB.prepare(
      `SELECT plan.id, plan.revision, plan.status,
              plan.decision_role AS decisionRole,
              (SELECT COUNT(*)
                 FROM evaluation_plans current_plan
                WHERE current_plan.event_id = plan.event_id
                  AND current_plan.status <> 'archived') AS currentPlanCount,
              (SELECT COUNT(*)
                 FROM evaluation_rounds round
                WHERE round.event_id = plan.event_id
                  AND round.plan_id = plan.id) AS roundCount,
              (SELECT COUNT(*)
                 FROM evaluation_rounds round
                WHERE round.event_id = plan.event_id
                  AND round.plan_id = plan.id
                  AND round.status <> 'archived') AS unarchivedRoundCount,
              (SELECT COUNT(*)
                 FROM evaluator_assignments assignment
                 JOIN evaluation_rounds round
                   ON round.id = assignment.round_id
                  AND round.event_id = assignment.event_id
                WHERE round.event_id = plan.event_id
                  AND round.plan_id = plan.id
                  AND assignment.status IN ('assigned','in_progress','reopened'))
                AS unfinishedAssignmentCount,
              (SELECT COUNT(*)
                 FROM reviews review
                 JOIN evaluator_assignments assignment
                   ON assignment.id = review.assignment_id
                  AND assignment.event_id = review.event_id
                 JOIN evaluation_rounds round
                   ON round.id = assignment.round_id
                  AND round.event_id = assignment.event_id
                WHERE round.event_id = plan.event_id
                  AND round.plan_id = plan.id
                  AND review.status IN ('draft','reopened'))
                AS unfinishedReviewCount,
              (SELECT COUNT(*)
                 FROM operation_jobs operation
                 JOIN evaluation_rounds operation_round
                   ON operation_round.id = json_extract(
                        operation.payload_json,
                        '$.roundId'
                      )
                  AND operation_round.event_id = operation.event_id
                WHERE operation.event_id = plan.event_id
                  AND operation.organisation_id = event.organisation_id
                  AND operation.type = 'ai.review_assessment.generate'
                  AND operation.status = 'running'
                  AND operation_round.plan_id = plan.id)
                AS runningAssessmentOperationCount
         FROM evaluation_plans plan
         JOIN events event
           ON event.id = plan.event_id AND event.organisation_id = ?
        WHERE plan.id = ? AND plan.event_id = ?
          AND plan.status <> 'archived'`,
    )
      .bind(viewer.organisationId, parsed.currentPlanId, viewer.eventId)
      .first<{
        id: string;
        revision: number;
        status: "draft" | "active" | "closed";
        decisionRole: "administrator" | "committee_chair";
        currentPlanCount: number;
        roundCount: number;
        unarchivedRoundCount: number;
        unfinishedAssignmentCount: number;
        unfinishedReviewCount: number;
        runningAssessmentOperationCount: number;
      }>();
    if (!current || Number(current.currentPlanCount) !== 1) {
      throw new EvaluationStateError(
        "Start a new review cycle only from the event's single current evaluation plan.",
      );
    }
    if (current.status === "draft") {
      throw new EvaluationStateError(
        "Activate the current evaluation plan before starting a later review cycle.",
      );
    }
    if (
      Number(current.roundCount) === 0 ||
      Number(current.unarchivedRoundCount) === 0
    ) {
      throw new EvaluationStateError(
        "The current evaluation plan has no review round to archive.",
      );
    }
    if (Number(current.runningAssessmentOperationCount) !== 0) {
      throw new EvaluationStateError(
        "Wait for every running AI review assessment in the current cycle to finish before starting a new review cycle.",
      );
    }
    if (
      current.revision !== parsed.currentPlanRevision ||
      Number(current.runningAssessmentOperationCount) !==
        parsed.expectedRunningAssessmentOperationCount ||
      Number(current.unfinishedAssignmentCount) !==
        parsed.expectedUnfinishedAssignmentCount ||
      Number(current.unfinishedReviewCount) !==
        parsed.expectedUnfinishedReviewCount
    ) {
      throw new EvaluationRevisionConflictError(
        "The current review cycle changed after the confirmation was prepared. Refresh and review the latest unfinished counts.",
      );
    }

    const operationId = crypto.randomUUID();
    const planId = crypto.randomUUID();
    const roundId = crypto.randomUUID();
    const criteria = parsed.round.criteria.map((criterion, position) => ({
      ...criterion,
      id: crypto.randomUUID(),
      position,
    }));
    const opensAt = parsed.round.opensAt
      ? Math.floor(Date.parse(parsed.round.opensAt) / 1_000)
      : null;
    const closesAt = parsed.round.closesAt
      ? Math.floor(Date.parse(parsed.round.closesAt) / 1_000)
      : null;
    const unfinishedAssignmentCountSql = `(
      SELECT COUNT(*)
        FROM evaluator_assignments assignment
        JOIN evaluation_rounds round
          ON round.id = assignment.round_id
         AND round.event_id = assignment.event_id
       WHERE round.event_id = events.id
         AND round.plan_id = ?
         AND assignment.status IN ('assigned','in_progress','reopened')
    )`;
    const unfinishedReviewCountSql = `(
      SELECT COUNT(*)
        FROM reviews review
        JOIN evaluator_assignments assignment
          ON assignment.id = review.assignment_id
         AND assignment.event_id = review.event_id
        JOIN evaluation_rounds round
          ON round.id = assignment.round_id
         AND round.event_id = assignment.event_id
       WHERE round.event_id = events.id
         AND round.plan_id = ?
         AND review.status IN ('draft','reopened')
    )`;
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `UPDATE events
            SET last_operation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND (SELECT COUNT(*) FROM evaluation_plans current_plan
                  WHERE current_plan.event_id = events.id
                    AND current_plan.status <> 'archived') = 1
            AND EXISTS (
              SELECT 1 FROM evaluation_plans current_plan
               WHERE current_plan.id = ?
                 AND current_plan.event_id = events.id
                 AND current_plan.revision = ?
                 AND current_plan.status IN ('active','closed')
            )
            AND ? = (
              SELECT COUNT(*) FROM evaluation_rounds current_round
               WHERE current_round.event_id = events.id
                 AND current_round.plan_id = ?
                 AND current_round.status <> 'archived'
            )
            AND ? = ${unfinishedAssignmentCountSql}
            AND ? = ${unfinishedReviewCountSql}
            AND NOT EXISTS (
              SELECT 1
                FROM operation_jobs operation
                JOIN evaluation_rounds operation_round
                  ON operation_round.id = json_extract(
                       operation.payload_json,
                       '$.roundId'
                     )
                 AND operation_round.event_id = operation.event_id
               WHERE operation.event_id = events.id
                 AND operation.organisation_id = events.organisation_id
                 AND operation.type = 'ai.review_assessment.generate'
                 AND operation.status = 'running'
                 AND operation_round.plan_id = ?
            )`,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.currentPlanId,
        parsed.currentPlanRevision,
        Number(current.unarchivedRoundCount),
        parsed.currentPlanId,
        parsed.expectedUnfinishedAssignmentCount,
        parsed.currentPlanId,
        parsed.expectedUnfinishedReviewCount,
        parsed.currentPlanId,
        parsed.currentPlanId,
      ),
      this.env.DB.prepare(
        `UPDATE evaluation_plans
            SET status = 'archived', revision = revision + 1,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND revision = ?
            AND status IN ('active','closed')
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = evaluation_plans.event_id
                 AND event.organisation_id = ?
                 AND event.last_operation_id = ?
            )`,
      ).bind(
        parsed.currentPlanId,
        viewer.eventId,
        parsed.currentPlanRevision,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE evaluation_rounds
            SET status = 'archived', revision = revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE event_id = ? AND plan_id = ? AND status <> 'archived'
            AND EXISTS (
              SELECT 1 FROM evaluation_plans archived_plan
               WHERE archived_plan.id = evaluation_rounds.plan_id
                 AND archived_plan.event_id = evaluation_rounds.event_id
                 AND archived_plan.status = 'archived'
                 AND archived_plan.revision = ?
            )
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = evaluation_rounds.event_id
                 AND event.organisation_id = ?
                 AND event.last_operation_id = ?
            )`,
      ).bind(
        operationId,
        viewer.eventId,
        parsed.currentPlanId,
        parsed.currentPlanRevision + 1,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO evaluation_plans (
           id, event_id, name, status, blinded_reviewing, decision_role,
           revision, created_by_person_id, created_at, updated_at
         )
         SELECT ?, event.id, ?, 'active', ?, ?, 1, ?, unixepoch(), unixepoch()
           FROM events event
          WHERE event.id = ? AND event.organisation_id = ?
            AND event.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM evaluation_plans archived_plan
               WHERE archived_plan.id = ?
                 AND archived_plan.event_id = event.id
                 AND archived_plan.status = 'archived'
                 AND archived_plan.revision = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM evaluation_plans current_plan
               WHERE current_plan.event_id = event.id
                 AND current_plan.status <> 'archived'
            )`,
      ).bind(
        planId,
        parsed.planName,
        parsed.round.anonymous ? 1 : 0,
        current.decisionRole,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
        parsed.currentPlanId,
        parsed.currentPlanRevision + 1,
      ),
      this.env.DB.prepare(
        `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status,
           opens_at, closes_at, blinded_reviewing, scorecard_id,
           scorecard_version, advancement_rule_json, revision,
           created_at, updated_at
         )
         SELECT ?, plan.event_id, plan.id, 1, ?, 'active', ?, ?, ?, ?, 1,
                '{}', 1, unixepoch(), unixepoch()
           FROM evaluation_plans plan
           JOIN events event
             ON event.id = plan.event_id AND event.organisation_id = ?
          WHERE plan.id = ? AND plan.event_id = ? AND plan.status = 'active'
            AND plan.revision = 1 AND event.last_operation_id = ?`,
      ).bind(
        roundId,
        parsed.round.name,
        opensAt,
        closesAt,
        parsed.round.anonymous ? 1 : 0,
        roundId,
        viewer.organisationId,
        planId,
        viewer.eventId,
        operationId,
      ),
    ];
    for (const criterion of criteria) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO evaluation_criteria (
             id, event_id, round_id, name, description, input_type,
             options_json, weight_percent, required, position
           )
           SELECT ?, round.event_id, round.id, ?, ?, ?, ?, ?, ?, ?
             FROM evaluation_rounds round
             JOIN evaluation_plans plan
               ON plan.id = round.plan_id AND plan.event_id = round.event_id
             JOIN events event
               ON event.id = round.event_id AND event.organisation_id = ?
            WHERE round.id = ? AND round.event_id = ?
              AND round.status = 'active' AND round.revision = 1
              AND plan.id = ? AND plan.status = 'active'
              AND event.last_operation_id = ?`,
        ).bind(
          criterion.id,
          criterion.name,
          criterion.description || null,
          criterion.inputType,
          JSON.stringify(criterion.options),
          criterion.weightPercent,
          criterion.required ? 1 : 0,
          criterion.position,
          viewer.organisationId,
          roundId,
          viewer.eventId,
          planId,
          operationId,
        ),
      );
    }
    const auditIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'evaluation.review_cycle.started',
                'evaluation_plan', ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM evaluation_plans archived_plan
             WHERE archived_plan.id = ? AND archived_plan.event_id = ?
               AND archived_plan.status = 'archived'
          )
            AND NOT EXISTS (
              SELECT 1 FROM evaluation_rounds old_round
               WHERE old_round.event_id = ? AND old_round.plan_id = ?
                 AND old_round.status <> 'archived'
            )
            AND EXISTS (
              SELECT 1 FROM evaluation_plans new_plan
               WHERE new_plan.id = ? AND new_plan.event_id = ?
                 AND new_plan.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM evaluation_rounds new_round
               WHERE new_round.id = ? AND new_round.event_id = ?
                 AND new_round.plan_id = ? AND new_round.status = 'active'
                 AND (SELECT COUNT(*) FROM evaluation_criteria criterion
                       WHERE criterion.event_id = new_round.event_id
                         AND criterion.round_id = new_round.id) = ?
            )
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = ? AND event.organisation_id = ?
                 AND event.last_operation_id = ?
            )`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        planId,
        JSON.stringify({
          archivedPlanId: parsed.currentPlanId,
          planId,
          roundId,
          unfinishedAssignmentCount: parsed.expectedUnfinishedAssignmentCount,
          unfinishedReviewCount: parsed.expectedUnfinishedReviewCount,
        }),
        parsed.currentPlanId,
        viewer.eventId,
        viewer.eventId,
        parsed.currentPlanId,
        planId,
        viewer.eventId,
        roundId,
        viewer.eventId,
        planId,
        criteria.length,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM audit_events audit
            WHERE audit.id = ? AND audit.organisation_id = ?
              AND audit.event_id = ?
              AND audit.action = 'evaluation.review_cycle.started'
         ) THEN 1 ELSE json_extract('review-cycle-commit-failed', '$') END
           AS valid`,
      ).bind(operationId, viewer.organisationId, viewer.eventId),
    );

    let results: D1Result[];
    try {
      results = await this.env.DB.batch(statements);
    } catch (error) {
      const refreshed = await this.env.DB.prepare(
        `SELECT plan.id, plan.revision,
                (SELECT COUNT(*)
                   FROM evaluation_rounds round
                  WHERE round.event_id = plan.event_id
                    AND round.plan_id = plan.id
                    AND round.status <> 'archived') AS unarchivedRoundCount,
                (SELECT COUNT(*)
                   FROM evaluator_assignments assignment
                   JOIN evaluation_rounds round
                     ON round.id = assignment.round_id
                    AND round.event_id = assignment.event_id
                  WHERE round.event_id = plan.event_id
                    AND round.plan_id = plan.id
                    AND assignment.status IN ('assigned','in_progress','reopened'))
                  AS unfinishedAssignmentCount,
                (SELECT COUNT(*)
                   FROM reviews review
                   JOIN evaluator_assignments assignment
                     ON assignment.id = review.assignment_id
                    AND assignment.event_id = review.event_id
                   JOIN evaluation_rounds round
                     ON round.id = assignment.round_id
                    AND round.event_id = assignment.event_id
                  WHERE round.event_id = plan.event_id
                    AND round.plan_id = plan.id
                    AND review.status IN ('draft','reopened'))
                  AS unfinishedReviewCount,
                (SELECT COUNT(*)
                   FROM operation_jobs operation
                   JOIN evaluation_rounds operation_round
                     ON operation_round.id = json_extract(
                          operation.payload_json,
                          '$.roundId'
                        )
                    AND operation_round.event_id = operation.event_id
                  WHERE operation.event_id = plan.event_id
                    AND operation.organisation_id = event.organisation_id
                    AND operation.type = 'ai.review_assessment.generate'
                    AND operation.status = 'running'
                    AND operation_round.plan_id = plan.id)
                  AS runningAssessmentOperationCount
           FROM evaluation_plans plan
           JOIN events event
             ON event.id = plan.event_id AND event.organisation_id = ?
          WHERE plan.event_id = ? AND plan.status <> 'archived'
          ORDER BY plan.created_at DESC LIMIT 1`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .first<{
          id: string;
          revision: number;
          unarchivedRoundCount: number;
          unfinishedAssignmentCount: number;
          unfinishedReviewCount: number;
          runningAssessmentOperationCount: number;
        }>();
      if (Number(refreshed?.runningAssessmentOperationCount ?? 0) !== 0) {
        throw new EvaluationStateError(
          "A running AI review assessment appeared before the new review cycle could start. Wait for it to finish and try again.",
        );
      }
      if (
        !refreshed ||
        refreshed.id !== parsed.currentPlanId ||
        refreshed.revision !== parsed.currentPlanRevision ||
        Number(refreshed.unarchivedRoundCount) !==
          Number(current.unarchivedRoundCount) ||
        Number(refreshed.unfinishedAssignmentCount) !==
          parsed.expectedUnfinishedAssignmentCount ||
        Number(refreshed.unfinishedReviewCount) !==
          parsed.expectedUnfinishedReviewCount
      ) {
        throw new EvaluationRevisionConflictError(
          "The current review cycle changed before the new cycle could start. Refresh and try again.",
        );
      }
      throw error;
    }
    const expectedChanges = [
      [results[0], 1],
      [results[1], 1],
      [results[2], Number(current.unarchivedRoundCount)],
      [results[3], 1],
      [results[4], 1],
      ...criteria.map((_, index) => [results[5 + index], 1] as const),
      [results[auditIndex], 1],
    ] as const;
    if (
      expectedChanges.some(
        ([result, expected]) => (result?.meta.changes ?? 0) !== expected,
      )
    ) {
      throw new Error(
        "The new review cycle committed without its complete historical archive and fresh rubric.",
      );
    }
    return {
      archivedPlanId: parsed.currentPlanId,
      planId,
      roundId,
      unfinishedAssignmentCount: parsed.expectedUnfinishedAssignmentCount,
      unfinishedReviewCount: parsed.expectedUnfinishedReviewCount,
    };
  }

  protected async getRounds(
    eventId: string,
    organisationId: string,
    planId: string,
  ): Promise<Round[]> {
    const [roundRows, criterionRows, reviewerRows] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT r.id, r.name, r.round_number AS roundNumber, r.status, r.revision,
               r.opens_at AS opensAt, r.closes_at AS closesAt,
               r.blinded_reviewing AS anonymous,
               r.scorecard_id AS scorecardId,
               r.scorecard_version AS scorecardVersion,
               (SELECT COUNT(*)
                  FROM operation_jobs operation
                 WHERE operation.event_id = r.event_id
                   AND operation.organisation_id = e.organisation_id
                   AND operation.type = 'ai.review_assessment.generate'
                   AND operation.status = 'running'
                   AND json_type(operation.payload_json, '$.roundId') = 'text'
                   AND json_extract(operation.payload_json, '$.roundId') = r.id)
                 AS runningAiAssessmentCount
          FROM evaluation_rounds r
          JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
         WHERE r.event_id = ? AND r.plan_id = ? ORDER BY r.round_number
      `,
      )
        .bind(organisationId, eventId, planId)
        .all<
          Omit<Round, "criteria" | "reviewers"> & {
            anonymous: number | boolean;
          }
        >(),
      this.env.DB.prepare(
        `
        SELECT c.id, c.round_id AS roundId, c.name, c.description,
               c.input_type AS inputType, c.weight_percent AS weightPercent,
               c.options_json AS optionsJson, c.required, c.position
          FROM evaluation_criteria c
          JOIN evaluation_rounds r
            ON r.id = c.round_id AND r.event_id = c.event_id
          JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
         WHERE c.event_id = ? AND r.plan_id = ? ORDER BY r.round_number, c.position
      `,
      )
        .bind(organisationId, eventId, planId)
        .all<
          Omit<Criterion, "options"> & { roundId: string; optionsJson: string }
        >(),
      this.env.DB.prepare(
        `
        SELECT pool.round_id AS roundId, pool.person_id AS personId,
               person.display_name AS name, person.email
          FROM evaluation_round_reviewers pool
          JOIN people person ON person.id = pool.person_id
          JOIN evaluation_rounds r
            ON r.id = pool.round_id AND r.event_id = pool.event_id
          JOIN events e ON e.id = pool.event_id AND e.organisation_id = ?
         WHERE pool.event_id = ? AND r.plan_id = ?
         ORDER BY pool.round_id, person.display_name, person.id
      `,
      )
        .bind(organisationId, eventId, planId)
        .all<{
          roundId: string;
          personId: string;
          name: string;
          email: string;
        }>(),
    ]);
    return roundRows.results.map((round) => ({
      ...round,
      anonymous: Boolean(round.anonymous),
      reviewers: reviewerRows.results
        .filter((reviewer) => reviewer.roundId === round.id)
        .map(({ roundId: _roundId, ...reviewer }) => reviewer),
      criteria: criterionRows.results
        .filter((criterion) => criterion.roundId === round.id)
        .map(({ optionsJson, ...criterion }) => ({
          ...criterion,
          options: parseCriterionOptions(
            optionsJson,
            criterion.id,
            criterion.inputType,
          ),
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

  protected async savePlanD1(
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
    assertPlanScorecardConsistency(parsed.rounds);
    const blindedReviewing = parsed.rounds.some((round) => round.anonymous)
      ? 1
      : 0;
    const existing = await this.env.DB.prepare(
      `
      SELECT plan.id, plan.revision, plan.decision_role AS decisionRole
        FROM evaluation_plans plan
        JOIN events event
          ON event.id = plan.event_id AND event.organisation_id = ?
       WHERE plan.event_id = ? AND plan.status <> 'archived'
       ORDER BY plan.created_at DESC LIMIT 1
    `,
    )
      .bind(viewer.organisationId, viewer.eventId)
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
    const readReplacementBlockingActivity = (planId: string) =>
      this.env.DB.prepare(
        `
        SELECT
          EXISTS (
            SELECT 1
              FROM evaluator_assignments assignment
              JOIN evaluation_rounds assigned_round
                ON assigned_round.id = assignment.round_id
               AND assigned_round.event_id = assignment.event_id
             WHERE assigned_round.plan_id = plan.id
               AND assigned_round.event_id = plan.event_id
          ) AS hasAssignments,
          EXISTS (
            SELECT 1
              FROM ai_review_assessments assessment
              JOIN evaluation_rounds assessed_round
                ON assessed_round.id = assessment.round_id
               AND assessed_round.event_id = assessment.event_id
             WHERE assessed_round.plan_id = plan.id
               AND assessed_round.event_id = plan.event_id
          ) AS hasAiAssessments,
          EXISTS (
            SELECT 1
              FROM operation_jobs operation
              JOIN evaluation_rounds operation_round
                ON operation_round.id = json_extract(
                     operation.payload_json,
                     '$.roundId'
                   )
               AND operation_round.event_id = operation.event_id
             WHERE operation.event_id = plan.event_id
               AND operation.organisation_id = event.organisation_id
               AND operation.type = 'ai.review_assessment.generate'
               AND operation.status = 'running'
               AND json_type(operation.payload_json, '$.roundId') = 'text'
               AND operation_round.plan_id = plan.id
          ) AS hasRunningAiAssessments
          FROM evaluation_plans plan
          JOIN events event
            ON event.id = plan.event_id AND event.organisation_id = ?
         WHERE plan.id = ? AND plan.event_id = ?
      `,
      )
        .bind(viewer.organisationId, planId, viewer.eventId)
        .first<{
          hasAssignments: number;
          hasAiAssessments: number;
          hasRunningAiAssessments: number;
        }>();
    if (existing) {
      const activity = await readReplacementBlockingActivity(existing.id);
      if (activity?.hasAssignments)
        throw new EvaluationStateError(
          "A plan with assignments cannot have its rounds or rubric replaced. Create the next round instead.",
        );
      if (activity?.hasAiAssessments)
        throw new EvaluationStateError(
          "A plan with AI assessments cannot have its rounds or rubric replaced. Create the next round instead.",
        );
      if (activity?.hasRunningAiAssessments)
        throw new EvaluationStateError(
          "Wait for every running AI review assessment in this plan to finish before replacing its rounds or rubric.",
        );
    }
    if (existing) {
      await assertPersistedScorecardConsistency(
        this.env.DB,
        viewer.organisationId,
        viewer.eventId,
        existing.id,
        parsed.rounds,
      );
    }
    const existingReviewerRows = existing
      ? (
          await this.env.DB.prepare(
            `
            SELECT pool.id, pool.round_id AS roundId, pool.person_id AS personId,
                   pool.added_by_person_id AS addedByPersonId,
                   pool.revision, pool.created_at AS createdAt
              FROM evaluation_round_reviewers pool
              JOIN evaluation_rounds round
                ON round.id = pool.round_id AND round.event_id = pool.event_id
              JOIN events event
                ON event.id = pool.event_id AND event.organisation_id = ?
             WHERE pool.event_id = ? AND round.plan_id = ?
          `,
          )
            .bind(viewer.organisationId, viewer.eventId, existing.id)
            .all<{
              id: string;
              roundId: string;
              personId: string;
              addedByPersonId: string | null;
              revision: number;
              createdAt: number;
            }>()
        ).results
      : [];
    const planId = existing?.id ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const planHasNoReplacementBlockingActivity = `
      NOT EXISTS (
        SELECT 1
          FROM evaluator_assignments assignment
          JOIN evaluation_rounds assigned_round
            ON assigned_round.id = assignment.round_id
           AND assigned_round.event_id = assignment.event_id
         WHERE assigned_round.plan_id = ?
           AND assigned_round.event_id = ?
      )
      AND NOT EXISTS (
        SELECT 1
          FROM ai_review_assessments assessment
          JOIN evaluation_rounds assessed_round
            ON assessed_round.id = assessment.round_id
           AND assessed_round.event_id = assessment.event_id
         WHERE assessed_round.plan_id = ?
           AND assessed_round.event_id = ?
      )
      AND NOT EXISTS (
        SELECT 1
          FROM operation_jobs operation
          JOIN evaluation_rounds operation_round
            ON operation_round.id = json_extract(
                 operation.payload_json,
                 '$.roundId'
               )
           AND operation_round.event_id = operation.event_id
         WHERE operation.event_id = ?
           AND operation.organisation_id = ?
           AND operation.type = 'ai.review_assessment.generate'
           AND operation.status = 'running'
           AND json_type(operation.payload_json, '$.roundId') = 'text'
           AND operation_round.plan_id = ?
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
                    AND plan.revision = ? AND ${planHasNoReplacementBlockingActivity}
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
            planId,
            viewer.eventId,
            viewer.eventId,
            viewer.organisationId,
            planId,
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
           AND ${planHasNoReplacementBlockingActivity}
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
              planId,
              viewer.eventId,
              viewer.eventId,
              viewer.organisationId,
              planId,
              viewer.eventId,
              viewer.organisationId,
              operationId,
            ),
            this.env.DB.prepare(
              `
        DELETE FROM evaluation_rounds
         WHERE plan_id = ? AND event_id = ?
           AND ${planHasNoReplacementBlockingActivity}
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
              // DELETE target.
              planId,
              viewer.eventId,
              // No assignment activity in this plan.
              planId,
              viewer.eventId,
              // No persisted AI assessment activity in this plan.
              planId,
              viewer.eventId,
              // No running AI generation targeting this plan.
              viewer.eventId,
              viewer.organisationId,
              planId,
              // The preceding plan update must still be authoritative.
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
      const closesAt =
        round.closesAt !== undefined ? round.closesAt : (round.dueAt ?? null);
      statements.push(
        this.env.DB.prepare(
          `
        INSERT INTO evaluation_rounds (
          id, event_id, plan_id, round_number, name, status, opens_at, closes_at,
          blinded_reviewing, scorecard_id, scorecard_version,
          advancement_rule_json, revision, created_at, updated_at
        )
        SELECT ?, p.event_id, p.id, ?, ?, ?, ?, ?, ?, ?, ?, '{}', 1, unixepoch(), unixepoch()
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
          round.opensAt ? Math.floor(Date.parse(round.opensAt) / 1_000) : null,
          closesAt ? Math.floor(Date.parse(closesAt) / 1_000) : null,
          round.anonymous ? 1 : 0,
          round.scorecardId ?? round.id,
          round.scorecardVersion,
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
            id, event_id, round_id, name, description, input_type, options_json,
            weight_percent, required, position
          )
          SELECT ?, r.event_id, r.id, ?, ?, ?, ?, ?, ?, ?
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
            JSON.stringify(criterion.options),
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
      for (const reviewer of existingReviewerRows.filter(
        (candidate) => candidate.roundId === round.id,
      )) {
        statements.push(
          this.env.DB.prepare(
            `
            INSERT INTO evaluation_round_reviewers (
              id, event_id, round_id, person_id, added_by_person_id,
              revision, created_at, updated_at
            )
            SELECT ?, r.event_id, r.id, ?, ?, ?, ?, unixepoch()
              FROM evaluation_rounds r
              JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
             WHERE r.id = ? AND r.event_id = ? AND r.plan_id = ?
          `,
          ).bind(
            reviewer.id,
            reviewer.personId,
            reviewer.addedByPersonId,
            reviewer.revision,
            reviewer.createdAt,
            viewer.organisationId,
            round.id,
            viewer.eventId,
            planId,
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
        const activity = await readReplacementBlockingActivity(existing.id);
        if (activity?.hasAssignments) {
          throw new EvaluationStateError(
            "A plan with assignments cannot have its rounds or rubric replaced. Create the next round instead.",
          );
        }
        if (activity?.hasAiAssessments) {
          throw new EvaluationStateError(
            "A plan with AI assessments cannot have its rounds or rubric replaced. Create the next round instead.",
          );
        }
        if (activity?.hasRunningAiAssessments) {
          throw new EvaluationStateError(
            "A running AI review assessment appeared before the plan could be replaced. Wait for it to finish and try again.",
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
}
