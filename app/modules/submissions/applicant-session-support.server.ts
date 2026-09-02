import { createEmailProvider } from "~/modules/communications/email-provider.server";
import {
  EVALUATION_ORGANISATION_ID,
  type EvaluationSessionPayload,
  readEvaluationSession,
} from "~/platform/evaluation/evaluation-session.server";
import {
  requireRuntimeMode,
  requiresProductionSecurity,
} from "~/platform/runtime-environment.server";
import { ApplicantConfigurationError } from "./applicant-session-errors";
import type {
  Applicant,
  FormSummary,
  FormVersion,
} from "./submission-repository.server";

const COOKIE_PREFIX = "pc_applicant";
const PRODUCTION_COOKIE_PREFIX = "__Host-pc_applicant";

export async function hashApplicantToken(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function requireApplicantPepper(env: CloudflareEnvironment) {
  if (String(env.DEMO_MODE) === "true")
    return "program-cue-explicit-demo-only-verification-pepper";
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new ApplicantConfigurationError(
      "BETTER_AUTH_SECRET must be configured with at least 32 characters",
    );
  }
  return env.BETTER_AUTH_SECRET;
}

export function requireEmailDelivery(env: CloudflareEnvironment) {
  const from = env.AUTH_EMAIL_FROM?.trim();
  if (!from)
    throw new ApplicantConfigurationError(
      "AUTH_EMAIL_FROM is required to deliver the verification code",
    );
  try {
    return { provider: createEmailProvider(env), from };
  } catch (error) {
    throw new ApplicantConfigurationError(
      error instanceof Error
        ? error.message
        : "Email provider configuration is invalid",
    );
  }
}

export async function cookieName(formId: string, production: boolean) {
  const prefix = production ? PRODUCTION_COOKIE_PREFIX : COOKIE_PREFIX;
  return `${prefix}_${(await hashApplicantToken(formId)).slice(0, 16)}`;
}

export async function formCookieName(
  env: CloudflareEnvironment,
  formId: string,
) {
  return cookieName(formId, requiresProductionSecurity(env.APP_ENV));
}

export function cookieValue(request: Request, expectedName: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name !== expectedName) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {}
  }
  return null;
}

export function cookieSecureFlag(name: string, production: boolean) {
  return production || name.startsWith("__Host-") ? "; Secure" : "";
}

export function expireApplicantCookie(
  name: string,
  path: "/" | "/apply",
  production: boolean,
) {
  return `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureFlag(name, production)}`;
}

export function leftoverApplicantCookieExpiries(
  currentName: string,
  production: boolean,
) {
  if (currentName.startsWith("__Host-")) {
    const legacyName = currentName.slice("__Host-".length);
    return [
      expireApplicantCookie(legacyName, "/", true),
      expireApplicantCookie(legacyName, "/", false),
      expireApplicantCookie(legacyName, "/apply", true),
      expireApplicantCookie(legacyName, "/apply", false),
    ];
  }
  return [expireApplicantCookie(currentName, "/apply", production)];
}

