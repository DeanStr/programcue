import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
import type { loadEvaluationReviewSaveContext } from "./evaluation-review-save-context.server";
import {
  type reviewDraftSchema,
  reviewerAiCriterionSuggestionsSchema,
} from "./evaluation-schema";

type ReviewSaveContext = Awaited<
  ReturnType<typeof loadEvaluationReviewSaveContext>
>;

export async function resolveEvaluationReviewAiProvenance(input: {
  env: CloudflareEnvironment;
  viewer: Viewer;
  parsed: z.infer<typeof reviewDraftSchema>;
  context: ReviewSaveContext;
}) {
  const { env, viewer, parsed, context } = input;
  const {
    assignment,
    existing,
    reviewId,
    responses,
    criterionInputTypeById,
    sourceSnapshotHash,
  } = context;
  let existingImportedCriterionIds: string[] = [];
  let existingResponses: Record<string, string | number | boolean> = {};
  try {
    existingImportedCriterionIds = z
      .array(z.string().min(1).max(200))
      .max(30)
      .parse(JSON.parse(existing?.importedCriterionIdsJson ?? "[]"));
    existingResponses = z
      .record(z.string().min(1), z.union([z.string(), z.number(), z.boolean()]))
      .parse(JSON.parse(existing?.scoresJson ?? "{}"));
  } catch {
    throw new EvaluationStateError(
      `Review ${reviewId} has invalid persisted scores or AI suggestion provenance.`,
    );
  }
  const suggestionId = parsed.suggestionId ?? existing?.aiSuggestionId ?? null;
  const importedCriterionIds = parsed.suggestionId
    ? parsed.importedCriterionIds
    : existingImportedCriterionIds;
  if (
    existing?.aiSuggestionId &&
    parsed.suggestionId &&
    existing.aiSuggestionId !== parsed.suggestionId
  ) {
    throw new EvaluationValidationError(
      "A review cannot replace its imported AI suggestion with another suggestion.",
    );
  }
  let suggestion: {
    status: "offered" | "imported";
    assignmentRevision: number;
    scorecardId: string;
    scorecardVersion: number;
    sourceSnapshotHash: string;
    suggestions: z.infer<typeof reviewerAiCriterionSuggestionsSchema>;
  } | null = null;
  if (suggestionId) {
    const row = await env.DB.prepare(
      `SELECT suggestion.status,
              suggestion.assignment_revision AS assignmentRevision,
              suggestion.scorecard_id AS scorecardId,
              suggestion.scorecard_version AS scorecardVersion,
              suggestion.source_snapshot_hash AS sourceSnapshotHash,
              suggestion.suggestions_json AS suggestionsJson
         FROM reviewer_ai_suggestions suggestion
         JOIN events event
           ON event.id = suggestion.event_id AND event.organisation_id = ?
          AND event.repository_provider = 'd1'
        WHERE suggestion.id = ? AND suggestion.event_id = ?
          AND suggestion.assignment_id = ?
          AND suggestion.evaluator_person_id = ?
          AND suggestion.status IN ('offered','imported')`,
    )
      .bind(
        viewer.organisationId,
        suggestionId,
        viewer.eventId,
        assignment.id,
        viewer.personId,
      )
      .first<{
        status: "offered" | "imported";
        assignmentRevision: number;
        scorecardId: string;
        scorecardVersion: number;
        sourceSnapshotHash: string;
        suggestionsJson: string;
      }>();
    if (!row) {
      throw new EvaluationValidationError(
        "This AI suggestion is unavailable for this review assignment.",
      );
    }
    let suggestions: z.infer<typeof reviewerAiCriterionSuggestionsSchema>;
    try {
      suggestions = reviewerAiCriterionSuggestionsSchema.parse(
        JSON.parse(row.suggestionsJson),
      );
    } catch {
      throw new EvaluationStateError(
        `AI suggestion ${suggestionId} has invalid persisted criterion content.`,
      );
    }
    suggestion = { ...row, suggestions };
    if (
      (suggestion.status === "offered" &&
        suggestion.assignmentRevision !== assignment.revision) ||
      suggestion.scorecardId !== assignment.scorecardId ||
      suggestion.scorecardVersion !== assignment.scorecardVersion ||
      suggestion.sourceSnapshotHash !== sourceSnapshotHash
    ) {
      throw new EvaluationRevisionConflictError(
        "The assignment or scorecard changed after AI suggestions were generated. Refresh before saving.",
      );
    }
    const suggestedClosedValues = new Map(
      suggestion.suggestions
        .filter((item) => item.suggestedValue !== null)
        .map((item) => [item.criterionId, item.suggestedValue]),
    );
    if (importedCriterionIds.some((id) => !suggestedClosedValues.has(id))) {
      throw new EvaluationValidationError(
        "Only closed criteria from this AI suggestion can be imported.",
      );
    }
    if (!existing?.aiSuggestionId) {
      if (!importedCriterionIds.length) {
        throw new EvaluationValidationError(
          "This AI suggestion has no unanswered closed criteria to import.",
        );
      }
      if (
        importedCriterionIds.some((id) => Object.hasOwn(existingResponses, id))
      ) {
        throw new EvaluationValidationError(
          "AI suggestions can only fill criteria that were unanswered in the saved review.",
        );
      }
      if (
        importedCriterionIds.some((id) => {
          const response = responses[id];
          const persistedValue =
            criterionInputTypeById.get(id) === "yes_no"
              ? response === true
                ? "yes"
                : response === false
                  ? "no"
                  : ""
              : String(response ?? "");
          return persistedValue !== suggestedClosedValues.get(id);
        })
      ) {
        throw new EvaluationValidationError(
          "Each imported AI criterion must retain its exact suggested value.",
        );
      }
    }
    if (
      existing?.aiSuggestionId &&
      (existingImportedCriterionIds.length !== importedCriterionIds.length ||
        existingImportedCriterionIds.some(
          (id) => !importedCriterionIds.includes(id),
        ))
    ) {
      throw new EvaluationValidationError(
        "Imported AI criterion provenance cannot be changed after it is saved.",
      );
    }
  } else if (
    importedCriterionIds.length ||
    parsed.confirmedAiCriterionIds.length
  ) {
    throw new EvaluationValidationError(
      "AI criterion provenance requires an available reviewer suggestion.",
    );
  }
  const unchangedImportedCriterionIds = suggestion
    ? suggestion.suggestions
        .filter((item) => {
          if (
            item.suggestedValue === null ||
            !importedCriterionIds.includes(item.criterionId)
          ) {
            return false;
          }
          const response = responses[item.criterionId];
          const persistedValue =
            criterionInputTypeById.get(item.criterionId) === "yes_no"
              ? response === true
                ? "yes"
                : response === false
                  ? "no"
                  : ""
              : String(response ?? "");
          return persistedValue === item.suggestedValue;
        })
        .map((item) => item.criterionId)
    : [];
  if (
    parsed.confirmedAiCriterionIds.some(
      (id) => !unchangedImportedCriterionIds.includes(id),
    )
  ) {
    throw new EvaluationValidationError(
      "Only unchanged imported AI criteria can be confirmed.",
    );
  }
  if (
    parsed.intent === "submit" &&
    unchangedImportedCriterionIds.some(
      (id) => !parsed.confirmedAiCriterionIds.includes(id),
    )
  ) {
    throw new EvaluationValidationError(
      "Confirm every unchanged AI-derived criterion before submitting the review.",
    );
  }
  const confirmedAiCriterionIds =
    parsed.intent === "submit" ? unchangedImportedCriterionIds : [];
  return {
    suggestion,
    suggestionId,
    importedCriterionIds,
    confirmedAiCriterionIds,
  };
}
