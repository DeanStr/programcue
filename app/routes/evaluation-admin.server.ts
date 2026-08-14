import { type LoaderFunctionArgs } from "react-router";
import { AiReviewAssessmentService } from "~/modules/ai/ai-review-assessment.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
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
  const [workspace, event, reviewerReminderTemplateRows] = await Promise.all([
    new EvaluationService(env).getAdminWorkspace(viewer),
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
  const unassignedOnly = search.get("filter") === "unassigned";
  const focusedSubmissionId = search.get("submission")?.trim() ?? "";
  if (focusedSubmissionId.length > 200) {
    throw new Response("Invalid evaluation submission focus", { status: 400 });
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
    }
  >();
  if (resultsRoundId) {
    for (const assignment of workspace.assignments) {
      if (
        assignment.roundId !== resultsRoundId ||
        assignment.submissionId === null ||
        assignment.status === "recused" ||
        assignment.status === "cancelled"
      ) {
        continue;
      }
      const aggregate = submissionResults.get(assignment.submissionId) ?? {
        assignmentCount: 0,
        completedReviewCount: 0,
        scoredReviewCount: 0,
        scoreTotal: 0,
      };
      aggregate.assignmentCount += 1;
      if (
        assignment.reviewStatus === "submitted" ||
        assignment.reviewStatus === "locked"
      ) {
        aggregate.completedReviewCount += 1;
        if (assignment.weightedScore !== null) {
          aggregate.scoredReviewCount += 1;
          aggregate.scoreTotal += assignment.weightedScore;
        }
      }
      submissionResults.set(assignment.submissionId, aggregate);
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
    };
  });
  const visibleSubmissions = unassignedOnly
    ? roundScopedSubmissions.filter(
        (submission) => submission.assignmentCount === 0,
      )
    : roundScopedSubmissions;
  const sortedSubmissions = [...visibleSubmissions].sort((left, right) => {
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
  });
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
    unassignedOnly,
    focusedSubmissionId: focusedSubmissionId || null,
    resultSort,
    resultsRoundId,
    resultsExportIntent: crypto.randomUUID(),
    focusedRoundId: requestedRoundId || null,
    totalSubmissionCount: roundScopedSubmissions.length,
    eventTimezone: event.timezone,
    acceptedSpeakerInvitationResendEnabled: String(env.DEMO_MODE) !== "true",
  };
}

export { action } from "./evaluation-admin-action.server";
