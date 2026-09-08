import { describe, expect, it } from "vitest";

import { defaultRecommendationChoices } from "./evaluation-recommendation-choices";
import {
  calculateRubricWeightedScore,
  calculateWeightedScore,
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

  it("uses exact relative weights and normalises mixed scales before rounding", () => {
    const criteria = [
      { id: "originality", weightPercent: 2 },
      { id: "relevance", weightPercent: 1 },
    ];
    expect(
      calculateWeightedScore(criteria, { originality: 4, relevance: 2 }),
    ).toBe(3.33);
    expect(
      calculateWeightedScore(
        criteria.map((c) => ({ ...c, weightPercent: c.weightPercent * 10 })),
        { originality: 4, relevance: 2 },
      ),
    ).toBe(3.33);
    expect(
      calculateRubricWeightedScore(
        [
          { id: "originality", weightPercent: 2, inputType: "scale_10" },
          { id: "relevance", weightPercent: 1, inputType: "scale_5" },
        ],
        { originality: 8, relevance: 2 },
      ),
    ).toBe(3.33);
  });

  it.each([0, -1, 0.5, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects invalid scored weight %s",
    (weightPercent) => {
      expect(() =>
        calculateWeightedScore([{ id: "quality", weightPercent }], {
          quality: 4,
        }),
      ).toThrow(/weights/);
    },
  );

  it("rejects an empty scored rubric", () => {
    expect(() => calculateWeightedScore([], {})).toThrow(/weights/);
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

  it("accepts a positive rubric total other than 100", () => {
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
            recommendationChoices: defaultRecommendationChoices(),
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
    ).not.toThrow();
  });

  it("requires recommendation choices instead of silently applying defaults", () => {
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
                weightPercent: 100,
                required: true,
                position: 0,
              },
            ],
          },
        ],
      }),
    ).toThrow(/recommendationChoices/);
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

  it("accepts odd 1-10 scores that become half-points on the five-point scale", () => {
    expect(
      calculateRubricWeightedScore(
        [
          { id: "fit", inputType: "scale_10", weightPercent: 50 },
          { id: "quality", inputType: "scale_5", weightPercent: 50 },
        ],
        { fit: 7, quality: 4 },
      ),
    ).toBe(3.75);
    expect(
      calculateRubricWeightedScore(
        [{ id: "fit", inputType: "scale_10", weightPercent: 100 }],
        { fit: 1 },
      ),
    ).toBe(0.5);
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
            recommendationChoices: defaultRecommendationChoices(),
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
            recommendationChoices: defaultRecommendationChoices(),
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
