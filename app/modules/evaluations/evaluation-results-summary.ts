export type EvaluationReviewTarget = {
  targetType: "proposal" | "session";
};

export function summarizeEvaluationReviewTargets(
  results: ReadonlyArray<EvaluationReviewTarget>,
) {
  const proposals = results.filter(
    (result) => result.targetType === "proposal",
  ).length;
  return {
    total: results.length,
    proposals,
    sessions: results.length - proposals,
  };
}
