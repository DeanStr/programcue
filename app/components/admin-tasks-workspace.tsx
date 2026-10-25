import { AlertTriangle, CheckCircle2, ListFilter } from "lucide-react";
import { Form, Link, useLocation, useNavigate } from "react-router";
import { AdminAssignedTasksPanel } from "~/components/admin-assigned-tasks-panel";
import { AdminTaskPlanPanel } from "~/components/admin-task-plan-panel";
import {
  TaskCompletionUndoControl,
  type TaskCompletionUndoNotice,
} from "~/components/task-completion-undo-control";
import { AdminWorkspaceTabs } from "~/components/ui/admin-workspace-tabs";
import { Button, ButtonLink } from "~/components/ui/button";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { ReadinessWeightingCard } from "~/components/ui/readiness-weighting";
import {
  type TaskTemplateDraftValues,
  taskTargetTypeLabel,
  taskTypeLabel,
} from "~/modules/tasks/task-schema";
import type { AdminTasksData, TaskWorkspaceView } from "~/routes/admin-tasks";

const TASK_FILTER_KEYS = ["task", "state", "impact", "target", "type", "owner"];

const TASK_QUICK_FILTERS = [
  { label: "Outstanding", state: "open", count: "open" },
  { label: "Overdue", state: "overdue", count: "overdue" },
  { label: "Needs review", state: "submitted", count: "submitted" },
  { label: "Blocked", state: "blocked", count: "blocked" },
  { label: "All", state: "", count: "all" },
] as const;

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
      if (key !== "state" && !search.get(key)) search.delete(key);
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
        </div>
        <div className="page-actions">
          <ButtonLink to="/admin/tasks/deliverables">
            Speaker deliverables
          </ButtonLink>
          <ButtonLink to="/admin/tasks/bulk">Bulk task actions</ButtonLink>
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
        <div className="tasks-quick-choices">
          {/* Each count is the number of rows its filter shows under the
              other active filters, so no separate stats line repeats them. */}
          <nav className="pc-filter-chips" aria-label="Task state">
            {TASK_QUICK_FILTERS.map((choice) => {
              const search = new URLSearchParams(location.search);
              search.set("state", choice.state);
              search.delete("task");
              search.delete("view");
              return (
                <Link
                  key={choice.label}
                  aria-current={
                    data.filters.state === choice.state ? "page" : undefined
                  }
                  preventScrollReset
                  to={`/admin/tasks?${search.toString()}`}
                >
                  {choice.label}
                  <span className="pc-filter-chip-count">
                    {data.quickFilterCounts[choice.count]}
                  </span>
                </Link>
              );
            })}
          </nav>
          <details className="tasks-filters">
            <summary>
              <ListFilter aria-hidden size={14} /> Filters
              {[
                data.filters.owner,
                data.filters.target,
                data.filters.type,
                data.filters.impact,
                data.filters.task,
                !["", "open", "overdue", "submitted", "blocked"].includes(
                  data.filters.state,
                ),
              ].filter(Boolean).length > 0
                ? " · Active"
                : ""}
            </summary>
            <Form
              method="get"
              className="grid grid-5"
              key={data.filterSignature}
            >
              <input type="hidden" name="view" value="assigned" />
              {data.filters.task ? (
                <input type="hidden" name="task" value={data.filters.task} />
              ) : null}
              <label className="label">
                Status
                <select
                  className="select"
                  name="state"
                  defaultValue={data.filters.state}
                >
                  <option value="">All statuses</option>
                  <option value="open">Outstanding</option>
                  <option value="not_started">Not started</option>
                  <option value="in_progress">In progress</option>
                  <option value="blocked">Blocked</option>
                  <option value="submitted">Needs review</option>
                  <option value="completed">Completed</option>
                  <option value="waived">Waived</option>
                  <option value="overdue">Overdue</option>
                  <option value="due_soon">Due in 7 days</option>
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
                  <option value="non_critical">High, medium or low</option>
                </select>
              </label>
              <label className="label">
                Owner
                <select
                  className="select"
                  name="owner"
                  defaultValue={data.filters.owner}
                >
                  <option value="">All owners</option>
                  <option value="participant">Participants</option>
                </select>
              </label>
              <div className="page-actions" style={{ alignItems: "end" }}>
                <Button type="submit">Apply filters</Button>
                <ButtonLink variant="ghost" to="/admin/tasks">
                  Clear
                </ButtonLink>
              </div>
            </Form>
          </details>
          <a className="tasks-readiness-link" href="#readiness-weighting">
            <strong>{data.taskSummary.readiness}%</strong> event readiness
          </a>
        </div>
        <AdminAssignedTasksPanel data={data} busy={busy} />
        <details className="tasks-readiness-more mt" id="readiness-weighting">
          <summary>How task readiness is calculated</summary>
          <ReadinessWeightingCard />
        </details>
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
            <span className="pc-count">{activeTemplateCount} active</span>
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
                      <td data-label="Scope">
                        {taskTargetTypeLabel(template.targetType)}
                      </td>
                      <td data-label="Type">
                        {taskTypeLabel(template.taskType)}
                      </td>
                      <td data-label="Assignment">
                        {template.autoAssignOnAcceptance
                          ? "On acceptance"
                          : "Manual"}
                      </td>
                      <td data-label="Status">
                        <DomainStatusBadge
                          domain="content"
                          status={template.status}
                        />
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
