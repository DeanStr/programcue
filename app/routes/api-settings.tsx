import {
  AlertTriangle,
  CheckCircle2,
  Copy,
  KeyRound,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import { useState } from "react";
import { data, Form, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/api-settings";
import { apiKeyLifecycleState } from "~/platform/api/api-key-state";
import {
  API_KEY_SCOPES,
  ApiKeyNameConflictError,
  ApiKeyService,
} from "~/platform/api/api-key-service.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export const meta = () => [{ title: "API & Settings · Program Cue" }];

async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  return {
    keys: await new ApiKeyService(env).list(viewer),
    scopes: API_KEY_SCOPES,
    generatedAt: Math.floor(Date.now() / 1_000),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  const service = new ApiKeyService(env);
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
      });
    }
    if (form.get("intent") === "revoke") {
      await service.revoke(viewer, String(form.get("keyId") ?? ""));
      return data({
        ok: true as const,
        message: "API key revoked.",
        token: null,
      });
    }
    return data(
      {
        ok: false as const,
        message: "Unsupported settings action.",
        token: null,
      },
      { status: 400 },
    );
  } catch (error) {
    if (error instanceof ApiKeyNameConflictError) {
      return data(
        { ok: false as const, message: error.message, token: null },
        { status: 409 },
      );
    }
    if (error instanceof ZodError) {
      return data(
        {
          ok: false as const,
          message: error.issues[0]?.message ?? "Review the API key details.",
          token: null,
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

export default function ApiSettings({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  async function copyToken() {
    if (!actionData?.token) return;
    try {
      await navigator.clipboard.writeText(actionData.token);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }
  const activeKeyCount = loaderData.keys.filter(
    (key) => apiKeyLifecycleState(key, loaderData.generatedAt) === "active",
  ).length;
  return (
    <>
      <div className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Developer access</span>
          <h1>API &amp; settings</h1>
          <p>
            Create event-scoped credentials with the minimum permissions an
            integration needs.
          </p>
        </div>
        <div className="page-actions">
          <a className="btn" href="/api/docs">
            API reference
          </a>
          <span className="status info">
            <ShieldCheck aria-hidden size={14} /> Scoped credentials
          </span>
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
            {actionData.token ? (
              <>
                <div className="api-secret">
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
          </div>
        </div>
      ) : null}
      <div className="grid grid-2 api-settings-grid">
        <section className="card pad">
          <div className="card-title">
            <h2>Create an API key</h2>
            <KeyRound aria-hidden size={19} />
          </div>
          <p className="subtle">
            The secret is stored only as a SHA-256 digest and is revealed once.
          </p>
          <Form method="post" className="stack">
            <input type="hidden" name="intent" value="create" />
            <label className="label">
              Key name
              <input
                className="field"
                name="name"
                placeholder="Website programme sync"
                required
                minLength={2}
                maxLength={80}
              />
            </label>
            <fieldset>
              <legend className="label">Scopes</legend>
              <div className="api-scope-list">
                {loaderData.scopes.map((scope) => (
                  <label className="speaker-confirm" key={scope}>
                    <input type="checkbox" name="scopes" value={scope} />{" "}
                    <code>{scope}</code>
                  </label>
                ))}
              </div>
            </fieldset>
            <label className="label">
              Expiry
              <select className="select" name="expiresInDays" defaultValue="90">
                <option value="30">30 days</option>
                <option value="90">90 days</option>
                <option value="365">1 year</option>
                <option value="">No expiry</option>
              </select>
            </label>
            <button
              className="btn primary"
              disabled={navigation.state !== "idle"}
            >
              <KeyRound aria-hidden size={14} /> Create key
            </button>
          </Form>
        </section>
        <section className="card pad">
          <div className="card-title">
            <h2>Event credentials</h2>
            <span className="status neutral">{activeKeyCount} active</span>
          </div>
          {loaderData.keys.length ? (
            <div className="table-wrap">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Prefix and scopes</th>
                    <th>Activity</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {loaderData.keys.map((key) => {
                    const lifecycle = apiKeyLifecycleState(
                      key,
                      loaderData.generatedAt,
                    );
                    return (
                      <tr key={key.id}>
                        <td>
                          <strong>{key.name}</strong>
                          <small className="subtle">
                            Created {epochLabel(key.createdAt)}
                          </small>
                        </td>
                        <td>
                          <code>{key.prefix}…</code>
                          <small className="subtle">
                            {key.scopes.join(" · ")}
                          </small>
                        </td>
                        <td>
                          <span
                            className={`status ${lifecycle === "active" ? "success" : lifecycle === "expired" ? "warn" : "danger"}`}
                          >
                            {lifecycle === "active"
                              ? "Active"
                              : lifecycle === "expired"
                                ? "Expired"
                                : "Revoked"}
                          </span>
                          <small className="subtle">
                            Last used: {epochLabel(key.lastUsedAt)}
                            <br />
                            Expires: {epochLabel(key.expiresAt)}
                          </small>
                        </td>
                        <td>
                          {!key.revokedAt ? (
                            <Form
                              method="post"
                              onSubmit={(event) => {
                                if (
                                  !window.confirm(
                                    `Revoke ${key.name}? Existing integrations using this key will stop working.`,
                                  )
                                )
                                  event.preventDefault();
                              }}
                            >
                              <input
                                type="hidden"
                                name="intent"
                                value="revoke"
                              />
                              <input
                                type="hidden"
                                name="keyId"
                                value={key.id}
                              />
                              <button
                                className="btn small danger"
                                aria-label={`Revoke ${key.name}`}
                                disabled={navigation.state !== "idle"}
                              >
                                <Trash2 aria-hidden size={13} /> Revoke
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
              <KeyRound aria-hidden size={28} />
              <h2>No API keys</h2>
              <p>Create a narrowly scoped key for a trusted integration.</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