export function applicantSetCookies(
  name: string,
  value: string,
  production: boolean,
) {
  return [
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600${cookieSecureFlag(name, production)}`,
    ...leftoverApplicantCookieExpiries(name, production),
  ];
}

export async function issueApplicantCookies(
  env: CloudflareEnvironment,
  formId: string,
  value: string,
) {
  const production = requiresProductionSecurity(env.APP_ENV);
  const setCookies = applicantSetCookies(
    await formCookieName(env, formId),
    value,
    production,
  );
  const cookie = setCookies[0];
  if (!cookie) {
    throw new Error("Applicant session cookies must include a live cookie.");
  }
  return { cookie, setCookies };
}

export async function readApplicantToken(
  request: Request,
  env: CloudflareEnvironment,
  formId: string,
) {
  return cookieValue(request, await formCookieName(env, formId));
}

export type PublicForm = FormSummary & { version: FormVersion };

export type PreparedApplicantSession = {
  applicant: Applicant;
  cookie: string;
  setCookies: string[];
  persistence: {
    sessionId: string;
    identifier: string;
    sessionHash: string;
    personId: string;
  };
};

export async function applicationSessionIdentifierPrefix(form: PublicForm) {
  const accessFingerprint = await hashApplicantToken(
    JSON.stringify([form.accessMode, form.accessPasswordHash]),
  );
  return `application-session:${form.id}:${accessFingerprint}:`;
}

export async function anonymousSessionIdentifierPrefix(form: PublicForm) {
  return `anonymous-${await applicationSessionIdentifierPrefix(form)}`;
}

export async function evaluationApplicationSessionIdentifierPrefix(
  form: PublicForm,
  fixtureGeneration: string,
) {
  return `${await applicationSessionIdentifierPrefix(form)}evaluation:${await hashApplicantToken(fixtureGeneration)}:`;
}

export function isEvaluationApplicantSession(
  session: EvaluationSessionPayload,
) {
  return (
    session.identityKey === "sbek_applicant" ||
    session.identityKey === "applicant"
  );
}

export function anonymousApplicant(draftId: string): Applicant {
  return {
    personId: null,
    email: "",
    name: "",
    verified: false,
    anonymousDraftId: draftId,
    biography: "",
    profileRevision: 0,
  };
}

export async function readApplicantSessionIdentifier(
  env: CloudflareEnvironment,
  request: Request,
  form: PublicForm,
) {
  const rawToken = await readApplicantToken(request, env, form.id);
  if (!rawToken) return null;
  const tokenHash = await hashApplicantToken(rawToken);
  return env.DB.prepare(
    `SELECT identifier FROM verification_tokens
      WHERE value = ? AND expires_at > unixepoch()
      LIMIT 1`,
  )
    .bind(tokenHash)
    .first<{ identifier: string }>();
}

export async function resolveAnonymousApplicantSession(
  env: CloudflareEnvironment,
  form: PublicForm,
  identifier: string,
  committedDiscardId?: string,
) {
  const anonymousPrefix = await anonymousSessionIdentifierPrefix(form);
  if (!identifier.startsWith(anonymousPrefix)) return null;
  const draftId = identifier.slice(anonymousPrefix.length);
  if (!draftId) return null;
  if (draftId === committedDiscardId) return anonymousApplicant(draftId);
  const ownedDraft = await env.DB.prepare(
    `SELECT submission.id
       FROM submissions submission
       JOIN form_versions version
         ON version.id = submission.form_version_id
        AND version.event_id = submission.event_id
      WHERE submission.id = ? AND submission.event_id = ?
        AND version.form_id = ? AND submission.status = 'draft'
        AND submission.submitter_person_id IS NULL
        AND submission.submitter_email IS NULL`,
  )
    .bind(draftId, form.eventId, form.id)
    .first<{ id: string }>();
  return ownedDraft ? anonymousApplicant(draftId) : null;
}

export async function resolveVerifiedApplicantSession(
  env: CloudflareEnvironment,
  form: PublicForm,
  identifier: string,
  prefix: string,
) {
  if (!identifier.startsWith(prefix)) return null;
  const personId = identifier.slice(prefix.length);
  if (!personId) return null;
  const row = await env.DB.prepare(
    `SELECT id AS personId, email, display_name AS name,
            COALESCE(biography, '') AS biography,
            profile_revision AS profileRevision
       FROM people WHERE id = ? AND email_verified = 1
         AND (
           ? <> 'account_required' OR EXISTS (
             SELECT 1 FROM submission_speakers speaker
             JOIN submissions submission
               ON submission.id = speaker.submission_id
              AND submission.event_id = speaker.event_id
             JOIN form_versions version
               ON version.id = submission.form_version_id
              AND version.event_id = submission.event_id
            WHERE speaker.person_id = people.id
              AND speaker.invitation_status = 'claimed'
              AND speaker.event_id = ? AND version.form_id = ?
           )
         )`,
  )
    .bind(personId, form.accessMode, form.eventId, form.id)
    .first<{
      personId: string;
      email: string;
      name: string;
      biography: string;
      profileRevision: number;
    }>();
  return row
    ? {
        ...row,
        verified: true as const,
        anonymousDraftId: null,
        claimOnly: form.accessMode === "account_required" || undefined,
      }
    : null;
}

export async function isEvaluationFixtureForm(
  env: CloudflareEnvironment,
  form: Pick<PublicForm, "eventId">,
) {
  const fixtureEvent = await env.DB.prepare(
    `SELECT 1 FROM events
      WHERE id = ? AND organisation_id = ?
        AND activation_status = 'active'`,
  )
    .bind(form.eventId, EVALUATION_ORGANISATION_ID)
    .first();
  return Boolean(fixtureEvent);
}

export async function evaluationApplicantSessionContext(
  env: CloudflareEnvironment,
  request: Request,
  form: Pick<PublicForm, "eventId">,
) {
  if (!requireRuntimeMode(env).evaluation) return null;
  const session = await readEvaluationSession(request, env);
  if (!session) return null;
  return {
    session,
    fixtureForm: await isEvaluationFixtureForm(env, form),
  };
}
