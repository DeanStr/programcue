import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  PlugZap,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/integrations-admin";
import { EmptyState } from "~/components/ui/states";
import { AcceleventsProviderError } from "~/modules/integrations/accelevents-provider.server";
import { isAcceleventsTerminalRunStatus } from "~/modules/integrations/accelevents-run-contract";
import { IntegrationCredentialConfigurationError } from "~/modules/integrations/integration-credentials.server";
import {
  IntegrationService,
  IntegrationStateError,
} from "~/modules/integrations/integration-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export const meta = () => [{ title: "Integrations · Program Cue" }];

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
  const service = new IntegrationService(env);
  const workspace = await service.getWorkspace(viewer);
  const requestedConnection = new URL(request.url).searchParams.get(
    "connection",
  );
  const selected = requestedConnection
    ? workspace.connections.find(
        (connection) => connection.id === requestedConnection,
      )
    : workspace.connections[0];
  if (requestedConnection && !selected)
    throw new Response("Integration connection not found", { status: 404 });
  const preview =
    selected?.status === "connected"
      ? await service.preview(viewer, selected.id)
      : null;
  return {
    ...workspace,
    selected,
    preview,
    nextRunKey: crypto.randomUUID(),
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
  const intent = form.get("intent");
  const service = new IntegrationService(env);
  try {
    if (intent === "configure") {
      const result = await service.configureAccelevents(viewer, {
        provider: "accelevents",
        apiKey: form.get("apiKey"),
        eventUrl: form.get("eventUrl"),
        externalEventId: form.get("externalEventId"),
        sessionTypeFormat: form.get("sessionTypeFormat"),
      });
      return data({
        ok: true as const,
        message: "Accelevents credentials verified and encrypted.",
        connectionId: result.connectionId,
        operationId: null,
      });
    }
    if (intent === "run") {
      const result = await service.startRun(viewer, {
        connectionId: form.get("connectionId"),
        dryRun: form.get("mode") === "dry_run",
        idempotencyKey: form.get("idempotencyKey"),
        previewFingerprint: form.get("previewFingerprint"),
      });
      return data({
        ok: true as const,
        message:
          form.get("mode") === "dry_run"
            ? "Dry-run reconciliation recorded without provider writes."
            : result.replayed
              ? "This exact export request was already recorded. Open its operation to inspect the current or completed result."
              : result.queued
              ? "Export queued. Follow record-level progress in Operations."
              : "No provider changes were required; the run completed without enqueueing work.",
        connectionId: String(form.get("connectionId") ?? ""),
        operationId: result.operationId,
      });
    }
    if (intent === "disconnect") {
      await service.disconnect(viewer, String(form.get("connectionId") ?? ""));
      return data({
        ok: true as const,
        message: "Accelevents credentials removed and the connection disabled.",
        connectionId: null,
        operationId: null,
      });
    }
    return data(
      {
        ok: false as const,
        message: "Unsupported integration action.",
        connectionId: null,
        operationId: null,
      },
      { status: 400 },
    );
  } catch (error) {
    if (
      error instanceof ZodError ||
      error instanceof IntegrationStateError ||
      error instanceof IntegrationCredentialConfigurationError ||
      error instanceof AcceleventsProviderError
    ) {
      const message =
        error instanceof ZodError
          ? (error.issues[0]?.message ?? "Review the integration details.")
          : error.message;
      return data(
        {
          ok: false as const,
          message,
          connectionId: null,
          operationId: null,
        },
        { status: error instanceof IntegrationStateError ? 409 : 422 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function operationalDateTime(epoch: number | null) {
  if (epoch === null) return "—";
  return `${new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(epoch * 1_000))} UTC`;
}

function statusTone(status: string) {
  if (["connected", "succeeded", "completed"].includes(status))
    return "success";
  if (["failed", "partially_failed", "needs_attention"].includes(status))
    return "danger";
  if (["queued", "running"].includes(status)) return "warning";
  return "info";
}

export default function IntegrationsAdmin({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">External provider boundaries</span>
          <h1>Integrations</h1>
          <p>
            Preview exact Accelevents record changes, then run a durable one-way
            export. Provider writes never occur during a dry run. Airtable
            repository authority is managed in Event Setup.
          </p>
        </div>
        <div className="page-actions">
          <span className="status info">
            <PlugZap aria-hidden size={14} /> {loaderData.connections.length}{" "}
            configured
          </span>
          <Link className="btn" to="/admin/operations">
            Operation history <ExternalLink aria-hidden size={13} />
          </Link>
        </div>
      </div>

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
            {actionData.operationId ? (
              <Link
                to={`/admin/operations?operation=${encodeURIComponent(actionData.operationId)}`}
              >
                Open operation progress
              </Link>
            ) : null}
          </div>
        </div>
      ) : null}

      <div className="grid grid-2 align-start">
        <section className="card pad">
          <div className="card-title">
            <h2>Accelevents connection</h2>
            <span className="status info">
              <ShieldCheck aria-hidden size={13} /> Encrypted
            </span>
          </div>
          <p className="help">
            The event identifier and API key are verified against Accelevents
            before anything is stored. Saving replaces the prior event-scoped
            credential.
          </p>
          <Form method="post" className="form-stack mt">
            <input type="hidden" name="intent" value="configure" />
            <label className="label">
              Event URL identifier
              <input
                className="input"
                name="eventUrl"
                required
                placeholder="future-of-events"
                autoComplete="off"
              />
              <span className="help">The final segment after /events/.</span>
            </label>
            <label className="label">
              Numeric event ID
              <input
                className="input"
                name="externalEventId"
                required
                inputMode="numeric"
                pattern="[0-9]+"
              />
            </label>
            <label className="label">
              API key
              <input
                className="input"
                name="apiKey"
                required
                type="password"
                autoComplete="new-password"
              />
            </label>
            <label className="label">
              Accelevents event format
              <select
                className="select"
                name="sessionTypeFormat"
                required
                defaultValue="IN_PERSON"
              >
                <option value="IN_PERSON">In person</option>
                <option value="VIRTUAL">Virtual</option>
                <option value="HYBRID">Hybrid</option>
              </select>
              <span className="help">
                Required by Accelevents when sessions are created or updated.
              </span>
            </label>
            <button className="btn primary" disabled={busy} type="submit">
              {busy ? "Verifying…" : "Verify and save"}
            </button>
          </Form>
        </section>

        <section className="card pad">
          <div className="card-title">
            <h2>Connections</h2>
          </div>
          {loaderData.connections.length ? (
            <div className="stack-list">
              {loaderData.connections.map((connection) => (
                <article className="validation-item" key={connection.id}>
                  <div>
                    <strong>{connection.provider}</strong>
                    <div className="help">
                      {connection.demoNoWriteFixture
                        ? "Demonstration only · no credentials or provider validation"
                        : `Updated ${operationalDateTime(connection.updatedAt)}`}
                    </div>
                  </div>
                  <span
                    className={`status ${connection.demoNoWriteFixture ? "warning" : statusTone(connection.status)}`}
                  >
                    {connection.demoNoWriteFixture
                      ? "demo no-write"
                      : connection.status.replaceAll("_", " ")}
                  </span>
                  <Link
                    className="btn small"
                    to={`/admin/integrations?${new URLSearchParams({ connection: connection.id })}`}
                  >
                    Inspect
                  </Link>
                </article>
              ))}
            </div>
          ) : (
            <EmptyState
              title="No provider connected"
              description="Connect Accelevents to unlock mapping previews and audited one-way exports."
              icon={PlugZap}
            />
          )}
        </section>
      </div>

      {loaderData.selected && loaderData.preview ? (
        <section className="card pad mt">
          <div className="card-title">
            <div>
              <h2>Mapping preview</h2>
              <p className="help">
                {loaderData.preview.summary.create} create ·{" "}
                {loaderData.preview.summary.update} update ·{" "}
                {loaderData.preview.summary.noop} unchanged
                {loaderData.preview.summary.blocked
                  ? ` · ${loaderData.preview.summary.blocked} blocked by the published provider contract`
                  : ""}
              </p>
            </div>
            <span
              className={`status ${loaderData.preview.connection.demoNoWriteFixture ? "warning" : "success"}`}
            >
              {loaderData.preview.connection.demoNoWriteFixture
                ? "Demo no-write fixture"
                : "Connected"}
            </span>
          </div>
          {loaderData.preview.connection.demoNoWriteFixture ? (
            <div className="validation-item warn mb" role="status">
              <strong>Demonstration only · provider not called</strong>
              <span>
                This explicit demo fixture exercises mapping, dry-run and
                failure/retry UX without credentials. Live export is disabled
                and no Accelevents success is simulated.
              </span>
            </div>
          ) : null}
          {loaderData.preview.items.length ? (
            <div
              className="table-wrap"
              tabIndex={0}
              aria-label="Accelevents export preview"
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Record</th>
                    <th>Type</th>
                    <th>Change</th>
                    <th>Diff</th>
                    <th>External ID</th>
                  </tr>
                </thead>
                <tbody>
                  {loaderData.preview.items.map((item) => (
                    <tr key={`${item.entityType}:${item.entityId}`}>
                      <td>
                        <strong>{item.label}</strong>
                      </td>
                      <td>{item.entityType}</td>
                      <td>
                        <span
                          className={`status ${item.action === "noop" ? "info" : "warning"}`}
                        >
                          {item.action}
                        </span>
                        {item.providerSupport === "blocked" &&
                        item.action !== "noop" ? (
                          <small
                            className="subtle"
                            style={{ display: "block" }}
                          >
                            Provider write unavailable
                          </small>
                        ) : null}
                      </td>
                      <td>
                        {item.changes.length ? (
                          <details>
                            <summary>
                              {item.changes.length} field
                              {item.changes.length === 1 ? "" : "s"}
                            </summary>
                            <ul>
                              {item.changes.map((change) => (
                                <li key={change.field}>
                                  <strong>{change.field}</strong>:{" "}
                                  {JSON.stringify(change.before)} →{" "}
                                  {JSON.stringify(change.after)}
                                </li>
                              ))}
                            </ul>
                            {item.providerMessage ? (
                              <p className="help">{item.providerMessage}</p>
                            ) : null}
                          </details>
                        ) : (
                          "No source change"
                        )}
                      </td>
                      <td>{item.externalId ?? "New"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              title="No published programme records"
              description="Publish a schedule with accepted speakers before exporting."
              icon={RefreshCw}
            />
          )}
          <div className="page-actions mt">
            <Form method="post">
              <input type="hidden" name="intent" value="run" />
              <input
                type="hidden"
                name="connectionId"
                value={loaderData.selected.id}
              />
              <input
                type="hidden"
                name="idempotencyKey"
                value={`dry:${loaderData.nextRunKey}`}
              />
              <input
                type="hidden"
                name="previewFingerprint"
                value={loaderData.preview.previewFingerprint}
              />
              <button
                className="btn"
                type="submit"
                name="mode"
                value="dry_run"
                disabled={busy}
              >
                Record dry run
              </button>
            </Form>
            <Form
              method="post"
              onSubmit={(event) => {
                if (
                  !window.confirm(
                    `Export the displayed speaker, track, session and association changes to Accelevents? This external effect cannot be undone in Program Cue.${loaderData.preview?.summary.blocked ? ` ${loaderData.preview.summary.blocked} displayed item(s) have no documented provider write and will fail explicitly without a fabricated success.` : ""}`,
                  )
                )
                  event.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="run" />
              <input
                type="hidden"
                name="connectionId"
                value={loaderData.selected.id}
              />
              <input
                type="hidden"
                name="idempotencyKey"
                value={`live:${loaderData.nextRunKey}`}
              />
              <input
                type="hidden"
                name="previewFingerprint"
                value={loaderData.preview.previewFingerprint}
              />
              <button
                className="btn primary"
                type="submit"
                name="mode"
                value="live"
                disabled={
                  busy ||
                  loaderData.preview.items.length === 0 ||
                  loaderData.preview.connection.demoNoWriteFixture
                }
              >
                {loaderData.preview.connection.demoNoWriteFixture
                  ? "Live export unavailable in demo"
                  : "Queue live export"}
              </button>
            </Form>
            <Form
              method="post"
              onSubmit={(event) => {
                if (
                  !window.confirm(
                    "Disconnect and delete the stored Accelevents credential?",
                  )
                )
                  event.preventDefault();
              }}
            >
              <input type="hidden" name="intent" value="disconnect" />
              <input
                type="hidden"
                name="connectionId"
                value={loaderData.selected.id}
              />
              <button className="btn danger" type="submit" disabled={busy}>
                Disconnect
              </button>
            </Form>
          </div>
        </section>
      ) : null}

      <section className="card pad mt">
        <div className="card-title">
          <h2>Recent integration runs</h2>
        </div>
        {loaderData.runs.length ? (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Created</th>
                  <th>Operation</th>
                  <th>Report</th>
                </tr>
              </thead>
              <tbody>
                {loaderData.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.provider}</td>
                    <td>{run.dryRun ? "Dry run" : "Live"}</td>
                    <td>
                      <span className={`status ${statusTone(run.status)}`}>
                        {run.status.replaceAll("_", " ")}
                      </span>
                    </td>
                    <td>{operationalDateTime(run.createdAt)}</td>
                    <td>
                      <Link
                        to={`/admin/operations?operation=${encodeURIComponent(run.operationId)}`}
                      >
                        Inspect
                      </Link>
                    </td>
                    <td>
                      {isAcceleventsTerminalRunStatus(run.status) &&
                      run.completedAt !== null ? (
                        <a
                          href={`/admin/integrations/accelevents/runs/${encodeURIComponent(run.id)}/reconciliation.csv`}
                        >
                          Download CSV
                        </a>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="empty">No integration runs have been recorded.</p>
        )}
      </section>
    </>
  );
}
