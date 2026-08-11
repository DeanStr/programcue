import {
  AlertTriangle,
  CheckCircle2,
  ListChecks,
  ShieldCheck,
} from "lucide-react";
import { Link } from "react-router";

import { AdminAssignedTasksPanel } from "~/components/admin-assigned-tasks-panel";
import { AdminTaskPlanPanel } from "~/components/admin-task-plan-panel";
import {
  TaskCompletionUndoControl,
  type TaskCompletionUndoNotice,
} from "~/components/task-completion-undo-control";
import type { AdminTasksData } from "~/routes/admin-tasks";

export function AdminTasksWorkspace({
  data,
  actionNotice,
  busy,
}: {
  data: AdminTasksData;
  actionNotice?: { ok: boolean; message: string } & TaskCompletionUndoNotice;
  busy: boolean;
}) {
  const overdue = data.tasks.filter((task) => task.isOverdue).length;
  const blocked = data.tasks.filter((task) => task.status === "blocked").length;
  const submitted = data.tasks.filter(
    (task) => task.status === "submitted",
  ).length;
  const complete = data.tasks.filter((task) =>
    ["completed", "waived"].includes(task.status),
  ).length;
  const readiness = data.tasks.length
    ? Math.round((complete / data.tasks.length) * 100)
    : 100;

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
          <Link className="btn" to="/admin/tasks/bulk">
            Bulk actions
          </Link>
          <span className="status info">
            <ShieldCheck aria-hidden size={14} /> Server authorised
          </span>
        </div>
      </div>
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
      <div className="grid grid-5 mb">
        <section className="card metric">
          <div className="label">Readiness</div>
          <div className="value">{readiness}%</div>
        </section>
        <section className="card metric">
          <div className="label">Outstanding</div>
          <div className="value">{data.tasks.length - complete}</div>
        </section>
        <section className="card metric">
          <div className="label">Evidence review</div>
          <div className="value">{submitted}</div>
        </section>
        <section className="card metric">
          <div className="label">Blocked</div>
          <div className="value">{blocked}</div>
        </section>
        <section className="card metric">
          <div className="label">Overdue</div>
          <div className="value">{overdue}</div>
        </section>
      </div>
      <div className="tasks-layout">
        <AdminAssignedTasksPanel data={data} busy={busy} />
        <AdminTaskPlanPanel data={data} busy={busy} />
      </div>
    </>
  );
}
