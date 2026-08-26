import {
  AlertTriangle,
  CheckCircle2,
  ListChecks,
  ListFilter,
} from "lucide-react";
import { Form, Link, useLocation, useNavigate } from "react-router";

import { AdminAssignedTasksPanel } from "~/components/admin-assigned-tasks-panel";
import { AdminTaskPlanPanel } from "~/components/admin-task-plan-panel";
import {
  TaskCompletionUndoControl,
  type TaskCompletionUndoNotice,
} from "~/components/task-completion-undo-control";
import { AdminWorkspaceTabs } from "~/components/ui/admin-workspace-tabs";
import { Button, ButtonLink } from "~/components/ui/button";
import { ReadinessWeightingCard } from "~/components/ui/readiness-weighting";
import type { TaskTemplateDraftValues } from "~/modules/tasks/task-schema";
import type { AdminTasksData, TaskWorkspaceView } from "~/routes/admin-tasks";

const TASK_FILTER_KEYS = ["task", "state", "impact", "target", "type"];

const TASK_WORKSPACE_PANELS = [
  { id: "assigned", label: "Assigned work" },
  { id: "plans", label: "Plans & onboarding" },
  { id: "templates", label: "Templates" },
] as const;

type AdminTasksActionNotice = {
  ok: boolean;
  message: string;
  intent?: "create-template";
  committed?: boolean;
  draft?: TaskTemplateDraftValues;
  errors?: Record<string, string[]>;
} & TaskCompletionUndoNotice;

function TaskActionNotice({ notice }: { notice?: AdminTasksActionNotice }) {
  if (!notice) return null;
  return (
    <div
      className={`pc-status-notice ${notice.ok ? "is-success" : "is-danger"} mb`}
      role={notice.ok ? "status" : "alert"}
    >
      {notice.ok ? (
        <CheckCircle2 aria-hidden size={18} />
      ) : (
        <AlertTriangle aria-hidden size={18} />
      )}
      <div className="pc-status-notice-copy">
        <strong>{notice.ok ? "Saved" : "Action needed"}</strong>
        <div>{notice.message}</div>
        <TaskCompletionUndoControl notice={notice} />
      </div>
    </div>
  );
}

