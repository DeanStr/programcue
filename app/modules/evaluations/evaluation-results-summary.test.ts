import { describe, expect, it } from "vitest";
import { summarizeEvaluationReviewTargets } from "./evaluation-results-summary";

describe("evaluation review target summary", () => {
  it("reports proposal and session counts from the supplied result projection", () => {
    expect(
      summarizeEvaluationReviewTargets([
        { targetType: "proposal" },
        { targetType: "session" },
        { targetType: "session" },
      ]),
    ).toEqual({ total: 3, proposals: 1, sessions: 2 });
  });
});
