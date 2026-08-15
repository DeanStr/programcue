import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
  DEMO_RESET_CONFIRMATION,
} from "~/platform/demo/demo-identities";
import {
  assertEvaluationPeopleAreDedicated,
  EvaluationIdentityIsolationError,
} from "~/platform/evaluation/evaluation-identity-isolation.server";
import { currentEvaluationFixtureGeneration } from "~/platform/evaluation/evaluation-fixture-reset-lock.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

export const EVALUATION_SESSION_COOKIE = "__Host-program_cue_evaluation";
const SESSION_SECONDS = 60 * 60 * 8;
const EVALUATION_APPLICANT_MEMBERSHIP_ID =
  "membership-production-evaluation-applicant-event";

export const EVALUATION_IDENTITIES = {
  owner: {
    ...DEMO_IDENTITIES.owner,
    label: "Organisation owner",
    description:
      "Governance, retention, event setup and every admin workspace.",
    whatToTry:
      "Review retention controls, then open Event setup or Command Centre.",
    group: "showcase",
  },
  organizer: {
    ...DEMO_IDENTITIES.administrator,
    label: "Event organiser",
    description:
      "The complete operations workspace with a rich, published event.",
    whatToTry:
      "Inspect submissions and scheduling; when creating a D1 event, explicitly reuse the verified sender.",
    group: "showcase",
  },
  chair: {
    ...DEMO_IDENTITIES.committee_chair,
    label: "Committee chair",
    description:
      "Round configuration, assignments, conflicts and decision oversight.",
    whatToTry:
      "Open Evaluation administration and inspect the seeded review round.",
    group: "showcase",
  },
  reviewer: {
    ...DEMO_IDENTITIES.evaluator,
    label: "Reviewer",
    description: "An assigned proposal and the focused scoring workbench.",
    whatToTry:
      "Score the assigned proposal, save a draft and submit the review.",
    group: "showcase",
  },
  applicant: {
    ...DEMO_IDENTITIES.submitter,
    label: "Applicant",
    description: "Submitted proposal history, messages and participant tasks.",
    whatToTry:
      "Open the submitted application and inspect its timeline and messages.",
    group: "showcase",
  },
  speaker: {
    ...DEMO_IDENTITIES.speaker,
    label: "Accepted speaker",
    description:
      "Profile, session participation, resources and readiness tasks.",
    whatToTry: "Update the profile, confirm participation and complete a task.",
    group: "showcase",
  },
  sbek_applicant: {
    ...DEMO_IDENTITIES.sbek_speaker,
    destination: "/apply/form",
    label: "Clean applicant",
    description:
      "The exact clean starting identity used by the automated workflow.",
    whatToTry: "Start an application, add Marcus as co-speaker and submit it.",
    group: "scenario",
  },
  sbek_reviewer: {
    ...DEMO_IDENTITIES.sbek_reviewer,
    destination: "/events/select",
    label: "Clean invited reviewer",
    description:
      "The fixed reviewer identity before the scenario creates an assignment.",
    whatToTry:
      "After the organiser invites this reviewer, accept access and open the workbench.",
    group: "scenario",
  },
} as const;

export type EvaluationIdentityKey = keyof typeof EVALUATION_IDENTITIES;

export type EvaluationSessionPayload = {
  version: 1;
  identityKey: EvaluationIdentityKey | null;
  fixtureGeneration: string;
  expiresAt: number;
};

