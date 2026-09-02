import {
  EVALUATION_RESULT_PRESETS,
  type EvaluationResultPreset,
} from "./evaluation-result-workbench";

const RESULT_SORT_OPTIONS = [
  "score_desc",
  "score_asc",
  "title_asc",
  "completion_desc",
] as const;

export type EvaluationResultSort = (typeof RESULT_SORT_OPTIONS)[number];
export type EvaluationReviewFilter = "unassigned" | "incomplete" | null;

export function parseEvaluationAdminResultsQuery(input: {
  search: URLSearchParams;
  submissionIds: ReadonlySet<string>;
  sessionIds: ReadonlySet<string>;
  rounds: ReadonlyArray<{ id: string; status: string }>;
}) {
  const { search, submissionIds, sessionIds, rounds } = input;
  const requestedPreset = search.get("preset") ?? "all";
  if (!EVALUATION_RESULT_PRESETS.some((preset) => preset === requestedPreset)) {
    throw new Response("Invalid evaluation results preset", { status: 400 });
  }

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

  const requestedFilter = search.get("filter") ?? "";
  if (
    requestedFilter &&
    requestedFilter !== "unassigned" &&
    requestedFilter !== "incomplete"
  ) {
    throw new Response("Invalid evaluation review filter", { status: 400 });
  }
  const reviewFilter: EvaluationReviewFilter =
    requestedFilter === "unassigned" || requestedFilter === "incomplete"
      ? requestedFilter
      : null;

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
  if (focusedSubmissionId && !submissionIds.has(focusedSubmissionId)) {
    throw new Response("Submission not found in this event's evaluation", {
      status: 404,
    });
  }
  if (focusedSessionId && !sessionIds.has(focusedSessionId)) {
    throw new Response("Session not found in this event's evaluation", {
      status: 404,
    });
  }
  if ((focusedSubmissionId || focusedSessionId) && rounds.length === 0) {
    throw new Response(
      focusedSubmissionId
        ? "Create an evaluation plan before opening a submission in Review."
        : "Create an evaluation plan before opening a session in Review.",
      { status: 409 },
    );
  }

  const requestedSort = search.get("sort") ?? "score_desc";
  if (!RESULT_SORT_OPTIONS.some((option) => option === requestedSort)) {
    throw new Response("Invalid evaluation results sort", { status: 400 });
  }

  const requestedRoundId = search.get("round")?.trim() ?? "";
  if (requestedRoundId.length > 200) {
    throw new Response("Invalid evaluation round focus", { status: 400 });
  }
  if (
    requestedRoundId &&
    !rounds.some((round) => round.id === requestedRoundId)
  ) {
    throw new Response("Evaluation round not found in this event", {
      status: 404,
    });
  }

  const requestedResultsRoundId = search.get("resultsRound")?.trim() ?? "";
  if (requestedResultsRoundId.length > 200) {
    throw new Response("Invalid evaluation results round", { status: 400 });
  }
  if (
    requestedResultsRoundId &&
    !rounds.some((round) => round.id === requestedResultsRoundId)
  ) {
    throw new Response("Evaluation results round not found in this event", {
      status: 404,
    });
  }

  return {
    resultPreset: requestedPreset as EvaluationResultPreset,
    resultsPage,
    resultsPageSize: 25,
    reviewFilter,
    unassignedOnly: reviewFilter === "unassigned",
    incompleteOnly: reviewFilter === "incomplete",
    focusedSubmissionId,
    focusedSessionId,
    resultSort: requestedSort as EvaluationResultSort,
    requestedRoundId,
    resultsRoundId:
      requestedResultsRoundId ||
      rounds.find((round) => round.status === "active")?.id ||
      rounds.at(-1)?.id ||
      null,
  };
}
