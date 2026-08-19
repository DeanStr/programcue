import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  type EvaluationAdminModel,
  EvaluationAdminModelContext,
} from "./evaluation-admin-model";
import { EvaluationModerationPanel } from "./evaluation-moderation-panel";

describe("evaluation moderation reviewer outcomes", () => {
  it("renders the configured recommendation label instead of its stable ID", () => {
    const activeRound = { id: "round-a", name: "Initial review" };
    const model = {
      loaderData: {
        submissions: [
          {
            id: "submission-a",
            title: "A proposal",
            status: "in_review",
            reviewableInCurrentCycle: true,
          },
        ],
        moderations: [],
      },
      activeRound,
      activeRoundAssignments: [
        {
          id: "assignment-a",
          submissionId: "submission-a",
          evaluatorName: "A reviewer",
          teamName: null,
          status: "submitted",
          reviewStatus: "submitted",
          weightedScore: 4,
          recommendation: "strong_accept",
          recommendationLabel: "Strong accept",
          conflictNotes: null,
        },
      ],
      setModerationSubmissionId: () => undefined,
      setReopenAssignmentId: () => undefined,
    } as unknown as EvaluationAdminModel;

    const markup = renderToStaticMarkup(
      <EvaluationAdminModelContext.Provider value={model}>
        <EvaluationModerationPanel />
      </EvaluationAdminModelContext.Provider>,
    );

    expect(markup).toContain("Strong accept");
    expect(markup).not.toContain("strong_accept");
  });
});
