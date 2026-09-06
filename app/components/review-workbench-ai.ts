import { useState } from "react";
import { buildUnansweredReviewerAiImport } from "~/modules/evaluations/reviewer-ai-import";
import type {
  ReviewRecoveryPayload,
  ReviewWorkspace,
} from "./review-workbench-contract";

export function useReviewWorkbenchAi(
  workspace: ReviewWorkspace,
  recoveryPayload: ReviewRecoveryPayload,
  readOnly: boolean,
) {
  const [suggestionImport, setSuggestionImport] = useState(() => ({
    suggestionId: workspace.review?.aiSuggestionId ?? null,
    importedCriterionIds: workspace.review?.importedCriterionIds ?? [],
  }));
  const [confirmedAiCriterionIds, setConfirmedAiCriterionIds] = useState<
    Set<string>
  >(() => new Set(workspace.review?.confirmedAiCriterionIds ?? []));
  const reviewerSuggestion = workspace.reviewerAiSuggestion;
  const suggestionByCriterionId = new Map(
    reviewerSuggestion?.suggestions.map((suggestion) => [
      suggestion.criterionId,
      suggestion,
    ]) ?? [],
  );
  const unchangedAiCriterionIds = suggestionImport.suggestionId
    ? suggestionImport.importedCriterionIds.filter((criterionId) => {
        const suggestion = suggestionByCriterionId.get(criterionId);
        return (
          suggestion?.suggestedValue !== null &&
          String(recoveryPayload.scores[criterionId] ?? "") ===
            suggestion?.suggestedValue
        );
      })
    : [];
  function applyReviewerAiSuggestion(
    restoreReview: (payload: ReviewRecoveryPayload) => void,
  ) {
    if (!reviewerSuggestion || readOnly) return;
    const imported = buildUnansweredReviewerAiImport(
      recoveryPayload.scores,
      reviewerSuggestion.suggestions,
    );
    if (!imported.importedCriterionIds.length) return;
    restoreReview({
      ...recoveryPayload,
      scores: imported.scores,
      aiSuggestionId: reviewerSuggestion.id,
      aiImportedCriterionIds: imported.importedCriterionIds,
    });
  }
  function setAiCriterionConfirmed(criterionId: string, confirmed: boolean) {
    setConfirmedAiCriterionIds((current) => {
      const next = new Set(current);
      if (confirmed) next.add(criterionId);
      else next.delete(criterionId);
      return next;
    });
  }
  return {
    suggestionImport,
    setSuggestionImport,
    confirmedAiCriterionIds,
    setConfirmedAiCriterionIds,
    unchangedAiCriterionIds,
    applyReviewerAiSuggestion,
    setAiCriterionConfirmed,
  };
}
