export type ReviewerAiImportSuggestion = {
  criterionId: string;
  suggestedValue: string | null;
};

export function buildUnansweredReviewerAiImport(
  currentScores: Record<string, string>,
  suggestions: ReviewerAiImportSuggestion[],
) {
  const importedScores = Object.fromEntries(
    suggestions
      .filter(
        (suggestion) =>
          suggestion.suggestedValue !== null &&
          String(currentScores[suggestion.criterionId] ?? "").trim() === "",
      )
      .map((suggestion) => [
        suggestion.criterionId,
        suggestion.suggestedValue!,
      ]),
  );
  return {
    scores: { ...currentScores, ...importedScores },
    importedCriterionIds: Object.keys(importedScores),
  };
}
