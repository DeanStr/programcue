import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  KeyRound,
  RefreshCcw,
  ShieldCheck,
  UsersRound,
} from "lucide-react";
import { data, Form, Link, useActionData, useNavigation } from "react-router";

import type { Route } from "./+types/demo-guide";
import { PageHeader } from "~/components/ui/page-header";
import { StatusBadge } from "~/components/ui/status-badge";
import { AiProviderSettingsService } from "~/modules/ai/ai-provider.server";
import {
  emailProviderConfigurationIssue,
  requireEmailProviderConfiguration,
} from "~/modules/communications/email-provider.server";
import {
  DemoResetBusyError,
  DemoResetConfirmationError,
  DemoResetStorageError,
  DemoResetUnavailableError,
  clearDemoEvaluationWorkflow,
  prepareJudgedDemoWorkflow,
  readDemoActiveWork,
  resetDemoEvent,
} from "~/platform/demo/demo-reset.server";
import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_RESET_CONFIRMATION,
  type DemoIdentityKey,
} from "~/platform/demo/demo-identities";
import { resolveDemoIdentityState } from "~/platform/demo/demo-identity.server";
import {
  requireEventRole,
  selectedDemoIdentity,
  type Viewer,
} from "~/platform/auth/authorize.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

const walkthrough = [
  [
    "Command Centre",
    "Open the exact blocker cohorts and readiness actions.",
    "/admin/command",
    "administrator",
  ],
  [
    "Form builder",
    "Edit, preview and publish the seeded call for speakers.",
    "/admin/submissions/form",
    "administrator",
  ],
  [
    "Applicant path",
    "Start a clean SBEK-compatible draft as Priya Raman, add Marcus Okafor and submit.",
    "/apply/form",
    "sbek_speaker",
  ],
  [
    "Review workbench",
    "Score an assigned proposal in the split-pane review flow.",
    "/review/workbench",
    "evaluator",
  ],
  [
    "Evaluation administration",
    "Inspect rounds, assignments and decision previews.",
    "/admin/review",
    "administrator",
  ],
  [
    "Speaker readiness",
    "Complete the profile, resources and dependent task evidence.",
    "/participant/dashboard",
    "speaker",
  ],
  [
    "Communications",
    "Preview a targeted reminder and inspect provider readiness.",
    "/admin/communications",
    "administrator",
  ],
  [
    "Schedule",
    "Use drag or keyboard placement, validate and publish.",
    "/admin/schedule",
    "administrator",
  ],
  [
    "Public programme",
    "Try gallery filters, itinerary, calendar and embed links.",
    "/public/programme/future-of-events-2025",
    "administrator",
  ],
  [
    "Integrations",
    "Run an honest dry run; unavailable providers stay labelled.",
    "/admin/integrations",
    "administrator",
  ],
  [
    "Event assistant",
    "Inspect context and approve a bounded task action.",
    "/admin/assistant",
    "administrator",
  ],
  [
    "Operations",
    "Inspect durable progress, item results and retry state.",
    "/admin/operations",
    "administrator",
  ],
] as const;

function assertDemoRoute(env: CloudflareEnvironment) {
  if (
    String(env.DEMO_MODE) !== "true" ||
    env.APP_ENV === "production" ||
    env.DEFAULT_EVENT_ID !== DEMO_EVENT_ID
  ) {
    throw new Response("Evaluator demo guide not found", { status: 404 });
  }
}

