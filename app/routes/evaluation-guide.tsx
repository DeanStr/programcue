import {
  data,
  redirect,
  redirectDocument,
  useActionData,
  useNavigation,
} from "react-router";

import type { Route } from "./+types/evaluation-guide";
import { EvaluationAccessSurface } from "~/components/evaluation-access-surface";
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
  activateEvaluationApplicantAccount,
  clearEvaluationSessionCookie,
  evaluationAccessCodeMatches,
  evaluationPersonForSession,
  evaluationSessionCookie,
  isEvaluationIdentityKey,
  readEvaluationSession,
  renewedEvaluationSessionCookie,
  requireEvaluationMode,
  resolveEvaluationPerson,
} from "~/platform/evaluation/evaluation-session.server";
import { resetProductionEvaluationFixtureForEvaluator } from "~/platform/evaluation/evaluation-fixture.server";
import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicRateLimit,
} from "~/platform/http/public-abuse-protection.server";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";

type ActionResult =
  { ok: true; message: string } | { ok: false; message: string };

export const meta = () => [{ title: "Evaluation access · Program Cue" }];
export const headers: Route.HeadersFunction = () => ({
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
});

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  requireEvaluationMode(env);
  const session = await readEvaluationSession(request, env);
  const selected = session
    ? await evaluationPersonForSession(env, session)
    : null;
  return {
    unlocked: Boolean(session),
    eventName: EVALUATION_EVENT_NAME,
    selected: selected
      ? {
          identityKey: selected.identityKey,
          name: selected.name,
          label: selected.definition.label,
          destination: selected.definition.destination,
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
        requiresAccountActivation: key === "sbek_applicant",
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

  if (intent === "reset_fixture") {
    const confirmation = form.get("confirmation");
    if (confirmation !== EVALUATION_EVENT_NAME) {
      return data<ActionResult>(
        {
          ok: false,
          message: `Type ${EVALUATION_EVENT_NAME} exactly to reset the fixture.`,
        },
        { status: 409, headers: { "cache-control": "no-store" } },
      );
    }
    try {
      await enforcePublicRateLimit({
        env,
        request,
        action: "evaluation_reset",
        tenantId: EVALUATION_EVENT_ID,
        email: "evaluation-reset",
      });
      await resetProductionEvaluationFixtureForEvaluator(
        env,
        confirmation,
        session.identityKey,
        session.fixtureGeneration,
      );
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
        return data<ActionResult>(
          {
            ok: false,
            message: "Evaluation reset protection is temporarily unavailable.",
          },
          { status: 503, headers: { "cache-control": "no-store" } },
        );
      }
      if (error instanceof Error) {
        return data<ActionResult>(
          { ok: false, message: error.message },
          { status: 409, headers: { "cache-control": "no-store" } },
        );
      }
      throw error;
    }
    const headers = new Headers({ "cache-control": "private, no-store" });
    headers.append("set-cookie", await evaluationSessionCookie(env, null));
    headers.append("set-cookie", clearCurrentEventCookie(env));
    return data<ActionResult>(
      {
        ok: true,
        message: "Evaluation data reset. Choose a fresh starting persona.",
      },
      { headers },
    );
  }

  const identityKey = String(form.get("identity") ?? "");
  const choosesApplicantEvent = intent === "activate_account_and_choose_event";
  const activatesEvaluatorAccount =
    intent === "activate_account" || choosesApplicantEvent;
  if (
    (intent !== "select_identity" && !activatesEvaluatorAccount) ||
    !isEvaluationIdentityKey(identityKey) ||
    (activatesEvaluatorAccount && identityKey !== "sbek_applicant") ||
    (!activatesEvaluatorAccount && identityKey === "sbek_applicant")
  ) {
    return data<ActionResult>(
      { ok: false, message: "Choose one of the fixed evaluation identities." },
      { status: 400, headers: { "cache-control": "no-store" } },
    );
  }
  const selected = await resolveEvaluationPerson(env, identityKey);
  const accountActivation = activatesEvaluatorAccount
    ? await activateEvaluationApplicantAccount(env, session.fixtureGeneration)
    : null;
  if (!accountActivation?.replayed) {
    await env.DB.prepare(
      `INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_id, action, entity_type,
       entity_id, metadata_json, created_at
     ) VALUES (?, 'system', 'internal', 1, ?, ?, 'production-evaluation-access',
               ?, 'person', ?, ?, unixepoch())`,
    )
      .bind(
        crypto.randomUUID(),
        EVALUATION_ORGANISATION_ID,
        EVALUATION_EVENT_ID,
        "evaluation.identity.selected",
        selected.personId,
        JSON.stringify({
          identityKey,
          fixtureGeneration: session.fixtureGeneration,
          accountActivated: activatesEvaluatorAccount,
        }),
      )
      .run();
  }
  const headers = new Headers();
  headers.append(
    "set-cookie",
    await renewedEvaluationSessionCookie(env, session, identityKey),
  );
  headers.append(
    "set-cookie",
    choosesApplicantEvent
      ? clearCurrentEventCookie(env)
      : currentEventCookie(EVALUATION_EVENT_ID, env),
  );
  const destination = choosesApplicantEvent
    ? "/events/select"
    : selected.definition.destination;
  return redirectDocument(destination, {
    status: 303,
    headers,
  });
}

export default function EvaluationGuide({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <EvaluationAccessSurface
      actionData={actionData}
      busy={busy}
      eventName={loaderData.eventName}
      identities={loaderData.identities}
      resetBusy={
        busy && navigation.formData?.get("_intent") === "reset_fixture"
      }
      selected={loaderData.selected}
      unlocked={loaderData.unlocked}
    />
  );
}
