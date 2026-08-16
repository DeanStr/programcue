import { describe, expect, it } from "vitest";

import { buildUnansweredReviewerAiImport } from "./reviewer-ai-import";

describe("reviewer AI import", () => {
  it("fills only unanswered closed criteria and preserves independent answers", () => {
    expect(
      buildUnansweredReviewerAiImport(
        {
          relevance: "3",
          originality: "",
          notes: "My independent observation.",
        },
        [
          { criterionId: "relevance", suggestedValue: "4" },
          { criterionId: "originality", suggestedValue: "5" },
          { criterionId: "notes", suggestedValue: null },
        ],
      ),
    ).toEqual({
      scores: {
        relevance: "3",
        originality: "5",
        notes: "My independent observation.",
      },
      importedCriterionIds: ["originality"],
    });
  });
});