async function authorizedDemoViewer(
  request: Request,
  context: Route.ActionArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  assertDemoRoute(env);
  const viewer = await requireEventRole(request, env, DEMO_EVENT_ID, [
    "owner",
    "administrator",
    "evaluator",
    "submitter",
    "speaker",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  assertDemoRoute(env);
  const selected = selectedDemoIdentity(request);
  const requestedReturnTo = safeReturnTo(
    new URL(request.url).searchParams.get("returnTo"),
  );
  const emailConfigurationIssue = emailProviderConfigurationIssue(env);
  const emailProvider = emailConfigurationIssue
    ? null
    : requireEmailProviderConfiguration(env);
  const [baselineState, activeWork, connections, verifiedSender, aiProvider] =
    await Promise.all([
      prepareJudgedDemoWorkflow(env),
      readDemoActiveWork(env),
      env.DB.prepare(
        `SELECT provider, status,
              length(trim(encrypted_credentials)) > 0 AS hasCredentials
         FROM integration_connections
        WHERE event_id = ? ORDER BY provider`,
      )
        .bind(DEMO_EVENT_ID)
        .all<{ provider: string; status: string; hasCredentials: number }>(),
      env.DB.prepare(
        `SELECT id FROM sender_profiles
        WHERE event_id = ? AND provider = ? AND status = 'verified'
        LIMIT 1`,
      )
        .bind(
          DEMO_EVENT_ID,
          emailProvider?.provider ?? "email-provider-unavailable",
        )
        .first<{ id: string }>(),
      new AiProviderSettingsService(env).readiness({
        personId: DEMO_IDENTITIES.administrator.personId,
        name: DEMO_IDENTITIES.administrator.name,
        email: DEMO_IDENTITIES.administrator.email,
        role: "administrator",
        organisationId: "org-future-events",
        eventId: DEMO_EVENT_ID,
        demo: true,
      } satisfies Viewer),
    ]);
  const integrationCredentialsConfigured = Boolean(
    env.INTEGRATION_CREDENTIALS_KEY?.trim(),
  );
  const selectedState = selected
    ? await resolveDemoIdentityState(env, selected.identityKey)
    : null;
  return {
    viewer: selected
      ? {
          identityKey: selected.identityKey,
          name: selected.identity.name,
          role: selectedState!.role,
          destination: selectedState!.destination,
          cohort: selected.identity.cohort,
        }
      : null,
    returnTo: requestedReturnTo === "/" ? null : requestedReturnTo,
    baseline: baselineState.evidence,
    baselineComplete: baselineState.complete,
    activeWork,
    providerConfiguration: {
      airtable:
        connections.results.some(
          (connection) =>
            connection.provider === "airtable_repository" &&
            connection.status === "connected" &&
            Boolean(connection.hasCredentials),
        ) && integrationCredentialsConfigured,
      accelevents:
        connections.results.some(
          (connection) =>
            connection.provider === "accelevents" &&
            connection.status === "connected" &&
            Boolean(connection.hasCredentials),
        ) && integrationCredentialsConfigured,
      email: Boolean(!emailConfigurationIssue && verifiedSender),
      calendar: Boolean(
        env.CALENDAR_CREDENTIALS_KEY?.trim() &&
        ((env.GOOGLE_CALENDAR_CLIENT_ID?.trim() &&
          env.GOOGLE_CALENDAR_CLIENT_SECRET?.trim()) ||
          (env.MICROSOFT_CALENDAR_CLIENT_ID?.trim() &&
            env.MICROSOFT_CALENDAR_CLIENT_SECRET?.trim())),
      ),
      ai: aiProvider.configured,
    },
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env, viewer } = await authorizedDemoViewer(request, context);
  if (viewer.role !== "owner" && viewer.role !== "administrator") {
    throw new Response(
      "Only the demo owner or administrator can reset the event",
      {
        status: 403,
      },
    );
  }
  const form = await request.formData();
  if (form.get("intent") === "clear-evaluation") {
    try {
      const result = await clearDemoEvaluationWorkflow(
        env,
        form.get("confirmation"),
      );
      return data({
        ok: true as const,
        committed: true,
        message:
          "The demo evaluation graph was cleared for a focused acceptance workflow.",
        result,
      });
    } catch (error) {
      if (error instanceof DemoResetConfirmationError) {
        return data(
          {
            ok: false as const,
            committed: false,
            message: error.message,
            result: null,
          },
          { status: 422 },
        );
      }
      throw error;
    }
  }
  if (form.get("intent") !== "reset") {
    return data(
      {
        ok: false as const,
        committed: false,
        message: "Unsupported demo action.",
        result: null,
      },
      { status: 400 },
    );
  }
  try {
    const result = await resetDemoEvent(
      env,
      viewer.personId,
      form.get("confirmation"),
    );
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "event",
      entityId: viewer.eventId,
      changeType: "updated",
    });
    if (realtimeFailure) {
      return data(
        {
          ok: false as const,
          committed: true,
          message: `The D1/R2 demo reset committed. ${realtimeFailure.message}`,
          result,
        },
        { status: 207 },
      );
    }
    return data({
      ok: true as const,
      committed: true,
      message:
        "The D1 event and private demo file prefix were restored to the judged baseline.",
      result,
    });
  } catch (error) {
    if (error instanceof DemoResetBusyError) {
      return data(
        {
          ok: false as const,
          committed: false,
          message: error.message,
          result: { activeWork: error.activeWork },
        },
        { status: 409, headers: { "Retry-After": "2" } },
      );
    }
    if (error instanceof DemoResetConfirmationError) {
      return data(
        {
          ok: false as const,
          committed: false,
          message: error.message,
          result: null,
        },
        { status: 422 },
      );
    }
    if (error instanceof DemoResetStorageError) {
      return data(
        {
          ok: false as const,
          committed: true,
          message: error.message,
          result: null,
        },
        { status: 503 },
      );
    }
    if (error instanceof DemoResetUnavailableError) {
      throw new Response("Evaluator demo guide not found", { status: 404 });
    }
    throw error;
  }
}

