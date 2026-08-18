export type WeightedCriterion = {
  id: string;
  weightPercent: number;
  inputType?: "scale_5" | "scale_10";
};

function weightedFivePointScore(
  criteria: ReadonlyArray<WeightedCriterion>,
  scores: Readonly<Record<string, number>>,
) {
  const totalWeight = criteria.reduce(
    (sum, criterion) => sum + criterion.weightPercent,
    0,
  );
  if (criteria.length === 0 || totalWeight !== 100) {
    throw new Error("Evaluation criteria must exist and total 100%.");
  }
  const invalid = criteria.filter((criterion) => {
    const score = scores[criterion.id];
    return !Number.isFinite(score) || score < 0.5 || score > 5;
  });
  if (invalid.length) {
    throw new Error(
      `Every criterion needs a five-point contribution from 0.5 to 5. Missing: ${invalid.map((item) => item.id).join(", ")}.`,
    );
  }
  const score = criteria.reduce(
    (sum, criterion) =>
      sum + (scores[criterion.id] * criterion.weightPercent) / 100,
    0,
  );
  return Number(score.toFixed(2));
}

export function calculateWeightedScore(
  criteria: ReadonlyArray<WeightedCriterion>,
  scores: Readonly<Record<string, number>>,
) {
  const missing = criteria.filter(
    (criterion) =>
      !Number.isInteger(scores[criterion.id]) ||
      scores[criterion.id] < 1 ||
      scores[criterion.id] > 5,
  );
  if (missing.length) {
    throw new Error(
      `Every criterion needs a whole-number score from 1 to 5. Missing: ${missing.map((item) => item.id).join(", ")}.`,
    );
  }
  return weightedFivePointScore(criteria, scores);
}

export function calculateRubricWeightedScore(
  criteria: ReadonlyArray<WeightedCriterion>,
  responses: Readonly<Record<string, unknown>>,
) {
  const normalisedScores = Object.fromEntries(
    criteria.map((criterion) => {
      const raw = responses[criterion.id];
      const numeric =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && raw.trim()
            ? Number(raw)
            : Number.NaN;
      const maximum = criterion.inputType === "scale_10" ? 10 : 5;
      if (!Number.isInteger(numeric) || numeric < 1 || numeric > maximum) {
        throw new Error(
          `Criterion ${criterion.id} needs a whole-number score from 1 to ${maximum}.`,
        );
      }
      return [criterion.id, maximum === 10 ? numeric / 2 : numeric];
    }),
  );
  return weightedFivePointScore(criteria, normalisedScores);
}
