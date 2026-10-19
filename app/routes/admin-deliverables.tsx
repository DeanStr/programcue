import { data, Form, Link, redirect, useNavigation } from "react-router";
import { ZodError, z } from "zod";
import { Button, ButtonLink } from "~/components/ui/button";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EventDateTime } from "~/components/ui/event-date-time";
import { CommunicationDraftService } from "~/modules/communications/communication-draft-service.server";
import {
  CommunicationService,
  CommunicationStateError,
} from "~/modules/communications/communication-service.server";
import { sourceVariables } from "~/modules/communications/communication-service-shared";
import { namedRecipient } from "~/modules/communications/manual-recipients";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  buildDeliverables,
  deliverableComplete,
  deliverableOverdue,
  deliverablesFilterSchema,
} from "~/modules/tasks/deliverables";
import {
  TaskService,
  TaskStateError,
} from "~/modules/tasks/task-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/admin-deliverables";
import "~/styles/deliverables.css";

export const meta = () => [{ title: "Speaker deliverables · Program Cue" }];

async function workspaceFor(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const search = new URL(request.url).searchParams;
  for (const key of ["q", "template", "state", "page", "columns"]) {
    if (search.getAll(key).length > 1)
      throw new Response("Invalid deliverables filters", { status: 400 });
  }
  const parsed = deliverablesFilterSchema.safeParse(Object.fromEntries(search));
  if (!parsed.success)
    throw new Response("Invalid deliverables filters", { status: 400 });
  const workspace = await new TaskService(env).getAdminWorkspace(viewer);
  const now = Math.floor(Date.now() / 1000);
  const matrix = buildDeliverables(workspace, parsed.data, now);
  if (parsed.data.template && !matrix.columns.length)
    throw new Response("Task template not found in this event", {
      status: 404,
    });
  return { env, viewer, workspace, filters: parsed.data, matrix, now };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer, workspace, filters, matrix, now } = await workspaceFor(
    request,
    context,
  );
  const centre = await new CommunicationService(env).listCentre(viewer);
  const templates = centre.templates.filter(
    (template) =>
      template.versionStatus === "published" &&
      template.category === "task_reminder" &&
      sourceVariables(template).length === 0,
  );
  const pages = Math.max(1, Math.ceil(matrix.rows.length / 25));
  const columnPages = Math.max(1, Math.ceil(matrix.columns.length / 10));
  if (filters.page > pages || filters.columns > columnPages)
    throw new Response("Deliverables page not found", { status: 404 });
  return {
    filters,
    now,
    timezone: workspace.eventTimezone,
    templates,
    allColumns: matrix.allColumns,
    columns: matrix.columns.slice(
      (filters.columns - 1) * 10,
      filters.columns * 10,
    ),
    rows: matrix.rows.slice((filters.page - 1) * 25, filters.page * 25),
    total: matrix.rows.length,
    pages,
    columnPages,
    recipientCount: matrix.recipients.length,
    draftId: crypto.randomUUID(),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST")
    throw new Response("Method not allowed", { status: 405 });
  const { env, viewer, matrix } = await workspaceFor(request, context);
  const form = await request.formData();
  try {
    if (form.get("intent") === "extend") {
      const result = await new TaskService(env).extendSpeakerDeadline(viewer, {
        taskId: form.get("taskId"),
        revision: form.get("revision"),
        dueDate: form.get("dueDate"),
        reason: form.get("reason"),
      });
      const warning = await recordRouteChange(env, viewer, {
        entityType: "task",
        entityId: result.taskId,
        changeType: "updated",
      });
      if (warning) return data(warning, { status: 207 });
      return data({
        message: result.webhookWarning ?? "Deadline extended.",
        ok: !result.webhookWarning,
      });
    }
    if (form.get("intent") !== "reminder")
      return data(
        { ok: false, message: "Unsupported action." },
        { status: 400 },
      );
    if (!matrix.recipients.length)
      throw new TaskStateError(
        "No speakers in these filters have actionable outstanding work.",
      );
    const service = new CommunicationService(env);
    const centre = await service.listCentre(viewer);
    const template = centre.templates.find(
      (item) =>
        item.id === form.get("templateVersionId") &&
        item.versionStatus === "published" &&
        item.category === "task_reminder" &&
        sourceVariables(item).length === 0,
    );
    if (!template)
      throw new TaskStateError(
        "Choose a published reminder template without task-specific merge fields.",
      );
    const draftId = z.uuid().parse(form.get("draftId"));
    const draft = await new CommunicationDraftService(env).create(
      viewer,
      {
        templateVersionId: template.id,
        audienceType: "manual",
        kind: "transactional",
        scheduledAt: null,
        manualRecipients: matrix.recipients
          .map((speaker) => namedRecipient(speaker.name, speaker.email))
          .join("\n"),
      },
      { draftId, idempotencyKey: `deliverables:${draftId}` },
    );
    throw redirect(`/admin/communications/compose/${draft.id}`);
  } catch (error) {
    if (
      error instanceof TaskStateError ||
      error instanceof CommunicationStateError ||
      error instanceof ZodError
    )
      return data(
        {
          ok: false,
          message:
            error instanceof ZodError ? error.issues[0].message : error.message,
        },
        { status: 422 },
      );
    throw error;
  }
}

