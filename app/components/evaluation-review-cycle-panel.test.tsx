import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { EvaluationReviewCyclePanel } from "./evaluation-admin-configuration-panels";
import {
  type EvaluationAdminModel,
  EvaluationAdminModelContext,
} from "./evaluation-admin-model";

function renderPanel(runningAssessmentOperationCount: number) {
  const model = {
    loaderData: {
      plan: {
        id: "current-plan",
        revision: 4,
        name: "Programme review",
        rounds: [
          {
            id: "initial-round",
            roundNumber: 1,
            name: "Initial review",
            scorecardVersion: 1,
            criteria: [
              {
                id: "criterion-original",
                name: "Original rubric",
                description: "Superseded initial criterion",
                inputType: "scale_5",
                weightPercent: 100,
                required: true,
              },
            ],
          },
          {
            id: "final-round",
            roundNumber: 2,
            name: "Final review",
            scorecardVersion: 3,
            criteria: [
              {
                id: "criterion-relevance",
                name: "Relevance",
                description: "Fit for this event and audience",
                inputType: "scale_5",
                weightPercent: 100,
                required: true,
              },
            ],
          },
        ],
      },
      reviewCyclePreview: {
        unfinishedAssignmentCount: 2,
        unfinishedReviewCount: 1,
        runningAssessmentOperationCount,
      },
      canManageEvaluationAccess: true,
      eventTimezone: "UTC",
    },
    navigation: { state: "idle" },
  } as unknown as EvaluationAdminModel;
  const router = createMemoryRouter(
    [
      {
        path: "/admin/review",
        element: (
          <EvaluationAdminModelContext.Provider value={model}>
            <EvaluationReviewCyclePanel />
          </EvaluationAdminModelContext.Provider>
        ),
      },
    ],
    { initialEntries: ["/admin/review"] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("evaluation review-cycle controls", () => {
  it("explains running AI work and disables the consequential action", () => {
    const markup = renderPanel(2);
    const startButton = markup.match(
      /<button[^>]*>Review and start new cycle<\/button>/u,
    )?.[0];

    expect(markup).toContain("Wait for 2 AI review assessments");
    expect(markup).toContain(
      'name="expectedRunningAssessmentOperationCount" value="2"',
    );
    expect(markup).toContain(
      "Prefilled from Round 2 — Final review · Scorecard v3",
    );
    expect(markup).toContain('value="Relevance"');
    expect(markup).not.toContain('value="Original rubric"');
    expect(startButton).toContain("disabled");
  });

  it("enables review-cycle confirmation when no AI assessment is running", () => {
    const markup = renderPanel(0);
    const startButton = markup.match(
      /<button[^>]*>Review and start new cycle<\/button>/u,
    )?.[0];

    expect(markup).not.toContain("Wait for");
    expect(startButton).not.toContain("disabled");
  });
});
