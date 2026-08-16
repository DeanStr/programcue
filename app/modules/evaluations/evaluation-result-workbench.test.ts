import { describe, expect, it } from "vitest";

import {
  evaluationResultFlags,
  matchesEvaluationResultPreset,
} from "./evaluation-result-workbench";

const complete = {
  assignmentCount: 2,
  completedReviewCount: 2,
  recusedCount: 0,
  recommendationCounts: { accept: 2 },
  moderationStatus: null,
};

describe("evaluation result workbench rules", () => {
  it("keeps decision readiness transparent and assignment-authoritative", () => {
    expect(evaluationResultFlags(complete)).toEqual({
      mixedRecommendations: false,
      incomplete: false,
      decisionReady: true,
    });
    expect(
      evaluationResultFlags({
        ...complete,
        assignmentCount: 0,
        completedReviewCount: 0,
      }),
    ).toMatchObject({ decisionReady: false, incomplete: false });
    expect(
      evaluationResultFlags({ ...complete, completedReviewCount: 1 }),
    ).toMatchObject({ decisionReady: false, incomplete: true });
    expect(
      evaluationResultFlags({ ...complete, recusedCount: 1 }),
    ).toMatchObject({ decisionReady: false });
    expect(
      evaluationResultFlags({
        ...complete,
        recommendationCounts: { accept: 1, reject: 1 },
      }),
    ).toMatchObject({ decisionReady: false, mixedRecommendations: true });
  });

  it("routes targets into coverage, decision-ready and moderation presets", () => {
    expect(matchesEvaluationResultPreset("decision_ready", complete)).toBe(
      true,
    );
    expect(
      matchesEvaluationResultPreset("coverage", {
        ...complete,
        assignmentCount: 0,
        completedReviewCount: 0,
        recommendationCounts: {},
      }),
    ).toBe(true);
    expect(
      matchesEvaluationResultPreset("moderation", {
        ...complete,
        recommendationCounts: { accept: 1, reject: 1 },
      }),
    ).toBe(true);
    expect(
      matchesEvaluationResultPreset("moderation", {
        ...complete,
        moderationStatus: "draft",
      }),
    ).toBe(true);
  });
});
