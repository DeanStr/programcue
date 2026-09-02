import { z } from "zod";

import { requireValue } from "~/lib/required-value";
import { parseRecommendationChoicesJson } from "./evaluation-recommendation-choices";

const historicalEvidenceIdSchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value.trim() === value, "must not have outer whitespace");
const historicalReviewScoresSchema = z.record(
  historicalEvidenceIdSchema,
  z.union([z.string(), z.number(), z.boolean()]),
);
const historicalReviewContentSchema = z.object({
  recommendation: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
  submitterFeedback: z.string().optional(),
  privateNotes: z.string().optional(),
  reopenReason: z.string().optional(),
});
const historicalCriteriaSchema = z
  .array(
    z.object({
      id: historicalEvidenceIdSchema,
      name: z
        .string()
        .min(1)
        .max(500)
        .refine(
          (value) => value.trim() === value,
          "must not have outer whitespace",
        ),
    }),
  )
  .min(1);

function parseRevisionEvidence<T>(
  revisionId: string,
  field: string,
  raw: string,
  schema: z.ZodType<T>,
) {
  try {
    return schema.parse(JSON.parse(raw));
  } catch {
    throw new Error(
      `Review revision ${revisionId} contains invalid ${field} evidence.`,
    );
  }
}

export function parseHistoricalReviewRevision(input: {
  id: string;
  scoresJson: string;
  contentJson: string;
  scorecardId: string | null;
  scorecardVersion: number | null;
  criteriaSnapshotJson: string | null;
  recommendationChoicesSnapshotJson: string;
}) {
  const scores = parseRevisionEvidence(
    input.id,
    "scores",
    input.scoresJson,
    historicalReviewScoresSchema,
  );
  const content = parseRevisionEvidence(
    input.id,
    "content",
    input.contentJson,
    historicalReviewContentSchema,
  );
  const recommendationChoices = parseRecommendationChoicesJson(
    input.recommendationChoicesSnapshotJson,
    `Review revision ${input.id}`,
  );
  const recommendationLabel = content.recommendation
    ? recommendationChoices.find(
        (choice) => choice.id === content.recommendation,
      )?.label
    : null;
  if (content.recommendation && !recommendationLabel) {
    throw new Error(
      `Review revision ${input.id} contains an invalid recommendation.`,
    );
  }
  const evidencePresence = [
    input.scorecardId !== null,
    input.scorecardVersion !== null,
    input.criteriaSnapshotJson !== null,
  ];
  if (evidencePresence.some(Boolean) && !evidencePresence.every(Boolean)) {
    throw new Error(
      `Review revision ${input.id} contains incomplete scorecard evidence.`,
    );
  }
  if (!evidencePresence.some(Boolean)) {
    return {
      scores,
      content,
      criteria: null,
      recommendationChoices,
      recommendationLabel,
    };
  }
  if (
    !historicalEvidenceIdSchema.safeParse(input.scorecardId).success ||
    !Number.isInteger(input.scorecardVersion) ||
    requireValue(
      input.scorecardVersion,
      "Required input.scorecardVersion is unavailable.",
    ) < 1
  ) {
    throw new Error(
      `Review revision ${input.id} contains invalid scorecard identity evidence.`,
    );
  }
  const criteria = parseRevisionEvidence(
    input.id,
    "criteria",
    requireValue(
      input.criteriaSnapshotJson,
      "Required input.criteriaSnapshotJson is unavailable.",
    ),
    historicalCriteriaSchema,
  );
  const criterionIds = criteria.map((criterion) => criterion.id);
  if (new Set(criterionIds).size !== criterionIds.length) {
    throw new Error(
      `Review revision ${input.id} contains duplicate criterion evidence.`,
    );
  }
  const knownCriteria = new Set(criterionIds);
  const missingCriterion = Object.keys(scores).find(
    (criterionId) => !knownCriteria.has(criterionId),
  );
  if (missingCriterion) {
    throw new Error(
      `Review revision ${input.id} contains a score without matching criterion evidence.`,
    );
  }
  return {
    scores,
    content,
    criteria,
    recommendationChoices,
    recommendationLabel,
  };
}