export const meta: Route.MetaFunction = () => [
  { title: "Evaluator guide · Program Cue" },
];

function providerState(configured: boolean, configuredCopy: string) {
  return configured
    ? { tone: "success" as const, label: "Configured", copy: configuredCopy }
    : {
        tone: "neutral" as const,
        label: "Not configured",
        copy: "No success is simulated. The relevant workflow fails explicitly or remains a dry run.",
      };
}

export default function DemoGuide({ loaderData }: Route.ComponentProps) {
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  const activeTotal = Object.values(loaderData.activeWork).reduce(
    (sum, count) => sum + count,
    0,
  );
  const providers = [
    [
      "Airtable",
      providerState(
        loaderData.providerConfiguration.airtable,
        "A credential-bearing Airtable connection is stored as connected for this event; use Integrations to test it.",
      ),
    ],
    [
      "Accelevents",
      providerState(
        loaderData.providerConfiguration.accelevents,
        "A credential-bearing connection is stored as connected; use Integrations to run a dry run before confirming export.",
      ),
    ],
    [
      "Email",
      providerState(
        loaderData.providerConfiguration.email,
        "The explicitly selected email provider and a verified event sender are configured; delivery results remain visible in Operations.",
      ),
    ],
    [
      "Calendar",
      providerState(
        loaderData.providerConfiguration.calendar,
        "A complete calendar OAuth client and credential-encryption key are configured.",
      ),
    ],
    [
      "AI",
      providerState(
        loaderData.providerConfiguration.ai,
        "An OpenAI API key is present; generated output remains advisory until approved.",
      ),
    ],
  ] as const;
  const selectedIdentity = loaderData.viewer;

  return (
    <main id="main" className="design-board pc-design-board">
      <PageHeader
        eyebrow="Environment-gated evaluator mode"
        title="Try the complete conference workflow"
        description={
          selectedIdentity
            ? `You selected ${selectedIdentity.name} (${selectedIdentity.role}). D1 interactions persist until an explicit reset; external providers are never impersonated.`
            : "Choose a task or browse the published programme anonymously. Private workspaces do not silently assign an administrator identity."
        }
        actions={
          selectedIdentity ? (
            <Link className="btn primary" to={selectedIdentity.destination}>
              Continue as {selectedIdentity.name}{" "}
              <ArrowRight aria-hidden size={15} />
            </Link>
          ) : (
            <Link
              className="btn primary"
              to="/public/programme/future-of-events-2025"
            >
              Browse anonymously <ArrowRight aria-hidden size={15} />
            </Link>
          )
        }
      />

      {result ? (
        <div
          className={`pc-status-notice ${result.ok ? "is-success" : "is-danger"} mb`}
          role={result.ok ? "status" : "alert"}
        >
          {result.ok ? (
            <CheckCircle2 aria-hidden size={18} />
          ) : (
            <Activity aria-hidden size={18} />
          )}
          <div className="pc-status-notice-copy">
            <strong>
              {result.ok
                ? "Demo restored"
                : result.committed
                  ? "Reset needs follow-up"
                  : "Reset blocked"}
            </strong>
            <div>{result.message}</div>
          </div>
        </div>
      ) : null}

      <section className="card design-section pc-design-wide mb">
        <div className="pc-section-heading">
          <div>
            <span className="pc-section-kicker">Start here</span>
            <h2>Choose a test identity</h2>
          </div>
          <p>
            Demo authentication uses an HttpOnly identity cookie. These people
            have no password and cannot authenticate against production. The
            SBEK speaker and reviewer begin without accepted speaker or
            evaluator access.
          </p>
        </div>
        <div className="table-wrap pc-responsive-table-wrap">
          <table className="data-table pc-responsive-table">
            <thead>
              <tr>
                <th>Purpose</th>
                <th>Identity</th>
                <th>Email</th>
                <th>Entry point</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(DEMO_IDENTITIES).map(
                ([identityKey, identity]) => (
                  <tr key={identityKey}>
                    <td data-label="Purpose">
                      <StatusBadge
                        tone={
                          identityKey === selectedIdentity?.identityKey
                            ? "success"
                            : identity.cohort === "sbek"
                              ? "info"
                              : "neutral"
                        }
                      >
                        {identityKey.replaceAll("_", " ")}
                      </StatusBadge>
                    </td>
                    <td data-label="Identity">
                      <strong>{identity.name}</strong>
                    </td>
                    <td data-label="Email">
                      <code>{identity.email}</code>
                    </td>
                    <td data-label="Entry point">
                      <Form method="post" action="/demo/role">
                        <input
                          type="hidden"
                          name="identity"
                          value={identityKey}
                        />
                        {loaderData.returnTo ? (
                          <input
                            type="hidden"
                            name="returnTo"
                            value={loaderData.returnTo}
                          />
                        ) : null}
                        <button className="btn small" type="submit">
                          Continue as {identity.name}{" "}
                          <ArrowRight aria-hidden size={13} />
                        </button>
                      </Form>
                    </td>
                  </tr>
                ),
              )}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid grid-2 mb">
        <section className="card design-section">
          <div className="pc-section-heading">
            <div>
              <span className="pc-section-kicker">Guided checklist</span>
              <h2>What to try</h2>
            </div>
          </div>
          <ol className="stack">
            {walkthrough.map(([title, copy, href, identityKey], index) => (
              <li className="card pad" key={title}>
                <div className="card-title">
                  <StatusBadge tone="info">{index + 1}</StatusBadge>
                  <h3>{title}</h3>
                </div>
                <p className="subtle">{copy}</p>
                <div className="page-actions">
                  <Form method="post" action="/demo/role">
                    <input
                      type="hidden"
                      name="identity"
                      value={identityKey satisfies DemoIdentityKey}
                    />
                    <input type="hidden" name="returnTo" value={href} />
                    <button className="btn small" type="submit">
                      Open as {DEMO_IDENTITIES[identityKey].name}{" "}
                      <ArrowRight aria-hidden size={13} />
                    </button>
                  </Form>
                </div>
              </li>
            ))}
          </ol>
        </section>

        <div className="stack">
          <section className="card design-section">
            <div className="pc-section-heading">
              <div>
                <span className="pc-section-kicker">Real seeded state</span>
                <h2>Judged baseline</h2>
              </div>
              <StatusBadge
                tone={loaderData.baselineComplete ? "success" : "warning"}
              >
                {loaderData.baselineComplete ? "Ready" : "Changed"}
              </StatusBadge>
            </div>
            <div className="grid grid-3">
              {Object.entries(loaderData.baseline).map(([label, count]) => (
                <div className="metric card" key={label}>
                  <div className="label">
                    {label.replace(/([A-Z])/g, " $1")}
                  </div>
                  <div className="value">{count}</div>
                </div>
              ))}
            </div>
            <p className="help mt">
              Forms, assigned proposals, speaker tasks, a published reminder
              template, sessions and the published schedule are real
              event-scoped D1 records.{" "}
              {loaderData.baselineComplete
                ? "The judged baseline is ready."
                : "The evaluator has changed the baseline; use the explicit reset below when ready."}
            </p>
          </section>

          <section className="card design-section">
            <div className="pc-section-heading">
              <div>
                <span className="pc-section-kicker">Evidence boundary</span>
                <h2>Provider truth</h2>
              </div>
              <ShieldCheck aria-hidden size={20} />
            </div>
            <div className="stack">
              {providers.map(([name, state]) => (
                <div className="card pad" key={name}>
                  <div className="card-title">
                    <h3>{name}</h3>
                    <span className="right">
                      <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                    </span>
                  </div>
                  <p className="subtle">{state.copy}</p>
                </div>
              ))}
            </div>
            <p className="help mt">
              <ExternalLink aria-hidden size={13} /> Sandbox credentials and a
              separately provisioned Airtable-backed evaluator event remain
              deployment configuration, not repository-simulated evidence.
            </p>
          </section>

          <section className="card design-section">
            <div className="pc-section-heading">
              <div>
                <span className="pc-section-kicker">
                  Destructive demo action
                </span>
                <h2>Reset the event</h2>
              </div>
              <RefreshCcw aria-hidden size={20} />
            </div>
            <p>
              This removes event-scoped D1 work, clears{" "}
              <code>private/events/{DEMO_EVENT_ID}/</code> in R2, preserves
              append-only audit history and reseeds the judged workflow.
            </p>
            <p>
              <StatusBadge tone={activeTotal ? "warning" : "success"}>
                {activeTotal
                  ? `${activeTotal} active work item(s)`
                  : "No active work"}
              </StatusBadge>
            </p>
            {activeTotal ? (
              <ul className="help">
                {Object.entries(loaderData.activeWork)
                  .filter(([, count]) => count > 0)
                  .map(([kind, count]) => (
                    <li key={kind}>
                      {kind.replace(/([A-Z])/g, " $1")}: {count}
                    </li>
                  ))}
              </ul>
            ) : null}
            {selectedIdentity?.role === "owner" ||
            selectedIdentity?.role === "administrator" ? (
              <Form
                method="post"
                className="stack"
                onSubmit={(event) => {
                  if (
                    !window.confirm("Reset the complete evaluator event now?")
                  )
                    event.preventDefault();
                }}
              >
                <input type="hidden" name="intent" value="reset" />
                <label className="label">
                  Type <strong>{DEMO_RESET_CONFIRMATION}</strong> to confirm
                  <input
                    className="field"
                    name="confirmation"
                    autoComplete="off"
                    required
                  />
                </label>
                <button
                  className="btn danger"
                  type="submit"
                  disabled={busy || activeTotal > 0}
                >
                  <RefreshCcw aria-hidden size={14} />{" "}
                  {busy ? "Restoring demo…" : "Reset complete demo event"}
                </button>
              </Form>
            ) : (
              <p className="help">
                <KeyRound aria-hidden size={13} /> Switch to the owner or
                administrator identity to reset.
              </p>
            )}
          </section>
        </div>
      </div>

      <p className="help">
        <UsersRound aria-hidden size={13} /> This route returns 404 unless an
        explicit non-production demo runtime and the fixed evaluator event
        binding are active.
      </p>
    </main>
  );
}