export function AdminTasksWorkspace({
  data,
  actionNotice,
  busy,
}: {
  data: AdminTasksData;
  actionNotice?: AdminTasksActionNotice;
  busy: boolean;
}) {
  const location = useLocation();
  const navigate = useNavigate();
  const activeTemplateCount = data.templates.filter(
    (template) => template.status === "active",
  ).length;

  function showWorkspaceView(view: TaskWorkspaceView) {
    const search = new URLSearchParams(location.search);
    for (const key of TASK_FILTER_KEYS) {
      if (!search.get(key)) search.delete(key);
    }
    if (view === "assigned") search.delete("view");
    else search.set("view", view);
    void navigate(
      {
        pathname: location.pathname,
        search: search.toString() ? `?${search.toString()}` : "",
        hash: "",
      },
      { preventScrollReset: true },
    );
  }

  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <h1>Tasks &amp; readiness</h1>
          <p>
            Manage assigned work, onboarding plans and reusable task templates.
          </p>
        </div>
        <div className="page-actions">
          <ButtonLink variant="primary" to="/admin/tasks/bulk">
            Bulk actions
          </ButtonLink>
        </div>
      </div>
      <AdminWorkspaceTabs<TaskWorkspaceView>
        className="tasks-workspace-tabs"
        label="Task workspace views"
        panels={TASK_WORKSPACE_PANELS.map((panel) => ({
          ...panel,
          meta:
            panel.id === "assigned"
              ? data.totalTaskCount
              : panel.id === "templates"
                ? activeTemplateCount
                : undefined,
        }))}
        activePanel={data.view}
        onChange={showWorkspaceView}
      />
      <TaskActionNotice notice={actionNotice} />

      <section
        className="tasks-workspace-panel"
        aria-label="Assigned work"
        hidden={data.view !== "assigned"}
      >
        <section
          className="card tasks-filters mb"
          aria-labelledby="task-filters-heading"
        >
          <div className="card-title">
            <h3 id="task-filters-heading">Filter assigned work</h3>
            <span className="help right">
              <ListFilter aria-hidden size={14} /> Shareable URL filters
            </span>
          </div>
          <Form method="get" className="grid grid-5" key={data.filterSignature}>
            <input type="hidden" name="view" value="assigned" />
            <label className="label">
              Status
              <select
                className="select"
                name="state"
                defaultValue={data.filters.state}
              >
                <option value="">All statuses</option>
                <option value="open">Incomplete</option>
                <option value="not_started">Not started</option>
                <option value="in_progress">In progress</option>
                <option value="blocked">Blocked</option>
                <option value="submitted">Awaiting review</option>
                <option value="completed">Completed</option>
                <option value="waived">Waived</option>
                <option value="overdue">Overdue</option>
              </select>
            </label>
            <label className="label">
              Scope
              <select
                className="select"
                name="target"
                defaultValue={data.filters.target}
              >
                <option value="">All scopes</option>
                <option value="speaker">Speaker</option>
                <option value="session">Session</option>
                <option value="event">Event</option>
              </select>
            </label>
            <label className="label">
              Task type
              <select
                className="select"
                name="type"
                defaultValue={data.filters.type}
              >
                <option value="">All task types</option>
                <option value="checklist">Checklist</option>
                <option value="acknowledgement">Acknowledgement</option>
                <option value="short_form">Short form</option>
                <option value="file_upload">File upload</option>
                <option value="link_visit">Link visit</option>
                <option value="administrator_only">Administrator only</option>
              </select>
            </label>
            <label className="label">
              Impact
              <select
                className="select"
                name="impact"
                defaultValue={data.filters.impact}
              >
                <option value="">All impacts</option>
                <option value="critical">Critical</option>
                <option value="high">High</option>
                <option value="medium">Medium</option>
                <option value="low">Low</option>
              </select>
            </label>
            <div className="page-actions" style={{ alignItems: "end" }}>
              <Button type="submit">Apply filters</Button>
              <ButtonLink to="/admin/tasks">Clear</ButtonLink>
            </div>
          </Form>
        </section>
        {Object.values(data.filters).some(Boolean) ? (
          <div className="pc-status-notice is-info mb" role="status">
            <ListChecks aria-hidden size={18} />
            <div className="pc-status-notice-copy">
              <strong>Filtered task records</strong>
              <div>
                Showing {data.tasks.length} of {data.totalTaskCount} tasks.{" "}
                <Link to="/admin/tasks">Clear filters</Link>
              </div>
            </div>
          </div>
        ) : null}
        <div className="card tasks-summary mb">
          <section className="metric">
            <div className="label">Readiness</div>
            <div className="value">{data.taskSummary.readiness}%</div>
            <a className="metric-note" href="#readiness-weighting">
              Impact-weighted
            </a>
          </section>
          <section className="metric">
            <div className="label">Outstanding</div>
            <div className="value">{data.taskSummary.outstanding}</div>
          </section>
          {data.taskSummary.evidenceReview > 0 ? (
            <section className="metric">
              <div className="label">Evidence review</div>
              <div className="value">{data.taskSummary.evidenceReview}</div>
            </section>
          ) : null}
          {data.taskSummary.blocked > 0 ? (
            <section className="metric">
              <div className="label">Blocked</div>
              <div className="value">{data.taskSummary.blocked}</div>
            </section>
          ) : null}
          {data.taskSummary.overdue > 0 ? (
            <section className="metric">
              <div className="label">Overdue</div>
              <div className="value">{data.taskSummary.overdue}</div>
            </section>
          ) : null}
        </div>
        <details className="tasks-readiness-more mb" id="readiness-weighting">
          <summary>How task readiness is calculated</summary>
          <ReadinessWeightingCard />
        </details>
        <AdminAssignedTasksPanel data={data} busy={busy} />
      </section>

      <section
        className="tasks-workspace-panel"
        aria-label="Plans & onboarding"
        hidden={data.view !== "plans"}
      >
        <AdminTaskPlanPanel
          data={data}
          busy={busy}
          actionNotice={actionNotice}
          mode="plan"
        />
      </section>

      <section
        className="tasks-workspace-panel"
        aria-label="Templates"
        hidden={data.view !== "templates"}
      >
        <section className="card pad tasks-template-inventory">
          <div className="card-title">
            <h3>Existing templates</h3>
            <span className="status info">{activeTemplateCount} active</span>
          </div>
          {data.templates.length ? (
            <div className="table-wrap">
              <table className="data-table pc-responsive-table">
                <thead>
                  <tr>
                    <th scope="col">Template</th>
                    <th scope="col">Scope</th>
                    <th scope="col">Type</th>
                    <th scope="col">Assignment</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.templates.map((template) => (
                    <tr key={template.id}>
                      <th scope="row" data-label="Template">
                        {template.name}
                      </th>
                      <td data-label="Scope">{template.targetType}</td>
                      <td data-label="Type">
                        {template.taskType.replaceAll("_", " ")}
                      </td>
                      <td data-label="Assignment">
                        {template.autoAssignOnAcceptance
                          ? "On acceptance"
                          : "Manual"}
                      </td>
                      <td data-label="Status">
                        <span
                          className={`status ${template.status === "active" ? "success" : "neutral"}`}
                        >
                          {template.status}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="subtle">No templates have been created.</p>
          )}
        </section>
        <AdminTaskPlanPanel
          data={data}
          busy={busy}
          actionNotice={actionNotice}
          mode="create"
        />
      </section>
    </>
  );
}
