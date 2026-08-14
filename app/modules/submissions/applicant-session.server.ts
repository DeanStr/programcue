import { createAuth } from "~/platform/auth/auth.server";
import { createEmailProvider } from "~/modules/communications/email-provider.server";
import {
  EVALUATION_ORGANISATION_ID,
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

async function cookieName(formId: string) {
  return `${COOKIE_PREFIX}_${(await hashApplicantToken(formId)).slice(0, 16)}`;
}

function cookieValue(request: Request, expectedName: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === expectedName) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function sessionCookie(name: string, value: string, production: boolean) {
  return `${name}=${encodeURIComponent(value)}; Path=/apply; HttpOnly; SameSite=Lax; Max-Age=1209600${production ? "; Secure" : ""}`;
}

export type PublicForm = FormSummary & { version: FormVersion };

export type PreparedApplicantSession = {
  applicant: Applicant;
  cookie: string;
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

export class ApplicantSessionService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async get(request: Request, form: PublicForm): Promise<Applicant | null> {
    const evaluationSession = requireRuntimeMode(this.env).evaluation
      ? await readEvaluationSession(request, this.env)
      : null;
    if (evaluationSession) {
      if (
        form.accessMode !== "password_protected" &&
        evaluationSession.identityKey === "sbek_applicant"
      ) {
        const fixtureEvent = await this.env.DB.prepare(
          `SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ?
              AND activation_status = 'active'`,
        )
          .bind(form.eventId, EVALUATION_ORGANISATION_ID)
          .first();
        if (fixtureEvent) {
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
      return null;
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

    const rawToken = cookieValue(request, await cookieName(form.id));
    if (!rawToken) return null;
    const tokenHash = await hashApplicantToken(rawToken);
    const token = await this.env.DB.prepare(
      `
      SELECT identifier FROM verification_tokens
       WHERE value = ? AND expires_at > unixepoch()
       LIMIT 1
    `,
    )
      .bind(tokenHash)
      .first<{ identifier: string }>();
    const anonymousPrefix = await anonymousSessionIdentifierPrefix(form);
    if (token?.identifier.startsWith(anonymousPrefix)) {
      const draftId = token.identifier.slice(anonymousPrefix.length);
      if (!draftId) return null;
      const ownedDraft = await this.env.DB.prepare(
        `
        SELECT s.id
          FROM submissions s
          JOIN form_versions version
            ON version.id = s.form_version_id AND version.event_id = s.event_id
         WHERE s.id = ? AND s.event_id = ? AND version.form_id = ?
           AND s.status = 'draft' AND s.submitter_person_id IS NULL
           AND s.submitter_email IS NULL
      `,
      )
        .bind(draftId, form.eventId, form.id)
        .first<{ id: string }>();
      return ownedDraft ? anonymousApplicant(draftId) : null;
    }
    const prefix = await applicationSessionIdentifierPrefix(form);
    if (!token?.identifier.startsWith(prefix)) return null;
    const personId = token.identifier.slice(prefix.length);
    const row = await this.env.DB.prepare(
      `
      SELECT id AS personId, email, display_name AS name,
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
          )
    `,
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
      cookie: sessionCookie(
        await cookieName(form.id),
        rawSession,
        requiresProductionSecurity(this.env.APP_ENV),
      ),
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
      cookie: sessionCookie(
        await cookieName(form.id),
        rawSession,
        requiresProductionSecurity(this.env.APP_ENV),
      ),
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
          id, event_id, form_id, submission_id, email, token_hash, status,
          attempt_count, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, unixepoch() + 600, unixepoch())
        ON CONFLICT(token_hash) DO UPDATE SET
          submission_id = excluded.submission_id, status = 'pending', attempt_count = 0,
          expires_at = unixepoch() + 600,
          verified_at = NULL, consumed_at = NULL, created_at = unixepoch()
        WHERE submission_email_verifications.event_id = excluded.event_id
          AND submission_email_verifications.form_id = excluded.form_id
          AND submission_email_verifications.email = excluded.email COLLATE NOCASE
      `,
      ).bind(tokenId, form.eventId, form.id, anonymousDraftId, email, codeHash),
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
    const codeHash = await hashApplicantToken(
      `application-code:${requireApplicantPepper(this.env)}:${form.id}:${email}:${codeInput.trim()}`,
    );
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
    }
    const rawAnonymousToken = request
      ? cookieValue(request, await cookieName(form.id))
      : null;
    const rawSession = crypto.randomUUID() + crypto.randomUUID();
    const sessionHash = await hashApplicantToken(rawSession);
    const sessionIdentifier = `${await applicationSessionIdentifierPrefix(form)}${person.personId}`;
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
      cookie: sessionCookie(
        await cookieName(form.id),
        rawSession,
        requiresProductionSecurity(this.env.APP_ENV),
      ),
    };
  }

  async signOut(request: Request, form: PublicForm) {
    const name = await cookieName(form.id);
    const rawToken = cookieValue(request, name);
    if (rawToken) {
      await this.env.DB.prepare(
        "DELETE FROM verification_tokens WHERE value = ?",
      )
        .bind(await hashApplicantToken(rawToken))
        .run();
    }
    return `${name}=; Path=/apply; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  static hashPassword(value: string, pepper: string) {
    if (pepper.length < 32)
      throw new ApplicantConfigurationError(
        "BETTER_AUTH_SECRET must be configured with at least 32 characters",
      );
    return hashApplicantToken(`form-password:${pepper}:${value}`);
  }
}
