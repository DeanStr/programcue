import { AlertTriangle, ArrowRight, BellRing, ListChecks } from "lucide-react";
import { useState } from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
  useSubmit,
} from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/admin-task-bulk";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { DomainStatusBadge } from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  TaskBulkService,
  TaskBulkStateError,
  type TaskBulkAction,
} from "~/modules/tasks/task-bulk-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  const url = new URL(request.url);
  const operationId = url.searchParams.get("operation") ?? "";
  const service = new TaskBulkService(env);
  const [workspace, operation] = await Promise.all([
    service.workspace(viewer),
    operationId
      ? service.operation(viewer, operationId)
      : Promise.resolve(null),
  ]);
  const notices: Record<string, string> = {
    completed:
      "The confirmed task changes finished and are recorded in event history.",
    "completed-with-warning":
      "The confirmed task changes finished, but one or more outbound task webhooks need a retry in Operations.",
    "partially-failed":
      "Some task changes committed before another record failed revalidation. Inspect the exact result below.",
    "partially-failed-with-warning":
      "Some task changes committed before another record failed revalidation, and one or more outbound task webhooks need a retry in Operations. Inspect the exact result below.",
    cancelled: "The preview was cancelled without changing task records.",
  };
  return {
    workspace,
    operation,
    notice: notices[url.searchParams.get("notice") ?? ""] ?? null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const service = new TaskBulkService(env);
  try {
    if (intent === "preview") {
      const preview = await service.preview(viewer, {
        action: form.get("action"),
        recordIds: form.getAll("recordId"),
        templateId: form.get("templateId"),
        reason: form.get("reason"),
      });
      throw redirect(
        `/admin/tasks/bulk?operation=${encodeURIComponent(preview.operationId)}`,
      );
    }
    const operationId = String(form.get("operationId") ?? "");
    if (!operationId) {
      return data(
        { ok: false as const, message: "Operation id is required." },
        { status: 422 },
      );
    }
    if (intent === "confirm") {
      const result = await service.confirm(viewer, operationId);
      const notice =
        result.status === "completed"
          ? result.webhookWarning
            ? "completed-with-warning"
            : "completed"
          : result.webhookWarning
            ? "partially-failed-with-warning"
            : "partially-failed";
      throw redirect(
        `/admin/tasks/bulk?operation=${encodeURIComponent(operationId)}&notice=${notice}`,
      );
    }
    if (intent === "cancel") {
      await service.cancel(viewer, operationId);
      throw redirect(
        `/admin/tasks/bulk?operation=${encodeURIComponent(operationId)}&notice=cancelled`,
      );
    }
    return data(
      { ok: false as const, message: "Unsupported bulk task action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof ZodError) {
      return data(
        {
          ok: false as const,
          message: error.issues[0]?.message ?? "Review the bulk task settings.",
        },
        { status: 422 },
      );
    }
    if (error instanceof TaskBulkStateError) {
      return data(
        { ok: false as const, message: error.message },
        { status: 409 },
      );
    }
    throw error;
  }
}

export const meta = () => [{ title: "Bulk tasks · Program Cue" }];

function actionDescription(action: TaskBulkAction) {
  if (action === "assign_template") {
    return "Assign one plan to selected speakers, including missing prerequisites.";
  }
  if (action === "waive") {
    return "Apply one explicit, audited waiver reason to selected open tasks.";
  }
  return "Return selected completed or waived tasks to an open state.";
}

export default function AdminTaskBulk({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
  const [bulkAction, setBulkAction] =
    useState<TaskBulkAction>("assign_template");
  const operation = loaderData.operation;
  const canConfirm =
    operation?.status === "received" &&
    operation.summary.changeCount > 0 &&
    operation.summary.invalidCount === 0;
  const candidates =
    bulkAction === "assign_template"
      ? loaderData.workspace.speakers.map((speaker) => ({
          id: speaker.id,
          title: speaker.name,
          detail: speaker.email,
        }))
      : loaderData.workspace.tasks
          .filter((task) =>
            bulkAction === "reopen"
              ? ["completed", "waived"].includes(task.status)
              : !["completed", "waived"].includes(task.status),
          )
          .map((task) => ({
            id: task.id,
            title: task.title,
            detail: `${task.ownerName ?? "Unassigned"} · ${task.status.replaceAll("_", " ")} · revision ${task.revision}`,
          }));

  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Preview · confirm · audit</span>
          <h1>Bulk task operations</h1>
          <p>
            Select exact speakers or tasks, inspect every material change and
            commit through the normal task rules.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/admin/tasks">
            Tasks &amp; readiness
          </Link>
          <Link className="btn" to="/admin/operations?type=task.bulk">
            Operation history
          </Link>
        </div>
      </div>

      {loaderData.notice ? (
        <div className="validation-item ok card pad mb" role="status">
          <strong>Bulk workflow updated</strong>
          <span>{loaderData.notice}</span>
        </div>
      ) : null}
      {actionData ? (
        <div className="validation-item error card pad mb" role="alert">
          <strong>Bulk action blocked</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}

      <section className="card pad mb" aria-labelledby="task-bulk-configure">
        <div className="card-title">
          <h2 id="task-bulk-configure">1. Configure a task action</h2>
          <span className="help right">Maximum 100 records per preview</span>
        </div>
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="preview" />
          <div className="grid grid-3">
            <label className="label">
              Action
              <select
                className="select"
                name="action"
                value={bulkAction}
                onChange={(event) =>
                  setBulkAction(event.target.value as TaskBulkAction)
                }
              >
                <option value="assign_template">Assign task plan</option>
                <option value="waive">Waive requirements</option>
                <option value="reopen">Reopen requirements</option>
              </select>
              <span className="help">{actionDescription(bulkAction)}</span>
            </label>
            {bulkAction === "assign_template" ? (
              <label className="label">
                Task plan
                <select className="select" name="templateId" required>
                  <option value="">Choose a template</option>
                  {loaderData.workspace.templates.map((template) => (
                    <option key={template.id} value={template.id}>
                      {template.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            {bulkAction === "waive" ? (
              <label className="label">
                Shared waiver reason
                <input
                  className="field"
                  name="reason"
                  minLength={5}
                  maxLength={1_000}
                  required
                />
              </label>
            ) : null}
          </div>
          <fieldset className="stack pc-plain-fieldset">
            <legend>
              Select {bulkAction === "assign_template" ? "speakers" : "tasks"}
            </legend>
            <div className="bulk-record-picker">
              {candidates.map((candidate) => (
                <label className="speaker-confirm" key={candidate.id}>
                  <input type="checkbox" name="recordId" value={candidate.id} />
                  <span>
                    <strong>{candidate.title}</strong>
                    <small className="subtle">{candidate.detail}</small>
                  </span>
                </label>
              ))}
              {!candidates.length ? (
                <EmptyState
                  title="No eligible records"
                  description={
                    bulkAction === "assign_template"
                      ? "Speakers appear here once they are visible in this event."
                      : "Tasks appear here once they are in a state this action can change."
                  }
                  action={
                    <Link className="btn" to="/admin/tasks">
                      Tasks &amp; readiness
                    </Link>
                  }
                />
              ) : null}
            </div>
          </fieldset>
          <div className="page-actions">
            <button
              className="btn primary"
              type="submit"
              disabled={navigation.state !== "idle" || !candidates.length}
            >
              Preview exact changes <ArrowRight aria-hidden size={15} />
            </button>
          </div>
        </Form>
      </section>

      <div className="grid grid-2 mb">
        <section className="card pad" aria-labelledby="bulk-reminders-heading">
          <div className="card-title">
            <h2 id="bulk-reminders-heading">Bulk reminders</h2>
            <BellRing aria-hidden size={18} />
          </div>
          <p>
            Open the Communications Centre with a deterministic task cohort.
            Recipient and content preview remains mandatory before delivery.
          </p>
          <div className="page-actions">
            <Link
              className="btn"
              to="/admin/communications?audience=due_speakers&category=task_reminder"
            >
              Prepare due reminders
            </Link>
            <Link
              className="btn"
              to="/admin/communications?audience=overdue_speakers&category=task_reminder"
            >
              Prepare overdue reminders
            </Link>
          </div>
        </section>
        <section
          className="card pad"
          aria-labelledby="publication-safety-heading"
        >
          <div className="card-title">
            <h2 id="publication-safety-heading">Publication safety</h2>
            <AlertTriangle aria-hidden size={18} />
          </div>
          <p>
            Programme, form and resource publication can notify calendars,
            change public data or reset acknowledgements. They stay in their
            resource-specific preview and confirmation workflows instead of a
            generic bulk switch.
          </p>
          <div className="page-actions">
            <Link className="btn small" to="/admin/schedule">
              Schedule
            </Link>
            <Link className="btn small" to="/admin/submissions/form">
              Form
            </Link>
            <Link className="btn small" to="/admin/resources">
              Resources
            </Link>
          </div>
        </section>
      </div>

      {operation ? (
        <section className="card pad" aria-labelledby="task-bulk-preview">
          <div className="card-title">
            <h2 id="task-bulk-preview">2. Review and confirm</h2>
            <DomainStatusBadge domain="operation" status={operation.status} />
          </div>
          <p>
            <strong>{operation.summary.label}</strong>
            {operation.summary.templateName
              ? ` · ${operation.summary.templateName}`
              : null}
          </p>
          {operation.summary.reason ? (
            <p>
              <strong>Reason:</strong> {operation.summary.reason}
            </p>
          ) : null}
          <div className="grid grid-3 mb">
            <div className="validation-item ok">
              <strong>{operation.summary.changeCount}</strong>
              <span>will change</span>
            </div>
            <div className="validation-item warn">
              <strong>{operation.summary.skippedCount}</strong>
              <span>already satisfied</span>
            </div>
            <div
              className={`validation-item ${operation.summary.invalidCount ? "error" : "ok"}`}
            >
              <strong>{operation.summary.invalidCount}</strong>
              <span>blocked</span>
            </div>
          </div>
          <div className="table-wrap pc-responsive-table-wrap">
            <table className="data-table pc-responsive-table">
              <thead>
                <tr>
                  <th scope="col">Record</th>
                  <th scope="col">Change</th>
                  <th scope="col">Additional effect</th>
                  <th scope="col">Result</th>
                </tr>
              </thead>
              <tbody>
                {operation.items.map((item) => (
                  <tr key={item.id}>
                    <td data-label="Record">
                      <strong>{item.result.label}</strong>
                    </td>
                    <td data-label="Change">
                      {(item.result.beforeStatus ?? "—").replaceAll("_", " ")} →{" "}
                      {item.result.afterStatus.replaceAll("_", " ")}
                    </td>
                    <td data-label="Additional effect">
                      {item.result.additionalPrerequisites.length
                        ? `Also assigns: ${item.result.additionalPrerequisites.join(", ")}`
                        : "None"}
                    </td>
                    <td data-label="Result">
                      <DomainStatusBadge
                        domain="operation"
                        status={item.status}
                      />
                      {item.errorMessage ? (
                        <small className="subtle">{item.errorMessage}</small>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {operation.status === "received" ? (
            <div className="page-actions mt">
              {canConfirm ? (
                <Form
                  method="post"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const form = event.currentTarget;
                    confirm(
                      {
                        title: `Apply ${operation.summary.changeCount} reviewed task change${operation.summary.changeCount === 1 ? "" : "s"}?`,
                        description:
                          "Each record commits through the normal task rules, including any additional prerequisites listed in the preview.",
                        records: operation.items
                          .filter((item) => item.status === "pending")
                          .map(
                            (item) =>
                              `${item.result.label}: ${(item.result.beforeStatus ?? "—").replaceAll("_", " ")} → ${item.result.afterStatus.replaceAll("_", " ")}`,
                          ),
                        confirmLabel: "Confirm reviewed changes",
                        tone: "primary",
                      },
                      () => submit(form),
                    );
                  }}
                >
                  <input type="hidden" name="intent" value="confirm" />
                  <input
                    type="hidden"
                    name="operationId"
                    value={operation.id}
                  />
                  <button
                    className="btn primary"
                    type="submit"
                    disabled={navigation.state !== "idle"}
                  >
                    <ListChecks aria-hidden size={15} /> Confirm reviewed
                    changes
                  </button>
                </Form>
              ) : (
                <p className="subtle">
                  Resolve blocked records and create a fresh preview before
                  confirmation.
                </p>
              )}
              <Form method="post">
                <input type="hidden" name="intent" value="cancel" />
                <input type="hidden" name="operationId" value={operation.id} />
                <button
                  className="btn"
                  type="submit"
                  disabled={navigation.state !== "idle"}
                >
                  Cancel preview
                </button>
              </Form>
            </div>
          ) : null}
        </section>
      ) : null}
      {dialog}
    </>
  );
}
