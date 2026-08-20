import {
  data,
  redirect,
  redirectDocument,
  useActionData,
  useNavigation,
} from "react-router";
import {
  EvaluationAccessSurface,
  type EvaluationPersonaCard,
} from "~/components/evaluation-access-surface";
import {
  clearCurrentEventCookie,
  currentEventCookie,
} from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { resetProductionEvaluationFixtureForEvaluator } from "~/platform/evaluation/evaluation-fixture.server";
import {
  type EvaluationScenarioGuideState,
  evaluationApplicantGuideLabel,
  evaluationReviewerGuideLabel,
  readEvaluationScenarioGuideState,
} from "~/platform/evaluation/evaluation-guide-state.server";
import {
  activateEvaluationApplicantAccount,
  clearEvaluationSessionCookie,
  EVALUATION_EVENT_ID,
  EVALUATION_EVENT_NAME,
  EVALUATION_IDENTITIES,
  EVALUATION_ORGANISATION_ID,
  type EvaluationIdentityKey,
  evaluationAccessCodeMatches,
  evaluationPersonForSession,
  evaluationSessionCookie,
  isEvaluationIdentityKey,
  readEvaluationSession,
  renewedEvaluationSessionCookie,
  requireEvaluationMode,
  resolveEvaluationPerson,
} from "~/platform/evaluation/evaluation-session.server";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";
import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicRateLimit,
} from "~/platform/http/public-abuse-protection.server";
import { requestCorrelationId } from "~/platform/observability/request-correlation";
import { sourceRevisionForLog } from "~/platform/observability/source-revision.server";
import "~/styles/workspace-remaining.css";
import type { Route } from "./+types/evaluation-guide";

type ActionResult =
  | { ok: true; message: string }
  | { ok: false; message: string; retryAfterSeconds?: number };

function evaluationDependencyUnavailable(
  env: CloudflareEnvironment,
  request: Request,
  event: string,
  stage: string,
  error: unknown,
) {
  console.error(
    JSON.stringify({
      level: "error",
      sourceRevision: sourceRevisionForLog(env),
      subsystem: "evaluation-access",
      event,
      stage,
      correlationId: requestCorrelationId(request),
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: "An evaluation access dependency failed.",
    }),
  );
  return data<ActionResult>(
    {
      ok: false,
      message: "Evaluation access is temporarily unavailable. Try again.",
    },
    { status: 503, headers: { "cache-control": "no-store" } },
  );
}

export const meta = () => [{ title: "Evaluation access · Program Cue" }];
export const headers: Route.HeadersFunction = () => ({
  "cache-control": "private, no-store",
  "x-robots-tag": "noindex, nofollow",
});

type ScenarioPresentation = Pick<
  EvaluationPersonaCard,
  | "label"
  | "description"
  | "destination"
  | "whatToTry"
  | "primaryActionLabel"
  | "primaryActionHelp"
  | "secondaryActionLabel"
  | "progress"
>;