export default function Deliverables({
  loaderData: d,
  actionData,
}: Route.ComponentProps) {
  const busy = useNavigation().state !== "idle";
  const pageUrl = (page: number, columns: number) =>
    `?${new URLSearchParams({ ...d.filters, page: String(page), columns: String(columns) })}`;
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <h1>Speaker deliverables</h1>
          <p>
            Compare personal requirements across the active speaker roster.
            Session and event tasks remain in Tasks & readiness.
          </p>
        </div>
        <ButtonLink to="/admin/tasks">Tasks &amp; readiness</ButtonLink>
      </div>
      {actionData && (
        <p role={actionData.ok ? "status" : "alert"}>{actionData.message}</p>
      )}
      <Form method="get" className="card pad deliverables-filters">
        <label className="label">
          Speaker
          <input className="field" name="q" defaultValue={d.filters.q} />
        </label>
        <label className="label">
          Requirement
          <select
            className="select"
            name="template"
            defaultValue={d.filters.template}
          >
            <option value="">All requirements</option>
            {d.allColumns.map((column) => (
              <option key={column.id} value={column.id}>
                {column.name}
              </option>
            ))}
          </select>
        </label>
        <label className="label">
          Show speakers with
          <select
            className="select"
            name="state"
            defaultValue={d.filters.state}
          >
            <option value="all">Any status</option>
            <option value="outstanding">Outstanding work</option>
            <option value="overdue">Overdue work</option>
            <option value="submitted">Evidence awaiting review</option>
            <option value="complete">Completed work</option>
            <option value="unassigned">Unassigned requirements</option>
          </select>
        </label>
        <Button type="submit" disabled={busy}>
          Apply filters
        </Button>
        <ButtonLink to="/admin/tasks/deliverables">Clear</ButtonLink>
      </Form>
      <section className="card pad mt" aria-label="Remind filtered speakers">
        <h2>Remind speakers</h2>
        <p>
          {d.recipientCount} {d.recipientCount === 1 ? "speaker" : "speakers"}{" "}
          across all matching pages {d.recipientCount === 1 ? "has" : "have"}{" "}
          actionable outstanding work. Submitted evidence awaiting organiser
          review is excluded.
        </p>
        {d.templates.length ? (
          <Form method="post" className="deliverables-filters">
            <input type="hidden" name="intent" value="reminder" />
            <input type="hidden" name="draftId" value={d.draftId} />
            <label className="label">
              Reminder template
              <select className="select" name="templateVersionId">
                {d.templates.map((template) => (
                  <option key={template.id} value={template.id}>
                    {template.name}
                  </option>
                ))}
              </select>
            </label>
            <Button type="submit" disabled={busy || !d.recipientCount}>
              Prepare reminder
            </Button>
            <p className="help">
              Creates an editable draft for the current filtered recipients.
              Review the exact recipients and message before sending.
            </p>
          </Form>
        ) : (
          <p>
            Publish a task reminder template using recipient and event fields to
            prepare a filtered reminder.{" "}
            <Link to="/admin/communications">Open Communications</Link>
          </p>
        )}
      </section>
      <p className="mt">
        {d.total} {d.total === 1 ? "speaker" : "speakers"} · Speaker page{" "}
        {d.filters.page} of {d.pages} · Requirement page {d.filters.columns} of{" "}
        {d.columnPages}. Cells retain all statuses for each matching speaker.
      </p>
      <section
        className="table-wrap deliverables-matrix"
        aria-label="Speaker deliverables matrix"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: Keyboard users must be able to scroll the matrix.
        tabIndex={0}
      >
        <table className="data-table">
          <thead>
            <tr>
              <th scope="col">Speaker</th>
              {d.columns.map((column) => (
                <th key={column.id} scope="col">
                  {column.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {d.rows.map((speaker) => (
              <tr key={speaker.id}>
                <th scope="row">
                  <Link to={`/admin/speakers/${speaker.id}`}>
                    {speaker.name}
                  </Link>
                </th>
                {d.columns.map((column) => {
                  const tasks =
                    speaker.cells.find((cell) => cell.columnId === column.id)
                      ?.tasks ?? [];
                  return (
                    <td key={column.id}>
                      {tasks.length ? (
                        tasks.map((task) => (
                          <div key={task.id} className="deliverable-cell">
                            <Link
                              to={`/admin/tasks?task=${encodeURIComponent(task.id)}&state=`}
                            >
                              {task.title}
                            </Link>
                            <DomainStatusBadge
                              domain="task"
                              status={task.status}
                            />
                            {deliverableOverdue(task, d.now) && (
                              <strong>Overdue</strong>
                            )}
                            {task.dueAt && (
                              <EventDateTime
                                epochSeconds={task.dueAt}
                                timeZone={d.timezone}
                              />
                            )}
                            {task.evidence.length > 0 && (
                              <Link
                                to={`/admin/tasks?task=${encodeURIComponent(task.id)}&state=`}
                              >
                                Review evidence ({task.evidence.length})
                              </Link>
                            )}
                            {!deliverableComplete(task) &&
                              task.dueAt !== null && (
                                <details>
                                  <summary>Extend deadline</summary>
                                  <Form method="post">
                                    <input
                                      type="hidden"
                                      name="intent"
                                      value="extend"
                                    />
                                    <input
                                      type="hidden"
                                      name="taskId"
                                      value={task.id}
                                    />
                                    <input
                                      type="hidden"
                                      name="revision"
                                      value={task.revision}
                                    />
                                    <label className="label">
                                      New deadline
                                      <input
                                        className="field"
                                        type="date"
                                        name="dueDate"
                                        required
                                      />
                                    </label>
                                    <label className="label">
                                      Reason
                                      <input
                                        className="field"
                                        name="reason"
                                        minLength={5}
                                        maxLength={1000}
                                        required
                                      />
                                    </label>
                                    <Button type="submit" disabled={busy}>
                                      Save extension
                                    </Button>
                                  </Form>
                                </details>
                              )}
                          </div>
                        ))
                      ) : (
                        <span className="subtle">Not assigned</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
            {!d.rows.length && (
              <tr>
                <td colSpan={d.columns.length + 1}>
                  No speakers match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
      <nav className="page-actions mt" aria-label="Deliverables pages">
        {d.filters.page > 1 && (
          <ButtonLink to={pageUrl(d.filters.page - 1, d.filters.columns)}>
            Previous speakers
          </ButtonLink>
        )}
        {d.filters.page < d.pages && (
          <ButtonLink to={pageUrl(d.filters.page + 1, d.filters.columns)}>
            Next speakers
          </ButtonLink>
        )}
        {d.filters.columns > 1 && (
          <ButtonLink to={pageUrl(d.filters.page, d.filters.columns - 1)}>
            Previous requirements
          </ButtonLink>
        )}
        {d.filters.columns < d.columnPages && (
          <ButtonLink to={pageUrl(d.filters.page, d.filters.columns + 1)}>
            Next requirements
          </ButtonLink>
        )}
      </nav>
    </>
  );
}
