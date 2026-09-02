import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";

import {
  type EvaluationAdminModel,
  EvaluationAdminModelContext,
} from "./evaluation-admin-model";
import { EvaluationSessionQueue } from "./evaluation-session-queue";

const round = {
  id: "round-final",
  name: "Final review",
  status: "active",
  reviewers: [
    { personId: "person-assigned" },
    { personId: "person-available" },
  ],
};
const session = {
  id: "session-one",
  title: "Opening keynote",
  reference: "SESSION-001",
  format: "keynote",
  durationMinutes: 45,
  trackName: "Main stage",
  status: "confirmed",
  completedReviewCount: 1,
  assignmentCount: 1,
  averageScore: 4.5,
};
const assignment = {
  id: "assignment-one",
  roundId: round.id,
  targetType: "session",
  submissionId: null,
  sessionId: session.id,
  targetTitle: session.title,
  evaluatorPersonId: "person-assigned",
  evaluatorName: "Jordan Lee",
  status: "submitted",
  reviewStatus: "submitted",
  weightedScore: 4.5,
};

function renderQueue(selectedAssignment = assignment) {
  const value = {
    loaderData: {
      sessions: [session],
      assignments: [selectedAssignment],
      teams: [
        {
          id: "team-one",
          name: "Review team",
          members: [
            { personId: "person-assigned", authorised: true },
            { personId: "person-available", authorised: true },
          ],
        },
      ],
      focusedSessionId: null,
      resultsRoundId: round.id,
      resultSort: "score_desc",
      reviewFilter: null,
    },
    activeRound: round,
    activeRoundAssignments: [selectedAssignment],
    assignmentTargets: [
      {
        value: "team:team-one",
        label: "Review team (2)",
        kind: "Teams",
      },
      {
        value: "person:person-assigned",
        label: "Jordan Lee",
        kind: "Individuals",
      },
      {
        value: "person:person-available",
        label: "Sam Rivera",
        kind: "Individuals",
      },
    ],
    setReopenAssignmentId: vi.fn(),
  } as unknown as EvaluationAdminModel;
  const router = createMemoryRouter(
    [
      {
        path: "/admin/review",
        element: (
          <EvaluationAdminModelContext.Provider value={value}>
            <EvaluationSessionQueue />
          </EvaluationAdminModelContext.Provider>
        ),
      },
    ],
    { initialEntries: ["/admin/review"] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("session reviewer assignments", () => {
  it("shows active assignments inline and removes assigned targets", () => {
    const markup = renderQueue();

    expect(markup).toContain("Assigned reviewers · Final review");
    expect(markup).toContain("Jordan Lee</strong> · Submitted · 4.50 / 5");
    expect(markup).toContain("Reopen review");
    expect(markup).toContain("Add another reviewer");
    expect(markup).toContain("Review team (1)");
    expect(markup).toContain('value="person:person-available"');
    expect(markup).not.toContain('value="person:person-assigned"');
    expect(markup).not.toContain("Active-round session reviews");
  });

  it("does not render a returned assignment's abandoned draft score", () => {
    const markup = renderQueue({
      ...assignment,
      status: "recused",
      reviewStatus: "draft",
      weightedScore: 1.25,
    });

    expect(markup).toContain("Jordan Lee</strong> · Recused");
    expect(markup).not.toContain("1.25 / 5");
    expect(markup).not.toContain("Reopen review");
  });
});
