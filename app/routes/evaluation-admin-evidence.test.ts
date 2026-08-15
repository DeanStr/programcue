import { describe, expect, it } from "vitest";

import { parseHistoricalReviewRevision } from "./evaluation-admin.server";

const completeEvidence = {
  id: "revision-a",
  scoresJson: JSON.stringify({ relevance: 4 }),
  contentJson: JSON.stringify({ privateNotes: "Chair evidence" }),
  scorecardId: "scorecard-a",
  scorecardVersion: 2,
  criteriaSnapshotJson: JSON.stringify([
    { id: "relevance", name: "Relevance" },
  ]),
};

describe("historical review evidence", () => {
  it("accepts an exact scorecard snapshot and explicit pre-contract evidence", () => {
    expect(parseHistoricalReviewRevision(completeEvidence)).toMatchObject({
      scores: { relevance: 4 },
      criteria: [{ id: "relevance", name: "Relevance" }],
    });
    expect(
      parseHistoricalReviewRevision({
        ...completeEvidence,
        scorecardId: null,
        scorecardVersion: null,
        criteriaSnapshotJson: null,
      }),
    ).toMatchObject({ criteria: null });
  });

  it("rejects partial, duplicate, or mismatched scorecard evidence", () => {
    expect(() =>
      parseHistoricalReviewRevision({
        ...completeEvidence,
        criteriaSnapshotJson: null,
      }),
    ).toThrow("incomplete scorecard evidence");
    expect(() =>
      parseHistoricalReviewRevision({
        ...completeEvidence,
        criteriaSnapshotJson: JSON.stringify([
          { id: "relevance", name: "Relevance" },
          { id: "relevance", name: "Duplicate" },
        ]),
      }),
    ).toThrow("duplicate criterion evidence");
    expect(() =>
      parseHistoricalReviewRevision({
        ...completeEvidence,
        scoresJson: JSON.stringify({ missing: 4 }),
      }),
    ).toThrow("score without matching criterion evidence");
  });
});
