import { z } from "zod";

export const DEFAULT_RECOMMENDATION_CHOICES = [
  { id: "accept", label: "Accept" },
  { id: "minor_changes", label: "Minor" },
  { id: "conditional_accept", label: "Conditional" },
  { id: "waitlist", label: "Waitlist" },
  { id: "reject", label: "Reject" },
] as const;

export const recommendationChoiceSchema = z
  .object({
    id: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .refine((id) => id !== "mixed", {
        message: 'Recommendation choice identifier "mixed" is reserved.',
      }),
    label: z
      .string()
      .trim()
      .min(1, "Recommendation label is required.")
      .max(120),
  })
  .strict();

export const recommendationChoicesSchema = z
  .array(recommendationChoiceSchema)
  .min(2, "Add at least two recommendation choices.")
  .max(7, "Use no more than seven recommendation choices.")
  .superRefine((choices, context) => {
    const ids = choices.map((choice) => choice.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({
        code: "custom",
        message: "Recommendation choice identifiers must be unique.",
      });
    }
    const labels = choices.map((choice) => choice.label.toLowerCase());
    if (new Set(labels).size !== labels.length) {
      context.addIssue({
        code: "custom",
        message: "Recommendation choice labels must be unique.",
      });
    }
  });

export type RecommendationChoice = z.infer<typeof recommendationChoiceSchema>;

export function defaultRecommendationChoices(): RecommendationChoice[] {
  return DEFAULT_RECOMMENDATION_CHOICES.map((choice) => ({ ...choice }));
}

export function parseRecommendationChoicesJson(
  value: string,
  owner: string,
): RecommendationChoice[] {
  try {
    return recommendationChoicesSchema.parse(JSON.parse(value));
  } catch {
    throw new Error(`${owner} has invalid persisted recommendation choices.`);
  }
}

export function recommendationChoiceLabel(
  choices: readonly RecommendationChoice[],
  choiceId: string | null,
) {
  if (choiceId === null) return null;
  const choice = choices.find((candidate) => candidate.id === choiceId);
  if (!choice) {
    throw new Error(
      `Recommendation choice ${choiceId} is missing from its historical snapshot.`,
    );
  }
  return choice.label;
}
