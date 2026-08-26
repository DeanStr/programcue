import {
  AlertTriangle,
  CheckCircle2,
  ListChecks,
  ListFilter,
} from "lucide-react";
import { Form, Link } from "react-router";

import { AdminAssignedTasksPanel } from "~/components/admin-assigned-tasks-panel";
import { AdminTaskPlanPanel } from "~/components/admin-task-plan-panel";
import {
  TaskCompletionUndoControl,
  type TaskCompletionUndoNotice,
} from "~/components/task-completion-undo-control";
import { Button, ButtonLink } from "~/components/ui/button";
import { ReadinessWeightingCard } from "~/components/ui/readiness-weighting";
import type { TaskTemplateDraftValues } from "~/modules/tasks/task-schema";
import type { AdminTasksData } from "~/routes/admin-tasks";

export function AdminTasksWorkspace({
  data,
  actionNotice,
  busy,
}: {
  data: AdminTasksData;
  actionNotice?: {
    ok: boolean;
    message: string;
    intent?: "create-template";
    committed?: boolean;
    draft?: TaskTemplateDraftValues;
    errors?: Record<string, string[]>;
  } & TaskCompletionUndoNotice;
  busy: boolean;
}) {
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Onboarding operations</span>
          <h1>Tasks &amp; readiness</h1>
          <p>
            Create reusable requirements, preserve dependencies and review
            speaker evidence.
          </p>
        </div>
        <div className="page-actions">
          <ButtonLink variant="primary" to="/admin/tasks/bulk">
            Bulk actions
          </ButtonLink>
        </div>
      </div>
      <section
        className="card tasks-filters mb"
        aria-labelledby="task-filters-heading"
      >
        <div className="card-title">
          <h2 id="task-filters-heading">Filter assigned work</h2>
          <span className="help right">
            <ListFilter aria-hidden size={14} /> Shareable URL filters
          </span>
        </div>
        <Form method="get" className="grid grid-5" key={data.filterSignature}>
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
      {actionNotice ? (
        <div
          className={`pc-status-notice ${actionNotice.ok ? "is-success" : "is-danger"} mb`}
          role={actionNotice.ok ? "status" : "alert"}
        >
          {actionNotice.ok ? (
            <CheckCircle2 aria-hidden size={18} />
          ) : (
            <AlertTriangle aria-hidden size={18} />
          )}
          <div className="pc-status-notice-copy">
            <strong>{actionNotice.ok ? "Saved" : "Action needed"}</strong>
            <div>{actionNotice.message}</div>
            <TaskCompletionUndoControl notice={actionNotice} />
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
      <div className="tasks-layout tasks-board">
        <AdminAssignedTasksPanel data={data} busy={busy} />
        <div className="tasks-rail tasks-side" id="readiness-weighting">
          <details className="card pad tasks-plan-more">
            <summary>Plan and onboarding</summary>
            <ReadinessWeightingCard />
            <AdminTaskPlanPanel
              data={data}
              busy={busy}
              actionNotice={actionNotice}
              mode="plan"
            />
          </details>
          <details className="card pad tasks-plan-more">
            <summary>Create a template</summary>
            <AdminTaskPlanPanel
              data={data}
              busy={busy}
              actionNotice={actionNotice}
              mode="create"
            />
          </details>
        </div>
      </div>
    </>
  );
}
