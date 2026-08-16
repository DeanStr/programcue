import { Archive, ArrowRight, RotateCcw, Tags } from "lucide-react";
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
import { useConfirm } from "~/components/ui/confirm-dialog";
import {
  DomainStatusBadge,
  statusPresentation,
} from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  type SessionBulkAction,
  SessionBulkService,
  SessionBulkStateError,
} from "~/platform/operations/session-bulk-service.server";
import type { Route } from "./+types/admin-session-bulk";

async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
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
  const service = new SessionBulkService(env);
  const [workspace, operation] = await Promise.all([
    service.workspace(viewer),
    operationId
      ? service.operation(viewer, operationId)
      : Promise.resolve(null),
  ]);
  const notices: Record<string, string> = {
    completed:
      "The confirmed changes were applied and recorded in event history.",
    cancelled: "The preview was cancelled without changing any sessions.",
    "undo-preview":
      "The inverse changes are ready. Review them before confirming the undo.",
  };
  return {
    workspace,
    operation,
    now: Math.floor(Date.now() / 1_000),
    notice: notices[url.searchParams.get("notice") ?? ""] ?? null,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const intent = String(form.get("intent") ?? "");
  const service = new SessionBulkService(env);
  try {
    if (intent === "preview") {
      const preview = await service.preview(viewer, {
        action: form.get("action"),
        sessionIds: form.getAll("sessionId"),
        tagId: form.get("tagId"),
        tagName: form.get("tagName"),
        colourToken: form.get("colourToken"),
      });
      throw redirect(
        `/admin/sessions/bulk?operation=${encodeURIComponent(preview.operationId)}`,
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
      await service.confirm(viewer, operationId);
      throw redirect(
        `/admin/sessions/bulk?operation=${encodeURIComponent(operationId)}&notice=completed`,
      );
    }
    if (intent === "prepare-undo") {
      const inverse = await service.prepareUndo(viewer, operationId);
      throw redirect(
        `/admin/sessions/bulk?operation=${encodeURIComponent(inverse.operationId)}&notice=undo-preview`,
      );
    }
    if (intent === "cancel") {
      await service.cancel(viewer, operationId);
      throw redirect(
        `/admin/sessions/bulk?operation=${encodeURIComponent(operationId)}&notice=cancelled`,
      );
    }
    return data(
      { ok: false as const, message: "Unsupported bulk session action." },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof ZodError) {
      return data(
        {
          ok: false as const,
          message:
            error.issues[0]?.message ?? "Review the bulk action settings.",
        },
        { status: 422 },
      );
    }
    if (error instanceof SessionBulkStateError) {
      return data(
        { ok: false as const, message: error.message },
        { status: 409 },
      );
    }
    throw error;
  }
}

export const meta = () => [{ title: "Bulk sessions · Program Cue" }];

function actionDescription(action: SessionBulkAction) {
  if (action === "add_tag") return "Add a reusable event tag";
  if (action === "remove_tag") return "Remove one event tag";
  if (action === "archive") return "Hide inactive unscheduled sessions";
  return "Restore each session to its prior status";
}

function itemChange(
  item: NonNullable<
    Route.ComponentProps["loaderData"]["operation"]
  >["items"][number],
) {
  if (item.result.before.status !== item.result.after.status) {
    return `${statusPresentation("session", item.result.before.status).label} → ${statusPresentation("session", item.result.after.status).label}`;
  }
  const before = item.result.before.tags.join(", ") || "No tags";
  const after = item.result.after.tags.join(", ") || "No tags";
  return `${before} → ${after}`;
}

export default function AdminSessionBulk({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
  const [bulkAction, setBulkAction] = useState<SessionBulkAction>("add_tag");
  const [tagChoice, setTagChoice] = useState("");
  const operation = loaderData.operation;
  const canConfirm =
    operation?.status === "received" &&
    operation.summary.changeCount > 0 &&
    operation.summary.invalidCount === 0;
  const canUndo =
    operation?.status === "completed" &&
    !operation.summary.undoOf &&
    !operation.summary.undoneBy &&
    (operation.summary.undoExpiresAt ?? 0) >= loaderData.now;

  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Preview · confirm · audit</span>
          <h1>Bulk session updates</h1>
          <p>
            Select exact records, review every change and commit them as one
            tenant-scoped operation.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/admin/schedule">
            Open schedule
          </Link>
          <Link className="btn" to="/admin/operations?type=session.bulk">
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

      <section className="card pad mb" aria-labelledby="bulk-configure-heading">
        <div className="card-title">
          <h2 id="bulk-configure-heading">1. Configure a new action</h2>
          <span className="help right">Maximum 100 sessions</span>
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
                onChange={(event) => {
                  setBulkAction(event.target.value as SessionBulkAction);
                  setTagChoice("");
                }}
              >
                <option value="add_tag">Add tag</option>
                <option value="remove_tag">Remove tag</option>
                <option value="archive">Archive</option>
                <option value="restore">Restore</option>
              </select>
              <span className="help">{actionDescription(bulkAction)}</span>
            </label>
            {bulkAction === "add_tag" ? (
              <label className="label">
                Tag
                <select
                  className="select"
                  name="tagId"
                  value={tagChoice}
                  onChange={(event) => setTagChoice(event.target.value)}
                >
                  <option value="">Create a new tag</option>
                  {loaderData.workspace.tags.map((tag) => (
                    <option value={tag.id} key={tag.id}>
                      {tag.name} ({tag.count})
                    </option>
                  ))}
                </select>
              </label>
            ) : bulkAction === "remove_tag" ? (
              <label className="label">
                Tag to remove
                <select
                  className="select"
                  name="tagId"
                  required
                  defaultValue=""
                >
                  <option value="" disabled>
                    Choose a tag
                  </option>
                  {loaderData.workspace.tags.map((tag) => (
                    <option value={tag.id} key={tag.id}>
                      {tag.name} ({tag.count})
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <div className="card pad">
                <strong>Lifecycle guard</strong>
                <p className="help">
                  Scheduled and published sessions cannot be archived. Restore
                  uses the exact status recorded at archive time.
                </p>
              </div>
            )}
            {bulkAction === "add_tag" && !tagChoice ? (
              <label className="label">
                New tag name
                <input
                  className="field"
                  name="tagName"
                  required
                  maxLength={80}
                  placeholder="For example: keynote"
                />
                <select
                  className="select mt"
                  name="colourToken"
                  defaultValue="indigo"
                >
                  <option value="indigo">Indigo</option>
                  <option value="emerald">Emerald</option>
                  <option value="amber">Amber</option>
                  <option value="rose">Rose</option>
                  <option value="slate">Slate</option>
                </select>
              </label>
            ) : null}
          </div>

          <section
            className="table-wrap pc-responsive-table-wrap"
            aria-label="Sessions available for bulk update"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
            tabIndex={0}
          >
            <table
              className="data-table pc-responsive-table"
              aria-label="Sessions available for bulk update"
            >
              <thead>
                <tr>
                  <th scope="col">
                    <span className="sr-only">Select</span>
                  </th>
                  <th scope="col">Session</th>
                  <th scope="col">Status</th>
                  <th scope="col">Tags</th>
                </tr>
              </thead>
              <tbody>
                {loaderData.workspace.sessions.map((session) => (
                  <tr key={session.id}>
                    <td data-label="Select">
                      <input
                        type="checkbox"
                        name="sessionId"
                        value={session.id}
                        aria-label={`Select ${session.title}`}
                      />
                    </td>
                    <td className="pc-record-primary-cell" data-label="Session">
                      <strong>{session.title}</strong>
                    </td>
                    <td data-label="Status">
                      <DomainStatusBadge
                        domain="session"
                        status={session.status}
                      />
                    </td>
                    <td data-label="Tags">
                      {session.tags.length ? (
                        session.tags.map((tag) => tag.name).join(", ")
                      ) : (
                        <span className="subtle">No tags</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {!loaderData.workspace.sessions.length ? (
            <EmptyState
              title="No sessions to update"
              description="Accepted or directly created sessions will appear here."
              action={
                <Link className="btn primary" to="/admin/schedule">
                  Open schedule
                </Link>
              }
            />
          ) : null}
          <button
            className="btn primary"
            type="submit"
            disabled={
              navigation.state !== "idle" ||
              !loaderData.workspace.sessions.length
            }
          >
            Preview affected records <ArrowRight aria-hidden size={14} />
          </button>
        </Form>
      </section>

      {operation ? (
        <section className="card pad" aria-labelledby="bulk-preview-heading">
          <div className="card-title">
            <h2 id="bulk-preview-heading">
              2.{" "}
              {operation.status === "received"
                ? "Review and confirm"
                : "Operation result"}
            </h2>
            <DomainStatusBadge domain="operation" status={operation.status} />
          </div>
          <p>
            <strong>{operation.summary.label}</strong>
            {operation.summary.tagName ? ` · ${operation.summary.tagName}` : ""}
            {operation.summary.undoOf ? " · inverse of a prior operation" : ""}
          </p>
          <div className="stat-grid mb">
            <div className="stat">
              <span>Will change</span>
              <strong>{operation.summary.changeCount}</strong>
            </div>
            <div className="stat">
              <span>No change</span>
              <strong>{operation.summary.skippedCount}</strong>
            </div>
            <div className="stat">
              <span>Blocked</span>
              <strong>{operation.summary.invalidCount}</strong>
            </div>
          </div>
          <section
            className="table-wrap pc-responsive-table-wrap"
            aria-label="Bulk session update preview"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
            tabIndex={0}
          >
            <table
              className="data-table pc-responsive-table"
              aria-label="Bulk session update preview"
            >
              <thead>
                <tr>
                  <th scope="col">Session</th>
                  <th scope="col">Preview status</th>
                  <th scope="col">Before → after</th>
                </tr>
              </thead>
              <tbody>
                {operation.items.map((item) => (
                  <tr key={item.id}>
                    <td className="pc-record-primary-cell" data-label="Session">
                      <strong>{item.result.title}</strong>
                    </td>
                    <td data-label="Preview status">
                      <DomainStatusBadge
                        domain="operation"
                        status={item.status}
                      />
                    </td>
                    <td data-label="Before to after">
                      {item.errorMessage ?? itemChange(item)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          {operation.status === "received" ? (
            <div className="page-actions mt">
              <Form
                method="post"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  confirm(
                    {
                      title: `Apply ${operation.summary.changeCount} reviewed session change${operation.summary.changeCount === 1 ? "" : "s"}?`,
                      description:
                        "Only the records listed here change. The operation and its inverse stay in event history.",
                      records: operation.items
                        .filter((item) => item.status === "pending")
                        .map(
                          (item) =>
                            `${item.result.title} · ${itemChange(item)}`,
                        ),
                      confirmLabel: "Confirm exact changes",
                      tone: "primary",
                    },
                    () => submit(form),
                  );
                }}
              >
                <input type="hidden" name="intent" value="confirm" />
                <input type="hidden" name="operationId" value={operation.id} />
                <button
                  className="btn primary"
                  type="submit"
                  disabled={!canConfirm || navigation.state !== "idle"}
                >
                  {operation.summary.action.includes("tag") ? (
                    <Tags aria-hidden size={14} />
                  ) : (
                    <Archive aria-hidden size={14} />
                  )}
                  Confirm exact changes
                </button>
              </Form>
              <Form
                method="post"
                onSubmit={(event) => {
                  event.preventDefault();
                  const form = event.currentTarget;
                  confirm(
                    {
                      title: "Cancel this preview?",
                      description:
                        "No session changes are applied and the preview cannot be confirmed afterwards. You can build a fresh preview at any time.",
                      confirmLabel: "Cancel preview",
                    },
                    () => submit(form),
                  );
                }}
              >
                <input type="hidden" name="intent" value="cancel" />
                <input type="hidden" name="operationId" value={operation.id} />
                <button
                  className="btn danger"
                  type="submit"
                  disabled={navigation.state !== "idle"}
                >
                  Cancel preview
                </button>
              </Form>
              {operation.summary.invalidCount ? (
                <span className="help">
                  Remove every blocked record and create a fresh preview.
                </span>
              ) : null}
            </div>
          ) : null}
          {canUndo ? (
            <Form
              method="post"
              className="mt"
              onSubmit={(event) => {
                event.preventDefault();
                const form = event.currentTarget;
                confirm(
                  {
                    title: "Prepare the exact inverse changes?",
                    description:
                      "This builds a second preview that reverses this operation. Nothing changes until you review and confirm it.",
                    confirmLabel: "Prepare undo",
                    tone: "primary",
                  },
                  () => submit(form),
                );
              }}
            >
              <input type="hidden" name="intent" value="prepare-undo" />
              <input type="hidden" name="operationId" value={operation.id} />
              <button
                className="btn"
                type="submit"
                disabled={navigation.state !== "idle"}
              >
                <RotateCcw aria-hidden size={14} /> Prepare five-minute undo
              </button>
            </Form>
          ) : null}
          {operation.summary.undoneBy ? (
            <p className="help mt">
              Undone by operation{" "}
              <Link
                to={`/admin/sessions/bulk?operation=${encodeURIComponent(operation.summary.undoneBy)}`}
              >
                {operation.summary.undoneBy}
              </Link>
              .
            </p>
          ) : null}
          <p className="help mt">
            Operation{" "}
            <Link
              to={`/admin/operations?operation=${encodeURIComponent(operation.id)}`}
            >
              {operation.id}
            </Link>{" "}
            retains the record-level result and immutable audit history.
          </p>
        </section>
      ) : null}
      {dialog}
    </>
  );
}