function itemCount(count: number, singular: string) {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function applicantPresentation(
  state: EvaluationScenarioGuideState["applicant"],
): ScenarioPresentation {
  const label = evaluationApplicantGuideLabel(state.phase);
  const existingAccountHelp =
    "Uses Priya's existing fixed evaluator account; it does not create another membership or claim external delivery.";
  switch (state.phase) {
    case "clean":
      return {
        label,
        description:
          "Priya has no submitter activation, draft or submitted application in the fixture event.",
        destination: "/apply/form",
        whatToTry: "Activate Priya, start an application and submit it.",
        primaryActionLabel: "Create evaluator submitter account",
        primaryActionHelp:
          "Activates only this fixed fixture identity. No verification email or external-provider delivery is claimed.",
        secondaryActionLabel: "Activate account and choose event",
        progress: {
          clean: true,
          title: "Clean applicant baseline",
          detail: "No account activation or application work exists yet.",
        },
      };
    case "activated":
      return {
        label,
        description:
          "Priya has accepted submitter access but has not started an application.",
        destination: "/apply/form",
        whatToTry: "Start Priya's first application.",
        primaryActionLabel: "Start an application as Priya",
        primaryActionHelp: existingAccountHelp,
        secondaryActionLabel: "Choose from Priya's events",
        progress: {
          clean: false,
          title: "Applicant account activated",
          detail: "The clean applicant baseline has been passed.",
        },
      };
    case "draft":
      return {
        label,
        description: `Priya has ${itemCount(state.draftCount, "draft application")} and no submitted application.`,
        destination: "/participant/applications",
        whatToTry: "Continue or inspect Priya's application draft.",
        primaryActionLabel: "Continue Priya's application",
        primaryActionHelp: existingAccountHelp,
        secondaryActionLabel: "Choose from Priya's events",
        progress: {
          clean: false,
          title: "Application draft in progress",
          detail: `${itemCount(state.draftCount, "draft")} currently belongs to Priya.`,
        },
      };
    case "submitted": {
      const draftDetail = state.draftCount
        ? ` and ${itemCount(state.draftCount, "draft")}`
        : "";
      return {
        label,
        description: `Priya has ${itemCount(state.submittedCount, "submitted or progressed application")}${draftDetail}.`,
        destination: "/participant/applications",
        whatToTry: "Inspect Priya's submitted applications and their status.",
        primaryActionLabel: "Open Priya's applications",
        primaryActionHelp: existingAccountHelp,
        secondaryActionLabel: "Choose from Priya's events",
        progress: {
          clean: false,
          title: "Application submitted",
          detail: `${itemCount(state.submittedCount, "application")} ${state.submittedCount === 1 ? "has" : "have"} moved beyond draft${draftDetail}.`,
        },
      };
    }
    case "inactive":
      return {
        label,
        description:
          "Priya has fixture membership history, but the current evaluator activation is not active.",
        destination: "/apply/form",
        whatToTry:
          "Restore the fixed evaluator activation or reset before a new run.",
        primaryActionLabel: "Restore Priya's evaluator account",
        primaryActionHelp:
          "Restores only the fixed evaluator membership for the current fixture generation.",
        secondaryActionLabel: "Restore account and choose event",
        progress: {
          clean: false,
          title: "Applicant state is not clean",
          detail:
            "Membership history exists without a current active evaluator account.",
        },
      };
  }
}

function reviewerPresentation(
  state: EvaluationScenarioGuideState["reviewer"],
): ScenarioPresentation {
  const label = evaluationReviewerGuideLabel(state.phase);
  switch (state.phase) {
    case "clean":
      return {
        label,
        description:
          "Sam has no invitation, event access, assignment or review in the fixture event.",
        destination: "/events/select",
        whatToTry: "Have the organiser invite Sam before opening a workbench.",
        primaryActionLabel: "Open as clean reviewer",
        progress: {
          clean: true,
          title: "Clean reviewer baseline",
          detail:
            "No event access yet. The organiser must invite Sam before work can begin.",
        },
      };
    case "invited":
      return {
        label,
        description:
          "Sam has a pending evaluator invitation and has not accepted event access.",
        destination: "/events/select",
        whatToTry: "Accept the pending invitation as Sam.",
        primaryActionLabel: "Review invitation as Sam",
        progress: {
          clean: false,
          title: "Reviewer invitation pending",
          detail:
            "The organiser has invited Sam; acceptance is still required.",
        },
      };
    case "invitation_expired":
      return {
        label,
        description:
          "Sam's evaluator invitation has expired without being accepted.",
        destination: "/events/select",
        whatToTry:
          "Have the organiser send Sam a new invitation before continuing.",
        primaryActionLabel: "Open Sam's event access",
        progress: {
          clean: false,
          title: "Reviewer invitation expired",
          detail:
            "Sam cannot accept the expired invitation; the organiser must invite him again.",
        },
      };
    case "accepted":
      return {
        label,
        description:
          "Sam has accepted evaluator access and currently has no active assignment.",
        destination: "/review/workbench",
        whatToTry:
          "Open the reviewer workspace or create an assignment as the organiser.",
        primaryActionLabel: "Open Sam's reviewer workspace",
        progress: {
          clean: false,
          title: "Reviewer access accepted",
          detail: "Sam can enter the event, but no review is assigned yet.",
        },
      };
    case "assigned":
      return {
        label,
        description: `Sam has ${itemCount(state.assignmentCount, "review assignment")} and no saved review draft.`,
        destination: "/review/workbench",
        whatToTry:
          "Open the assigned proposal, save an independent rubric response, then request and inspect AI suggestions.",
        primaryActionLabel: "Open Sam's assigned review",
        progress: {
          clean: false,
          title: "Review assigned",
          detail: `${itemCount(state.assignmentCount, "assignment")} currently belongs to Sam.`,
        },
      };
    case "review_draft":
      return {
        label,
        description: `Sam has review work in progress across ${itemCount(state.assignmentCount, "assignment")}.`,
        destination: "/review/workbench",
        whatToTry:
          "Generate or inspect AI suggestions, then complete and submit Sam's saved review.",
        primaryActionLabel: "Continue Sam's review",
        progress: {
          clean: false,
          title: "Review draft in progress",
          detail: `${itemCount(state.reviewCount, "saved review")} currently belongs to Sam.`,
        },
      };
    case "review_submitted":
      return {
        label,
        description: `Sam has completed review work across ${itemCount(state.assignmentCount, "assignment")}.`,
        destination: "/review/workbench",
        whatToTry: "Inspect Sam's submitted, locked scoring record.",
        primaryActionLabel: "Inspect Sam's submitted review",
        progress: {
          clean: false,
          title: "Review submitted",
          detail: `${itemCount(state.reviewCount, "saved review")} ${state.reviewCount === 1 ? "is" : "are"} recorded for Sam.`,
        },
      };
    case "inactive":
      return {
        label,
        description:
          "Sam has inactive access or assignment history, so this is not a clean reviewer baseline.",
        destination: "/events/select",
        whatToTry: "Inspect Sam's event access or reset before a separate run.",
        primaryActionLabel: "Open Sam's reviewer access",
        progress: {
          clean: false,
          title: "Reviewer state is not clean",
          detail:
            "Inactive membership or assignment history remains in the shared fixture.",
        },
      };
  }
}

type ScenarioIdentityKey = "sbek_applicant" | "sbek_reviewer";

function isScenarioIdentityKey(
  key: EvaluationIdentityKey,
): key is ScenarioIdentityKey {
  return key === "sbek_applicant" || key === "sbek_reviewer";
}

function scenarioPresentation(
  key: ScenarioIdentityKey,
  state: EvaluationScenarioGuideState,
): ScenarioPresentation {
  if (key === "sbek_applicant") return applicantPresentation(state.applicant);
  return reviewerPresentation(state.reviewer);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  requireEvaluationMode(env);
  const session = await readEvaluationSession(request, env);
  const selected = session
    ? await evaluationPersonForSession(env, session)
    : null;
  const scenarioState = session
    ? await readEvaluationScenarioGuideState(env, session.fixtureGeneration)
    : null;
  const identities = (
    Object.keys(EVALUATION_IDENTITIES) as EvaluationIdentityKey[]
  ).map((key) => {
    const identity = EVALUATION_IDENTITIES[key];
    const scenarioIdentity = isScenarioIdentityKey(key);
    if ((identity.group === "scenario") !== scenarioIdentity) {
      throw new Error(
        `Evaluation identity ${key} has no matching scenario presentation configuration.`,
      );
    }
    const base = {
      key,
      label: identity.label,
      name: identity.name,
      description: identity.description,
      destination: identity.destination,
      whatToTry: identity.whatToTry,
      group: identity.group,
      requiresAccountActivation: key === "sbek_applicant",
    };
    return scenarioState && scenarioIdentity
      ? { ...base, ...scenarioPresentation(key, scenarioState) }
      : base;
  });
  let selectedData = null;
  if (selected) {
    const selectedCard = identities.find(
      (identity) => identity.key === selected.identityKey,
    );
    if (!selectedCard) {
      throw new Error(
        `Evaluation identity ${selected.identityKey} has no guide card.`,
      );
    }
    selectedData = {
      identityKey: selected.identityKey,
      name: selected.name,
      label: selectedCard.label,
      destination: selectedCard.destination,
    };
  }
  return {
    unlocked: Boolean(session),
    eventName: EVALUATION_EVENT_NAME,
    selected: selectedData,
    identities,
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
          {
            ok: false,
            message: error.message,
            retryAfterSeconds: error.retryAfterSeconds,
          },
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

  let session: Awaited<ReturnType<typeof readEvaluationSession>>;
  try {
    session = await readEvaluationSession(request, env);
  } catch (error) {
    if (error instanceof Response) throw error;
    return evaluationDependencyUnavailable(
      env,
      request,
      "session-read-failed",
      "read-session",
      error,
    );
  }
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
          {
            ok: false,
            message: error.message,
            retryAfterSeconds: error.retryAfterSeconds,
          },
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
  let selectionStage = "resolve-person";
  try {
    const selected = await resolveEvaluationPerson(env, identityKey);
    if (
      (selected.definition.group === "scenario") !==
      isScenarioIdentityKey(identityKey)
    ) {
      throw new Error(
        `Evaluation identity ${identityKey} has no matching scenario action configuration.`,
      );
    }
    selectionStage = "activate-account";
    const accountActivation = activatesEvaluatorAccount
      ? await activateEvaluationApplicantAccount(env, session.fixtureGeneration)
      : null;
    selectionStage = "record-audit";
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
    selectionStage = "read-scenario-state";
    const scenarioState = isScenarioIdentityKey(identityKey)
      ? await readEvaluationScenarioGuideState(env, session.fixtureGeneration)
      : null;
    const destination = choosesApplicantEvent
      ? "/events/select"
      : scenarioState && isScenarioIdentityKey(identityKey)
        ? scenarioPresentation(identityKey, scenarioState).destination
        : selected.definition.destination;
    const stampsCurrentEvent =
      !choosesApplicantEvent && destination !== "/events/select";
    selectionStage = "issue-session";
    const headers = new Headers();
    headers.append(
      "set-cookie",
      await renewedEvaluationSessionCookie(env, session, identityKey),
    );
    headers.append(
      "set-cookie",
      stampsCurrentEvent
        ? currentEventCookie(EVALUATION_EVENT_ID, env)
        : clearCurrentEventCookie(env),
    );
    return redirectDocument(destination, {
      status: 303,
      headers,
    });
  } catch (error) {
    if (error instanceof Response) throw error;
    return evaluationDependencyUnavailable(
      env,
      request,
      "identity-selection-failed",
      selectionStage,
      error,
    );
  }
}

export default function EvaluationGuide({ loaderData }: Route.ComponentProps) {
  const actionData = useActionData<ActionResult>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <div className="pc-eval-linear">
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
    </div>
  );
}
