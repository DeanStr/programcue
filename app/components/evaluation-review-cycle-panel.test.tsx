import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { EvaluationReviewCyclePanel } from "./evaluation-admin-configuration-panels";
import {
  EvaluationAdminModelContext,
  type EvaluationAdminModel,
} from "./evaluation-admin-model";

function renderPanel(runningAssessmentOperationCount: number) {
  const model = {
    loaderData: {
      plan: {
        id: "current-plan",
        revision: 4,
        name: "Programme review",
        rounds: [],
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
