export const EVALUATION_RESULT_PRESETS = [
  "all",
  "coverage",
  "decision_ready",
  "moderation",
] as const;

export type EvaluationResultPreset = (typeof EVALUATION_RESULT_PRESETS)[number];

export type EvaluationResultSignals = {
  assignmentCount: number;
  completedReviewCount: number;
  recusedCount: number;
  recommendationCounts: Readonly<Record<string, number>>;
  moderationStatus: string | null;
};

export function createEvaluationRecommendationCounts() {
  return Object.create(null) as Record<string, number>;
}

export function evaluationResultFlags(result: EvaluationResultSignals) {
  const mixedRecommendations =
    Object.values(result.recommendationCounts).filter((count) => count > 0)
      .length > 1;
  const incomplete =
    result.assignmentCount > 0 &&
    result.completedReviewCount < result.assignmentCount;
  const decisionReady =
    result.assignmentCount > 0 &&
    result.completedReviewCount === result.assignmentCount &&
    result.recusedCount === 0 &&
    !mixedRecommendations;
  return { mixedRecommendations, incomplete, decisionReady };
}

export function matchesEvaluationResultPreset(
  preset: EvaluationResultPreset,
  result: EvaluationResultSignals,
) {
  const flags = evaluationResultFlags(result);
  if (preset === "coverage") {
    return (
      result.assignmentCount === 0 ||
      flags.incomplete ||
      result.recusedCount > 0
    );
  }
  if (preset === "decision_ready") return flags.decisionReady;
  if (preset === "moderation") {
    return (
      flags.mixedRecommendations ||
      result.recusedCount > 0 ||
      result.moderationStatus === "draft"
    );
  }
  return true;
}
