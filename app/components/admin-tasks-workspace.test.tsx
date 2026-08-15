import { renderToStaticMarkup } from "react-dom/server";
import { createMemoryRouter, RouterProvider } from "react-router";
import { describe, expect, it } from "vitest";

import type { AdminTasksData } from "~/routes/admin-tasks";
import { AdminTasksWorkspace } from "./admin-tasks-workspace";

function taskData(overrides: Partial<AdminTasksData> = {}) {
  return {
    eventTimezone: "UTC",
    eventTarget: { id: "event-1", name: "Evaluation summit" },
    templates: [
      {
        id: "template-1",
        name: "Upload slides",
        description: "Upload the final deck.",
        targetType: "speaker",
        taskType: "file_upload",
        impact: "critical",
        evidenceMode: "file",
        dueAnchor: "fixed",
        dueOffsetMinutes: null,
        fixedDueAt: 1_800_000_000,
        autoAssignOnAcceptance: 0,
        configurationJson: "{}",
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
  it("renders shareable task filters with the active values selected", () => {
    const markup = renderWorkspace(
      taskData({
        filters: {
          task: "",
          state: "open",
          target: "speaker",
          type: "file_upload",
          impact: "critical",
        },
      }),
    );

    expect(markup).toContain("Filter assigned work");
    expect(markup).toContain('<option value="open" selected="">Incomplete');
    expect(markup).toContain('<option value="speaker" selected="">Speaker');
    expect(markup).toContain(
      '<option value="file_upload" selected="">File upload',
    );
    expect(markup).toContain('<option value="critical" selected="">Critical');
    expect(markup).toContain("Showing 0 of 0 tasks");
    expect(markup).toContain("No assigned work matches these filters");
  });

  it("keeps task-template creation visible when templates already exist", () => {
    const markup = renderWorkspace();

    expect(markup).toContain('<h2 id="create-task-template">');
    expect(markup).toContain("Create task template");
    expect(markup).toContain('name="dueAnchor"');
    expect(markup).toContain('name="dependencyIds"');
    expect(markup).toContain('name="assignIntentId" value="assign-intent-1"');
    expect(markup).toContain("Priya Shah · priya@example.test");
    expect(markup).not.toMatch(
      /<details[^>]*>\s*<summary>\s*<strong>Create task template/u,
    );
  });
});