async function currentFixtureGeneration(env: CloudflareEnvironment) {
  if (!env.DB) {
    throw new Error("Required Cloudflare binding DB is unavailable.");
  }
  const fixtureGeneration = await currentEvaluationFixtureGeneration(env);
  if (!fixtureGeneration) {
    throw new Response(
      "The evaluation fixture has no completed reset. Ask the evaluation operator to complete a reset before granting access.",
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return fixtureGeneration;
}

async function evaluationApplicantMembershipIsActive(
  env: CloudflareEnvironment,
  fixtureGeneration: string,
) {
  const membership = await env.DB.prepare(
    `SELECT 1
       FROM memberships
      WHERE id = ? AND organisation_id = ? AND event_id = ?
        AND person_id = ? AND role = 'submitter'
        AND accepted_at IS NOT NULL AND revoked_at IS NULL
        AND last_operation_id = ?`,
  )
    .bind(
      EVALUATION_APPLICANT_MEMBERSHIP_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.sbek_speaker.personId,
      `evaluation-account:${fixtureGeneration}`,
    )
    .first();
  return Boolean(membership);
}

function configuredSecret(env: CloudflareEnvironment) {
  const value = env.EVALUATION_SESSION_SECRET?.trim() ?? "";
  if (value.length < 32) {
    throw new Error(
      "EVALUATION_SESSION_SECRET must contain at least 32 characters.",
    );
  }
  return value;
}

function configuredAccessCode(env: CloudflareEnvironment) {
  const value = env.EVALUATION_ACCESS_CODE?.trim() ?? "";
  if (value.length < 16) {
    throw new Error(
      "EVALUATION_ACCESS_CODE must contain at least 16 characters.",
    );
  }
  return value;
}

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function base64UrlDecode(value: string) {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Invalid encoding.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function signingKey(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function sign(payload: string, secret: string) {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(secret),
    new TextEncoder().encode(payload),
  );
  return base64UrlEncode(new Uint8Array(signature));
}

function cookieValue(request: Request) {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key !== EVALUATION_SESSION_COOKIE) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

export function isEvaluationIdentityKey(
  value: string,
): value is EvaluationIdentityKey {
  return Object.hasOwn(EVALUATION_IDENTITIES, value);
}

export function requireEvaluationMode(env: CloudflareEnvironment) {
  const runtime = requireRuntimeMode(env);
  if (
    runtime.appEnvironment !== "production" ||
    runtime.demo ||
    !runtime.evaluation
  ) {
    throw new Response("Not found", {
      status: 404,
      headers: { "cache-control": "no-store" },
    });
  }
}

export async function evaluationAccessCodeMatches(
  env: CloudflareEnvironment,
  candidate: unknown,
) {
  const expected = configuredAccessCode(env);
  const secret = configuredSecret(env);
  const supplied = typeof candidate === "string" ? candidate.trim() : "";
  if (supplied.length > 256) return false;
  const key = await signingKey(secret);
  const expectedSignature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(expected),
  );
  return crypto.subtle.verify(
    "HMAC",
    key,
    expectedSignature,
    new TextEncoder().encode(supplied),
  );
}

async function signedEvaluationSessionCookie(
  env: CloudflareEnvironment,
  identityKey: EvaluationIdentityKey | null,
  fixtureGeneration: string,
  now: number,
) {
  requireEvaluationMode(env);
  const payload: EvaluationSessionPayload = {
    version: 1,
    identityKey,
    fixtureGeneration,
    expiresAt: now + SESSION_SECONDS,
  };
  const encodedPayload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await sign(encodedPayload, configuredSecret(env));
  return `${EVALUATION_SESSION_COOKIE}=${encodedPayload}.${signature}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export async function evaluationSessionCookie(
  env: CloudflareEnvironment,
  identityKey: EvaluationIdentityKey | null,
  now = Math.floor(Date.now() / 1000),
) {
  return signedEvaluationSessionCookie(
    env,
    identityKey,
    await currentFixtureGeneration(env),
    now,
  );
}

export async function renewedEvaluationSessionCookie(
  env: CloudflareEnvironment,
  session: EvaluationSessionPayload,
  identityKey: EvaluationIdentityKey | null,
  now = Math.floor(Date.now() / 1000),
) {
  return signedEvaluationSessionCookie(
    env,
    identityKey,
    session.fixtureGeneration,
    now,
  );
}

export function clearEvaluationSessionCookie() {
  return `${EVALUATION_SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`;
}

export async function readEvaluationSession(
  request: Request,
  env: CloudflareEnvironment,
  now = Math.floor(Date.now() / 1000),
): Promise<EvaluationSessionPayload | null> {
  const value = cookieValue(request);
  if (!value || value.length > 1_024) return null;
  const [encodedPayload, encodedSignature, ...rest] = value.split(".");
  if (!encodedPayload || !encodedSignature || rest.length) return null;
  const secret = configuredSecret(env);
  let parsed: Partial<EvaluationSessionPayload> | null = null;
  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await signingKey(secret),
      base64UrlDecode(encodedSignature),
      new TextEncoder().encode(encodedPayload),
    );
    if (!valid) return null;
    parsed = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(encodedPayload)),
    ) as Partial<EvaluationSessionPayload>;
  } catch {
    return null;
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    parsed.version !== 1 ||
    typeof parsed.expiresAt !== "number" ||
    !Number.isSafeInteger(parsed.expiresAt) ||
    parsed.expiresAt <= now ||
    typeof parsed.fixtureGeneration !== "string" ||
    !parsed.fixtureGeneration ||
    parsed.fixtureGeneration.length > 200 ||
    (parsed.identityKey !== null &&
      (typeof parsed.identityKey !== "string" ||
        !isEvaluationIdentityKey(parsed.identityKey)))
  ) {
    return null;
  }
  if (parsed.fixtureGeneration !== (await currentFixtureGeneration(env))) {
    return null;
  }
  return parsed as EvaluationSessionPayload;
}

export async function resolveEvaluationPerson(
  env: CloudflareEnvironment,
  identityKey: EvaluationIdentityKey,
) {
  const definition = EVALUATION_IDENTITIES[identityKey];
  // The two scenario identities intentionally start without fixture-event
  // access. Every showcase identity must retain its seeded, active role.
  const requiresFixtureMembership = definition.group === "showcase";
  const expectedMembershipEventId =
    identityKey === "owner" ? null : DEMO_EVENT_ID;
  const person = await env.DB.prepare(
    `SELECT person.id AS personId, person.display_name AS name, person.email,
            COALESCE(person.biography, '') AS biography,
            person.profile_revision AS profileRevision
       FROM people person
      WHERE person.id = ?
        AND EXISTS (
          SELECT 1 FROM events event
           WHERE event.id = ? AND event.organisation_id = ?
             AND event.activation_status = 'active'
        )
        AND (
          ? = 0 OR EXISTS (
            SELECT 1 FROM memberships membership
             WHERE membership.person_id = person.id
               AND membership.organisation_id = ?
               AND membership.role = ?
               AND (
                 (? IS NULL AND membership.event_id IS NULL)
                 OR membership.event_id = ?
               )
               AND membership.accepted_at IS NOT NULL
               AND membership.revoked_at IS NULL
          )
        )`,
  )
    .bind(
      definition.personId,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      requiresFixtureMembership ? 1 : 0,
      DEMO_ORGANISATION_ID,
      definition.role,
      expectedMembershipEventId,
      expectedMembershipEventId,
    )
    .first<{
      personId: string;
      name: string;
      email: string;
      biography: string;
      profileRevision: number;
    }>();
  if (!person) {
    throw new Response(
      "This evaluator identity is unavailable. Ask the evaluation operator to reset the fixture.",
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    await assertEvaluationPeopleAreDedicated(env, [person.personId]);
  } catch (error) {
    if (error instanceof EvaluationIdentityIsolationError) {
      throw new Response(
        "This evaluator identity is no longer isolated to the dedicated evaluation organisation. Ask the evaluation operator to reset the fixture.",
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    throw error;
  }
  return { ...person, identityKey, definition };
}

export async function activateEvaluationApplicantAccount(
  env: CloudflareEnvironment,
  fixtureGeneration: string,
) {
  requireEvaluationMode(env);
  const definition = EVALUATION_IDENTITIES.sbek_applicant;
  try {
    await assertEvaluationPeopleAreDedicated(env, [definition.personId]);
  } catch (error) {
    if (error instanceof EvaluationIdentityIsolationError) {
      throw new Response(
        "The fixed evaluator applicant is no longer isolated to the dedicated evaluation organisation.",
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
    throw error;
  }
  const operationId = `evaluation-account:${fixtureGeneration}`;
  const auditId = `evaluation-account-activation:${fixtureGeneration}`;
  const metadataJson = JSON.stringify({
    identityKey: "sbek_applicant",
    fixtureGeneration,
    activationKind: "fixed_fixture_submitter_membership",
  });
  const existing = await env.DB.prepare(
    `SELECT organisation_id AS organisationId, event_id AS eventId,
            person_id AS personId, role
       FROM memberships WHERE id = ?`,
  )
    .bind(EVALUATION_APPLICANT_MEMBERSHIP_ID)
    .first<{
      organisationId: string;
      eventId: string | null;
      personId: string;
      role: string;
    }>();
  if (
    existing &&
    (existing.organisationId !== DEMO_ORGANISATION_ID ||
      existing.eventId !== DEMO_EVENT_ID ||
      existing.personId !== definition.personId ||
      existing.role !== "submitter")
  ) {
    throw new Error(
      "The fixed evaluator applicant membership belongs to another identity or tenant.",
    );
  }
  const [membership, audit, verification] = await env.DB.batch([
    env.DB.prepare(
      `WITH latest_reset AS (
         SELECT id, action
           FROM audit_events
          WHERE organisation_id = ? AND event_id = ?
            AND action IN (
              'evaluation.fixture.reset.started',
              'evaluation.fixture.reset'
            )
            AND entity_type = 'event' AND entity_id = ?
          ORDER BY rowid DESC
          LIMIT 1
       )
       INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role,
         invited_at, accepted_at, revoked_at, last_operation_id, created_at
       ) SELECT ?, ?, ?, person.id, 'submitter', NULL, unixepoch(),
                NULL, ?, unixepoch()
           FROM people person
           JOIN events event ON event.id = ? AND event.organisation_id = ?
          WHERE person.id = ? AND event.activation_status = 'active'
            AND EXISTS (
              SELECT 1 FROM latest_reset
               WHERE id = ? AND action = 'evaluation.fixture.reset'
            )
            AND NOT EXISTS (
              SELECT 1 FROM audit_events existing_audit
               WHERE existing_audit.id = ?
                 AND NOT (
                   existing_audit.organisation_id = ?
                   AND existing_audit.event_id = ?
                   AND existing_audit.actor_id = 'production-evaluation-access'
                   AND existing_audit.action = 'evaluation.account.activated'
                   AND existing_audit.entity_type = 'person'
                   AND existing_audit.entity_id = ?
                   AND existing_audit.correlation_id = ?
                   AND existing_audit.metadata_json = ?
                 )
            )
       ON CONFLICT(id) DO UPDATE SET
         accepted_at = unixepoch(), revoked_at = NULL,
         last_operation_id = excluded.last_operation_id
       WHERE memberships.organisation_id = excluded.organisation_id
         AND memberships.event_id = excluded.event_id
         AND memberships.person_id = excluded.person_id
         AND memberships.role = excluded.role
         AND memberships.last_operation_id IS NOT excluded.last_operation_id`,
    ).bind(
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      EVALUATION_APPLICANT_MEMBERSHIP_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      operationId,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      definition.personId,
      fixtureGeneration,
      auditId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      definition.personId,
      operationId,
      metadataJson,
    ),
    env.DB.prepare(
      `WITH latest_reset AS (
         SELECT id, action
           FROM audit_events
          WHERE organisation_id = ? AND event_id = ?
            AND action IN (
              'evaluation.fixture.reset.started',
              'evaluation.fixture.reset'
            )
            AND entity_type = 'event' AND entity_id = ?
          ORDER BY rowid DESC
          LIMIT 1
       )
       INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_id, action, entity_type,
         entity_id, correlation_id, metadata_json, created_at
       ) SELECT ?, 'system', 'internal', 1, ?, ?, 'production-evaluation-access',
                'evaluation.account.activated', 'person', ?, ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM latest_reset
             WHERE id = ? AND action = 'evaluation.fixture.reset'
          )
            AND EXISTS (
            SELECT 1 FROM memberships
             WHERE id = ? AND organisation_id = ? AND event_id = ?
               AND person_id = ? AND role = 'submitter'
               AND accepted_at IS NOT NULL AND revoked_at IS NULL
               AND last_operation_id = ?
          )
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      auditId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      definition.personId,
      operationId,
      metadataJson,
      fixtureGeneration,
      EVALUATION_APPLICANT_MEMBERSHIP_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      definition.personId,
      operationId,
    ),
    env.DB.prepare(
      `WITH latest_reset AS (
         SELECT id, action
           FROM audit_events
          WHERE organisation_id = ? AND event_id = ?
            AND action IN (
              'evaluation.fixture.reset.started',
              'evaluation.fixture.reset'
            )
            AND entity_type = 'event' AND entity_id = ?
          ORDER BY rowid DESC
          LIMIT 1
       )
       SELECT EXISTS (
                SELECT 1 FROM latest_reset
                 WHERE id = ? AND action = 'evaluation.fixture.reset'
              ) AS generationMatches,
              EXISTS (
                SELECT 1
                  FROM memberships membership
                  JOIN audit_events activation ON activation.id = ?
                 WHERE membership.id = ?
                   AND membership.organisation_id = ?
                   AND membership.event_id = ?
                   AND membership.person_id = ?
                   AND membership.role = 'submitter'
                   AND membership.accepted_at IS NOT NULL
                   AND membership.revoked_at IS NULL
                   AND membership.last_operation_id = ?
                   AND activation.organisation_id = ?
                   AND activation.event_id = ?
                   AND activation.actor_id = 'production-evaluation-access'
                   AND activation.action = 'evaluation.account.activated'
                   AND activation.entity_type = 'person'
                   AND activation.entity_id = ?
                   AND activation.correlation_id = ?
                   AND activation.metadata_json = ?
              ) AS activationMatches`,
    ).bind(
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      fixtureGeneration,
      auditId,
      EVALUATION_APPLICANT_MEMBERSHIP_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      definition.personId,
      operationId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      definition.personId,
      operationId,
      metadataJson,
    ),
  ]);
  const state = verification.results?.[0] as
    { generationMatches: number; activationMatches: number } | undefined;
  if (state?.generationMatches !== 1) {
    throw new Response(
      "The evaluation fixture changed before this account could be activated. Unlock the current fixture and try again.",
      { status: 409, headers: { "cache-control": "no-store" } },
    );
  }
  const firstApplication =
    (membership.meta.changes ?? 0) === 1 && (audit.meta.changes ?? 0) === 1;
  const exactReplay =
    (membership.meta.changes ?? 0) === 0 && (audit.meta.changes ?? 0) === 0;
  if (state.activationMatches !== 1 || (!firstApplication && !exactReplay)) {
    throw new Error("The fixed evaluator applicant account was not activated.");
  }
  return {
    membershipId: EVALUATION_APPLICANT_MEMBERSHIP_ID,
    personId: definition.personId,
    replayed: exactReplay,
  };
}

export async function selectedEvaluationPerson(
  request: Request,
  env: CloudflareEnvironment,
) {
  const runtime = requireRuntimeMode(env);
  if (!runtime.evaluation) return null;
  const session = await readEvaluationSession(request, env);
  return session ? evaluationPersonForSession(env, session) : null;
}

export async function evaluationPersonForSession(
  env: CloudflareEnvironment,
  session: EvaluationSessionPayload,
) {
  if (!session?.identityKey) return null;
  if (
    session.identityKey === "sbek_applicant" &&
    !(await evaluationApplicantMembershipIsActive(
      env,
      session.fixtureGeneration,
    ))
  ) {
    throw new Response(
      "The activated evaluator applicant account is unavailable. Ask the evaluation operator to reset the fixture.",
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return resolveEvaluationPerson(env, session.identityKey);
}

export { DEMO_EVENT_ID as EVALUATION_EVENT_ID };
export { DEMO_RESET_CONFIRMATION as EVALUATION_EVENT_NAME };
export { DEMO_ORGANISATION_ID as EVALUATION_ORGANISATION_ID };
