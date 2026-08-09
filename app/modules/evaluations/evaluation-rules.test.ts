import { describe, expect, it } from "vitest";

import { calculateWeightedScore } from "./evaluation-rules";
import { evaluationPlanSchema, reviewDraftSchema } from "./evaluation-schema";

describe("evaluation rules", () => {
  it("calculates a weighted score without rounding intermediate values", () => {
    expect(calculateWeightedScore([
      { id: "relevance", weightPercent: 25 },
      { id: "quality", weightPercent: 75 },
    ], { relevance: 3, quality: 5 })).toBe(4.5);
  });

  it("rejects incomplete score records", () => {
    expect(() => calculateWeightedScore([
      { id: "relevance", weightPercent: 50 },
      { id: "quality", weightPercent: 50 },
    ], { relevance: 4 })).toThrow(/quality/);
  });

  it("requires each rubric to total 100 percent", () => {
    expect(() => evaluationPlanSchema.parse({
      revision: 0,
      name: "Programme review",
      status: "draft",
      rounds: [{
        id: "round-one",
        name: "Initial review",
        anonymous: false,
        criteria: [{ id: "quality", name: "Quality", description: "", weightPercent: 80, position: 0 }],
      }],
    })).toThrow(/100%/);
  });

  it("does not submit an incomplete review", () => {
    expect(() => reviewDraftSchema.parse({
      assignmentId: "assignment-1",
      revision: 0,
      scores: { relevance: 4 },
      recommendation: null,
      confidence: null,
      submitterFeedback: "",
      privateNotes: "",
      intent: "submit",
    })).toThrow(/recommendation/);
  });
});
