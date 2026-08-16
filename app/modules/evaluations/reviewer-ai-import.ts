export type ReviewerAiImportSuggestion = {
  criterionId: string;
  suggestedValue: string | null;
};

export function buildUnansweredReviewerAiImport(
  currentScores: Record<string, string>,
  suggestions: ReviewerAiImportSuggestion[],
) {
  const importedScores = Object.fromEntries(
    suggestions.flatMap((suggestion) => {
      const value = suggestion.suggestedValue;
      if (
        value === null ||
        String(currentScores[suggestion.criterionId] ?? "").trim() !== ""
      ) {
        return [];
      }
      return [[suggestion.criterionId, value] as const];
    }),
  );
  return {
    scores: { ...currentScores, ...importedScores },
    importedCriterionIds: Object.keys(importedScores),
  };
}
