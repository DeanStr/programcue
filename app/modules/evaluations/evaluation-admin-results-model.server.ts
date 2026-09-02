import { requireValue } from "~/lib/required-value";
import type { AiReviewAssessment } from "~/modules/ai/ai-review-assessment.server";
import type { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { parseEvaluationAdminResultsQuery } from "./evaluation-admin-results-query";
import { loadEvaluationDecisionDrafts } from "./evaluation-decision-draft-reader.server";
import { loadEvaluationDecisionHistory } from "./evaluation-decision-history-reader.server";
import {
  createEvaluationRecommendationCounts,
  evaluationResultFlags,
  matchesEvaluationResultPreset,
} from "./evaluation-result-workbench";
import { summarizeEvaluationReviewTargets } from "./evaluation-results-summary";
import { parseHistoricalReviewRevision } from "./evaluation-review-history";

export { parseHistoricalReviewRevision } from "./evaluation-review-history";

import type { EvaluationService } from "./evaluation-service.server";

export async function buildEvaluationAdminResultsModel(input: {
  env: CloudflareEnvironment;
  viewer: Awaited<ReturnType<typeof requireCurrentEventRole>>;
  workspace: Awaited<ReturnType<EvaluationService["getAdminWorkspace"]>>;
  evaluationService: EvaluationService;
  aiReviewAssessments: AiReviewAssessment[];
  search: URLSearchParams;
}) {
  const {
    env,
    viewer,
    workspace,
    evaluationService,
    aiReviewAssessments,
    search,
  } = input;
  const {
    resultPreset,
    resultsPage,
    resultsPageSize,
    reviewFilter,
    unassignedOnly,
    incompleteOnly,
    focusedSubmissionId,
    focusedSessionId,
    resultSort,
    requestedRoundId,
    resultsRoundId,
  } = parseEvaluationAdminResultsQuery({
    search,
    submissionIds: new Set(workspace.submissions.map(({ id }) => id)),
    sessionIds: new Set(workspace.sessions.map(({ id }) => id)),
    rounds: workspace.plan?.rounds ?? [],
  });
  const resultRecommendationChoices = resultsRoundId
    ? requireValue(
        workspace.plan?.rounds.find((round) => round.id === resultsRoundId),
        "The selected evaluation results round is unavailable.",
      ).recommendationChoices
    : [];
  const submissionResults = new Map<
    string,
    {
      assignmentCount: number;
      completedReviewCount: number;
      scoredReviewCount: number;
      scoreTotal: number;
      minimumScore: number | null;
      maximumScore: number | null;
      recusedCount: number;
      recommendations: Record<string, number>;
      reviews: Array<{
        reviewId: string;
        assignmentId: string;
        evaluatorName: string;
        weightedScore: number | null;
        recommendation: string | null;
        recommendationLabel: string | null;
        privateNotes: string | null;
        submitterFeedback: string | null;
        scores: Record<string, string | number | boolean>;
      }>;
    }
  >();
  const sessionResults = new Map<
    string,
    {
      assignmentCount: number;
      completedReviewCount: number;
      scoredReviewCount: number;
      scoreTotal: number;
      minimumScore: number | null;
      maximumScore: number | null;
      recusedCount: number;
      recommendations: Record<string, number>;
      reviews: Array<{
        reviewId: string;
        assignmentId: string;
        evaluatorName: string;
        weightedScore: number | null;
        recommendation: string | null;
        recommendationLabel: string | null;
        privateNotes: string | null;
        submitterFeedback: string | null;
        scores: Record<string, string | number | boolean>;
      }>;
    }
  >();
  if (resultsRoundId) {
    for (const assignment of workspace.assignments) {
      if (
        assignment.roundId !== resultsRoundId ||
        assignment.status === "cancelled"
      ) {
        continue;
      }
      const targetResults = assignment.submissionId
        ? submissionResults
        : sessionResults;
      const targetId = assignment.submissionId ?? assignment.sessionId;
      if (!targetId) {
        throw new Error("An evaluation assignment has no review target.");
      }
      const aggregate = targetResults.get(targetId) ?? {
        assignmentCount: 0,
        completedReviewCount: 0,
        scoredReviewCount: 0,
        scoreTotal: 0,
        minimumScore: null,
        maximumScore: null,
        recusedCount: 0,
        recommendations: createEvaluationRecommendationCounts(),
        reviews: [],
      };
      if (assignment.status === "recused") {
        aggregate.recusedCount += 1;
        targetResults.set(targetId, aggregate);
        continue;
      }
      aggregate.assignmentCount += 1;
      if (
        assignment.reviewStatus === "submitted" ||
        assignment.reviewStatus === "locked"
      ) {
        aggregate.completedReviewCount += 1;
        if (assignment.weightedScore !== null) {
          aggregate.scoredReviewCount += 1;
          aggregate.scoreTotal += assignment.weightedScore;
          aggregate.minimumScore =
            aggregate.minimumScore === null
              ? assignment.weightedScore
              : Math.min(aggregate.minimumScore, assignment.weightedScore);
          aggregate.maximumScore =
            aggregate.maximumScore === null
              ? assignment.weightedScore
              : Math.max(aggregate.maximumScore, assignment.weightedScore);
        }
        if (assignment.recommendation) {
          aggregate.recommendations[assignment.recommendation] =
            (aggregate.recommendations[assignment.recommendation] ?? 0) + 1;
        }
        let scores: Record<string, string | number | boolean> = {};
        if (assignment.scoresJson !== null) {
          const parsed: unknown = JSON.parse(assignment.scoresJson);
          if (
            !parsed ||
            typeof parsed !== "object" ||
            Array.isArray(parsed) ||
            Object.values(parsed).some(
              (value) =>
                typeof value !== "string" &&
                typeof value !== "number" &&
                typeof value !== "boolean",
            )
          ) {
            throw new Error(
              `Submitted review ${assignment.reviewId ?? assignment.id} has invalid persisted criterion responses.`,
            );
          }
          scores = parsed as Record<string, string | number | boolean>;
        }
        aggregate.reviews.push({
          reviewId: requireValue(
            assignment.reviewId,
            "Required assignment.reviewId is unavailable.",
          ),
          assignmentId: assignment.id,
          evaluatorName: assignment.evaluatorName,
          weightedScore: assignment.weightedScore,
          recommendation: assignment.recommendation,
          recommendationLabel: assignment.recommendationLabel ?? null,
          privateNotes: assignment.privateNotes,
          submitterFeedback: assignment.submitterFeedback,
          scores,
        });
      }
      targetResults.set(targetId, aggregate);
    }
  }
  const roundScopedSubmissions = workspace.submissions.map((submission) => {
    const aggregate = submissionResults.get(submission.id);
    return {
      ...submission,
      assignmentCount: aggregate?.assignmentCount ?? 0,
      completedReviewCount: aggregate?.completedReviewCount ?? 0,
      averageScore:
        aggregate && aggregate.scoredReviewCount > 0
          ? aggregate.scoreTotal / aggregate.scoredReviewCount
          : null,
      minimumScore: aggregate?.minimumScore ?? null,
      maximumScore: aggregate?.maximumScore ?? null,
      recusedCount: aggregate?.recusedCount ?? 0,
      recommendations: aggregate?.recommendations ?? {},
      reviews: aggregate?.reviews ?? [],
    };
  });
  const matchesReviewFilter = (target: {
    assignmentCount: number;
    completedReviewCount: number;
  }) =>
    unassignedOnly
      ? target.assignmentCount === 0
      : incompleteOnly
        ? target.assignmentCount > 0 &&
          target.completedReviewCount < target.assignmentCount
        : true;
  const visibleSubmissions = roundScopedSubmissions.filter(matchesReviewFilter);
  const roundScopedSessions = workspace.sessions.map((session) => {
    const aggregate = sessionResults.get(session.id);
    return {
      ...session,
      assignmentCount: aggregate?.assignmentCount ?? 0,
      completedReviewCount: aggregate?.completedReviewCount ?? 0,
      averageScore:
        aggregate && aggregate.scoredReviewCount > 0
          ? aggregate.scoreTotal / aggregate.scoredReviewCount
          : null,
      minimumScore: aggregate?.minimumScore ?? null,
      maximumScore: aggregate?.maximumScore ?? null,
      recusedCount: aggregate?.recusedCount ?? 0,
      recommendations: aggregate?.recommendations ?? {},
      reviews: aggregate?.reviews ?? [],
    };
  });
  const visibleSessions = roundScopedSessions.filter(matchesReviewFilter);
  const compareResults = (
    left: {
      id: string;
      title: string;
      assignmentCount: number;
      completedReviewCount: number;
      averageScore: number | null;
    },
    right: {
      id: string;
      title: string;
      assignmentCount: number;
      completedReviewCount: number;
      averageScore: number | null;
    },
  ) => {
    if (resultSort === "title_asc") {
      return (
        left.title.localeCompare(right.title, undefined, {
          sensitivity: "base",
        }) || left.id.localeCompare(right.id)
      );
    }
    if (resultSort === "completion_desc") {
      const leftCompletion = left.assignmentCount
        ? left.completedReviewCount / left.assignmentCount
        : -1;
      const rightCompletion = right.assignmentCount
        ? right.completedReviewCount / right.assignmentCount
        : -1;
      return (
        rightCompletion - leftCompletion ||
        left.title.localeCompare(right.title, undefined, {
          sensitivity: "base",
        }) ||
        left.id.localeCompare(right.id)
      );
    }
    if (left.averageScore === null || right.averageScore === null) {
      if (left.averageScore === right.averageScore) {
        return (
          left.title.localeCompare(right.title, undefined, {
            sensitivity: "base",
          }) || left.id.localeCompare(right.id)
        );
      }
      return left.averageScore === null ? 1 : -1;
    }
    const scoreOrder =
      resultSort === "score_asc"
        ? left.averageScore - right.averageScore
        : right.averageScore - left.averageScore;
    return (
      scoreOrder ||
      left.title.localeCompare(right.title, undefined, {
        sensitivity: "base",
      }) ||
      left.id.localeCompare(right.id)
    );
  };
  const sortedSubmissions = [...visibleSubmissions].sort(compareResults);
  const selectedResultsRound = workspace.plan?.rounds.find(
    (round) => round.id === resultsRoundId,
  );
  const resultCriterionNames = Object.fromEntries(
    (selectedResultsRound?.criteria ?? []).map((criterion) => [
      criterion.id,
      criterion.name,
    ]),
  );
  const decisionHistoryRows = await loadEvaluationDecisionHistory({
    env,
    organisationId: viewer.organisationId,
    eventId: viewer.eventId,
    resultsRoundId,
  });
  const decisionDraftBySubmission = await loadEvaluationDecisionDrafts({
    env,
    organisationId: viewer.organisationId,
    eventId: viewer.eventId,
  });
  const allResults = [
    ...roundScopedSubmissions.map((submission) => ({
      targetType: "proposal" as const,
      id: submission.id,
      reference: submission.reference,
      title: submission.title,
      state: submission.status,
      assignmentCount: submission.assignmentCount,
      completedReviewCount: submission.completedReviewCount,
      averageScore: submission.averageScore,
      minimumScore: submission.minimumScore,
      maximumScore: submission.maximumScore,
      recusedCount: submission.recusedCount,
      recommendations: submission.recommendations,
      reviews: submission.reviews,
      moderation:
        workspace.moderations.find(
          (moderation) =>
            moderation.roundId === resultsRoundId &&
            moderation.submissionId === submission.id,
        ) ?? null,
      aiAssessment:
        aiReviewAssessments.find(
          (assessment) =>
            assessment.roundId === resultsRoundId &&
            assessment.submissionId === submission.id,
        ) ?? null,
      decisionHistory: decisionHistoryRows.results.filter(
        (decision) => decision.submissionId === submission.id,
      ),
    })),
    ...roundScopedSessions.map((session) => ({
      targetType: "session" as const,
      id: session.id,
      reference: session.reference,
      title: session.title,
      state: session.status,
      assignmentCount: session.assignmentCount,
      completedReviewCount: session.completedReviewCount,
      averageScore: session.averageScore,
      minimumScore: session.minimumScore,
      maximumScore: session.maximumScore,
      recusedCount: session.recusedCount,
      recommendations: session.recommendations,
      reviews: session.reviews,
      moderation: null,
      aiAssessment: null,
      decisionHistory: [],
    })),
  ]
    .filter(matchesReviewFilter)
    .map((result) => {
      const { mixedRecommendations, incomplete, decisionReady } =
        evaluationResultFlags({
          assignmentCount: result.assignmentCount,
          completedReviewCount: result.completedReviewCount,
          recusedCount: result.recusedCount,
          recommendationCounts: result.recommendations,
          moderationStatus: result.moderation?.status ?? null,
        });
      return {
        ...result,
        mixedRecommendations,
        incomplete,
        decisionReady,
      };
    })
    .filter((result) => {
      return matchesEvaluationResultPreset(resultPreset, {
        assignmentCount: result.assignmentCount,
        completedReviewCount: result.completedReviewCount,
        recusedCount: result.recusedCount,
        recommendationCounts: result.recommendations,
        moderationStatus: result.moderation?.status ?? null,
      });
    })
    .sort(compareResults);
  const reviewTargetSummary = summarizeEvaluationReviewTargets(allResults);
  const resultsTotal = reviewTargetSummary.total;
  const resultsPageCount = Math.max(
    1,
    Math.ceil(resultsTotal / resultsPageSize),
  );
  if (resultsPage > resultsPageCount) {
    throw new Response("Evaluation results page not found", { status: 404 });
  }
  const pagedResults = allResults.slice(
    (resultsPage - 1) * resultsPageSize,
    resultsPage * resultsPageSize,
  );
  const pageReviewIds = pagedResults.flatMap((result) =>
    result.reviews.map((review) => review.reviewId),
  );
  const reviewRevisionRows = pageReviewIds.length
    ? await env.DB.prepare(
        `SELECT revision.id, revision.review_id AS reviewId,
                revision.revision_number AS revisionNumber,
                revision.save_kind AS saveKind,
                revision.scores_json AS scoresJson,
                revision.content_json AS contentJson,
                revision.scorecard_id AS scorecardId,
                revision.scorecard_version AS scorecardVersion,
                revision.criteria_snapshot_json AS criteriaSnapshotJson,
                revision.recommendation_choices_snapshot_json AS recommendationChoicesSnapshotJson,
                revision.created_at AS createdAt,
                person.display_name AS savedByName
           FROM review_revisions revision
           JOIN reviews review
             ON review.id = revision.review_id
            AND review.event_id = revision.event_id
           JOIN events event
             ON event.id = review.event_id AND event.organisation_id = ?
           JOIN people person ON person.id = revision.saved_by_person_id
          WHERE revision.event_id = ?
            AND revision.review_id IN (${pageReviewIds.map(() => "?").join(",")})
          ORDER BY revision.review_id, revision.revision_number DESC`,
      )
        .bind(viewer.organisationId, viewer.eventId, ...pageReviewIds)
        .all<{
          id: string;
          reviewId: string;
          revisionNumber: number;
          saveKind: "autosave" | "manual" | "submitted" | "reopened";
          scoresJson: string;
          contentJson: string;
          scorecardId: string | null;
          scorecardVersion: number | null;
          criteriaSnapshotJson: string | null;
          recommendationChoicesSnapshotJson: string;
          createdAt: number;
          savedByName: string;
        }>()
    : { results: [] };
  const results = pagedResults.map((result) => ({
    ...result,
    reviews: result.reviews.map((review) => ({
      ...review,
      history: reviewRevisionRows.results
        .filter((revision) => revision.reviewId === review.reviewId)
        .map(
          ({
            scoresJson,
            contentJson,
            criteriaSnapshotJson,
            recommendationChoicesSnapshotJson,
            ...revision
          }) => ({
            ...revision,
            ...parseHistoricalReviewRevision({
              id: revision.id,
              scoresJson,
              contentJson,
              scorecardId: revision.scorecardId,
              scorecardVersion: revision.scorecardVersion,
              criteriaSnapshotJson,
              recommendationChoicesSnapshotJson,
            }),
          }),
        ),
    })),
  }));
  const discussionTarget = focusedSubmissionId
    ? ({ targetType: "submission", targetId: focusedSubmissionId } as const)
    : focusedSessionId
      ? ({ targetType: "session", targetId: focusedSessionId } as const)
      : null;
  const reviewDiscussion =
    discussionTarget && resultsRoundId
      ? await evaluationService.listDiscussion(viewer, {
          roundId: resultsRoundId,
          ...discussionTarget,
        })
      : null;
  let reviewDiscussionTitle: string | null = null;
  if (discussionTarget) {
    const titledTarget =
      discussionTarget.targetType === "submission"
        ? roundScopedSubmissions.find(
            (submission) => submission.id === discussionTarget.targetId,
          )
        : roundScopedSessions.find(
            (session) => session.id === discussionTarget.targetId,
          );
    if (!titledTarget) {
      throw new Error(
        "The validated evaluation discussion target is missing from the review workspace.",
      );
    }
    reviewDiscussionTitle = titledTarget.title;
  }

  return {
    submissions: sortedSubmissions.map((submission) => ({
      ...submission,
      decisionDraft: decisionDraftBySubmission.get(submission.id) ?? null,
      aiAssessmentGenerationIntent: crypto.randomUUID(),
    })),
    sessions: visibleSessions,
    results,
    reviewFilter,
    unassignedOnly,
    incompleteOnly,
    focusedSubmissionId: focusedSubmissionId || null,
    focusedSessionId: focusedSessionId || null,
    reviewDiscussion,
    reviewDiscussionTitle,
    resultSort,
    resultPreset,
    resultsRoundId,
    resultRecommendationChoices,
    resultsPage,
    resultsPageSize,
    resultsTotal,
    reviewTargetSummary,
    resultsPageCount,
    resultCriterionNames,
    resultsExportIntent: crypto.randomUUID(),
    focusedRoundId: requestedRoundId || null,
  };
}
