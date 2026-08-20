import { z } from "zod";
import { requireValue } from "~/lib/required-value";
import { reviewerAiCriterionSuggestionsSchema } from "~/modules/evaluations/evaluation-schema";
import type { AiModelProvider } from "./openai-responses-provider.server";
import { AiProviderError } from "./openai-responses-provider.server";

export const MAX_CONTEXT_CHARACTERS = 60_000;
export const GENERATION_LEASE_SECONDS = 5 * 60;
export const USAGE_WINDOW_SECONDS = 24 * 60 * 60;
export const ASSIGNMENT_PROVIDER_CALL_LIMIT_PER_24_HOURS = 3;
export const ORGANISATION_PROVIDER_CALL_LIMIT_PER_24_HOURS = 100;

export const generatedSuggestionSchema = z
  .object({ criteria: reviewerAiCriterionSuggestionsSchema })
  .strict();

export const generationInputSchema = z
  .object({
    assignmentId: z.string().trim().min(1).max(200),
    retryFailedOperationId: z.string().trim().min(1).max(200).optional(),
    duplicateRiskAcknowledged: z.literal(true).optional(),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      Boolean(input.retryFailedOperationId) !==
      Boolean(input.duplicateRiskAcknowledged)
    ) {
      context.addIssue({
        code: "custom",
        path: ["duplicateRiskAcknowledged"],
        message:
          "Acknowledge the possible duplicate AI request or charge before retrying.",
      });
    }
  });

export type ReviewerAiCriterionSuggestion = z.infer<
  typeof reviewerAiCriterionSuggestionsSchema
>[number];

export type ReviewerAiSuggestion = {
  id: string;
  assignmentId: string;
  status: "offered" | "dismissed" | "imported";
  suggestions: ReviewerAiCriterionSuggestion[];
  provider: "workers_ai" | "openai" | "anthropic";
  model: string;
  providerResponseId: string;
  generatedAt: number;
  stale: boolean;
};

export type ReviewerAiSuggestionRetry = {
  operationId: string;
  providerRequestId: string | null;
  lastError: string;
};

export type SuggestionDependencies = {
  provider?: AiModelProvider;
};

export function invariantGuardStatement(
  env: CloudflareEnvironment,
  failurePredicateSql: string,
  bindings: Array<string | number | null>,
) {
  return env.DB.prepare(
    `SELECT json('reviewer AI invariant failed')
       WHERE ${failurePredicateSql}`,
  ).bind(...bindings);
}

export function isInvariantGuardError(error: unknown) {
  return error instanceof Error && /malformed JSON/u.test(error.message);
}

export type Criterion = {
  id: string;
  name: string;
  description: string | null;
  inputType: "scale_5" | "scale_10" | "yes_no" | "free_text" | "dropdown";
  options: string[];
  weightPercent: number;
  required: boolean;
  position: number;
};

export function parseSuggestions(
  raw: string,
  suggestionId: string,
): ReviewerAiCriterionSuggestion[] {
  try {
    return reviewerAiCriterionSuggestionsSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(
      `Reviewer AI suggestion ${suggestionId} has invalid persisted content.`,
      { cause: error },
    );
  }
}

export function allowedValues(criterion: Criterion) {
  if (criterion.inputType === "scale_5") return ["1", "2", "3", "4", "5"];
  if (criterion.inputType === "scale_10")
    return Array.from({ length: 10 }, (_, index) => String(index + 1));
  if (criterion.inputType === "yes_no") return ["yes", "no"];
  if (criterion.inputType === "dropdown") return criterion.options;
  return [];
}

export function validateGeneratedSuggestions(
  raw: unknown,
  criteria: Criterion[],
  evidenceFieldIds: string[],
) {
  const parsed = generatedSuggestionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AiProviderError(
      "The AI provider returned reviewer suggestions that do not match the required criterion contract.",
    );
  }
  const criterionById = new Map(
    criteria.map((criterion) => [criterion.id, criterion]),
  );
  const returnedIds = parsed.data.criteria.map((item) => item.criterionId);
  if (
    new Set(returnedIds).size !== returnedIds.length ||
    returnedIds.length !== criteria.length ||
    criteria.some((criterion) => !returnedIds.includes(criterion.id))
  ) {
    throw new AiProviderError(
      "The AI provider returned an incomplete or duplicate reviewer criterion list.",
    );
  }
  const knownEvidence = new Set(evidenceFieldIds);
  for (const item of parsed.data.criteria) {
    const criterion = requireValue(
      criterionById.get(item.criterionId),
      "Required criterionById.get(item.criterionId) is unavailable.",
    );
    if (
      new Set(item.evidenceFieldIds).size !== item.evidenceFieldIds.length ||
      item.evidenceFieldIds.some((id) => !knownEvidence.has(id))
    ) {
      throw new AiProviderError(
        "The AI provider referenced an unknown or duplicate submission evidence field.",
      );
    }
    if (criterion.inputType === "free_text") {
      if (item.suggestedValue !== null) {
        throw new AiProviderError(
          "The AI provider attempted to write a free-text review response.",
        );
      }
    } else if (
      item.suggestedValue === null ||
      !allowedValues(criterion).includes(item.suggestedValue)
    ) {
      throw new AiProviderError(
        `The AI provider returned an invalid value for criterion ${criterion.id}.`,
      );
    }
  }
  return parsed.data.criteria;
}

export function suggestionTextFormat(
  criteria: Criterion[],
  evidenceFieldIds: string[],
) {
  return {
    name: "program_cue_reviewer_suggestions",
    description:
      "Assignment-specific advisory criterion suggestions grounded in immutable Program Cue evidence.",
    schema: {
      type: "object",
      properties: {
        criteria: {
          type: "array",
          minItems: criteria.length,
          maxItems: criteria.length,
          items: {
            type: "object",
            properties: {
              criterionId: {
                type: "string",
                enum: criteria.map(({ id }) => id),
              },
              suggestedValue: { type: ["string", "null"] },
              rationale: { type: "string", minLength: 20, maxLength: 800 },
              evidenceFieldIds: {
                type: "array",
                maxItems: 20,
                items: { type: "string", enum: evidenceFieldIds },
              },
            },
            required: [
              "criterionId",
              "suggestedValue",
              "rationale",
              "evidenceFieldIds",
            ],
            additionalProperties: false,
          },
        },
      },
      required: ["criteria"],
      additionalProperties: false,
    },
  } as const;
}
