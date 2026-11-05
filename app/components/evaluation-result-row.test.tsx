import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import {
  type EvaluationAdminModel,
  EvaluationAdminModelContext,
} from "./evaluation-admin-model";
import { EvaluationResultRow } from "./evaluation-result-row";

const proposal = {
  targetType: "proposal",
  id: "submission-one",
  reference: "PROP-001",
  title: "Designing calmer events",
  state: "assigned",
  assignmentCount: 1,
  completedReviewCount: 1,
  averageScore: 4,
  minimumScore: 4,
  maximumScore: 4,
  recusedCount: 0,
  recommendations: {},
  reviews: [],
  moderation: null,
  aiAssessment: null,
  // Results shows a later round, so the earlier release is not listed here.
  decisionHistory: [],
  incomplete: false,
  mixedRecommendations: false,
  decisionReady: true,
};

function renderRow(
  state: string,
  reopenableDecision: { decision: string } | null = null,
) {
  const value = {
    loaderData: {
      resultRecommendationChoices: [],
      resultCriterionNames: {},
      eventTimezone: "Australia/Melbourne",
      canAssessAiAdvisories: false,
      canManageEvaluationAccess: true,
      submissions: [{ id: proposal.id, reopenableDecision }],
    },
    setDecisionId: vi.fn(),
    setNoReviewOverrideConfirmed: vi.fn(),
    setModerationSubmissionId: vi.fn(),
    setReopenDecisionId: vi.fn(),
  } as unknown as EvaluationAdminModel;
  const result = { ...proposal, state } as Parameters<
    typeof EvaluationResultRow
  >[0]["result"];
  const router = createMemoryRouter(
    [
      {
        path: "/admin/review",
        element: (
          <EvaluationAdminModelContext.Provider value={value}>
            <table>
              <tbody>
                <EvaluationResultRow result={result} />
              </tbody>
            </table>
          </EvaluationAdminModelContext.Provider>
        ),
      },
    ],
    { initialEntries: ["/admin/review"] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("evaluation result row actions", () => {
  it("offers Decide and Moderate before a decision is released", () => {
    const markup = renderRow("assigned");

    expect(markup).toContain(">Decide</button>");
    expect(markup).toContain(">Moderate</button>");
    expect(markup).not.toContain("Change decision");
  });

  it("follows a decision released in another round, not the round's history", () => {
    const waitlisted = renderRow("waitlisted", { decision: "waitlisted" });
    expect(waitlisted).toContain(">Change decision</button>");
    expect(waitlisted).not.toContain(">Decide</button>");
    expect(waitlisted).not.toContain(">Moderate</button>");

    const accepted = renderRow("accepted");
    expect(accepted).toContain(">Final</span>");
    expect(accepted).not.toContain(">Decide</button>");
    expect(accepted).not.toContain(">Moderate</button>");
  });
});
