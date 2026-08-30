import { createEmailProvider } from "~/modules/communications/email-provider.server";
import { createAuth } from "~/platform/auth/auth.server";
import {
  EVALUATION_ORGANISATION_ID,
  type EvaluationSessionPayload,
  evaluationPersonForSession,
  readEvaluationSession,
} from "~/platform/evaluation/evaluation-session.server";
import {
  requireRuntimeMode,
  requiresProductionSecurity,
} from "~/platform/runtime-environment.server";
import type {
  Applicant,
  FormSummary,
  FormVersion,
} from "./submission-repository.server";

const COOKIE_PREFIX = "pc_applicant";
const PRODUCTION_COOKIE_PREFIX = "__Host-pc_applicant";
const DEMO_CODE = "424242";

export class ApplicantInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicantInputError";
  }
}

export class ApplicantConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApplicantConfigurationError";
  }
}

export class ApplicantDeliveryError extends Error {
  constructor(
    message = "The verification email could not be delivered. Try again later.",
  ) {
    super(message);
    this.name = "ApplicantDeliveryError";
  }
}

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

function requireEmailDelivery(env: CloudflareEnvironment) {
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

async function cookieName(formId: string, production: boolean) {
  const prefix = production ? PRODUCTION_COOKIE_PREFIX : COOKIE_PREFIX;
  return `${prefix}_${(await hashApplicantToken(formId)).slice(0, 16)}`;
}

async function formCookieName(env: CloudflareEnvironment, formId: string) {
  return cookieName(formId, requiresProductionSecurity(env.APP_ENV));
}

function cookieValue(request: Request, expectedName: string) {
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

function cookieSecureFlag(name: string, production: boolean) {
  return production || name.startsWith("__Host-") ? "; Secure" : "";
}

function expireApplicantCookie(
  name: string,
  path: "/" | "/apply",
  production: boolean,
) {
  return `${name}=; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=0${cookieSecureFlag(name, production)}`;
}

function leftoverApplicantCookieExpiries(
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

function applicantSetCookies(name: string, value: string, production: boolean) {
  return [
    `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1209600${cookieSecureFlag(name, production)}`,
    ...leftoverApplicantCookieExpiries(name, production),
  ];
}

async function issueApplicantCookies(
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

async function readApplicantToken(
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

async function applicationSessionIdentifierPrefix(form: PublicForm) {
  const accessFingerprint = await hashApplicantToken(
    JSON.stringify([form.accessMode, form.accessPasswordHash]),
  );
  return `application-session:${form.id}:${accessFingerprint}:`;
}

async function anonymousSessionIdentifierPrefix(form: PublicForm) {
  return `anonymous-${await applicationSessionIdentifierPrefix(form)}`;
}

async function evaluationApplicationSessionIdentifierPrefix(
  form: PublicForm,
  fixtureGeneration: string,
) {
  return `${await applicationSessionIdentifierPrefix(form)}evaluation:${await hashApplicantToken(fixtureGeneration)}:`;
}

function isEvaluationApplicantSession(session: EvaluationSessionPayload) {
  return (
    session.identityKey === "sbek_applicant" ||
    session.identityKey === "applicant"
  );
}

function anonymousApplicant(draftId: string): Applicant {
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

async function readApplicantSessionIdentifier(
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

async function resolveAnonymousApplicantSession(
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

async function resolveVerifiedApplicantSession(
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

async function isEvaluationFixtureForm(
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

export class ApplicantSessionService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async perPersonSubmissionLimitReached(
    form: PublicForm,
    personId: string,
    excludeSubmissionId: string,
  ) {
    if (form.perPersonSubmissionLimit === null) return false;
    const row = await this.env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM submissions submission
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
        WHERE version.form_id = ? AND submission.event_id = ?
          AND submission.submitter_person_id = ?
          AND submission.status <> 'withdrawn'
          AND submission.id <> ?`,
    )
      .bind(form.id, form.eventId, personId, excludeSubmissionId)
      .first<{ count: number }>();
    return (row?.count ?? 0) >= form.perPersonSubmissionLimit;
  }

  private perPersonSubmissionLimitMessage(form: PublicForm) {
    const limit = form.perPersonSubmissionLimit;
    if (limit === null) {
      throw new Error("A per-person submission limit is required.");
    }
    return `This form allows at most ${limit} active application${limit === 1 ? "" : "s"} per person. Withdraw an existing application before claiming this draft.`;
  }

  async get(
    request: Request,
    form: PublicForm,
    options: { committedDiscardId?: string } = {},
  ): Promise<Applicant | null> {
    const evaluationContext = await evaluationApplicantSessionContext(
      this.env,
      request,
      form,
    );
    if (evaluationContext) {
      const { session: evaluationSession } = evaluationContext;
      if (
        form.accessMode !== "password_protected" &&
        isEvaluationApplicantSession(evaluationSession)
      ) {
        if (evaluationContext.fixtureForm) {
          const evaluationPerson = await evaluationPersonForSession(
            this.env,
            evaluationSession,
          );
          if (!evaluationPerson) return null;
          return {
            personId: evaluationPerson.personId,
            email: evaluationPerson.email,
            name: evaluationPerson.name,
            biography: evaluationPerson.biography,
            profileRevision: evaluationPerson.profileRevision,
            verified: true,
            anonymousDraftId: null,
            evaluation: true,
          };
        }
      }
      const token = await readApplicantSessionIdentifier(
        this.env,
        request,
        form,
      );
      if (!token) return null;
      const anonymous = await resolveAnonymousApplicantSession(
        this.env,
        form,
        token.identifier,
        options.committedDiscardId,
      );
      if (anonymous) return anonymous;
      if (!evaluationContext.fixtureForm) return null;
      return resolveVerifiedApplicantSession(
        this.env,
        form,
        token.identifier,
        await evaluationApplicationSessionIdentifierPrefix(
          form,
          evaluationSession.fixtureGeneration,
        ),
      );
    }

    if (form.accessMode !== "password_protected") {
      const session = await createAuth(this.env).api.getSession({
        headers: request.headers,
      });
      if (session?.user?.emailVerified) {
        const person = await this.env.DB.prepare(
          `SELECT id AS personId, email, display_name AS name,
                  COALESCE(biography, '') AS biography,
                  profile_revision AS profileRevision
             FROM people WHERE id = ? AND email_verified = 1`,
        )
          .bind(session.user.id)
          .first<{
            personId: string;
            email: string;
            name: string;
            biography: string;
            profileRevision: number;
          }>();
        if (person) {
          return { ...person, verified: true, anonymousDraftId: null };
        }
      }
    }

    const token = await readApplicantSessionIdentifier(this.env, request, form);
    if (!token) return null;
    const anonymous = await resolveAnonymousApplicantSession(
      this.env,
      form,
      token.identifier,
      options.committedDiscardId,
    );
    if (anonymous) return anonymous;
    const prefix = await applicationSessionIdentifierPrefix(form);
    if (token.identifier.startsWith(`${prefix}evaluation:`)) return null;
    return resolveVerifiedApplicantSession(
      this.env,
      form,
      token.identifier,
      prefix,
    );
  }

  async startAnonymous(
    form: PublicForm,
    draftId: string,
    password: string,
    options: { requireExistingDraft: boolean } = {
      requireExistingDraft: false,
    },
  ) {
    if (!form.allowAnonymousDrafts || form.accessMode === "account_required") {
      throw new ApplicantInputError(
        "This form requires verification before a draft can be created.",
      );
    }
    await this.assertPassword(form, password);
    const rawSession = crypto.randomUUID() + crypto.randomUUID();
    const sessionHash = await hashApplicantToken(rawSession);
    const identifier = `${await anonymousSessionIdentifierPrefix(form)}${draftId}`;
    const tokenId = crypto.randomUUID();
    // Each exact retry receives a new bearer token. Existing tokens expire
    // naturally: deleting by identifier here could invalidate the response of
    // another concurrent request that won the draft-creation race.
    const inserted = await this.env.DB.prepare(
      `INSERT INTO verification_tokens (
         id, identifier, value, expires_at, created_at, updated_at
       )
       SELECT ?, ?, ?, unixepoch() + 1209600, unixepoch(), unixepoch()
        WHERE ? = 0 OR EXISTS (
          SELECT 1 FROM submissions submission
          JOIN form_versions version
            ON version.id = submission.form_version_id
           AND version.event_id = submission.event_id
         WHERE submission.id = ? AND submission.event_id = ?
           AND submission.status = 'draft'
           AND submission.submitter_person_id IS NULL
           AND submission.submitter_email IS NULL
           AND version.form_id = ?
        )`,
    )
      .bind(
        tokenId,
        identifier,
        sessionHash,
        options.requireExistingDraft ? 1 : 0,
        draftId,
        form.eventId,
        form.id,
      )
      .run();
    if ((inserted.meta.changes ?? 0) !== 1) {
      throw new ApplicantInputError(
        "This anonymous application draft is no longer available.",
      );
    }
    return {
      applicant: anonymousApplicant(draftId),
      tokenId,
      ...(await issueApplicantCookies(this.env, form.id, rawSession)),
    };
  }

  async prepareVerifiedSession(
    form: PublicForm,
    personId: string,
  ): Promise<PreparedApplicantSession> {
    const person = await this.env.DB.prepare(
      `SELECT id AS personId, email, display_name AS name,
              COALESCE(biography, '') AS biography,
              profile_revision AS profileRevision
         FROM people WHERE id = ?`,
    )
      .bind(personId)
      .first<{
        personId: string;
        email: string;
        name: string;
        biography: string;
        profileRevision: number;
      }>();
    if (!person) {
      throw new ApplicantInputError(
        "The invited speaker record is unavailable",
      );
    }
    const rawSession = crypto.randomUUID() + crypto.randomUUID();
    const sessionHash = await hashApplicantToken(rawSession);
    const identifier = `${await applicationSessionIdentifierPrefix(form)}${personId}`;
    const sessionId = crypto.randomUUID();
    return {
      applicant: {
        ...person,
        verified: true as const,
        anonymousDraftId: null,
      },
      ...(await issueApplicantCookies(this.env, form.id, rawSession)),
      persistence: { sessionId, identifier, sessionHash, personId },
    };
  }

  private async assertPassword(form: PublicForm, password: string) {
    if (form.accessMode !== "password_protected") return;
    if (!form.accessPasswordHash)
      throw new ApplicantConfigurationError(
        "This form is missing its access password configuration",
      );
    if (
      (await ApplicantSessionService.hashPassword(
        password,
        requireApplicantPepper(this.env),
      )) !== form.accessPasswordHash
    ) {
      throw new ApplicantInputError("The form password is incorrect");
    }
  }

  private async assertAnonymousPrimaryEmail(
    form: PublicForm,
    draftId: string,
    email: string,
  ) {
    const primary = await this.env.DB.prepare(
      `SELECT speaker.email
         FROM submission_speakers speaker
         JOIN submissions submission
           ON submission.id = speaker.submission_id
          AND submission.event_id = speaker.event_id
         JOIN form_versions version
           ON version.id = submission.form_version_id
          AND version.event_id = submission.event_id
        WHERE speaker.submission_id = ? AND speaker.event_id = ?
          AND speaker.position = 0 AND speaker.is_primary = 1
          AND submission.status = 'draft'
          AND submission.submitter_person_id IS NULL
          AND submission.submitter_email IS NULL
          AND version.form_id = ?`,
    )
      .bind(draftId, form.eventId, form.id)
      .first<{ email: string }>();
    if (primary && primary.email.toLowerCase() !== email.toLowerCase()) {
      throw new ApplicantInputError(
        "Verify the primary speaker email saved in this anonymous draft.",
      );
    }
  }

  private async evaluationSessionForVerification(
    request: Request | undefined,
    form: PublicForm,
  ) {
    if (!request) return null;
    const evaluationContext = await evaluationApplicantSessionContext(
      this.env,
      request,
      form,
    );
    if (evaluationContext && !evaluationContext.fixtureForm) {
      throw new ApplicantInputError(
        "Lock evaluation access before verifying an application outside the evaluation fixture.",
      );
    }
    return evaluationContext?.session ?? null;
  }

  async requestCode(
    form: PublicForm,
    emailInput: string,
    password: string,
    request?: Request,
  ) {
    if (form.accessMode === "account_required") {
      throw new ApplicantInputError(
        "This form requires a Program Cue account. Use the sign-in link instead.",
      );
    }
    const email = emailInput.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254)
      throw new ApplicantInputError("Enter a valid email address");

    const evaluationBound = await this.evaluationSessionForVerification(
      request,
      form,
    );
    const evaluationGenerationHash = evaluationBound
      ? await hashApplicantToken(evaluationBound.fixtureGeneration)
      : null;
    const current = request ? await this.get(request, form) : null;
    const anonymousDraftId =
      current && !current.verified ? current.anonymousDraftId : null;
    if (anonymousDraftId) {
      await this.assertAnonymousPrimaryEmail(form, anonymousDraftId, email);
    } else {
      await this.assertPassword(form, password);
    }

    const demo = !requiresProductionSecurity(this.env.APP_ENV);
    const delivery = demo ? null : requireEmailDelivery(this.env);
    const code = demo
      ? DEMO_CODE
      : String(
          crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000,
        ).padStart(6, "0");
    const codeHash = await hashApplicantToken(
      `application-code:${requireApplicantPepper(this.env)}:${form.id}:${email}:${code}`,
    );
    const personId = crypto.randomUUID();
    const tokenId = crypto.randomUUID();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'draft', unixepoch(), unixepoch())
        ON CONFLICT(email) DO NOTHING
      `,
      ).bind(personId, email, email.split("@")[0]),
      this.env.DB.prepare(
        `
        UPDATE submission_email_verifications
           SET status = 'revoked'
         WHERE event_id = ? AND form_id = ? AND email = ? COLLATE NOCASE AND status = 'pending'
      `,
      ).bind(form.eventId, form.id, email),
      this.env.DB.prepare(
        `
        INSERT INTO submission_email_verifications (
          id, event_id, form_id, submission_id, email, token_hash,
          evaluation_generation_hash, status, attempt_count, expires_at,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 0,
                  unixepoch() + 600, unixepoch())
        ON CONFLICT(token_hash) DO UPDATE SET
          submission_id = excluded.submission_id,
          evaluation_generation_hash = excluded.evaluation_generation_hash,
          status = 'pending', attempt_count = 0,
          expires_at = unixepoch() + 600,
          verified_at = NULL, consumed_at = NULL, created_at = unixepoch()
        WHERE submission_email_verifications.event_id = excluded.event_id
          AND submission_email_verifications.form_id = excluded.form_id
          AND submission_email_verifications.email = excluded.email COLLATE NOCASE
      `,
      ).bind(
        tokenId,
        form.eventId,
        form.id,
        anonymousDraftId,
        email,
        codeHash,
        evaluationGenerationHash,
      ),
    ]);

    if (!delivery) {
      return { demoCode: DEMO_CODE };
    }
    try {
      await delivery.provider.send({
        from: delivery.from,
        to: email,
        subject: `Your ${form.eventName} application code`,
        text: `Your Program Cue verification code is ${code}. It expires in ten minutes.`,
        html: `<p>Your Program Cue verification code is <strong>${code}</strong>.</p><p>It expires in ten minutes.</p>`,
        idempotencyKey: `application-verification:${tokenId}`,
      });
    } catch (error) {
      console.error("Verification email delivery failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      throw new ApplicantDeliveryError();
    }
    return { demoCode: null };
  }

  async verifyCode(
    form: PublicForm,
    emailInput: string,
    codeInput: string,
    request?: Request,
  ) {
    const email = emailInput.trim().toLowerCase();
    const evaluationBound = await this.evaluationSessionForVerification(
      request,
      form,
    );
    const codeHash = await hashApplicantToken(
      `application-code:${requireApplicantPepper(this.env)}:${form.id}:${email}:${codeInput.trim()}`,
    );
    const evaluationGenerationHash = evaluationBound
      ? await hashApplicantToken(evaluationBound.fixtureGeneration)
      : null;
    const pendingVerification = await this.env.DB.prepare(
      `SELECT evaluation_generation_hash AS evaluationGenerationHash
         FROM submission_email_verifications
        WHERE event_id = ? AND form_id = ? AND email = ? COLLATE NOCASE
          AND token_hash = ? AND status = 'pending'
          AND attempt_count < 5 AND expires_at > unixepoch()
        LIMIT 1`,
    )
      .bind(form.eventId, form.id, email, codeHash)
      .first<{ evaluationGenerationHash: string | null }>();
    if (
      pendingVerification &&
      pendingVerification.evaluationGenerationHash !== evaluationGenerationHash
    ) {
      throw new ApplicantInputError(
        pendingVerification.evaluationGenerationHash
          ? "Re-enter evaluation access before verifying this evaluation application."
          : "Lock evaluation access before verifying an application started outside evaluation.",
      );
    }
    const person = await this.env.DB.prepare(
      `
      SELECT id AS personId, email, display_name AS name,
             COALESCE(biography, '') AS biography,
             profile_revision AS profileRevision
        FROM people WHERE email = ? COLLATE NOCASE
    `,
    )
      .bind(email)
      .first<{
        personId: string;
        email: string;
        name: string;
        biography: string;
        profileRevision: number;
      }>();
    if (!person)
      throw new ApplicantInputError("The applicant record no longer exists");

    const current = request ? await this.get(request, form) : null;
    const anonymousDraftId =
      current && !current.verified ? current.anonymousDraftId : null;
    if (anonymousDraftId) {
      await this.assertAnonymousPrimaryEmail(form, anonymousDraftId, email);
      if (
        pendingVerification &&
        (await this.perPersonSubmissionLimitReached(
          form,
          person.personId,
          anonymousDraftId,
        ))
      ) {
        throw new ApplicantInputError(
          this.perPersonSubmissionLimitMessage(form),
        );
      }
    }
    const rawAnonymousToken = request
      ? await readApplicantToken(request, this.env, form.id)
      : null;
    const rawSession = crypto.randomUUID() + crypto.randomUUID();
    const sessionHash = await hashApplicantToken(rawSession);
    const sessionIdentifier = `${
      evaluationBound
        ? await evaluationApplicationSessionIdentifierPrefix(
            form,
            evaluationBound.fixtureGeneration,
          )
        : await applicationSessionIdentifierPrefix(form)
    }${person.personId}`;
    const sessionId = crypto.randomUUID();
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT INTO verification_tokens (id, identifier, value, expires_at, created_at, updated_at)
        SELECT ?, ?, ?, unixepoch() + 1209600, unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM submission_email_verifications
            WHERE event_id = ? AND form_id = ? AND email = ? COLLATE NOCASE AND token_hash = ?
              AND status = 'pending' AND attempt_count < 5 AND expires_at > unixepoch()
              AND (
                (? IS NULL AND submission_id IS NULL)
                OR submission_id = ?
              )
              AND (
                (? IS NULL AND evaluation_generation_hash IS NULL)
                OR evaluation_generation_hash = ?
              )
              AND (
                ? IS NULL OR ? IS NULL OR (
                  SELECT COUNT(*)
                    FROM submissions active_submission
                    JOIN form_versions active_version
                      ON active_version.id = active_submission.form_version_id
                     AND active_version.event_id = active_submission.event_id
                   WHERE active_version.form_id = ?
                     AND active_submission.event_id = ?
                     AND active_submission.submitter_person_id = ?
                     AND active_submission.status <> 'withdrawn'
                     AND active_submission.id <> ?
                ) < ?
              )
         )
      `,
      ).bind(
        sessionId,
        sessionIdentifier,
        sessionHash,
        form.eventId,
        form.id,
        email,
        codeHash,
        anonymousDraftId,
        anonymousDraftId,
        evaluationGenerationHash,
        evaluationGenerationHash,
        anonymousDraftId,
        form.perPersonSubmissionLimit,
        form.id,
        form.eventId,
        person.personId,
        anonymousDraftId,
        form.perPersonSubmissionLimit,
      ),
      this.env.DB.prepare(
        `
        UPDATE submission_email_verifications
           SET status = 'consumed', verified_at = unixepoch(), consumed_at = unixepoch()
         WHERE event_id = ? AND form_id = ? AND email = ? COLLATE NOCASE AND token_hash = ?
           AND status = 'pending' AND attempt_count < 5 AND expires_at > unixepoch()
           AND EXISTS (SELECT 1 FROM verification_tokens WHERE id = ?)
      `,
      ).bind(form.eventId, form.id, email, codeHash, sessionId),
      this.env.DB.prepare(
        `
        DELETE FROM verification_tokens
         WHERE identifier = ? AND id <> ?
           AND EXISTS (SELECT 1 FROM verification_tokens WHERE id = ?)
      `,
      ).bind(sessionIdentifier, sessionId, sessionId),
      this.env.DB.prepare(
        `
        UPDATE people SET email_verified = 1, updated_at = unixepoch()
         WHERE id = ? AND EXISTS (SELECT 1 FROM verification_tokens WHERE id = ?)
      `,
      ).bind(person.personId, sessionId),
      this.env.DB.prepare(
        `
        UPDATE submissions
           SET submitter_person_id = ?, submitter_email = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status = 'draft'
           AND submitter_person_id IS NULL AND submitter_email IS NULL
           AND EXISTS (
             SELECT 1 FROM form_versions version
              WHERE version.id = submissions.form_version_id
                AND version.event_id = submissions.event_id
                AND version.form_id = ?
           )
           AND EXISTS (SELECT 1 FROM verification_tokens WHERE id = ?)
      `,
      ).bind(
        person.personId,
        person.email,
        anonymousDraftId,
        form.eventId,
        form.id,
        sessionId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submission_speakers
           SET person_id = ?, invitation_status = 'claimed', claimed_at = unixepoch(),
               updated_at = unixepoch()
         WHERE submission_id = ? AND event_id = ? AND email = ? COLLATE NOCASE
           AND EXISTS (SELECT 1 FROM verification_tokens WHERE id = ?)
      `,
      ).bind(
        person.personId,
        anonymousDraftId,
        form.eventId,
        person.email,
        sessionId,
      ),
      this.env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, invitation_expires_at, accepted_at, revoked_at,
           last_operation_id, created_at
         )
         SELECT ?, event.organisation_id, event.id, ?, 'submitter',
                unixepoch(), NULL, unixepoch(), NULL, ?, unixepoch()
           FROM events event
          WHERE event.id = ? AND ? IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM submissions submission
               WHERE submission.id = ? AND submission.event_id = event.id
                 AND submission.submitter_person_id = ?
            )
            AND EXISTS (SELECT 1 FROM verification_tokens WHERE id = ?)
         ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
         DO UPDATE SET invited_at = unixepoch(), invitation_expires_at = NULL,
                       accepted_at = unixepoch(), revoked_at = NULL,
                       last_operation_id = excluded.last_operation_id
          WHERE memberships.organisation_id = excluded.organisation_id
            AND (memberships.revoked_at IS NOT NULL
                 OR memberships.accepted_at IS NULL)`,
      ).bind(
        crypto.randomUUID(),
        person.personId,
        sessionId,
        form.eventId,
        anonymousDraftId,
        anonymousDraftId,
        person.personId,
        sessionId,
      ),
      this.env.DB.prepare(
        `UPDATE file_assets
            SET owner_person_id = ?, updated_at = unixepoch()
          WHERE event_id = ? AND target_type = 'submission' AND target_id = ?
            AND owner_person_id IS NULL
            AND EXISTS (
              SELECT 1 FROM submissions submission
               WHERE submission.id = file_assets.target_id
                 AND submission.event_id = file_assets.event_id
                 AND submission.status = 'draft'
                 AND submission.submitter_person_id = ?
            )
            AND EXISTS (SELECT 1 FROM verification_tokens WHERE id = ?)`,
      ).bind(
        person.personId,
        form.eventId,
        anonymousDraftId,
        person.personId,
        sessionId,
      ),
      this.env.DB.prepare(
        `UPDATE file_versions
            SET created_by_person_id = ?
          WHERE event_id = ? AND created_by_person_id IS NULL
            AND EXISTS (
              SELECT 1 FROM file_assets asset
               WHERE asset.id = file_versions.asset_id
                 AND asset.event_id = file_versions.event_id
                 AND asset.target_type = 'submission'
                 AND asset.target_id = ?
                 AND asset.owner_person_id = ?
            )
            AND EXISTS (SELECT 1 FROM verification_tokens WHERE id = ?)`,
      ).bind(
        person.personId,
        form.eventId,
        anonymousDraftId,
        person.personId,
        sessionId,
      ),
      this.env.DB.prepare(
        `DELETE FROM verification_tokens
          WHERE value = ? AND ? IS NOT NULL
            AND EXISTS (SELECT 1 FROM verification_tokens WHERE id = ?)`,
      ).bind(
        rawAnonymousToken
          ? await hashApplicantToken(rawAnonymousToken)
          : "no-anonymous-session",
        anonymousDraftId,
        sessionId,
      ),
    ]);
    if (
      (results[0].meta.changes ?? 0) !== 1 ||
      (results[1].meta.changes ?? 0) !== 1
    ) {
      if (
        pendingVerification &&
        anonymousDraftId &&
        (await this.perPersonSubmissionLimitReached(
          form,
          person.personId,
          anonymousDraftId,
        ))
      ) {
        throw new ApplicantInputError(
          this.perPersonSubmissionLimitMessage(form),
        );
      }
      await this.env.DB.prepare(
        `
        UPDATE submission_email_verifications
           SET attempt_count = attempt_count + 1,
               status = CASE WHEN attempt_count + 1 >= 5 OR expires_at <= unixepoch() THEN 'expired' ELSE status END
         WHERE event_id = ? AND form_id = ? AND email = ? COLLATE NOCASE AND status = 'pending'
      `,
      )
        .bind(form.eventId, form.id, email)
        .run();
      throw new ApplicantInputError(
        "That verification code is invalid or expired",
      );
    }
    return {
      applicant: {
        ...person,
        verified: true as const,
        anonymousDraftId: null,
      },
      ...(await issueApplicantCookies(this.env, form.id, rawSession)),
    };
  }

  async signOut(request: Request, form: PublicForm) {
    const production = requiresProductionSecurity(this.env.APP_ENV);
    const name = await formCookieName(this.env, form.id);
    const rawToken = await readApplicantToken(request, this.env, form.id);
    if (rawToken) {
      await this.env.DB.prepare(
        "DELETE FROM verification_tokens WHERE value = ?",
      )
        .bind(await hashApplicantToken(rawToken))
        .run();
    }
    return [
      expireApplicantCookie(name, "/", production),
      ...leftoverApplicantCookieExpiries(name, production),
    ];
  }

  static hashPassword(value: string, pepper: string) {
    if (pepper.length < 32)
      throw new ApplicantConfigurationError(
        "BETTER_AUTH_SECRET must be configured with at least 32 characters",
      );
    return hashApplicantToken(`form-password:${pepper}:${value}`);
  }
}
