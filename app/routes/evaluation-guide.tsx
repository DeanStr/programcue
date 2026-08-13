import {
  ArrowRight,
  CalendarDays,
  ExternalLink,
  KeyRound,
  ShieldCheck,
} from "lucide-react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useNavigation,
} from "react-router";

import type { Route } from "./+types/evaluation-guide";
import { BrandMark } from "~/components/brand-mark";
import {
  currentEventCookie,
  clearCurrentEventCookie,
} from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  EVALUATION_EVENT_ID,
  EVALUATION_EVENT_NAME,
  EVALUATION_IDENTITIES,
  EVALUATION_ORGANISATION_ID,
  clearEvaluationSessionCookie,
  evaluationAccessCodeMatches,
  evaluationSessionCookie,
  isEvaluationIdentityKey,
  readEvaluationSession,
  requireEvaluationMode,
  resolveEvaluationPerson,
} from "~/platform/evaluation/evaluation-session.server";
import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicRateLimit,
} from "~/platform/http/public-abuse-protection.server";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";

type ActionResult = { ok: false; message: string };

export const meta = () => [{ title: "Evaluation access · Program Cue" }];
export const headers: Route.HeadersFunction = () => ({
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
});

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  requireEvaluationMode(env);
  const session = await readEvaluationSession(request, env);
  const selected = session?.identityKey
    ? await resolveEvaluationPerson(env, session.identityKey)
    : null;
  return {
    unlocked: Boolean(session),
    eventName: EVALUATION_EVENT_NAME,
    selected: selected
      ? {
          identityKey: selected.identityKey,
          name: selected.name,
          label: selected.definition.label,
        }
      : null,
    identities: Object.entries(EVALUATION_IDENTITIES).map(
      ([key, identity]) => ({
        key,
        label: identity.label,
        name: identity.name,
        description: identity.description,
        destination: identity.destination,
        whatToTry: identity.whatToTry,
        group: identity.group,
      }),
    ),
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  requireEvaluationMode(env);
  const originRejection = rejectCrossOriginBrowserMutation(request);
  if (originRejection) return originRejection;
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const form = await request.formData();
  const intent = String(form.get("_intent") ?? "");

  if (intent === "unlock") {
    try {
      await enforcePublicRateLimit({
        env,
        request,
        action: "evaluation_unlock",
        tenantId: EVALUATION_EVENT_ID,
        email: "evaluation-access",
      });
    } catch (error) {
      if (error instanceof AbuseRateLimitError) {
        return data<ActionResult>(
          { ok: false, message: error.message },
          {
            status: 429,
            headers: {
              "cache-control": "no-store",
              "retry-after": String(error.retryAfterSeconds),
            },
          },
        );
      }
      if (error instanceof AbuseProtectionConfigurationError) {
        console.error(
          JSON.stringify({
            level: "error",
            subsystem: "evaluation-access",
            event: "rate-limit-unavailable",
            errorName: error.name,
            message: "Evaluation access rate limiting is unavailable.",
          }),
        );
        return data<ActionResult>(
          {
            ok: false,
            message: "Evaluation access is temporarily unavailable.",
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      throw error;
    }
    if (!(await evaluationAccessCodeMatches(env, form.get("accessCode")))) {
      return data<ActionResult>(
        { ok: false, message: "That evaluation access code is not valid." },
        { status: 401, headers: { "cache-control": "no-store" } },
      );
    }
    return redirect("/evaluate", {
      status: 303,
      headers: { "set-cookie": await evaluationSessionCookie(env, null) },
    });
  }

  const session = await readEvaluationSession(request, env);
  if (!session) {
    return data<ActionResult>(
      {
        ok: false,
        message: "Evaluation access expired. Enter the access code again.",
      },
      { status: 401, headers: { "cache-control": "no-store" } },
    );
  }

  if (intent === "lock") {
    const headers = new Headers();
    headers.append("set-cookie", clearEvaluationSessionCookie());
    headers.append("set-cookie", clearCurrentEventCookie(env));
    return redirect("/evaluate", { status: 303, headers });
  }

  const identityKey = String(form.get("identity") ?? "");
  if (intent !== "select_identity" || !isEvaluationIdentityKey(identityKey)) {
    return data<ActionResult>(
      { ok: false, message: "Choose one of the fixed evaluation identities." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const selected = await resolveEvaluationPerson(env, identityKey);
  await env.DB.prepare(
    `INSERT INTO audit_events (
       id, organisation_id, event_id, actor_id, action, entity_type,
       entity_id, metadata_json, created_at
     ) VALUES (?, ?, ?, 'production-evaluation-access',
               'evaluation.identity.selected', 'person', ?, ?, unixepoch())`,
  )
    .bind(
      crypto.randomUUID(),
      EVALUATION_ORGANISATION_ID,
      EVALUATION_EVENT_ID,
      selected.personId,
      JSON.stringify({ identityKey }),
    )
    .run();
  const headers = new Headers();
  headers.append("set-cookie", await evaluationSessionCookie(env, identityKey));
  headers.append("set-cookie", currentEventCookie(EVALUATION_EVENT_ID, env));
  return redirect(selected.definition.destination, { status: 303, headers });
}

function RoleCards({
  identities,
  group,
  busy,
}: {
  identities: Awaited<ReturnType<typeof loader>>["identities"];
  group: "showcase" | "scenario";
  busy: boolean;
}) {
  return (
    <div className="grid grid-3">
      {identities
        .filter((identity) => identity.group === group)
        .map((identity) => (
          <article className="card pad" key={identity.key}>
            <span className="pc-page-eyebrow">{identity.label}</span>
            <h3>{identity.name}</h3>
            <p>{identity.description}</p>
            <p className="subtle">
              <strong>What to try:</strong> {identity.whatToTry}
            </p>
            <Form method="post">
              <input type="hidden" name="_intent" value="select_identity" />
              <input type="hidden" name="identity" value={identity.key} />
              <button className="btn primary" type="submit" disabled={busy}>
                Open as {identity.label} <ArrowRight aria-hidden size={15} />
              </button>
            </Form>
          </article>
        ))}
    </div>
  );
}

export default function EvaluationGuide({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  if (!loaderData.unlocked) {
    return (
      <main className="design-board" id="main" style={{ minHeight: "100vh" }}>
        <section
          className="card pad"
          style={{ maxWidth: 560, margin: "8vh auto" }}
        >
          <div className="brand" style={{ color: "var(--ink)", padding: 0 }}>
            <BrandMark /> <span>Program Cue</span>
          </div>
          <span className="pc-page-eyebrow">Private evaluation workspace</span>
          <h1>Evaluation access</h1>
          <p>
            Enter the access code supplied with the evaluation instructions. It
            unlocks only fixed identities in the dedicated evaluation fixture.
          </p>
          {actionData ? (
            <p className="validation-item error" role="alert">
              {actionData.message}
            </p>
          ) : null}
          <Form method="post" className="stack">
            <input type="hidden" name="_intent" value="unlock" />
            <label className="label">
              Access code
              <input
                className="field"
                name="accessCode"
                type="password"
                required
                autoComplete="off"
              />
            </label>
            <button className="btn primary" type="submit" disabled={busy}>
              <KeyRound aria-hidden size={16} />{" "}
              {busy ? "Checking…" : "Unlock evaluation"}
            </button>
          </Form>
        </section>
      </main>
    );
  }

  return (
    <main className="design-board" id="main">
      <header className="page-head pc-page-header">
        <div>
          <span className="pc-page-eyebrow">Production evaluation mode</span>
          <h1>Choose an evaluator journey</h1>
          <p>
            Explore the real production role boundaries with dedicated seeded
            data. Return here at any time to change roles without creating
            accounts or sharing magic links.
          </p>
        </div>
        <Form method="post">
          <input type="hidden" name="_intent" value="lock" />
          <button className="btn" type="submit">
            <ShieldCheck aria-hidden size={15} /> Lock evaluation
          </button>
        </Form>
      </header>
      <section
        className="pc-status-notice is-info mb"
        aria-label="Seeded evaluation event"
      >
        <CalendarDays aria-hidden size={18} />
        <div className="pc-status-notice-copy">
          <strong>Seeded event: {loaderData.eventName}</strong>
        </div>
      </section>
      {loaderData.selected ? (
        <div className="pc-status-notice is-success mb" role="status">
          <ShieldCheck aria-hidden size={18} />
          <div>
            <strong>Current persona: {loaderData.selected.label}</strong>
            <div>{loaderData.selected.name}</div>
          </div>
        </div>
      ) : null}

      <section className="mb" aria-labelledby="role-cards-title">
        <div className="card-title">
          <div>
            <h2 id="role-cards-title">Showcase personas</h2>
            <p className="subtle">Each opens on useful seeded work.</p>
          </div>
        </div>
        <RoleCards
          identities={loaderData.identities}
          group="showcase"
          busy={busy}
        />
      </section>

      <section className="card pad mb" aria-labelledby="proof-links-title">
        <div className="card-title">
          <div>
            <h2 id="proof-links-title">Direct proof links</h2>
            <p className="subtle">
              Public output remains accessible without a private persona.
            </p>
          </div>
        </div>
        <div className="page-actions">
          <Link
            className="btn primary"
            to="/public/programme/future-of-events-2025"
          >
            Published programme <ExternalLink aria-hidden size={14} />
          </Link>
          <Link
            className="btn"
            to="/public/programme/future-of-events-2025/schedule"
          >
            Schedule
          </Link>
          <Link
            className="btn"
            to="/public/programme/future-of-events-2025/speakers"
          >
            Speaker gallery
          </Link>
          <Link className="btn" to="/apply/form">
            Application form
          </Link>
          <Link className="btn" to="/api/docs">
            API documentation
          </Link>
        </div>
      </section>

      <details className="card pad mb pc-disclosure">
        <summary>
          <strong>Automated scenario starting identities</strong>{" "}
          <span className="subtle">clean fixture state</span>
        </summary>
        <div className="mt">
          <RoleCards
            identities={loaderData.identities}
            group="scenario"
            busy={busy}
          />
        </div>
      </details>
    </main>
  );
}
