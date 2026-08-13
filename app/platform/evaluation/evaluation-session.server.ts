import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_ORGANISATION_ID,
  DEMO_RESET_CONFIRMATION,
  SBEK_SECOND_SPEAKER,
} from "~/platform/demo/demo-identities";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

export const EVALUATION_SESSION_COOKIE = "__Host-program_cue_evaluation";
const SESSION_SECONDS = 60 * 60 * 8;

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
      "Open Command Centre, inspect submissions, then publish a schedule change.",
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
  sbek_second_speaker: {
    ...SBEK_SECOND_SPEAKER,
    role: "submitter",
    destination: "/apply/form",
    cohort: "sbek",
    label: "Clean co-speaker",
    description:
      "The second fixed identity used in the automated application scenario.",
    whatToTry:
      "Use this identity only when inspecting the co-speaker scenario.",
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

type EvaluationSessionPayload = {
  version: 1;
  identityKey: EvaluationIdentityKey | null;
  fixtureGeneration: string;
  expiresAt: number;
};

async function currentFixtureGeneration(env: CloudflareEnvironment) {
  if (!env.DB) {
    throw new Error("Required Cloudflare binding DB is unavailable.");
  }
  const reset = await env.DB.prepare(
    `SELECT id AS fixtureGeneration, action
       FROM audit_events
      WHERE organisation_id = ? AND event_id = ?
        AND action IN (
          'evaluation.fixture.reset.started',
          'evaluation.fixture.reset'
        )
        AND entity_type = 'event' AND entity_id = ?
      ORDER BY rowid DESC
      LIMIT 1`,
  )
    .bind(DEMO_ORGANISATION_ID, DEMO_EVENT_ID, DEMO_EVENT_ID)
    .first<{ fixtureGeneration: string; action: string }>();
  if (
    !reset?.fixtureGeneration ||
    reset.action !== "evaluation.fixture.reset"
  ) {
    throw new Response(
      "The evaluation fixture has no completed reset. Ask the evaluation operator to complete a reset before granting access.",
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  return reset.fixtureGeneration;
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

export async function evaluationSessionCookie(
  env: CloudflareEnvironment,
  identityKey: EvaluationIdentityKey | null,
  now = Math.floor(Date.now() / 1000),
) {
  requireEvaluationMode(env);
  const payload: EvaluationSessionPayload = {
    version: 1,
    identityKey,
    fixtureGeneration: await currentFixtureGeneration(env),
    expiresAt: now + SESSION_SECONDS,
  };
  const encodedPayload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  const signature = await sign(encodedPayload, configuredSecret(env));
  return `${EVALUATION_SESSION_COOKIE}=${encodedPayload}.${signature}; Max-Age=${SESSION_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Lax`;
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
          EXISTS (
            SELECT 1 FROM memberships membership
             WHERE membership.person_id = person.id
               AND membership.organisation_id = ?
          )
          OR person.id IN (?, ?, ?)
        )`,
  )
    .bind(
      definition.personId,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_IDENTITIES.sbek_speaker.personId,
      SBEK_SECOND_SPEAKER.personId,
      DEMO_IDENTITIES.sbek_reviewer.personId,
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
  return { ...person, identityKey, definition };
}

export async function selectedEvaluationPerson(
  request: Request,
  env: CloudflareEnvironment,
) {
  const runtime = requireRuntimeMode(env);
  if (!runtime.evaluation) return null;
  const session = await readEvaluationSession(request, env);
  if (!session?.identityKey) return null;
  return resolveEvaluationPerson(env, session.identityKey);
}

export { DEMO_EVENT_ID as EVALUATION_EVENT_ID };
export { DEMO_RESET_CONFIRMATION as EVALUATION_EVENT_NAME };
export { DEMO_ORGANISATION_ID as EVALUATION_ORGANISATION_ID };
