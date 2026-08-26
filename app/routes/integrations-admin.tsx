import { AlertTriangle, CheckCircle2, ExternalLink } from "lucide-react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";
import { Button, ButtonLink } from "~/components/ui/button";
import { useConfirm } from "~/components/ui/confirm-dialog";
import {
  DomainStatusBadge,
  statusPresentation,
} from "~/components/ui/domain-status-badge";
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
  const selected = loaderData.selected;
  const preview = loaderData.preview;
  const connectionStatus = selected
    ? selected.demoNoWriteFixture
      ? "Demonstration only"
      : null
    : "Not connected";
  return (
    <div className="integ-page">
      {dialog}
      <div className="page-head pc-page-header integ-page-head">
        <div>
          <span className="pc-page-eyebrow">External providers</span>
          <h1>Integrations</h1>
          <p>
            Preview the exact record changes, then export them to Accelevents. A
            preview never writes. Which system owns your event data is set in
            Event settings.
          </p>
        </div>
        <div className="page-actions">
          <ButtonLink to="/admin/operations">
            Operation history <ExternalLink aria-hidden size={13} />
          </ButtonLink>
        </div>
      </div>

      {actionData ? (
        <div
          className={`pc-status-notice ${actionData.ok ? "is-success" : "is-danger"}`}
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

      <section className="integ-instrument" aria-labelledby="integ-accelevents">
        <header className="integ-instrument-head">
          <div className="integ-instrument-identity">
            <span className="integration-logo" aria-hidden>
              AE
            </span>
            <div>
              <h2 id="integ-accelevents">Accelevents</h2>
              <p>
                One-way programme export. The event identifier and API key are
                verified before anything is stored. Saving replaces the prior
                event-scoped credential.
              </p>
            </div>
          </div>
          {connectionStatus ? (
            <span className="integ-status">{connectionStatus}</span>
          ) : selected ? (
            <DomainStatusBadge
              domain="integrationConnection"
              status={selected.status}
            />
          ) : null}
        </header>

        {loaderData.connections.length > 1 ? (
          <nav className="integ-switcher" aria-label="Connections">
            {loaderData.connections.map((connection) => (
              <Link
                key={connection.id}
                to={`/admin/integrations?${new URLSearchParams({ connection: connection.id })}`}
                aria-current={
                  selected?.id === connection.id ? "page" : undefined
                }
              >
                {providerLabel(connection.provider)}
                {connection.demoNoWriteFixture
                  ? " · Demonstration only"
                  : ` · ${operationalDateTime(connection.updatedAt)}`}
              </Link>
            ))}
          </nav>
        ) : null}

        <Form method="post" className="integ-fields">
          <input type="hidden" name="intent" value="configure" />
          <div className="integ-row">
            <div className="integ-row-copy">
              <label htmlFor="integ-event-url">Event URL identifier</label>
              <p className="help">The final segment after /events/.</p>
            </div>
            <input
              id="integ-event-url"
              className="field"
              name="eventUrl"
              required
              placeholder="future-of-events"
              autoComplete="off"
            />
          </div>
          <div className="integ-row">
            <div className="integ-row-copy">
              <label htmlFor="integ-event-id">Numeric event ID</label>
            </div>
            <input
              id="integ-event-id"
              className="field"
              name="externalEventId"
              required
              inputMode="numeric"
              pattern="[0-9]+"
            />
          </div>
          <div className="integ-row">
            <div className="integ-row-copy">
              <label htmlFor="integ-api-key">API key</label>
              <p className="help">
                Encrypted at rest after Accelevents accepts it.
              </p>
            </div>
            <input
              id="integ-api-key"
              className="field"
              name="apiKey"
              required
              type="password"
              autoComplete="new-password"
            />
          </div>
          <div className="integ-row integ-row-commit">
            <div className="integ-row-copy">
              <label htmlFor="integ-format">Accelevents event format</label>
              <p className="help">
                Required by Accelevents when sessions are created or updated.
              </p>
            </div>
            <div className="page-actions">
              <select
                id="integ-format"
                className="select"
                name="sessionTypeFormat"
                required
                defaultValue="IN_PERSON"
              >
                <option value="IN_PERSON">In person</option>
                <option value="VIRTUAL">Virtual</option>
                <option value="HYBRID">Hybrid</option>
              </select>
              <Button variant="primary" disabled={busy} type="submit">
                {busy ? "Verifying…" : "Verify and save"}
              </Button>
            </div>
          </div>
        </Form>

        {loaderData.connections.length ? null : (
          <p className="integ-empty">
            No provider connected. Verify Accelevents to preview mappings and
            run audited one-way exports.
          </p>
        )}

        {selected && preview ? (
          <div className="integ-preview">
            <div className="integ-preview-head">
              <div>
                <h3>Mapping preview</h3>
                <p className="help">
                  {preview.summary.create} to create · {preview.summary.update}{" "}
                  to update · {preview.summary.noop} unchanged
                  {preview.summary.blocked
                    ? ` · ${preview.summary.blocked} that Accelevents does not accept`
                    : ""}
                </p>
              </div>
            </div>
            {preview.connection.demoNoWriteFixture ? (
              <div className="validation-item warn" role="status">
                <strong>Demonstration only · provider not called</strong>
                <span>
                  This explicit demo fixture exercises mapping, dry-run and
                  failure/retry UX without credentials. Live export is disabled
                  and no Accelevents success is simulated.
                </span>
              </div>
            ) : null}
            {preview.items.length ? (
              <ul
                className="integ-change-list"
                aria-label="Accelevents export preview"
              >
                {preview.items.map((item) => (
                  <li
                    className="integ-change"
                    key={`${item.entityType}:${item.entityId}`}
                  >
                    <div className="integ-change-copy">
                      <strong>{item.label}</strong>
                      <small>
                        {fieldLabel(item.entityType)} ·{" "}
                        {item.externalId ?? "New"}
                        {item.providerSupport === "blocked" &&
                        item.action !== "noop"
                          ? " · Provider write unavailable"
                          : ""}
                      </small>
                    </div>
                    <div className="integ-change-meta">
                      <DomainStatusBadge
                        domain="integrationChange"
                        status={item.action}
                      />
                    </div>
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
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="integ-empty">
                No published programme records. Publish a schedule with accepted
                speakers before exporting.
              </p>
            )}
            <div className="integ-actions">
              <Form method="post">
                <input type="hidden" name="intent" value="run" />
                <input type="hidden" name="connectionId" value={selected.id} />
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={`dry:${loaderData.nextRunKey}`}
                />
                <input
                  type="hidden"
                  name="previewFingerprint"
                  value={preview.previewFingerprint}
                />
                <Button
                  type="submit"
                  name="mode"
                  value="dry_run"
                  disabled={busy}
                >
                  Record this preview
                </Button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="run" />
                <input type="hidden" name="mode" value="live" />
                <input type="hidden" name="connectionId" value={selected.id} />
                <input
                  type="hidden"
                  name="idempotencyKey"
                  value={`live:${loaderData.nextRunKey}`}
                />
                <input
                  type="hidden"
                  name="previewFingerprint"
                  value={preview.previewFingerprint}
                />
                <Button
                  variant="primary"
                  type="button"
                  disabled={
                    busy ||
                    preview.items.length === 0 ||
                    preview.connection.demoNoWriteFixture
                  }
                  onClick={(event) => {
                    const form = event.currentTarget.form;
                    const blocked = preview.summary.blocked;
                    confirm(
                      {
                        title: "Queue a live export to Accelevents?",
                        description: `The displayed speaker, track, session and association changes are written to Accelevents. This cannot be undone from Program Cue.${blocked ? ` ${blocked} of the listed changes are not something Accelevents accepts; they will be reported as failures rather than quietly skipped.` : ""}`,
                        records: preview.items
                          .filter((item) => item.action !== "noop")
                          .map(
                            (item) =>
                              `${item.label} · ${statusPresentation("integrationChange", item.action).label}`,
                          ),
                        confirmLabel: "Queue live export",
                      },
                      () => form?.requestSubmit(),
                    );
                  }}
                >
                  {preview.connection.demoNoWriteFixture
                    ? "Live export unavailable in demo"
                    : "Queue live export"}
                </Button>
              </Form>
              <Form method="post">
                <input type="hidden" name="intent" value="disconnect" />
                <input type="hidden" name="connectionId" value={selected.id} />
                <Button
                  variant="danger"
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
                </Button>
              </Form>
            </div>
          </div>
        ) : null}
      </section>

      <section className="integ-runs" aria-labelledby="integ-runs-heading">
        <div className="integ-runs-head">
          <h2 id="integ-runs-heading">Recent runs</h2>
          {loaderData.runs.length ? (
            <span className="help">{loaderData.runs.length} recorded</span>
          ) : null}
        </div>
        {loaderData.runs.length ? (
          <ul className="integ-run-list" aria-label="Recent integration runs">
            {loaderData.runs.map((run) => (
              <li className="integ-run" key={run.id}>
                <div className="integ-run-copy">
                  <strong>
                    {providerLabel(run.provider)} ·{" "}
                    {run.dryRun ? "Preview only" : "Live"}
                  </strong>
                  <small>{operationalDateTime(run.createdAt)}</small>
                </div>
                <div className="integ-run-tools">
                  <DomainStatusBadge domain="integration" status={run.status} />
                  <Link
                    to={`/admin/operations?operation=${encodeURIComponent(run.operationId)}`}
                  >
                    Inspect
                  </Link>
                  {isAcceleventsTerminalRunStatus(run.status) &&
                  run.completedAt !== null ? (
                    <a
                      href={`/admin/integrations/accelevents/runs/${encodeURIComponent(run.id)}/reconciliation.csv`}
                    >
                      Download CSV
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="integ-runs-empty">
            No exports yet. Recorded previews and live exports appear here.
          </p>
        )}
      </section>
    </div>
  );
}
