import { type LoaderFunctionArgs } from "react-router";
import { AiReviewAssessmentService } from "~/modules/ai/ai-review-assessment.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import {
  EVALUATION_RESULT_PRESETS,
  evaluationResultFlags,
  matchesEvaluationResultPreset,
  type EvaluationResultPreset,
} from "~/modules/evaluations/evaluation-result-workbench";
import { EventService } from "~/modules/events/event-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { canReleaseEvaluationDecisions } from "./evaluation-admin-outcomes";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  await ensureDemoEvaluationData(env);
  const canPrepareReviewerReminders =
    viewer.role === "owner" || viewer.role === "administrator";
  const evaluationService = new EvaluationService(env);
  const [workspace, event, reviewerReminderTemplateRows] = await Promise.all([
    evaluationService.getAdminWorkspace(viewer),
    new EventService(env).getSetup(viewer),
    canPrepareReviewerReminders
      ? env.DB.prepare(
          `SELECT version.id, version.name, version.version_number AS versionNumber,
                  version.subject_template AS subject
             FROM communication_template_versions version
             JOIN communication_templates template
               ON template.id = version.template_id
              AND template.event_id = version.event_id
             JOIN events event
               ON event.id = version.event_id AND event.organisation_id = ?
            WHERE version.event_id = ? AND version.category = 'ad_hoc'
              AND version.channel = 'email' AND version.status = 'published'
              AND template.status = 'active'
            ORDER BY template.updated_at DESC, version.version_number DESC`,
        )
          .bind(viewer.organisationId, viewer.eventId)
          .all<{
            id: string;
            name: string;
            versionNumber: number;
            subject: string;
          }>()
      : Promise.resolve({ results: [] }),
  ]);
  const aiReviewAssessmentsSupported = event.repositoryProvider === "d1";
  const canManageAiAssessments =
    canPrepareReviewerReminders && aiReviewAssessmentsSupported;
  const aiAssessmentService = new AiReviewAssessmentService(env);
  const [aiReviewAssessments, aiReviewAssessmentGenerationAttempts] =
    await Promise.all([
      aiReviewAssessmentsSupported
        ? aiAssessmentService.listForEvent(viewer)
        : Promise.resolve([]),
      canManageAiAssessments
        ? aiAssessmentService.listGenerationAttempts(viewer)
        : Promise.resolve([]),
    ]);
  const search = new URL(request.url).searchParams;
  const requestedPreset = search.get("preset") ?? "all";
  if (!EVALUATION_RESULT_PRESETS.some((preset) => preset === requestedPreset)) {
    throw new Response("Invalid evaluation results preset", { status: 400 });
  }
  const resultPreset = requestedPreset as EvaluationResultPreset;
  const requestedPage = search.get("page") ?? "1";
  const resultsPage = Number(requestedPage);
  if (
    !/^\d+$/u.test(requestedPage) ||
    !Number.isSafeInteger(resultsPage) ||
    resultsPage < 1 ||
    resultsPage > 100_000
  ) {
    throw new Response("Invalid evaluation results page", { status: 400 });
  }
  const resultsPageSize = 25;
  const requestedFilter = search.get("filter") ?? "";
  if (
    requestedFilter &&
    !["unassigned", "incomplete"].includes(requestedFilter)
  ) {
    throw new Response("Invalid evaluation review filter", { status: 400 });
  }
  const reviewFilter =
    requestedFilter === "unassigned" || requestedFilter === "incomplete"
      ? requestedFilter
      : null;
  const unassignedOnly = reviewFilter === "unassigned";
  const incompleteOnly = reviewFilter === "incomplete";
  const focusedSubmissionId = search.get("submission")?.trim() ?? "";
  const focusedSessionId = search.get("session")?.trim() ?? "";
  if (focusedSubmissionId.length > 200 || focusedSessionId.length > 200) {
    throw new Response("Invalid evaluation discussion focus", { status: 400 });
  }
  if (focusedSubmissionId && focusedSessionId) {
    throw new Response("Choose one evaluation discussion target", {
      status: 400,
    });
  }
  if (
    focusedSubmissionId &&
    !workspace.submissions.some(
      (submission) => submission.id === focusedSubmissionId,
    )
  ) {
    throw new Response("Submission not found in this event's evaluation", {
      status: 404,
    });
  }
  if (focusedSubmissionId && !workspace.plan) {
    throw new Response(
      "Create an evaluation plan before opening a submission in Review.",
      { status: 409 },
    );
  }
  if (
    focusedSessionId &&
    !workspace.sessions.some((session) => session.id === focusedSessionId)
  ) {
    throw new Response("Session not found in this event's evaluation", {
      status: 404,
    });
  }
  if (focusedSessionId && !workspace.plan) {
    throw new Response(
      "Create an evaluation plan before opening a session in Review.",
      { status: 409 },
    );
  }
  const requestedSort = search.get("sort") ?? "score_desc";
  const resultSortOptions = [
    "score_desc",
    "score_asc",
    "title_asc",
    "completion_desc",
  ] as const;
  if (!resultSortOptions.some((option) => option === requestedSort)) {
    throw new Response("Invalid evaluation results sort", { status: 400 });
  }
  const resultSort = requestedSort as (typeof resultSortOptions)[number];
  const requestedRoundId = search.get("round")?.trim() ?? "";
  if (requestedRoundId.length > 200)
    throw new Response("Invalid evaluation round focus", { status: 400 });
  if (
    requestedRoundId &&
    !workspace.plan?.rounds.some((round) => round.id === requestedRoundId)
  )
    throw new Response("Evaluation round not found in this event", {
      status: 404,
    });
  const requestedResultsRoundId = search.get("resultsRound")?.trim() ?? "";
  if (requestedResultsRoundId.length > 200) {
    throw new Response("Invalid evaluation results round", { status: 400 });
  }
  if (
    requestedResultsRoundId &&
    !workspace.plan?.rounds.some(
      (round) => round.id === requestedResultsRoundId,
    )
  ) {
    throw new Response("Evaluation results round not found in this event", {
      status: 404,
    });
  }
  const resultsRoundId =
    requestedResultsRoundId ||
    workspace.plan?.rounds.find((round) => round.status === "active")?.id ||
    workspace.plan?.rounds.at(-1)?.id ||
    null;
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
        assignmentId: string;
        evaluatorName: string;
        weightedScore: number | null;
        recommendation: string | null;
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
        assignmentId: string;
        evaluatorName: string;
        weightedScore: number | null;
        recommendation: string | null;
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
        recommendations: {},
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
          assignmentId: assignment.id,
          evaluatorName: assignment.evaluatorName,
          weightedScore: assignment.weightedScore,
          recommendation: assignment.recommendation,
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
  const decisionHistoryRows = resultsRoundId
    ? await env.DB.prepare(
        `SELECT decision.id, decision.submission_id AS submissionId,
                decision.revision_number AS revisionNumber,
                decision.status, decision.decision, decision.rationale,
                decision.decided_at AS decidedAt,
                decision.published_at AS publishedAt,
                person.display_name AS decidedByName
           FROM submission_decisions decision
           JOIN events event
             ON event.id = decision.event_id AND event.organisation_id = ?
           JOIN people person ON person.id = decision.decided_by_person_id
          WHERE decision.event_id = ? AND decision.round_id = ?
          ORDER BY decision.submission_id, decision.revision_number DESC`,
      )
        .bind(viewer.organisationId, viewer.eventId, resultsRoundId)
        .all<{
          id: string;
          submissionId: string;
          revisionNumber: number;
          status: string;
          decision: string;
          rationale: string | null;
          decidedAt: number;
          publishedAt: number | null;
          decidedByName: string;
        }>()
    : { results: [] };
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
        criterionNames: Object.fromEntries(
          (selectedResultsRound?.criteria ?? []).map((criterion) => [
            criterion.id,
            criterion.name,
          ]),
        ),
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
  const resultsTotal = allResults.length;
  const resultsPageCount = Math.max(1, Math.ceil(resultsTotal / resultsPageSize));
  if (resultsPage > resultsPageCount && resultsTotal > 0) {
    throw new Response("Evaluation results page not found", { status: 404 });
  }
  const results = allResults.slice(
    (resultsPage - 1) * resultsPageSize,
    resultsPage * resultsPageSize,
  );
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
    ...workspace,
    demoMode: viewer.demo,
    canReleaseDecisions: canReleaseEvaluationDecisions(
      viewer.role,
      workspace.plan,
    ),
    canManageEvaluationAccess:
      viewer.role === "owner" || viewer.role === "administrator",
    canPrepareReviewerReminders,
    canManageAiAssessments,
    aiReviewAssessmentsSupported,
    reviewerReminderTemplates: reviewerReminderTemplateRows.results,
    aiReviewAssessments,
    aiReviewAssessmentGenerationAttempts,
    submissions: sortedSubmissions.map((submission) => ({
      ...submission,
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
    resultsPage,
    resultsPageSize,
    resultsTotal,
    resultsPageCount,
    resultsExportIntent: crypto.randomUUID(),
    focusedRoundId: requestedRoundId || null,
    eventTimezone: event.timezone,
    acceptedSpeakerInvitationResendEnabled: String(env.DEMO_MODE) !== "true",
  };
}

export { action } from "./evaluation-admin-action.server";
