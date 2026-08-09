export type WeightedCriterion = {
  id: string;
  weightPercent: number;
};

export function calculateWeightedScore(
  criteria: ReadonlyArray<WeightedCriterion>,
  scores: Readonly<Record<string, number>>,
) {
  const totalWeight = criteria.reduce((sum, criterion) => sum + criterion.weightPercent, 0);
  if (criteria.length === 0 || totalWeight !== 100) {
    throw new Error("Evaluation criteria must exist and total 100%.");
  }
  const missing = criteria.filter((criterion) => !Number.isInteger(scores[criterion.id]) || scores[criterion.id] < 1 || scores[criterion.id] > 5);
  if (missing.length) {
    throw new Error(`Every criterion needs a whole-number score from 1 to 5. Missing: ${missing.map((item) => item.id).join(", ")}.`);
  }
  const score = criteria.reduce(
    (sum, criterion) => sum + scores[criterion.id] * criterion.weightPercent / 100,
    0,
  );
  return Number(score.toFixed(2));
}
