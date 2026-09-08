import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it, vi } from "vitest";
import {
  type EvaluationAdminModel,
  EvaluationAdminModelContext,
} from "./evaluation-admin-model";
import { EvaluationSubmissionQueue } from "./evaluation-admin-queue-panels";

const round = {
  id: "round-one",
  name: "Initial review",
  revision: 3,
  scorecardId: "scorecard-one",
  scorecardVersion: 2,
  status: "active",
};

const submission = {
  id: "submission-one",
  title: "Resilient operations",
  reference: "PC-001",
  category: "Operations",
  speakers: [],
  routedTeamName: null,
  status: "under_review",
  reviewableInCurrentCycle: true,
  assignmentCount: 1,
  completedReviewCount: 0,
  averageScore: null,
  aiAssessmentGenerationIntent: "generation-retry",
};

const failedAttempt = {
  status: "failed",
  operationId: "failed-operation",
  roundId: round.id,
  submissionId: submission.id,
  roundRevision: round.revision,
  scorecardId: round.scorecardId,
  scorecardVersion: round.scorecardVersion,
  provider: "workers_ai",
  providerLabel: "Workers AI",
  model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
  retryOfOperationId: null,
  lastError: "The provider request failed.",
  providerRequestId: "provider-failure",
  failedAt: 1_786_620_000,
};

function model(input: {
  navigation: EvaluationAdminModel["navigation"];
  attempts: unknown[];
}) {
  return {
    loaderData: {
      plan: { id: "plan-one", revision: 1, rounds: [round] },
      resultsRoundId: round.id,
      aiReviewAssessments: [],
      aiReviewAssessmentGenerationAttempts: input.attempts,
      aiReviewAssessmentsSupported: true,
      canManageAiAssessments: true,
      aiAssessmentProvider: {
        providerLabel: "OpenAI",
        model: "fixture-model",
        destination: "https://ai.example.com",
        configuration: "fixture-configuration",
      },
      aiAssessmentProviderProblem: null,
      eventTimezone: "UTC",
      resultSort: "score_desc",
      resultsExportIntent: "export-one",
      unassignedOnly: false,
      submissions: [submission],
      assignments: [],
      teams: [],
    },
    navigation: input.navigation,
    activeRound: null,
    activeRoundAssignments: [],
    assignmentTargets: [],
    bulkAssignableSubmissions: [],
    setDecisionId: vi.fn(),
    setNoReviewOverrideConfirmed: vi.fn(),
    setBulkAssignOpen: vi.fn(),
    setBulkAssignPreview: vi.fn(),
    setBulkAssignmentTarget: vi.fn(),
    setBulkSubmissionIds: vi.fn(),
  } as unknown as EvaluationAdminModel;
}

function renderQueue(value: EvaluationAdminModel) {
  const router = createMemoryRouter(
    [
      {
        path: "/admin/review",
        element: (
          <EvaluationAdminModelContext.Provider value={value}>
            <EvaluationSubmissionQueue />
          </EvaluationAdminModelContext.Provider>
        ),
      },
    ],
    { initialEntries: ["/admin/review"] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("AI assessment attempt feedback", () => {
  it("names the provider destination before opening request details", () => {
    const markup = renderQueue(
      model({ navigation: { state: "idle" } as never, attempts: [] }),
    );
    expect(markup).toContain("OpenAI · fixture-model · https://ai.example.com");
    expect(markup).toContain("Opening the request details sends nothing");
    expect(markup).toContain("Review AI request details");
    expect(markup).toContain(
      'name="providerConfiguration" value="fixture-configuration"',
    );
  });

  it("disables a new request when the provider is unavailable", () => {
    const value = model({
      navigation: { state: "idle" } as never,
      attempts: [],
    });
    value.loaderData.aiAssessmentProvider = null;
    value.loaderData.aiAssessmentProviderProblem =
      "OpenAI credentials are not configured.";
    const markup = renderQueue(value);
    expect(markup).toContain("OpenAI credentials are not configured.");
    expect(markup).toMatch(
      /<button[^>]*disabled[^>]*>Review AI request details<\/button>/,
    );
  });

  it("immediately replaces a failed retry action while its navigation is pending", () => {
    const formData = new FormData();
    formData.set("intent", "retry-ai-review-assessment");
    formData.set("roundId", round.id);
    formData.set("submissionId", submission.id);
    const markup = renderQueue(
      model({
        navigation: { state: "submitting", formData } as never,
        attempts: [failedAttempt],
      }),
    );

    expect(markup).toContain("Starting AI first pass retry");
    expect(markup).toContain("Submitting the request from this page.");
    expect(markup).not.toContain("Review AI retry details");
  });

  it("shows the durable running retry and links to its operation", () => {
    const markup = renderQueue(
      model({
        navigation: { state: "idle" } as never,
        attempts: [
          {
            ...failedAttempt,
            status: "running",
            operationId: "running-operation",
            retryOfOperationId: failedAttempt.operationId,
            requestedByName: "Olivia Bennett",
            startedAt: 1_786_620_000,
            recoveryRequired: false,
            lastError: undefined,
            providerRequestId: undefined,
            failedAt: undefined,
          },
        ],
      }),
    );

    expect(markup).toContain("AI first pass retry running");
    expect(markup).toContain("Started by Olivia Bennett.");
    expect(markup).toContain(
      'href="/admin/operations?operation=running-operation"',
    );
    expect(markup).not.toContain("Review AI retry details");
  });

  it("offers provider-safe reconciliation for a recoverable running attempt", () => {
    const markup = renderQueue(
      model({
        navigation: { state: "idle" } as never,
        attempts: [
          {
            ...failedAttempt,
            status: "running",
            operationId: "expired-operation",
            requestedByName: "Olivia Bennett",
            startedAt: 1_786_620_000,
            recoveryRequired: true,
            lastError: undefined,
            providerRequestId: undefined,
            failedAt: undefined,
          },
        ],
      }),
    );

    expect(markup).toContain("AI attempt needs reconciliation");
    expect(markup).toContain(
      "Reconciliation never sends another provider request.",
    );
    expect(markup).toContain('value="reconcile-ai-review-assessment"');
    expect(markup).toContain('value="expired-operation"');
    expect(markup).toContain("Reconcile AI attempt");
    expect(markup).not.toContain("Review AI retry details");
  });
});
