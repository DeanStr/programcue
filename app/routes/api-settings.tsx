import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  Send,
  Trash2,
  Webhook,
  X,
} from "lucide-react";
import { useState } from "react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";
import { useConfirm } from "~/components/ui/confirm-dialog";
import {
  DomainStatusBadge,
  statusPresentation,
} from "~/components/ui/domain-status-badge";
import {
  API_KEY_SCOPES,
  ApiKeyNameConflictError,
  ApiKeyService,
} from "~/platform/api/api-key-service.server";
import { apiKeyLifecycleState } from "~/platform/api/api-key-state";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { outboundWebhookEventTypes } from "~/platform/operations/webhook-schema";
import {
  WebhookEndpointCredentialsErasedError,
  WebhookEndpointNotFoundError,
  WebhookQueueUnavailableError,
  WebhookService,
} from "~/platform/operations/webhook-service.server";
import type { Route } from "./+types/api-settings";

export const meta = () => [{ title: "API & webhooks · Program Cue" }];

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
  return {
    keys: await new ApiKeyService(env).list(viewer),
    webhooks: await new WebhookService(env).list(viewer),
    webhookEventTypes: outboundWebhookEventTypes,
    scopes: API_KEY_SCOPES,
    generatedAt: Math.floor(Date.now() / 1_000),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const service = new ApiKeyService(env);
  const webhookService = new WebhookService(env);
  try {
    if (form.get("intent") === "create") {
      const created = await service.create(viewer, {
        name: form.get("name"),
        scopes: form.getAll("scopes"),
        expiresInDays:
          form.get("expiresInDays") === "" ? null : form.get("expiresInDays"),
      });
      return data({
        ok: true as const,
        message: "API key created. Copy it now; it will not be shown again.",
        token: created.token,
        webhookSecret: null,
        operationId: null,
      });
    }
    if (form.get("intent") === "revoke") {
      await service.revoke(viewer, String(form.get("keyId") ?? ""));
      return data({
        ok: true as const,
        message: "API key revoked.",
        token: null,
        webhookSecret: null,
        operationId: null,
      });
    }
    if (form.get("intent") === "create-webhook") {
      const created = await webhookService.create(viewer, {
        name: form.get("name"),
        url: form.get("url"),
        eventTypes: form.getAll("eventTypes"),
      });
      return data({
        ok: true as const,
        message:
          "Webhook endpoint created. Copy its signing secret now; it will not be shown again.",
        token: null,
        webhookSecret: created.secret,
        operationId: null,
      });
    }
    if (
      form.get("intent") === "enable-webhook" ||
      form.get("intent") === "disable-webhook"
    ) {
      const status =
        form.get("intent") === "enable-webhook" ? "active" : "disabled";
      await webhookService.setStatus(
        viewer,
        String(form.get("endpointId") ?? ""),
        status,
      );
      return data({
        ok: true as const,
        message: `Webhook endpoint ${status === "active" ? "enabled" : "disabled"}.`,
        token: null,
        webhookSecret: null,
        operationId: null,
      });
    }
    if (form.get("intent") === "test-webhook") {
      const queued = await webhookService.queueTest(
        viewer,
        String(form.get("endpointId") ?? ""),
      );
      return data({
        ok: true as const,
        message:
          "Signed webhook test queued. Follow its result in the Operation Centre.",
        token: null,
        webhookSecret: null,
        operationId: queued.operationId,
      });
    }
    return data(
      {
        ok: false as const,
        message: "Unsupported settings action.",
        token: null,
        webhookSecret: null,
        operationId: null,
      },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ApiKeyNameConflictError) {
      return data(
        {
          ok: false as const,
          message: error.message,
          token: null,
          webhookSecret: null,
          operationId: null,
        },
        { status: 409 },
      );
    }
    if (error instanceof WebhookQueueUnavailableError) {
      return data(
        {
          ok: false as const,
          message: error.message,
          token: null,
          webhookSecret: null,
          operationId: error.operationId,
        },
        { status: 503 },
      );
    }
    if (error instanceof WebhookEndpointCredentialsErasedError) {
      return data(
        {
          ok: false as const,
          message: error.message,
          token: null,
          webhookSecret: null,
          operationId: null,
        },
        { status: 409 },
      );
    }
    if (error instanceof WebhookEndpointNotFoundError) {
      return data(
        {
          ok: false as const,
          message: error.message,
          token: null,
          webhookSecret: null,
          operationId: null,
        },
        { status: 404 },
      );
    }
    if (error instanceof ZodError) {
      return data(
        {
          ok: false as const,
          message: error.issues[0]?.message ?? "Review the API key details.",
          token: null,
          webhookSecret: null,
          operationId: null,
        },
        { status: 422 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

function epochLabel(epoch: number | null) {
  return epoch
    ? `${new Intl.DateTimeFormat("en", { dateStyle: "medium", timeZone: "UTC" }).format(new Date(epoch * 1_000))} UTC`
    : "Never";
}

const WEBHOOK_URL_EXAMPLE = "https://hooks.example.com/program-cue";

function SettingsTokenPicker({
  name,
  options,
  addLabel,
}: {
  name: string;
  options: readonly string[];
  addLabel: string;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const remaining = options.filter((option) => !selected.includes(option));
  return (
    <div className="settings-pick-set">
      {selected.length ? (
        <ul className="settings-pick-list">
          {selected.map((value) => (
            <li className="settings-pick" key={value}>
              <input type="hidden" name={name} value={value} />
              <code title={value}>{value}</code>
              <button
                type="button"
                className="settings-pick-remove"
                aria-label={`Remove ${value}`}
                onClick={() =>
                  setSelected((current) =>
                    current.filter((item) => item !== value),
                  )
                }
              >
                <X aria-hidden size={12} />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {remaining.length ? (
        <select
          className="select settings-pick-add"
          aria-label={addLabel}
          value=""
          onChange={(event) => {
            const value = event.target.value;
            if (!value) return;
            setSelected((current) => [...current, value]);
          }}
        >
          <option value="">{addLabel}</option>
          {remaining.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      ) : null}
    </div>
  );
}

export default function ApiSettings({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const { confirm, dialog } = useConfirm();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  const [webhookCopyState, setWebhookCopyState] = useState<
    "idle" | "copied" | "failed"
  >("idle");
  async function copyToken() {
    if (!actionData?.token) return;
    try {
      await navigator.clipboard.writeText(actionData.token);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  async function copyWebhookSecret() {
    if (!actionData?.webhookSecret) return;
    try {
      await navigator.clipboard.writeText(actionData.webhookSecret);
      setWebhookCopyState("copied");
    } catch {
      setWebhookCopyState("failed");
    }
  }
  const activeKeyCount = loaderData.keys.filter(
    (key) => apiKeyLifecycleState(key, loaderData.generatedAt) === "active",
  ).length;
  return (
    <div className="settings-page">
      {dialog}
      <div className="page-head pc-page-header settings-page-head">
        <div>
          <span className="pc-page-eyebrow">Developer access</span>
          <h1>API &amp; webhooks</h1>
          <p>
            Event-scoped credentials with the minimum permissions an integration
            needs.
          </p>
        </div>
        <div className="page-actions">
          <Link className="btn" to="/api/docs">
            API reference
          </Link>
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
            {actionData.token ? (
              <>
                <div className="settings-secret">
                  <code>{actionData.token}</code>
                  <button
                    className="btn small"
                    type="button"
                    onClick={() => void copyToken()}
                  >
                    <Copy aria-hidden size={13} />{" "}
                    {copyState === "copied" ? "Copied" : "Copy"}
                  </button>
                </div>
                {copyState === "failed" ? (
                  <span className="field-error" role="alert">
                    Clipboard access failed. Select and copy the key manually.
                  </span>
                ) : null}
              </>
            ) : null}
            {actionData.webhookSecret ? (
              <>
                <div className="settings-secret">
                  <code>{actionData.webhookSecret}</code>
                  <button
                    className="btn small"
                    type="button"
                    onClick={() => void copyWebhookSecret()}
                  >
                    <Copy aria-hidden size={13} />{" "}
                    {webhookCopyState === "copied" ? "Copied" : "Copy"}
                  </button>
                </div>
                {webhookCopyState === "failed" ? (
                  <span className="field-error" role="alert">
                    Clipboard access failed. Select and copy the secret
                    manually.
                  </span>
                ) : null}
              </>
            ) : null}
            {actionData.operationId ? (
              <p>
                <Link
                  to={`/admin/operations?operation=${encodeURIComponent(actionData.operationId)}`}
                >
                  Open operation {actionData.operationId}
                </Link>
              </p>
            ) : null}
          </div>
        </div>
      ) : null}

      <section className="settings-section" aria-labelledby="settings-keys">
        <header className="settings-section-head">
          <div>
            <h2 id="settings-keys">API keys</h2>
            <p>
              The secret is stored only as a SHA-256 digest and is revealed
              once. {activeKeyCount} active.
            </p>
          </div>
        </header>
        <Form method="post" className="settings-rows">
          <input type="hidden" name="intent" value="create" />
          <div className="settings-row">
            <div className="settings-row-copy">
              <label htmlFor="settings-key-name">Key name</label>
            </div>
            <input
              id="settings-key-name"
              className="field"
              name="name"
              placeholder="Website programme sync"
              required
              minLength={2}
              maxLength={80}
            />
          </div>
          <fieldset className="settings-row settings-row-stack pc-plain-fieldset">
            <legend>Scopes</legend>
            <SettingsTokenPicker
              name="scopes"
              options={loaderData.scopes}
              addLabel="Add scope"
            />
          </fieldset>
          <div className="settings-row settings-row-commit">
            <div className="settings-row-copy">
              <label htmlFor="settings-key-expiry">Expiry</label>
            </div>
            <div className="page-actions">
              <select
                id="settings-key-expiry"
                className="select"
                name="expiresInDays"
                defaultValue="90"
              >
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
                <option value="">No expiry</option>
              </select>
              <button
                type="submit"
                className="btn primary"
                disabled={navigation.state !== "idle"}
              >
                <KeyRound aria-hidden size={14} /> Create key
              </button>
            </div>
          </div>
        </Form>
        {loaderData.keys.length ? (
          <ul className="settings-list" aria-label="Event API credentials">
            {loaderData.keys.map((key) => {
              const lifecycle = apiKeyLifecycleState(
                key,
                loaderData.generatedAt,
              );
              return (
                <li className="settings-item" key={key.id}>
                  <div className="settings-item-copy">
                    <strong>{key.name}</strong>
                    <small>
                      <code>{key.prefix}…</code>
                      {" · "}
                      {key.scopes.join(" · ")}
                    </small>
                    <small>
                      Created {epochLabel(key.createdAt)} · Last used{" "}
                      {epochLabel(key.lastUsedAt)} · Expires{" "}
                      {epochLabel(key.expiresAt)}
                    </small>
                  </div>
                  <div className="settings-item-tools">
                    <span
                      className={`status ${lifecycle === "active" ? "success" : lifecycle === "expired" ? "warn" : "danger"}`}
                    >
                      {lifecycle === "active"
                        ? "Active"
                        : lifecycle === "expired"
                          ? "Expired"
                          : "Revoked"}
                    </span>
                    {!key.revokedAt ? (
                      <Form method="post">
                        <input type="hidden" name="intent" value="revoke" />
                        <input type="hidden" name="keyId" value={key.id} />
                        <button
                          className="btn small danger"
                          aria-label={`Revoke ${key.name}`}
                          type="button"
                          disabled={navigation.state !== "idle"}
                          onClick={(event) => {
                            const form = event.currentTarget.form;
                            confirm(
                              {
                                title: `Revoke ${key.name}?`,
                                description:
                                  "Every integration authenticating with this key stops working immediately. Revocation cannot be undone; issue a replacement key instead.",
                                records: [
                                  `${key.name} · ${key.prefix}… · ${key.scopes.join(", ")}`,
                                ],
                                confirmLabel: "Revoke key",
                              },
                              () => form?.requestSubmit(),
                            );
                          }}
                        >
                          <Trash2 aria-hidden size={13} /> Revoke
                        </button>
                      </Form>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="settings-empty">
            No API keys. Create a narrowly scoped key for a trusted integration.
          </p>
        )}
      </section>

      <section className="settings-section" aria-labelledby="settings-webhooks">
        <header className="settings-section-head">
          <div>
            <h2 id="settings-webhooks">Webhooks</h2>
            <p>
              Program Cue signs each HTTPS request with a per-endpoint HMAC
              secret. Provider work is never simulated.
            </p>
          </div>
        </header>
        <Form method="post" className="settings-rows">
          <input type="hidden" name="intent" value="create-webhook" />
          <div className="settings-row">
            <div className="settings-row-copy">
              <label htmlFor="settings-webhook-name">Endpoint name</label>
            </div>
            <input
              id="settings-webhook-name"
              className="field"
              name="name"
              placeholder="Data warehouse"
              required
              minLength={2}
              maxLength={80}
            />
          </div>
          <div className="settings-row">
            <div className="settings-row-copy">
              <label htmlFor="settings-webhook-url">HTTPS URL</label>
            </div>
            <textarea
              id="settings-webhook-url"
              className="field settings-url-field"
              name="url"
              inputMode="url"
              autoComplete="url"
              rows={2}
              spellCheck={false}
              placeholder={WEBHOOK_URL_EXAMPLE}
              title={WEBHOOK_URL_EXAMPLE}
              required
              onInput={(event) => {
                event.currentTarget.title =
                  event.currentTarget.value || WEBHOOK_URL_EXAMPLE;
              }}
            />
          </div>
          <fieldset className="settings-row settings-row-stack pc-plain-fieldset">
            <legend>Event types</legend>
            <SettingsTokenPicker
              name="eventTypes"
              options={loaderData.webhookEventTypes}
              addLabel="Add event type"
            />
          </fieldset>
          <p className="settings-contract">
            Requests include a stable delivery id, event type, Unix timestamp
            and a <code>v1</code> HMAC-SHA256 signature over{" "}
            <code>timestamp.payload</code>. Reject timestamps outside your
            replay window, deduplicate with the delivery id, and return 2xx only
            after accepting the event. Redirects are not followed. Signing
            secrets are encrypted at rest and shown only once.
          </p>
          <div className="settings-row settings-row-commit">
            <div className="settings-row-copy">
              <span className="sr-only">Create webhook</span>
            </div>
            <div className="page-actions">
              <button
                className="btn primary"
                type="submit"
                disabled={navigation.state !== "idle"}
              >
                <Webhook aria-hidden size={14} /> Create endpoint
              </button>
            </div>
          </div>
        </Form>
        {loaderData.webhooks.length ? (
          <ul className="settings-list" aria-label="Outbound webhook endpoints">
            {loaderData.webhooks.map((endpoint) => (
              <li className="settings-item" key={endpoint.id}>
                <div className="settings-item-copy">
                  <strong>{endpoint.name}</strong>
                  <small>{endpoint.url}</small>
                  <small>
                    {endpoint.eventTypes.length} event
                    {endpoint.eventTypes.length === 1 ? "" : "s"}
                    {endpoint.failureCount
                      ? ` · ${endpoint.failureCount} consecutive failures`
                      : ""}
                    {endpoint.credentialsErased
                      ? " · Signing secret erased; create a new endpoint or rotate the secret before enabling"
                      : ""}
                    {" · "}
                    {endpoint.latestDelivery ? (
                      <>
                        {endpoint.latestDelivery.operationId ? (
                          <Link
                            to={`/admin/operations?operation=${encodeURIComponent(endpoint.latestDelivery.operationId)}`}
                          >
                            {
                              statusPresentation(
                                "webhookDelivery",
                                endpoint.latestDelivery.status,
                              ).label
                            }
                          </Link>
                        ) : (
                          statusPresentation(
                            "webhookDelivery",
                            endpoint.latestDelivery.status,
                          ).label
                        )}
                        {` · ${endpoint.latestDelivery.attemptCount} attempt${endpoint.latestDelivery.attemptCount === 1 ? "" : "s"}`}
                      </>
                    ) : (
                      "Never delivered"
                    )}
                  </small>
                </div>
                <div className="settings-item-tools">
                  <DomainStatusBadge
                    domain="webhookEndpoint"
                    status={endpoint.status}
                  />
                  {endpoint.status !== "disabled" &&
                  !endpoint.credentialsErased ? (
                    <Form method="post">
                      <input type="hidden" name="intent" value="test-webhook" />
                      <input
                        type="hidden"
                        name="endpointId"
                        value={endpoint.id}
                      />
                      <button
                        className="btn small"
                        type="button"
                        disabled={navigation.state !== "idle"}
                        onClick={(event) => {
                          const form = event.currentTarget.form;
                          confirm(
                            {
                              title: `Send a signed test event to ${endpoint.name}?`,
                              description: `Program Cue makes a real signed HTTPS request to ${endpoint.url}. Follow the result in the Operation Centre.`,
                              confirmLabel: "Send test event",
                              tone: "primary",
                            },
                            () => form?.requestSubmit(),
                          );
                        }}
                      >
                        <Send aria-hidden size={13} /> Test
                      </button>
                    </Form>
                  ) : null}
                  {endpoint.credentialsErased ? null : (
                    <Form method="post">
                      <input
                        type="hidden"
                        name="intent"
                        value={
                          endpoint.status === "disabled"
                            ? "enable-webhook"
                            : "disable-webhook"
                        }
                      />
                      <input
                        type="hidden"
                        name="endpointId"
                        value={endpoint.id}
                      />
                      <button
                        className={`btn small${endpoint.status === "disabled" ? "" : " danger"}`}
                        type="submit"
                        disabled={navigation.state !== "idle"}
                      >
                        {endpoint.status === "disabled" ? "Enable" : "Disable"}
                      </button>
                    </Form>
                  )}
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <p className="settings-empty">
            No outbound webhooks. Create an endpoint to deliver signed event
            notifications.
          </p>
        )}
      </section>
    </div>
  );
}
