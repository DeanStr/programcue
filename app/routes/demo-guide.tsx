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
import {
  data,
  Form,
  Link,
  useActionData,
  useNavigation,
  useSubmit,
} from "react-router";
import { useConfirm } from "~/components/ui/confirm-dialog";
import { PageHeader } from "~/components/ui/page-header";
import { StatusBadge } from "~/components/ui/status-badge";
import { requireValue } from "~/lib/required-value";
import { AiProviderSettingsService } from "~/modules/ai/ai-provider.server";
import {
  emailProviderConfigurationIssue,
  requireEmailProviderConfiguration,
} from "~/modules/communications/email-provider.server";
import {
  PROGRAMME_WORKFLOW_PHASES,
  type ProgrammeWorkflowPhaseKey,
} from "~/modules/readiness/programme-workflow-phases";
import {
  requireEventRole,
  selectedDemoIdentity,
  type Viewer,
} from "~/platform/auth/authorize.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_RESET_CONFIRMATION,
  type DemoIdentityKey,
} from "~/platform/demo/demo-identities";
import { resolveDemoIdentityState } from "~/platform/demo/demo-identity.server";
import {
  clearDemoEvaluationWorkflow,
  DemoResetBusyError,
  DemoResetConfirmationError,
  DemoResetStorageError,
  DemoResetUnavailableError,
  prepareJudgedDemoWorkflow,
  readDemoActiveWork,
  resetDemoEvent,
} from "~/platform/demo/demo-reset.server";
import { EventRealtimeService } from "~/platform/realtime/event-realtime.server";
import "~/styles/workspace-demo.css";
import type { Route } from "./+types/demo-guide";

type DemoWalkthroughStep = {
  phase: ProgrammeWorkflowPhaseKey;
  title: string;
  copy: string;
  href: string;
  identityKey: DemoIdentityKey;
  evidence?: boolean;
};

