import {
  AlertTriangle,
  CheckCircle2,
  GitBranch,
  ListChecks,
  Plus,
  ShieldCheck,
} from "lucide-react";
import { data, Form, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-tasks";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  TaskService,
  TaskStateError,
} from "~/modules/tasks/task-service.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta = () => [{ title: "Tasks & Readiness · Program Cue" }];

async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  await ensureDemoSpeakerData(env);
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  const workspace = await new TaskService(env).getAdminWorkspace(viewer);
  const search = new URL(request.url).searchParams;
  const filters = {
    state: search.get("state") ?? "",
    impact: search.get("impact") ?? "",
    target: search.get("target") ?? "",
    type: search.get("type") ?? "",
  };
  const open = new Set([
    "not_started",
    "in_progress",
    "blocked",
    "submitted",
    "overdue",
  ]);
  const now = Math.floor(Date.now() / 1_000);
  const isOverdue = (task: (typeof workspace.tasks)[number]) =>
    open.has(task.status) &&
    (task.status === "overdue" ||
      task.readinessState === "overdue" ||
      (task.dueAt !== null && task.dueAt < now));
  const tasks = workspace.tasks
    .filter((task) => {
      const stateMatches =
        !filters.state ||
        (filters.state === "open"
          ? open.has(task.status)
          : filters.state === "overdue"
            ? isOverdue(task)
            : task.status === filters.state);
      return (
        stateMatches &&
        (!filters.impact || task.impact === filters.impact) &&
        (!filters.target || task.targetType === filters.target) &&
        (!filters.type || task.taskType === filters.type)
      );
    })
    .map((task) => ({ ...task, isOverdue: isOverdue(task) }));
  return {
    ...workspace,
    tasks,
    filters,
    totalTaskCount: workspace.tasks.length,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const service = new TaskService(env);
  try {
    if (intent === "create-template") {
      const templateId = await service.createTemplate(viewer, {
        name: form.get("name"),
        description: form.get("description"),
        targetType: form.get("targetType"),
        taskType: form.get("taskType"),
        impact: form.get("impact"),
        evidenceMode: form.get("evidenceMode"),
        dueAnchor: form.get("dueAnchor"),
        dueOffsetDays:
          form.get("dueOffsetDays") === "" ? null : form.get("dueOffsetDays"),
        fixedDueDate:
          form.get("fixedDueDate") === "" ? null : form.get("fixedDueDate"),
        dependencyIds: form.getAll("dependencyIds").map(String),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_template",
        entityId: templateId,
        changeType: "created",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({ ok: true, message: "Task template created." });
    }
    if (intent === "assign") {
      const taskId = await service.assignTemplate(
        viewer,
        String(form.get("templateId") ?? ""),
        String(form.get("personId") ?? ""),
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message: "Task plan assigned, including any missing prerequisites.",
      });
    }
    if (["approve", "complete", "waive", "reopen"].includes(intent)) {
      const taskId = String(form.get("taskId") ?? "");
      await service.administerTask(viewer, {
        taskId,
        revision: form.get("revision"),
        intent,
        reason: form.get("reason"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "progress",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message: `Task ${intent === "approve" ? "approved" : intent === "waive" ? "waived" : intent === "reopen" ? "reopened" : "completed"}.`,
      });
    }
    if (intent === "comment") {
      const taskId = String(form.get("taskId") ?? "");
      await service.addComment(
        viewer,
        taskId,
        String(form.get("body") ?? ""),
        form.get("administratorOnly") ? "administrator" : "participant",
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "task_instance",
        entityId: taskId,
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({ ok: true, message: "Comment added." });
    }
    return data(
      { ok: false, message: "Unsupported task action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ZodError) {
      return data(
        {
          ok: false,
          message: error.issues[0]?.message ?? "Review the task details.",
        },
        { status: 422 },
      );
    }
    if (error instanceof TaskStateError) {
      return data({ ok: false, message: error.message }, { status: 409 });
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function taskStatusClass(status: string) {
  if (["completed", "waived"].includes(status)) return "success";
  if (status === "overdue") return "danger";
  if (["blocked", "submitted"].includes(status)) return "warning";
  return "info";
}

function dateLabel(epoch: number | null, timezone: string) {
  return epoch
    ? new Intl.DateTimeFormat("en", {
        month: "short",
        day: "numeric",
        year: "numeric",
        timeZone: timezone,
      }).format(new Date(epoch * 1_000))
    : "No due date";
}

export default function AdminTasks({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const overdue = loaderData.tasks.filter((task) => task.isOverdue).length;
  const blocked = loaderData.tasks.filter(
    (task) => task.status === "blocked",
  ).length;
  const submitted = loaderData.tasks.filter(
    (task) => task.status === "submitted",
  ).length;
  const complete = loaderData.tasks.filter((task) =>
    ["completed", "waived"].includes(task.status),
  ).length;
  const readiness = loaderData.tasks.length
    ? Math.round((complete / loaderData.tasks.length) * 100)
    : 100;
  const assignableTemplates = loaderData.templates.filter(
    (template) =>
      template.targetType === "speaker" && template.status === "active",
  );
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
          <span className="status info">
            <ShieldCheck aria-hidden size={14} /> Server authorised
          </span>
        </div>
      </div>
      {Object.values(loaderData.filters).some(Boolean) ? (
        <div className="pc-status-notice is-info mb" role="status">
          <ListChecks aria-hidden size={18} />
          <div className="pc-status-notice-copy">
            <strong>Filtered task records</strong>
            <div>
              Showing {loaderData.tasks.length} of {loaderData.totalTaskCount}{" "}
              tasks. <a href="/admin/tasks">Clear filters</a>
            </div>
          </div>
        </div>
      ) : null}
      {actionData ? (
        <div
          className={`pc-status-notice ${actionData.ok ? "is-success" : "is-danger"} mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          {actionData.ok ? (
            <CheckCircle2 aria-hidden size={18} />
          ) : (
            <AlertTriangle aria-hidden size={18} />
          )}
          <div className="pc-status-notice-copy">
            <strong>{actionData.ok ? "Saved" : "Action needed"}</strong>
            <div>{actionData.message}</div>
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
          <div className="value">{loaderData.tasks.length - complete}</div>
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
        <section className="card pad">
          <div className="card-title">
            <h2>Assigned work</h2>
            <span className="help right">
              Dependencies refresh before every read
            </span>
          </div>
          <div className="table-wrap pc-responsive-table-wrap">
            <table className="data-table pc-responsive-table">
              <thead>
                <tr>
                  <th scope="col">Requirement</th>
                  <th scope="col">Speaker</th>
                  <th scope="col">Impact</th>
                  <th scope="col">Due ({loaderData.eventTimezone})</th>
                  <th scope="col">Status / evidence</th>
                  <th scope="col">Administrator action</th>
                </tr>
              </thead>
              <tbody>
                {loaderData.tasks.map((task) => (
                  <tr key={task.id}>
                    <td
                      className="pc-record-primary-cell"
                      data-label="Requirement"
                    >
                      <div className="pc-record-stack">
                        <strong>{task.title}</strong>
                        <small className="subtle">
                          Type: {task.taskType.replaceAll("_", " ")}
                        </small>
                        <small className="subtle">
                          Revision {task.revision}
                        </small>
                      </div>
                    </td>
                    <td data-label="Speaker">
                      {task.ownerName ?? task.targetId}
                    </td>
                    <td data-label="Impact">
                      <span className={`impact ${task.impact}`}>
                        {task.impact}
                      </span>
                    </td>
                    <td data-label={`Due (${loaderData.eventTimezone})`}>
                      {dateLabel(task.dueAt, loaderData.eventTimezone)}
                    </td>
                    <td data-label="Status / evidence">
                      <div className="pc-record-stack">
                        <span
                          className={`status ${taskStatusClass(task.status)}`}
                        >
                          {task.status.replaceAll("_", " ")}
                        </span>
                        {task.evidence[0] ? (
                          <div className="pc-record-stack task-evidence-review">
                            <small className="subtle">
                              Latest evidence: {task.evidence[0].status}
                              {task.evidence[0].fileAssetId
                                ? " · private file"
                                : ""}
                            </small>
                            {task.evidence[0].fileAssetId &&
                            task.evidence[0].details.fileVersionId ? (
                              task.evidence[0].downloadAvailable ? (
                                <a
                                  className="btn small"
                                  href={`/admin/tasks/files/${encodeURIComponent(task.evidence[0].fileAssetId)}/${encodeURIComponent(task.evidence[0].details.fileVersionId)}`}
                                >
                                  Download evidence
                                </a>
                              ) : (
                                <small className="subtle">
                                  Download remains unavailable until the exact
                                  submitted version passes scanning.
                                </small>
                              )
                            ) : null}
                            {task.evidence[0].details.text ? (
                              <p>
                                <strong>Response:</strong>{" "}
                                {task.evidence[0].details.text}
                              </p>
                            ) : null}
                            {task.evidence[0].details.url ? (
                              <p>
                                <strong>Submitted link:</strong>{" "}
                                <a
                                  href={task.evidence[0].details.url}
                                  target="_blank"
                                  rel="noreferrer"
                                >
                                  {task.evidence[0].details.url}
                                </a>
                              </p>
                            ) : null}
                            {task.evidence[0].details.confirmed ? (
                              <small>
                                Participant confirmed this requirement.
                              </small>
                            ) : null}
                          </div>
                        ) : null}
                        {task.comments.length ? (
                          <details>
                            <summary>
                              {task.comments.length} message
                              {task.comments.length === 1 ? "" : "s"}
                            </summary>
                            <div className="stack mt">
                              {task.comments.map((comment) => (
                                <blockquote
                                  className="task-comment"
                                  key={comment.id}
                                >
                                  <strong>{comment.authorName}</strong>
                                  {comment.visibility === "administrator" ? (
                                    <small className="subtle">
                                      Administrator only
                                    </small>
                                  ) : null}
                                  <p>{comment.body}</p>
                                </blockquote>
                              ))}
                            </div>
                          </details>
                        ) : null}
                      </div>
                    </td>
                    <td
                      data-label="Administrator action"
                      className="pc-record-action-cell"
                    >
                      <Form method="post" className="task-admin-actions">
                        <input type="hidden" name="taskId" value={task.id} />
                        <input
                          type="hidden"
                          name="revision"
                          value={task.revision}
                        />
                        {task.status === "submitted" ? (
                          <button
                            className="btn small primary"
                            name="intent"
                            value="approve"
                            formNoValidate
                            disabled={navigation.state !== "idle"}
                          >
                            Approve
                          </button>
                        ) : null}
                        {!["completed", "waived", "submitted"].includes(
                          task.status,
                        ) ? (
                          <button
                            className="btn small"
                            name="intent"
                            value="complete"
                            formNoValidate
                            disabled={navigation.state !== "idle"}
                          >
                            Complete
                          </button>
                        ) : ["completed", "waived"].includes(task.status) ? (
                          <button
                            className="btn small"
                            name="intent"
                            value="reopen"
                            formNoValidate
                            disabled={navigation.state !== "idle"}
                          >
                            Reopen
                          </button>
                        ) : null}
                        {!["completed", "waived"].includes(task.status) ? (
                          <details>
                            <summary className="btn small">Waive…</summary>
                            <label className="label">
                              Reason
                              <input
                                className="field"
                                name="reason"
                                minLength={5}
                                required
                              />
                            </label>
                            <button
                              className="btn small danger"
                              name="intent"
                              value="waive"
                              disabled={navigation.state !== "idle"}
                            >
                              Confirm waiver
                            </button>
                          </details>
                        ) : null}
                      </Form>
                      <details className="mt">
                        <summary className="btn small">Comment…</summary>
                        <Form method="post" className="stack mt">
                          <input type="hidden" name="intent" value="comment" />
                          <input type="hidden" name="taskId" value={task.id} />
                          <label className="label">
                            Message
                            <textarea
                              className="textarea"
                              name="body"
                              required
                              maxLength={2_000}
                            />
                          </label>
                          <label className="speaker-confirm">
                            <input type="checkbox" name="administratorOnly" />{" "}
                            Keep this note administrator-only
                          </label>
                          <button
                            className="btn small"
                            disabled={navigation.state !== "idle"}
                          >
                            Send comment
                          </button>
                        </Form>
                      </details>
                    </td>
                  </tr>
                ))}
                {!loaderData.tasks.length ? (
                  <tr className="pc-table-empty-row">
                    <td className="pc-table-empty-cell" colSpan={6}>
                      <div className="pc-empty-state">
                        <ListChecks aria-hidden className="pc-state-icon" />
                        <h2>No matching tasks</h2>
                        <p className="subtle">
                          Clear the filters or assign a task plan.
                        </p>
                      </div>
                    </td>
                  </tr>
                ) : null}
              </tbody>
            </table>
          </div>
        </section>
        <aside className="tasks-side stack">
          <section className="card pad">
            <div className="card-title">
              <h2>Assign a plan</h2>
              <GitBranch aria-hidden className="subtle" size={18} />
            </div>
            <Form method="post" className="stack">
              <input type="hidden" name="intent" value="assign" />
              <label className="label">
                Template
                <select className="select" name="templateId" required>
                  {assignableTemplates.map((template) => (
                    <option value={template.id} key={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="label">
                Speaker
                <select className="select" name="personId" required>
                  {loaderData.speakers.map((speaker) => (
                    <option value={speaker.id} key={speaker.id}>
                      {speaker.name}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="btn primary"
                disabled={
                  !assignableTemplates.length ||
                  !loaderData.speakers.length ||
                  navigation.state !== "idle"
                }
              >
                <Plus aria-hidden size={15} /> Assign with prerequisites
              </button>
            </Form>
          </section>
          <details className="card pad" open={!loaderData.templates.length}>
            <summary>
              <strong>Create task template</strong>
            </summary>
            <Form method="post" className="stack mt">
              <input type="hidden" name="intent" value="create-template" />
              <label className="label">
                Name
                <input className="field" name="name" required />
              </label>
              <label className="label">
                Description
                <textarea className="textarea" name="description" />
              </label>
              <div className="form-row">
                <label className="label">
                  Scope
                  <input type="hidden" name="targetType" value="speaker" />
                  <input className="field" value="Speaker" readOnly />
                </label>
                <label className="label">
                  Type
                  <select
                    className="select"
                    name="taskType"
                    defaultValue="checklist"
                  >
                    <option value="checklist">Checklist</option>
                    <option value="acknowledgement">Acknowledgement</option>
                    <option value="short_form">Short form</option>
                    <option value="file_upload">File upload</option>
                    <option value="link_visit">Link visit</option>
                    <option value="administrator_only">
                      Administrator only
                    </option>
                  </select>
                </label>
              </div>
              <div className="form-row">
                <label className="label">
                  Impact
                  <select
                    className="select"
                    name="impact"
                    defaultValue="medium"
                  >
                    <option value="critical">Critical</option>
                    <option value="high">High</option>
                    <option value="medium">Medium</option>
                    <option value="low">Low</option>
                  </select>
                </label>
                <label className="label">
                  Evidence
                  <select
                    className="select"
                    name="evidenceMode"
                    defaultValue="checkbox"
                  >
                    <option value="none">None</option>
                    <option value="checkbox">Checkbox</option>
                    <option value="file">File</option>
                    <option value="text">Text</option>
                    <option value="link">Link</option>
                    <option value="admin_approval">
                      Administrator approval
                    </option>
                  </select>
                </label>
              </div>
              <label className="label">
                Due date anchor
                <select className="select" name="dueAnchor" defaultValue="none">
                  <option value="none">None</option>
                  <option value="acceptance">Acceptance date</option>
                  <option value="session_start">Session start</option>
                  <option value="fixed">Fixed date</option>
                </select>
              </label>
              <div className="form-row">
                <label className="label">
                  Offset days
                  <input
                    className="field"
                    type="number"
                    name="dueOffsetDays"
                    placeholder="e.g. 14 or -7"
                  />
                </label>
                <label className="label">
                  Fixed due date
                  <input className="field" type="date" name="fixedDueDate" />
                  <span className="help">
                    Ends at 11:59 PM in {loaderData.eventTimezone}.
                  </span>
                </label>
              </div>
              {loaderData.templates.length ? (
                <fieldset>
                  <legend className="label">Prerequisites</legend>
                  <div className="task-dependency-list">
                    {loaderData.templates
                      .filter((template) => template.status === "active")
                      .map((template) => (
                        <label className="speaker-confirm" key={template.id}>
                          <input
                            type="checkbox"
                            name="dependencyIds"
                            value={template.id}
                          />{" "}
                          {template.name}
                        </label>
                      ))}
                  </div>
                </fieldset>
              ) : null}
              <button className="btn primary">
                <Plus aria-hidden size={15} /> Create template
              </button>
            </Form>
          </details>
        </aside>
      </div>
    </>
  );
}
