import { z } from "zod";

import { emailDeliveryIssue } from "~/modules/communications/email-deliverability";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  DEMO_ORGANISATION_ID,
  SBEK_FIXTURE_PEOPLE,
} from "~/platform/demo/demo-identities";
import {
  assertEvaluationPeopleAreDedicated,
  EvaluationIdentityIsolationError,
} from "~/platform/evaluation/evaluation-identity-isolation.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

const emailSchema = z.email().transform((value) => value.trim().toLowerCase());

export const EVALUATOR_EMAIL_ALIASES = {
  "jordan.organizer@sbek-test.example.com":
    SBEK_FIXTURE_PEOPLE.organizer.personId,
  "priya.speaker@sbek-test.example.com": SBEK_FIXTURE_PEOPLE.speaker.personId,
  "marcus.speaker@sbek-test.example.com": SBEK_FIXTURE_PEOPLE.speaker2.personId,
  "sam.reviewer@sbek-test.example.com": SBEK_FIXTURE_PEOPLE.reviewer.personId,
} as const;

export type EvaluatorEmailAlias = keyof typeof EVALUATOR_EMAIL_ALIASES;

export type EvaluatorEmailRouting = {
  enteredEmail: EvaluatorEmailAlias;
  routedEmail: string;
  personId: string;
};

export type EvaluatorEmailResolution = {
  email: string;
  personId: string | null;
  routing: EvaluatorEmailRouting | null;
};

export class EvaluatorEmailAliasDriftError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvaluatorEmailAliasDriftError";
  }
}

export class EvaluatorEmailAliasContextError extends Error {
  constructor() {
    super(
      "Evaluator email aliases can be used only through a signed production-evaluation session in the dedicated evaluation organisation.",
    );
    this.name = "EvaluatorEmailAliasContextError";
  }
}

type EvaluatorAliasScope = Pick<Viewer, "organisationId" | "eventId"> & {
  evaluation?: boolean;
};

function isEvaluatorEmailAlias(value: string): value is EvaluatorEmailAlias {
  return Object.hasOwn(EVALUATOR_EMAIL_ALIASES, value);
}

async function assertFixturePeople(env: CloudflareEnvironment) {
  const personIds = Object.values(EVALUATOR_EMAIL_ALIASES);
  try {
    await assertEvaluationPeopleAreDedicated(env, personIds);
  } catch (error) {
    if (error instanceof EvaluationIdentityIsolationError) {
      throw new EvaluatorEmailAliasDriftError(
        `The production evaluation identity ${error.personId} is linked outside the dedicated evaluation organisation.`,
      );
    }
    throw error;
  }
  const rows = await env.DB.prepare(
    `SELECT id, lower(email) AS email
       FROM people
      WHERE id IN (${personIds.map(() => "?").join(",")})
      ORDER BY id`,
  )
    .bind(...personIds)
    .all<{ id: string; email: string }>();
  if (rows.results.length !== personIds.length) {
    throw new EvaluatorEmailAliasDriftError(
      "The production evaluation email aliases cannot be routed because a fixed evaluator identity is missing.",
    );
  }
  const byId = new Map(rows.results.map((row) => [row.id, row.email]));
  const addresses = new Set<string>();
  for (const personId of personIds) {
    const email = byId.get(personId);
    if (!email || emailDeliveryIssue(email, "production") !== null) {
      throw new EvaluatorEmailAliasDriftError(
        `The production evaluation identity ${personId} does not have a safe routeable email address.`,
      );
    }
    if (addresses.has(email)) {
      throw new EvaluatorEmailAliasDriftError(
        "The production evaluation identities no longer have distinct routeable email addresses.",
      );
    }
    addresses.add(email);
  }
  return byId;
}

/**
 * Routes only the four literal addresses published by the evaluation kit. The
 * caller must already be acting through a signed production evaluator session.
 * In production, an exact kit alias outside that context fails closed instead
 * of reaching a provider as a literal reserved-domain address. Non-aliases and
 * non-production fixture inputs are left untouched.
 */
export async function resolveEvaluatorEmailAlias(
  env: CloudflareEnvironment,
  scope: EvaluatorAliasScope,
  rawEmail: string,
): Promise<EvaluatorEmailResolution> {
  const email = emailSchema.parse(rawEmail);
  const runtime = requireRuntimeMode(env);
  if (!isEvaluatorEmailAlias(email)) {
    return { email, personId: null, routing: null };
  }
  if (runtime.appEnvironment !== "production") {
    return { email, personId: null, routing: null };
  }
  if (
    !runtime.evaluation ||
    scope.evaluation !== true ||
    scope.organisationId !== DEMO_ORGANISATION_ID
  ) {
    throw new EvaluatorEmailAliasContextError();
  }
  const event = await env.DB.prepare(
    `SELECT 1
       FROM events
      WHERE id = ? AND organisation_id = ? AND activation_status = 'active'`,
  )
    .bind(scope.eventId, DEMO_ORGANISATION_ID)
    .first();
  if (!event) {
    throw new EvaluatorEmailAliasDriftError(
      "Evaluator email aliases can be routed only inside an active event owned by the dedicated evaluation organisation.",
    );
  }
  const personId = EVALUATOR_EMAIL_ALIASES[email];
  const routeablePeople = await assertFixturePeople(env);
  const routedEmail = routeablePeople.get(personId);
  if (!routedEmail) {
    throw new EvaluatorEmailAliasDriftError(
      `The production evaluation identity ${personId} is unavailable.`,
    );
  }
  return {
    email: routedEmail,
    personId,
    routing: { enteredEmail: email, routedEmail, personId },
  };
}

export function evaluatorEmailRoutingMessage(
  routing: EvaluatorEmailRouting | null,
) {
  return routing
    ? `Evaluation address ${routing.enteredEmail} was routed to the fixed evaluator inbox ${routing.routedEmail}.`
    : "";
}