const walkthrough: ReadonlyArray<DemoWalkthroughStep> = [
  {
    phase: "setup",
    title: "Command Centre",
    copy: "Open the exact blocker cohorts and readiness actions.",
    href: "/admin/command",
    identityKey: "administrator",
  },
  {
    phase: "setup",
    title: "Form builder",
    copy: "Edit, preview and publish the seeded call for speakers.",
    href: "/admin/submissions/form",
    identityKey: "administrator",
  },
  {
    phase: "setup",
    title: "Applicant path",
    copy: "Start a clean SBEK-compatible draft as Priya Raman, add Marcus Okafor and submit.",
    href: "/apply/form",
    identityKey: "sbek_speaker",
  },
  {
    phase: "decide",
    title: "Review workbench",
    copy: "Score an assigned proposal in the split-pane review flow.",
    href: "/review/workbench",
    identityKey: "evaluator",
  },
  {
    phase: "decide",
    title: "Evaluation administration",
    copy: "Inspect rounds, assignments and decision previews.",
    href: "/admin/review",
    identityKey: "administrator",
  },
  {
    phase: "prepare",
    title: "Speaker readiness",
    copy: "Complete the profile, resources and dependent task evidence.",
    href: "/participant/dashboard",
    identityKey: "speaker",
  },
  {
    phase: "prepare",
    title: "Communications",
    copy: "Preview a targeted reminder and inspect provider readiness.",
    href: "/admin/communications",
    identityKey: "administrator",
  },
  {
    phase: "prepare",
    title: "Schedule",
    copy: "Use drag or keyboard placement, validate and publish.",
    href: "/admin/schedule",
    identityKey: "administrator",
  },
  {
    phase: "publish",
    title: "Public programme",
    copy: "Try gallery filters, itinerary, calendar and embed links.",
    href: "/public/programme/future-of-events-2027",
    identityKey: "administrator",
  },
  {
    phase: "publish",
    title: "Integrations",
    copy: "Run an honest dry run; unavailable providers stay labelled.",
    href: "/admin/integrations",
    identityKey: "administrator",
    evidence: true,
  },
  {
    phase: "publish",
    title: "Event assistant",
    copy: "Inspect context and approve a bounded task action.",
    href: "/admin/assistant",
    identityKey: "administrator",
    evidence: true,
  },
  {
    phase: "publish",
    title: "Operations",
    copy: "Inspect durable progress, item results and retry state.",
    href: "/admin/operations",
    identityKey: "administrator",
    evidence: true,
  },
];

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
          role: requireValue(
            selectedState,
            "Required selectedState is unavailable.",
          ).role,
          destination: requireValue(
            selectedState,
            "Required selectedState is unavailable.",
          ).destination,
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
    /* A reset replaces the event-change timeline that the current Durable
       Object cursor describes. Persist a fresh polling cursor, but do not
       publish it through that stale channel: local Workerd can leave the
       publish blocked behind a pre-reset socket forever. */
    await new EventRealtimeService(env).commitChange(viewer, {
      entityType: "event",
      entityId: viewer.eventId,
      changeType: "updated",
    });
    return data({
      ok: true as const,
      committed: true,
      message:
        "The D1 event and private demo file prefix were restored to the judged baseline. Refresh other open views before continuing.",
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
  const submit = useSubmit();
  const { confirm, dialog } = useConfirm();
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
    <main
      id="main"
      className="design-board pc-design-board pc-demo"
      tabIndex={-1}
    >
      {dialog}
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
              to="/public/programme/future-of-events-2027"
            >
              Browse anonymously <ArrowRight aria-hidden size={15} />
            </Link>
          )
        }
      />

      {result ? (
        <div
          className={`pc-status-notice ${result.ok ? "is-success" : "is-danger"}`}
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

      <section className="pc-demo-identities">
        <div className="pc-demo-section-head">
          <h2>Choose a test identity</h2>
          <p>
            Demo authentication uses an HttpOnly identity cookie. These people
            have no password and cannot authenticate against production. The
            SBEK speaker and reviewer begin without accepted speaker or
            evaluator access.
          </p>
        </div>
        <section
          className="table-wrap pc-responsive-table-wrap"
          aria-label="Demo test identities"
          // biome-ignore lint/a11y/noNoninteractiveTabindex: Scrollable data regions need keyboard focus so arrow keys can expose overflow content.
          tabIndex={0}
        >
          <table className="data-table pc-responsive-table pc-demo-identity-table">
            <thead>
              <tr>
                <th scope="col">Purpose</th>
                <th scope="col">Identity</th>
                <th scope="col">Email</th>
                <th scope="col">Entry point</th>
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
        </section>
      </section>

      <div className="pc-demo-layout">
        <section
          aria-labelledby="demo-walkthrough-heading"
          className="pc-demo-walkthrough"
        >
          <div className="pc-demo-section-head">
            <h2 id="demo-walkthrough-heading">Follow the programme story</h2>
            <p>
              Complete the core path in order. The final phase also exposes
              optional technical evidence after the public result.
            </p>
          </div>
          <ol className="pc-demo-path">
            {PROGRAMME_WORKFLOW_PHASES.map((phase, phaseIndex) => (
              <li className="pc-demo-phase" key={phase.key}>
                <div className="pc-demo-phase-head">
                  <span className="pc-demo-phase-index">{phaseIndex + 1}</span>
                  <div>
                    <h3>{phase.label}</h3>
                    <p>{phase.description}</p>
                  </div>
                </div>
                <ol className="pc-demo-steps">
                  {walkthrough
                    .filter((step) => step.phase === phase.key)
                    .map((step) => (
                      <li className="pc-demo-step" key={step.title}>
                        <div className="pc-demo-step-copy">
                          <div className="pc-demo-step-meta">
                            <h4>{step.title}</h4>
                            {step.evidence ? (
                              <StatusBadge tone="neutral">
                                Technical evidence
                              </StatusBadge>
                            ) : null}
                          </div>
                          <p>{step.copy}</p>
                        </div>
                        <Form method="post" action="/demo/role">
                          <input
                            type="hidden"
                            name="identity"
                            value={step.identityKey}
                          />
                          <input
                            type="hidden"
                            name="returnTo"
                            value={step.href}
                          />
                          <button className="btn small" type="submit">
                            Open as {DEMO_IDENTITIES[step.identityKey].name}{" "}
                            <ArrowRight aria-hidden size={13} />
                          </button>
                        </Form>
                      </li>
                    ))}
                </ol>
              </li>
            ))}
          </ol>
        </section>

        <aside className="pc-demo-rail">
          <section className="pc-demo-rail-block">
            <div className="pc-demo-rail-head">
              <h2>Judged baseline</h2>
              <StatusBadge
                tone={loaderData.baselineComplete ? "success" : "warning"}
              >
                {loaderData.baselineComplete ? "Ready" : "Changed"}
              </StatusBadge>
            </div>
            <p className="pc-demo-pulse">
              {(
                [
                  ["forms", "forms"],
                  ["submissions", "submissions"],
                  ["assignments", "assignments"],
                  ["tasks", "tasks"],
                  ["sessions", "sessions"],
                  ["publishedSchedules", "published schedules"],
                  ["publishedTemplates", "templates"],
                ] as const
              ).map(([key, label]) => (
                <span key={key}>
                  <strong>{loaderData.baseline[key]}</strong> {label}
                </span>
              ))}
            </p>
            <details className="pc-demo-baseline-more">
              <summary>All baseline counts</summary>
              <p className="pc-demo-pulse">
                {Object.entries(loaderData.baseline).map(([label, count]) => (
                  <span key={label}>
                    <strong>{count}</strong> {label.replace(/([A-Z])/g, " $1")}
                  </span>
                ))}
              </p>
            </details>
            <p className="help">
              Forms, assigned proposals, speaker tasks, a published reminder
              template, sessions and the published schedule are real
              event-scoped D1 records.{" "}
              {loaderData.baselineComplete
                ? "The judged baseline is ready."
                : "The evaluator has changed the baseline; use the explicit reset below when ready."}
            </p>
          </section>

          <section className="pc-demo-rail-block">
            <div className="pc-demo-rail-head">
              <h2>Provider truth</h2>
              <ShieldCheck aria-hidden size={16} />
            </div>
            <ul className="pc-demo-providers">
              {providers.map(([name, state]) => (
                <li key={name}>
                  <strong>{name}</strong>
                  <StatusBadge tone={state.tone}>{state.label}</StatusBadge>
                  <p>{state.copy}</p>
                </li>
              ))}
            </ul>
            <p className="help">
              <ExternalLink aria-hidden size={13} /> Sandbox credentials and a
              separately provisioned Airtable-backed evaluator event remain
              deployment configuration, not repository-simulated evidence.
            </p>
          </section>

          <section className="pc-demo-rail-block pc-demo-reset">
            <div className="pc-demo-rail-head">
              <h2>Reset the event</h2>
              <RefreshCcw aria-hidden size={16} />
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
              <ul className="pc-demo-work">
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
                  event.preventDefault();
                  if (busy || activeTotal > 0) return;
                  const form = event.currentTarget;
                  confirm(
                    {
                      title: "Reset the complete evaluator event?",
                      description: `Event-scoped D1 work and everything under private/events/${DEMO_EVENT_ID}/ in R2 are removed, then the judged baseline is reseeded. Append-only audit history is preserved.`,
                      confirmLabel: "Reset demo event",
                    },
                    () => submit(form),
                  );
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
        </aside>
      </div>

      <p className="help">
        <UsersRound aria-hidden size={13} /> This route returns 404 unless an
        explicit non-production demo runtime and the fixed evaluator event
        binding are active.
      </p>
    </main>
  );
}
