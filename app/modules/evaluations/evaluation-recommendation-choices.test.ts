import { describe, expect, it } from "vitest";

import {
  defaultRecommendationChoices,
  parseRecommendationChoicesJson,
  recommendationChoiceLabel,
  recommendationChoicesSchema,
} from "./evaluation-recommendation-choices";

describe("evaluation recommendation choices", () => {
  it("preserves stable IDs and configured order", () => {
    const choices = recommendationChoicesSchema.parse([
      { id: "strong_accept", label: "Strong accept" },
      { id: "discuss", label: "Discuss" },
      { id: "decline", label: "Decline" },
    ]);

    expect(choices.map((choice) => choice.id)).toEqual([
      "strong_accept",
      "discuss",
      "decline",
    ]);
    expect(recommendationChoiceLabel(choices, "discuss")).toBe("Discuss");
  });

  it("requires 2–7 choices with unique IDs and case-insensitive labels", () => {
    expect(
      recommendationChoicesSchema.safeParse([
        { id: "one", label: "Discuss" },
        { id: "two", label: "discuss" },
      ]).success,
    ).toBe(false);
    expect(
      recommendationChoicesSchema.safeParse([
        { id: "same", label: "One" },
        { id: "same", label: "Two" },
      ]).success,
    ).toBe(false);
    expect(
      recommendationChoicesSchema.safeParse([{ id: "one", label: "One" }])
        .success,
    ).toBe(false);
  });

  it("fails explicitly for corrupt persisted choices", () => {
    expect(() => parseRecommendationChoicesJson("{}", "Round test")).toThrow(
      "Round test has invalid persisted recommendation choices",
    );
    expect(() =>
      recommendationChoiceLabel(defaultRecommendationChoices(), "unknown"),
    ).toThrow("missing from its historical snapshot");
  });
});
