export type WeightedCriterion = {
  id: string;
  weightPercent: number;
  inputType?: "scale_5" | "scale_10";
};

export function calculateWeightedScore(
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
  const score = criteria.reduce(
    (sum, criterion) =>
      sum + (scores[criterion.id] * criterion.weightPercent) / 100,
    0,
  );
  return Number(score.toFixed(2));
}

/* The final score is gated on a complete rubric, which is correct: no round
   stores a partial total. But a reviewer scoring criterion three still needs to
   know what criteria one and two put into it, and that is an exact fact per row
   rather than a projected total. Contributions are reported as they are earned;
   the total stays gated. */
export function rubricContributions(
  criteria: ReadonlyArray<WeightedCriterion>,
  responses: Readonly<Record<string, unknown>>,
) {
  let weightScored = 0;
  const perCriterion = new Map<string, number>();
  for (const criterion of criteria) {
    const raw = responses[criterion.id];
    if (raw === undefined || (typeof raw === "string" && !raw.trim())) continue;
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
    const normalised = maximum === 10 ? numeric / 2 : numeric;
    const contribution = (normalised * criterion.weightPercent) / 100;
    perCriterion.set(criterion.id, Number(contribution.toFixed(2)));
    weightScored += criterion.weightPercent;
  }
  return {
    perCriterion,
    weightScored,
  };
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
  return calculateWeightedScore(criteria, normalisedScores);
}
