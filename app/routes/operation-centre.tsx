import { data, Form, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/operation-centre";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  OperationQueueUnavailableError,
  OperationService,
} from "~/platform/operations/operation-service.server";

export const meta = () => [{ title: "Operation Centre · Program Cue" }];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);
  const operations = await new OperationService(env).list(viewer);
  const search = new URL(request.url).searchParams;
  const status = search.get("status") ?? "";
  const operationId = search.get("operation") ?? "";
  const visible = operations.filter((operation) => {
    const statusMatches =
      !status ||
      (status === "failed"
        ? ["queue_failed", "failed", "partially_failed"].includes(
            operation.status,
          )
        : operation.status === status);
    return statusMatches && (!operationId || operation.id === operationId);
  });
  return {
    operations: visible,
    totalOperations: operations.length,
    filterActive: Boolean(status || operationId),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);
  const form = await request.formData();
  if (form.get("intent") !== "retry")
    throw new Response("Unsupported operation", { status: 400 });
  const operationId = String(form.get("operationId") ?? "");
  if (!operationId)
    throw new Response("Operation id is required", { status: 422 });
  try {
    await new OperationService(env).retry(viewer, operationId);
    return data({
      ok: true as const,
      operationId,
      message: `Operation ${operationId} was queued for retry.`,
    });
  } catch (error) {
    if (error instanceof OperationQueueUnavailableError) {
      return data(
        {
          ok: false as const,
          committed: true as const,
          operationId: error.operationId,
          message: error.message,
        },
        { status: 503 },
      );
    }
    throw error;
  }
}

function formatDate(epoch: number) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(epoch * 1_000));
}

export default function OperationCentre({ loaderData }: Route.ComponentProps) {
  const navigation = useNavigation();
  const actionData = useActionData<typeof action>();
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Operation Centre</h1>
          <p>Inspect background work, provider failures and safe retries.</p>
        </div>
        <div className="page-actions">
          <span className="status info">
            {loaderData.operations.length} recent operations
          </span>
        </div>
      </div>
      {actionData ? (
        <div
          className={`validation-item ${actionData.ok ? "ok" : "error"} card pad mb`}
          role={actionData.ok ? "status" : "alert"}
        >
          <strong>{actionData.ok ? "Retry queued" : "Retry not queued"}</strong>
          <span>{actionData.message}</span>
        </div>
      ) : null}
      {loaderData.filterActive ? (
        <div className="validation-item warn card pad mb" role="status">
          <strong>Filtered</strong>
          <span>
            Showing {loaderData.operations.length} of{" "}
            {loaderData.totalOperations} operations.{" "}
            <a href="/admin/operations">Clear filters</a>
          </span>
        </div>
      ) : null}
      <section className="card pad">
        <div className="card-title">
          <h2>Background operations</h2>
          <span className="help right">
            Durable intent is recorded before provider work starts.
          </span>
        </div>
        {loaderData.operations.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Operation</th>
                  <th>Status</th>
                  <th>Progress</th>
                  <th>Started (UTC)</th>
                  <th>Result</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loaderData.operations.map((operation) => {
                  const retryable = operation.retryable;
                  return (
                    <tr key={operation.id}>
                      <td>
                        <strong>{operation.type}</strong>
                        <small className="subtle" style={{ display: "block" }}>
                          {operation.id}
                        </small>
                      </td>
                      <td>
                        <span
                          className={`status ${operation.status === "completed" ? "success" : retryable ? "danger" : "info"}`}
                        >
                          {operation.status.replaceAll("_", " ")}
                        </span>
                      </td>
                      <td>
                        {operation.progressTotal
                          ? `${operation.progressCurrent} / ${operation.progressTotal}`
                          : "—"}
                      </td>
                      <td>{formatDate(operation.createdAt)}</td>
                      <td>
                        {operation.lastError ??
                          (operation.completedAt
                            ? formatDate(operation.completedAt)
                            : "Pending")}
                      </td>
                      <td>
                        {retryable ? (
                          <Form
                            method="post"
                            onSubmit={(event) => {
                              if (
                                !window.confirm(
                                  `Retry ${operation.type} operation ${operation.id}? This may repeat external provider work that did not previously complete.`,
                                )
                              ) {
                                event.preventDefault();
                              }
                            }}
                          >
                            <input type="hidden" name="intent" value="retry" />
                            <input
                              type="hidden"
                              name="operationId"
                              value={operation.id}
                            />
                            <button
                              className="btn small"
                              disabled={navigation.state !== "idle"}
                            >
                              Retry
                            </button>
                          </Form>
                        ) : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty">
            <h2>No background operations yet</h2>
            <p>
              Imports, sends, calendar updates and publications will appear
              here.
            </p>
          </div>
        )}
      </section>
    </>
  );
}
