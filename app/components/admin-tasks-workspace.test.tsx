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
});
