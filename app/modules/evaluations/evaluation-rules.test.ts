import { describe, expect, it } from "vitest";

import {
  calculateRubricWeightedScore,
  calculateWeightedScore,
  rubricContributions,
} from "./evaluation-rules";
import { evaluationPlanSchema, reviewDraftSchema } from "./evaluation-schema";

describe("evaluation rules", () => {
  it("calculates a weighted score without rounding intermediate values", () => {
    expect(
      calculateWeightedScore(
        [
          { id: "relevance", weightPercent: 25 },
          { id: "quality", weightPercent: 75 },
        ],
        { relevance: 3, quality: 5 },
      ),
    ).toBe(4.5);
  });

  it("rejects incomplete score records", () => {
    expect(() =>
      calculateWeightedScore(
        [
          { id: "relevance", weightPercent: 50 },
          { id: "quality", weightPercent: 50 },
        ],
        { relevance: 4 },
      ),
    ).toThrow(/quality/);
  });

  it("requires each rubric to total 100 percent", () => {
    expect(() =>
      evaluationPlanSchema.parse({
        revision: 0,
        name: "Programme review",
        status: "draft",
        rounds: [
          {
            id: "round-one",
            name: "Initial review",
            anonymous: false,
            criteria: [
              {
                id: "quality",
                name: "Quality",
                description: "",
                inputType: "scale_5",
                weightPercent: 80,
                required: true,
                position: 0,
              },
            ],
          },
        ],
      }),
    ).toThrow(/100%/);
  });

  it("normalises 1-10 criteria onto the common five-point weighted score", () => {
    expect(
      calculateRubricWeightedScore(
        [
          { id: "fit", inputType: "scale_10", weightPercent: 60 },
          { id: "quality", inputType: "scale_5", weightPercent: 40 },
        ],
        { fit: "8", quality: 5 },
      ),
    ).toBe(4.4);
  });

  it("accepts unweighted yes/no and free-text criteria beside a weighted scale", () => {
    expect(() =>
      evaluationPlanSchema.parse({
        revision: 0,
        name: "Mixed rubric",
        status: "draft",
        rounds: [
          {
            id: "round-one",
            name: "Initial review",
            anonymous: false,
            criteria: [
              {
                id: "quality",
                name: "Quality",
                inputType: "scale_5",
                weightPercent: 100,
                required: true,
                position: 0,
              },
              {
                id: "evidence",
                name: "Evidence supplied",
                inputType: "yes_no",
                weightPercent: 0,
                required: true,
                position: 1,
              },
              {
                id: "context",
                name: "Context",
                inputType: "free_text",
                weightPercent: 0,
                required: false,
                position: 2,
              },
            ],
          },
        ],
      }),
    ).not.toThrow();
  });

  it("rejects an optional scored criterion instead of calculating an incomplete weighted result", () => {
    expect(() =>
      evaluationPlanSchema.parse({
        revision: 0,
        name: "Incomplete weighted rubric",
        status: "draft",
        rounds: [
          {
            id: "round-one",
            name: "Initial review",
            anonymous: false,
            criteria: [
              {
                id: "quality",
                name: "Quality",
                inputType: "scale_5",
                weightPercent: 100,
                required: false,
                position: 0,
              },
            ],
          },
        ],
      }),
    ).toThrow(/scored criteria must be required/i);
  });

  it("does not submit an incomplete review", () => {
    expect(() =>
      reviewDraftSchema.parse({
        assignmentId: "assignment-1",
        revision: 0,
        scores: { relevance: 4 },
        recommendation: null,
        confidence: null,
        submitterFeedback: "",
        privateNotes: "",
        conflictAffirmed: true,
        intent: "submit",
      }),
    ).toThrow(/recommendation/);
  });

  it("does not submit a review without a conflict declaration", () => {
    expect(() =>
      reviewDraftSchema.parse({
        assignmentId: "assignment-1",
        revision: 0,
        scores: { relevance: 4 },
        recommendation: "accept",
        confidence: 4,
        submitterFeedback: "",
        privateNotes: "",
        intent: "submit",
      }),
    ).toThrow(/conflict of interest/i);
  });

  it("saves a draft before the conflict question is answered", () => {
    const draft = reviewDraftSchema.parse({
      assignmentId: "assignment-1",
      revision: 0,
      scores: { relevance: 4 },
      recommendation: null,
      confidence: null,
      submitterFeedback: "",
      privateNotes: "",
      intent: "save",
    });
    expect(draft.conflictAffirmed).toBe(false);
  });
});

describe("rubric contributions", () => {
  const criteria = [
    { id: "relevance", weightPercent: 60, inputType: "scale_5" as const },
    { id: "originality", weightPercent: 40, inputType: "scale_5" as const },
  ];

  it("reports what each scored criterion contributes", () => {
    const result = rubricContributions(criteria, { relevance: 4 });
    expect(result.perCriterion.get("relevance")).toBe(2.4);
    expect(result.perCriterion.has("originality")).toBe(false);
    expect(result.weightScored).toBe(60);
  });

  it("reports all rubric weight once every criterion is scored", () => {
    const responses = { relevance: 4, originality: 5 };
    const result = rubricContributions(criteria, responses);
    expect(result.weightScored).toBe(100);
    expect([...result.perCriterion.values()]).toEqual([2.4, 2]);
  });

  it("normalises a ten-point scale the same way the stored total does", () => {
    const tenPoint = [
      { id: "depth", weightPercent: 100, inputType: "scale_10" as const },
    ];
    const result = rubricContributions(tenPoint, { depth: 8 });
    expect(result.perCriterion.get("depth")).toBe(4);
  });

  it("ignores genuinely unscored criteria", () => {
    const result = rubricContributions(criteria, { relevance: "" });
    expect(result.perCriterion.size).toBe(0);
    expect(result.weightScored).toBe(0);
  });

  it("fails on a malformed present score", () => {
    expect(() => rubricContributions(criteria, { relevance: 6 })).toThrow(
      /relevance.*1 to 5/iu,
    );
  });
});
