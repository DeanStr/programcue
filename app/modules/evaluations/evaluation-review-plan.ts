import {
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
import { calculateRubricWeightedScore } from "./evaluation-rules";

export type ReviewCriterion = {
  id: string;
  name: string;
  description: string | null;
  inputType: "scale_5" | "scale_10" | "yes_no" | "free_text" | "dropdown";
  optionsJson: string;
  weightPercent: number;
  required: number | boolean;
  position: number;
};

export function planReviewResponses(
  criteria: ReviewCriterion[],
  scores: Record<string, string | number | boolean>,
  intent: "save" | "submit",
) {
  const criteriaSnapshotJson = JSON.stringify(
    criteria.map((criterion) => ({
      id: criterion.id,
      name: criterion.name,
      description: criterion.description,
      inputType: criterion.inputType,
      options: JSON.parse(criterion.optionsJson) as unknown,
      weightPercent: criterion.weightPercent,
      required: Boolean(criterion.required),
      position: criterion.position,
    })),
  );
  const criterionIds = new Set(criteria.map((criterion) => criterion.id));
  if (
    Object.keys(scores).some((criterionId) => !criterionIds.has(criterionId))
  ) {
    throw new EvaluationValidationError(
      "The review contains scores for criteria that are not in this evaluation round. Refresh before saving.",
    );
  }

  const responses: Record<string, string | number | boolean> = {};
  for (const criterion of criteria) {
    const raw = scores[criterion.id];
    const empty =
      raw === undefined || (typeof raw === "string" && raw.trim() === "");
    if (empty) {
      if (intent === "submit" && criterion.required) {
        throw new EvaluationValidationError(
          "Complete every required rubric criterion before submitting the review.",
        );
      }
      continue;
    }
    if (
      criterion.inputType === "scale_5" ||
      criterion.inputType === "scale_10"
    ) {
      const value = typeof raw === "number" ? raw : Number(raw);
      const maximum = criterion.inputType === "scale_10" ? 10 : 5;
      if (!Number.isInteger(value) || value < 1 || value > maximum) {
        throw new EvaluationValidationError(
          `A rubric score must be a whole number from 1 to ${maximum}.`,
        );
      }
      responses[criterion.id] = value;
    } else if (criterion.inputType === "yes_no") {
      if (raw !== "yes" && raw !== "no" && typeof raw !== "boolean") {
        throw new EvaluationValidationError(
          "A yes/no rubric response must be yes or no.",
        );
      }
      responses[criterion.id] = typeof raw === "boolean" ? raw : raw === "yes";
    } else if (criterion.inputType === "dropdown") {
      if (typeof raw !== "string") {
        throw new EvaluationValidationError(
          "A dropdown rubric response must be one of its configured options.",
        );
      }
      let options: unknown;
      try {
        options = JSON.parse(criterion.optionsJson);
      } catch {
        throw new EvaluationStateError(
          `Criterion ${criterion.id} has invalid persisted dropdown options.`,
        );
      }
      if (!Array.isArray(options) || !options.includes(raw.trim())) {
        throw new EvaluationValidationError(
          "Choose one of the configured dropdown options.",
        );
      }
      responses[criterion.id] = raw.trim();
    } else {
      if (typeof raw !== "string") {
        throw new EvaluationValidationError(
          "A free-text rubric response must be text.",
        );
      }
      responses[criterion.id] = raw.trim();
    }
  }

  const scaledCriteria = criteria
    .filter(
      (criterion) =>
        criterion.inputType === "scale_5" || criterion.inputType === "scale_10",
    )
    .map((criterion) => ({
      id: criterion.id,
      weightPercent: criterion.weightPercent,
      inputType: criterion.inputType as "scale_5" | "scale_10",
    }));
  return {
    criteriaSnapshotJson,
    responses,
    weightedScore:
      intent === "submit"
        ? calculateRubricWeightedScore(scaledCriteria, responses)
        : null,
  };
}
