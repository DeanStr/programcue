import type { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
import { parseRecommendationChoicesJson } from "./evaluation-recommendation-choices";
import {
  planReviewResponses,
  type ReviewCriterion,
} from "./evaluation-review-plan";
import type { reviewDraftSchema } from "./evaluation-schema";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

async function reviewSourceSnapshotHash(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function loadEvaluationReviewSaveContext(input: {
  env: CloudflareEnvironment;
  viewer: Viewer;
  parsed: z.infer<typeof reviewDraftSchema>;
}) {
  const { env, viewer, parsed } = input;
  const assignment = await env.DB.prepare(
    `
      SELECT a.id, a.status, a.revision,
           a.submission_id AS submissionId, a.session_id AS sessionId,
           a.round_id AS roundId, r.scorecard_id AS scorecardId,
           r.scorecard_version AS scorecardVersion,
           r.recommendation_choices_json AS recommendationChoicesJson,
           COALESCE(submission.submitted_snapshot_json, a.session_snapshot_json)
             AS sourceSnapshotJson
      FROM evaluator_assignments a
      JOIN evaluation_rounds r ON r.id = a.round_id AND r.event_id = a.event_id
      JOIN evaluation_plans plan
        ON plan.id = r.plan_id AND plan.event_id = r.event_id
      JOIN evaluation_round_reviewers pool
        ON pool.event_id = a.event_id
       AND pool.round_id = a.round_id
       AND pool.person_id = a.evaluator_person_id
      JOIN events event ON event.id = a.event_id
       AND event.organisation_id = ?
      LEFT JOIN submissions submission
        ON submission.id = a.submission_id
       AND submission.event_id = a.event_id
      LEFT JOIN sessions session
        ON session.id = a.session_id AND session.event_id = a.event_id
     WHERE a.id = ? AND a.event_id = ? AND a.evaluator_person_id = ?
       AND a.status IN ('assigned','in_progress','reopened')
       AND plan.status = 'active' AND r.status = 'active'
       AND (r.opens_at IS NULL OR r.opens_at <= unixepoch())
       AND (r.closes_at IS NULL OR r.closes_at > unixepoch())
       AND (
         (a.submission_id IS NOT NULL
          AND ${reviewableSubmissionSql("submission", "review")})
         OR
         (a.session_id IS NOT NULL
          AND session.status NOT IN ('cancelled','archived'))
       )
  `,
  )
    .bind(
      viewer.organisationId,
      parsed.assignmentId,
      viewer.eventId,
      viewer.personId,
    )
    .first<{
      id: string;
      status: string;
      revision: number;
      submissionId: string | null;
      sessionId: string | null;
      roundId: string;
      scorecardId: string;
      scorecardVersion: number;
      recommendationChoicesJson: string;
      sourceSnapshotJson: string | null;
    }>();
  if (!assignment)
    throw new EvaluationStateError(
      "This assignment is unavailable or already submitted.",
    );
  if (!assignment.sourceSnapshotJson) {
    throw new EvaluationStateError(
      "This assignment has no immutable source snapshot.",
    );
  }
  const recommendationChoices = parseRecommendationChoicesJson(
    assignment.recommendationChoicesJson,
    `Evaluation round ${assignment.roundId}`,
  );
  if (
    parsed.recommendation !== null &&
    !recommendationChoices.some((choice) => choice.id === parsed.recommendation)
  ) {
    throw new EvaluationValidationError(
      "Select a recommendation available for this evaluation round.",
    );
  }
  const recommendationChoicesSnapshotJson = JSON.stringify(
    recommendationChoices,
  );
  const sourceSnapshotHash = await reviewSourceSnapshotHash(
    assignment.sourceSnapshotJson,
  );
  const criteria = await env.DB.prepare(
    `SELECT criterion.id, criterion.name, criterion.description,
            criterion.input_type AS inputType,
            criterion.options_json AS optionsJson,
            criterion.weight_percent AS weightPercent, criterion.required,
            criterion.position
       FROM evaluation_criteria criterion
       JOIN evaluation_rounds round
         ON round.id = criterion.round_id AND round.event_id = criterion.event_id
       JOIN events event
         ON event.id = criterion.event_id AND event.organisation_id = ?
      WHERE criterion.event_id = ? AND criterion.round_id = ?
      ORDER BY criterion.position`,
  )
    .bind(viewer.organisationId, viewer.eventId, assignment.roundId)
    .all<ReviewCriterion>();
  const { criteriaSnapshotJson, responses, weightedScore } =
    planReviewResponses(criteria.results, parsed.scores, parsed.intent);
  const criterionInputTypeById = new Map(
    criteria.results.map((criterion) => [criterion.id, criterion.inputType]),
  );
  const existing = await env.DB.prepare(
    `SELECT review.id, review.revision, review.status,
            review.ai_suggestion_id AS aiSuggestionId,
            review.imported_criterion_ids_json AS importedCriterionIdsJson,
            review.scores_json AS scoresJson,
            review.recommendation_choices_snapshot_json AS recommendationChoicesSnapshotJson
       FROM reviews review
       JOIN events event
         ON event.id = review.event_id AND event.organisation_id = ?
      WHERE review.event_id = ? AND review.assignment_id = ?`,
  )
    .bind(viewer.organisationId, viewer.eventId, assignment.id)
    .first<{
      id: string;
      revision: number;
      status: string;
      aiSuggestionId: string | null;
      importedCriterionIdsJson: string;
      scoresJson: string;
      recommendationChoicesSnapshotJson: string;
    }>();
  if ((existing?.revision ?? 0) !== parsed.revision)
    throw new EvaluationRevisionConflictError();
  const reviewId = existing?.id ?? crypto.randomUUID();
  if (
    existing &&
    JSON.stringify(
      parseRecommendationChoicesJson(
        existing.recommendationChoicesSnapshotJson,
        `Review ${existing.id}`,
      ),
    ) !== recommendationChoicesSnapshotJson
  ) {
    throw new EvaluationStateError(
      `Review ${existing.id} does not match its assigned recommendation choices.`,
    );
  }
  return {
    assignment,
    recommendationChoicesSnapshotJson,
    sourceSnapshotHash,
    criteriaSnapshotJson,
    responses,
    weightedScore,
    criterionInputTypeById,
    existing,
    reviewId,
  };
}
