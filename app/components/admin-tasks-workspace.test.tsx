import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";
import { suggestedTaskEvidenceMode } from "~/modules/tasks/task-schema";
import type { AdminTasksData } from "~/routes/admin-tasks";
import { AdminTasksWorkspace } from "./admin-tasks-workspace";

function taskData(overrides: Partial<AdminTasksData> = {}) {
  return {
    eventTimezone: "UTC",
    eventTarget: { id: "event-1", name: "Evaluation summit" },
    templates: [
      {
        id: "template-1",
        name: "Upload participant consent form",
        description: "Upload the signed participant document.",
        targetType: "speaker",
        taskType: "file_upload",
        impact: "critical",
        evidenceMode: "file",
        dueAnchor: "fixed",
        dueOffsetMinutes: null,
        fixedDueAt: 1_800_000_000,
        autoAssignOnAcceptance: 0,
        configurationJson: '{"fileScope":"participant_document"}',
        status: "active",
        dependencies: [],
      },
    ],
    tasks: [],
    speakers: [
      {
        id: "speaker-1",
        name: "Priya Shah",
        email: "priya@example.test",
      },
    ],
    sessions: [],
    filters: { task: "", state: "", impact: "", target: "", type: "" },
    filterSignature: "all",
    focusedTaskId: null,
    totalTaskCount: 0,
    taskSummary: {
      readiness: 100,
      outstanding: 0,
      evidenceReview: 0,
      blocked: 0,
      overdue: 0,
    },
    intentId: "intent-1",
    assignIntentId: "assign-intent-1",
    ...overrides,
  } as AdminTasksData;
}

function renderWorkspace(data = taskData()) {
  const router = createMemoryRouter(
    [
      {
        path: "/admin/tasks",
        element: <AdminTasksWorkspace data={data} busy={false} />,
      },
    ],
    { initialEntries: ["/admin/tasks"] },
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("administrator task discoverability", () => {
  it("suggests evidence accepted by each task type", () => {
    expect(suggestedTaskEvidenceMode("administrator_only")).toBe("none");
    expect(suggestedTaskEvidenceMode("file_upload")).toBe("file");
  });

  it("keeps event-level metrics truthful when no rows match a filter", () => {
    const markup = renderWorkspace(
      taskData({
        totalTaskCount: 7,
        taskSummary: {
          readiness: 42,
          outstanding: 5,
          evidenceReview: 2,
          blocked: 1,
          overdue: 3,
        },
        filters: {
          task: "",
          state: "waived",
          target: "",
          type: "",
          impact: "",
        },
      }),
    );

    expect(markup).toContain("Showing 0 of 7 tasks");
    expect(markup).toContain('<div class="value">42%</div>');
    expect(markup).toContain('<div class="value">5</div>');
    expect(markup).not.toContain('<div class="value">100%</div>');
  });

  it("keeps retained legacy URLs visible when newer evidence has no URL", () => {
    const markup = renderWorkspace(
      taskData({
        totalTaskCount: 1,
        tasks: [
          {
            id: "task-legacy-link",
            templateId: "template-legacy-link",
            targetType: "speaker",
            targetId: "speaker-1",
            targetLabel: null,
            ownerPersonId: "speaker-1",
            ownerName: "Priya Shah",
            title: "Review the participant handbook",
            description: null,
            taskType: "link_visit",
            impact: "medium",
            status: "completed",
            readinessState: "on_track",
            readinessPercent: 100,
            isOverdue: false,
            participantActionable: true,
            revision: 3,
            dueAt: null,
            evidenceJson: '{"confirmed":true}',
            waiverJson: null,
            submittedAt: 1_800_000_100,
            completedAt: 1_800_000_100,
            completedByPersonId: "speaker-1",
            lastOperationId: "completion-current",
            evidenceMode: "link",
            configurationJson:
              '{"destinationUrl":"https://organizer.example.test/handbook"}',
            formFields: [],
            evidence: [
              {
                id: "evidence-current",
                taskId: "task-legacy-link",
                fileAssetId: null,
                evidenceJson: '{"confirmed":true}',
                status: "approved",
                createdAt: 1_800_000_100,
                submittedBy: "Priya Shah",
                downloadAvailable: false,
                details: { confirmed: true } as never,
              },
              {
                id: "evidence-legacy",
                taskId: "task-legacy-link",
                fileAssetId: null,
                evidenceJson:
                  '{"url":"https://legacy.example.test/participant-supplied"}',
                status: "approved",
                createdAt: 1_700_000_000,
                submittedBy: "Priya Shah",
                downloadAvailable: false,
                details: {
                  url: "https://legacy.example.test/participant-supplied",
                } as never,
              },
            ],
            comments: [],
          },
        ],
      }),
    );

    expect(markup).toContain("Legacy participant-submitted URL:");
    expect(markup).toContain(
      "https://legacy.example.test/participant-supplied",
    );
  });
});
