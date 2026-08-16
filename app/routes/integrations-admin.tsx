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
import { useConfirm } from "~/components/ui/confirm-dialog";
import {
  DomainStatusBadge,
  statusPresentation,
} from "~/components/ui/domain-status-badge";
import { EmptyState } from "~/components/ui/states";
import { providerLabel } from "~/lib/provider-labels";
import { fieldLabel, fieldValue } from "~/lib/record-labels";
import { AcceleventsProviderError } from "~/modules/integrations/accelevents-provider.server";
import { isAcceleventsTerminalRunStatus } from "~/modules/integrations/accelevents-run-contract";
import { IntegrationCredentialConfigurationError } from "~/modules/integrations/integration-credentials.server";
import {
  IntegrationService,
  IntegrationStateError,
} from "~/modules/integrations/integration-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/integrations-admin";

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
            ? "Preview recorded. Nothing was written to Accelevents."
            : result.replayed
              ? "This exact export was already recorded. Open it in Operations to see how it finished."
              : result.queued
                ? "Export started. Follow record-level progress in Operations."
                : "Nothing needed to change in Accelevents, so no export was started.",
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

export default function IntegrationsAdmin({
  loaderData,
}: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { confirm, dialog } = useConfirm();
  const busy = navigation.state !== "idle";
  return (
    <>
      {dialog}
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">External providers</span>
          <h1>Integrations</h1>
          <p>
            Preview the exact record changes, then export them to Accelevents. A
            preview never writes anything to Accelevents. Which system owns your
            event data is set in Event Setup.
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
                    <strong>{providerLabel(connection.provider)}</strong>
                    <div className="help">
                      {connection.demoNoWriteFixture
                        ? "Demonstration only · no credentials or provider validation"
                        : `Updated ${operationalDateTime(connection.updatedAt)}`}
                    </div>
                  </div>
                  {connection.demoNoWriteFixture ? (
                    <span className="status warning">Demonstration only</span>
                  ) : (
                    <DomainStatusBadge
                      domain="integrationConnection"
                      status={connection.status}
                    />
                  )}
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
                {loaderData.preview.summary.create} to create ·{" "}
                {loaderData.preview.summary.update} to update ·{" "}
                {loaderData.preview.summary.noop} unchanged
                {loaderData.preview.summary.blocked
                  ? ` · ${loaderData.preview.summary.blocked} that Accelevents does not accept`
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
            <section
              className="table-wrap"
              // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
              tabIndex={0}
              aria-label="Accelevents export preview"
            >
              <table className="data-table">
                <thead>
                  <tr>
                    <th scope="col">Record</th>
                    <th scope="col">Type</th>
                    <th scope="col">Change</th>
                    <th scope="col">Diff</th>
                    <th scope="col">External ID</th>
                  </tr>
                </thead>
                <tbody>
                  {loaderData.preview.items.map((item) => (
                    <tr key={`${item.entityType}:${item.entityId}`}>
                      <td>
                        <strong>{item.label}</strong>
                      </td>
                      <td>{fieldLabel(item.entityType)}</td>
                      <td>
                        <DomainStatusBadge
                          domain="integrationChange"
                          status={item.action}
                        />
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
                          <details className="pc-disclosure">
                            <summary>
                              {item.changes.length} field
                              {item.changes.length === 1 ? "" : "s"}
                            </summary>
                            <ul>
                              {item.changes.map((change) => (
                                <li key={change.field}>
                                  <strong>{fieldLabel(change.field)}</strong>:{" "}
                                  {fieldValue(change.before)} →{" "}
                                  {fieldValue(change.after)}
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
            </section>
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
                Record this preview
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="run" />
              <input type="hidden" name="mode" value="live" />
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
                type="button"
                disabled={
                  busy ||
                  loaderData.preview.items.length === 0 ||
                  loaderData.preview.connection.demoNoWriteFixture
                }
                onClick={(event) => {
                  const form = event.currentTarget.form;
                  const blocked = loaderData.preview?.summary.blocked ?? 0;
                  confirm(
                    {
                      title: "Queue a live export to Accelevents?",
                      description: `The displayed speaker, track, session and association changes are written to Accelevents. This cannot be undone from Program Cue.${blocked ? ` ${blocked} of the listed changes are not something Accelevents accepts; they will be reported as failures rather than quietly skipped.` : ""}`,
                      records:
                        loaderData.preview?.items
                          .filter((item) => item.action !== "noop")
                          .map(
                            (item) =>
                              `${item.label} · ${statusPresentation("integrationChange", item.action).label}`,
                          ) ?? [],
                      confirmLabel: "Queue live export",
                    },
                    () => form?.requestSubmit(),
                  );
                }}
              >
                {loaderData.preview.connection.demoNoWriteFixture
                  ? "Live export unavailable in demo"
                  : "Queue live export"}
              </button>
            </Form>
            <Form method="post">
              <input type="hidden" name="intent" value="disconnect" />
              <input
                type="hidden"
                name="connectionId"
                value={loaderData.selected.id}
              />
              <button
                className="btn danger"
                type="button"
                disabled={busy}
                onClick={(event) => {
                  const form = event.currentTarget.form;
                  confirm(
                    {
                      title: "Disconnect Accelevents?",
                      description:
                        "The stored credential is deleted and the connection is disabled. Mapping previews and exports stop until it is configured again. Records already written to Accelevents are not removed.",
                      confirmLabel: "Disconnect",
                    },
                    () => form?.requestSubmit(),
                  );
                }}
              >
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
          <section
            className="table-wrap"
            aria-label="Recent integration runs"
            // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
            tabIndex={0}
          >
            <table className="data-table">
              <thead>
                <tr>
                  <th scope="col">Provider</th>
                  <th scope="col">Mode</th>
                  <th scope="col">Status</th>
                  <th scope="col">Created</th>
                  <th scope="col">Operation</th>
                  <th scope="col">Report</th>
                </tr>
              </thead>
              <tbody>
                {loaderData.runs.map((run) => (
                  <tr key={run.id}>
                    <td>{providerLabel(run.provider)}</td>
                    <td>{run.dryRun ? "Preview only" : "Live"}</td>
                    <td>
                      <DomainStatusBadge
                        domain="integration"
                        status={run.status}
                      />
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
          </section>
        ) : (
          <EmptyState
            title="No exports yet"
            description="Recorded previews and live exports appear here, each with its report."
            icon={RefreshCw}
          />
        )}
      </section>
    </>
  );
}
