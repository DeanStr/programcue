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
    filters: {
      owner: "",
      task: "",
      state: "",
      impact: "",
      target: "",
      type: "",
    },
    filterSignature: "all",
    focusedTaskId: null,
    focusedSpeakerId: null,
    totalTaskCount: 0,
    quickFilterCounts: {
      open: 0,
      overdue: 0,
      submitted: 0,
      blocked: 0,
      all: 0,
    },
    taskSummary: { readiness: 100 },
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

  it("does not offer unrelated task templates for a speaker handoff", () => {
    const data = taskData({ focusedSpeakerId: "speaker-1", view: "plans" });
    data.templates = [
      {
        ...data.templates[0]!,
        targetType: "session",
        name: "Session-only template",
      },
    ];
    const markup = renderWorkspace(data);
    expect(markup).toContain("No active speaker task templates are available.");
    expect(
      markup.match(/<select[^>]*name="templateId"[^>]*>(.*?)<\/select>/s)?.[1],
    ).toContain("Choose a task template");
    expect(
      markup.match(/<select[^>]*name="templateId"[^>]*>(.*?)<\/select>/s)?.[1],
    ).not.toContain("Session-only template");
    const assignment = markup.slice(markup.indexOf("tasks-plan-assignment"));
    expect(assignment).toMatch(
      /<button[^>]*disabled=""[^>]*>.*?Assign with prerequisites/s,
    );
  });

  it("keeps event-level metrics truthful when no rows match a filter", () => {
    const markup = renderWorkspace(
      taskData({
        totalTaskCount: 7,
        quickFilterCounts: {
          open: 5,
          overdue: 3,
          submitted: 2,
          blocked: 1,
          all: 7,
        },
        taskSummary: { readiness: 42 },
        filters: {
          task: "",
          state: "waived",
          owner: "",
          target: "",
          type: "",
          impact: "",
        },
      }),
    );

    expect(markup).toContain("Filters · Active");
    expect(markup).toContain("<strong>42%</strong> event readiness");
    expect(markup).toMatch(
      /Outstanding<span class="pc-filter-chip-count">5<\/span>/,
    );
    expect(markup).toMatch(/All<span class="pc-filter-chip-count">7<\/span>/);
    expect(markup).not.toContain("<strong>100%</strong> event readiness");
  });

  it("does not offer administrator completion for participant session review", () => {
    const markup = renderWorkspace(
      taskData({
        totalTaskCount: 1,
        tasks: [
          {
            id: "task-session-review",
            templateId: "template-session-review",
            targetType: "session",
            targetId: "session-1",
            targetLabel: "Opening keynote",
            ownerPersonId: null,
            ownerName: null,
            title: "Review session details",
            description: "Confirm the shared session details.",
            taskType: "acknowledgement",
            impact: "high",
            status: "not_started",
            readinessState: "on_track",
            readinessPercent: 0,
            isOverdue: false,
            isSessionDetailsReview: true,
            blockingDependencies: [],
            participantActionable: true,
            readinessRelevant: true,
            revision: 1,
            dueAt: null,
            evidenceJson: null,
            waiverJson: null,
            submittedAt: null,
            completedAt: null,
            completedByPersonId: null,
            lastOperationId: null,
            evidenceMode: "checkbox",
            configurationJson: '{"preset":"session_details_review_v1"}',
            formFields: [],
            evidence: [],
            comments: [],
          },
        ],
      }),
    );

    expect(markup).not.toContain('value="complete"');
    expect(markup).not.toContain('value="approve"');
    expect(markup).toContain('value="waive"');
    expect(markup).toContain('value="comment"');
  });

  it("shows one row decision and keeps secondary task work behind More", () => {
    const task = {
      id: "task-slides",
      templateId: "template-slides",
      targetType: "speaker",
      targetId: "speaker-1",
      targetLabel: "Priya Shah",
      ownerPersonId: "speaker-1",
      ownerName: "Priya Shah",
      title: "Upload presentation slides",
      description: "Upload the final deck.",
      taskType: "file_upload",
      impact: "critical",
      status: "not_started",
      readinessState: "on_track",
      readinessPercent: 0,
      isOverdue: false,
      isSessionDetailsReview: false,
      blockingDependencies: [],
      participantActionable: true,
      readinessRelevant: true,
      revision: 1,
      dueAt: 1_800_000_000,
      evidenceJson: null,
      waiverJson: null,
      submittedAt: null,
      completedAt: null,
      completedByPersonId: null,
      lastOperationId: null,
      evidenceMode: "file",
      configurationJson: "{}",
      formFields: [],
      evidence: [],
      comments: [],
    } as unknown as AdminTasksData["tasks"][number];
    const rowActions = (status: AdminTasksData["tasks"][number]["status"]) => {
      const markup = renderWorkspace(
        taskData({
          now: 1_799_000_000,
          totalTaskCount: 1,
          tasks: [{ ...task, status }],
        }),
      );
      const [visible, more = ""] = markup.split('class="task-more-panel"');
      return { visible, more };
    };

    const open = rowActions("not_started");
    expect(open.visible).toContain('value="complete"');
    expect(open.visible).toContain("Mark complete");
    expect(open.visible).not.toContain('value="waive"');
    expect(open.visible).toContain('aria-expanded="false"');
    expect(open.visible).toContain("More actions");
    expect(open.more).toContain('value="waive"');
    expect(open.more).toContain('value="extend-deadline"');
    expect(open.more).toContain("File upload · Revision");

    const submitted = rowActions("submitted");
    expect(submitted.visible).toContain('value="approve"');
    expect(submitted.visible).not.toContain('value="complete"');

    const completed = rowActions("completed");
    expect(completed.visible).toContain('value="reopen"');
    expect(completed.more).not.toContain('value="waive"');
  });

  it("keeps administrator-only session work visibly active without eligible participants", () => {
    const markup = renderWorkspace(
      taskData({
        totalTaskCount: 1,
        tasks: [
          {
            id: "task-admin-session-closeout",
            templateId: "template-admin-session-closeout",
            targetType: "session",
            targetId: "session-1",
            targetLabel: "Opening keynote",
            ownerPersonId: null,
            ownerName: null,
            title: "Close out cancelled session",
            description: "Complete the remaining organiser work.",
            taskType: "administrator_only",
            impact: "critical",
            status: "not_started",
            readinessState: "blocked",
            readinessPercent: 0,
            isOverdue: false,
            isSessionDetailsReview: false,
            blockingDependencies: [],
            participantActionable: false,
            readinessRelevant: true,
            revision: 1,
            dueAt: null,
            evidenceJson: null,
            waiverJson: null,
            submittedAt: null,
            completedAt: null,
            completedByPersonId: null,
            lastOperationId: null,
            evidenceMode: "none",
            configurationJson: "{}",
            formFields: [],
            evidence: [],
            comments: [],
          },
        ],
      }),
    );

    expect(markup).toContain("Close out cancelled session");
    expect(markup).not.toContain("Inactive — no eligible participant");
    expect(markup).toContain('value="complete"');
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
            isSessionDetailsReview: false,
            blockingDependencies: [],
            participantActionable: true,
            readinessRelevant: true,
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
