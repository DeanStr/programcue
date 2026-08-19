import { z } from "zod";

import { routingSchema } from "~/modules/submissions/submission-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import { EvaluationStateError } from "./evaluation-errors";
import { parseRecommendationChoicesJson } from "./evaluation-recommendation-choices";
import {
  type Criterion,
  type Round,
  requireSubmittedSnapshot,
} from "./evaluation-service-foundation.server";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

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

export class EvaluationAdminWorkspaceReader {
  constructor(private readonly env: CloudflareEnvironment) {}

  async read(viewer: Viewer) {
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
                 SELECT json_group_array(json(ordered.speaker))
                   FROM (
                     SELECT json_object(
                              'name', speaker.display_name,
                              'email', speaker.email,
                              'roleLabel', speaker.role_label
                            ) AS speaker
                       FROM submission_speakers speaker
                      WHERE speaker.event_id = s.event_id
                        AND speaker.submission_id = s.id
                      ORDER BY speaker.position
                   ) ordered
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
               r.scores_json AS scoresJson,
               r.weighted_score AS weightedScore,
               r.recommendation, r.confidence,
               r.recommendation_choices_snapshot_json AS recommendationChoicesSnapshotJson,
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
          scoresJson: string | null;
          weightedScore: number | null;
          recommendation: string | null;
          recommendationChoicesSnapshotJson: string | null;
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
          .array(
            z.object({
              name: z.string(),
              email: z.string(),
              roleLabel: z.string().nullable(),
            }),
          )
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
      assignments: assignmentRows.results.map(
        ({ recommendationChoicesSnapshotJson, ...assignment }) => {
          if (!assignment.reviewId) {
            return {
              ...assignment,
              recommendationChoices: null,
              recommendationLabel: null,
            };
          }
          if (!recommendationChoicesSnapshotJson) {
            throw new EvaluationStateError(
              `Review ${assignment.reviewId} is missing its recommendation choice snapshot.`,
            );
          }
          const recommendationChoices = parseRecommendationChoicesJson(
            recommendationChoicesSnapshotJson,
            `Review ${assignment.reviewId}`,
          );
          const recommendationLabel = assignment.recommendation
            ? recommendationChoices.find(
                (choice) => choice.id === assignment.recommendation,
              )?.label
            : null;
          if (assignment.recommendation && !recommendationLabel) {
            throw new EvaluationStateError(
              `Review ${assignment.reviewId} has an invalid persisted recommendation.`,
            );
          }
          return {
            ...assignment,
            recommendationChoices,
            recommendationLabel,
          };
        },
      ),
      reviewerProgress,
      moderations: moderationRows.results,
    };
  }

  private async getRounds(
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
               r.recommendation_choices_json AS recommendationChoicesJson,
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
          Omit<Round, "criteria" | "reviewers" | "recommendationChoices"> & {
            anonymous: number | boolean;
            recommendationChoicesJson: string;
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
    return roundRows.results.map(({ recommendationChoicesJson, ...round }) => ({
      ...round,
      anonymous: Boolean(round.anonymous),
      recommendationChoices: parseRecommendationChoicesJson(
        recommendationChoicesJson,
        `Evaluation round ${round.id}`,
      ),
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
}
