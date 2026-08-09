import { createAuth } from "~/platform/auth/auth.server";
import { requiresProductionSecurity } from "~/platform/runtime-environment.server";
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

async function sha256(value: string) {
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
  const apiKey = env.RESEND_API_KEY?.trim();
  if (!apiKey)
    throw new ApplicantConfigurationError(
      "RESEND_API_KEY is required to deliver the verification code",
    );
  const from = env.AUTH_EMAIL_FROM?.trim();
  if (!from)
    throw new ApplicantConfigurationError(
      "AUTH_EMAIL_FROM is required to deliver the verification code",
    );
  return { apiKey, from };
}

async function cookieName(formId: string) {
  return `${COOKIE_PREFIX}_${(await sha256(formId)).slice(0, 16)}`;
}

function cookieValue(request: Request, expectedName: string) {
  const cookies = request.headers.get("cookie") ?? "";
  for (const part of cookies.split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === expectedName) return decodeURIComponent(value.join("="));
  }
  return null;
}

function sessionCookie(name: string, value: string, production: boolean) {
  return `${name}=${encodeURIComponent(value)}; Path=/apply; HttpOnly; SameSite=Lax; Max-Age=1209600${production ? "; Secure" : ""}`;
}

export type PublicForm = FormSummary & { version: FormVersion };

async function applicationSessionIdentifierPrefix(form: PublicForm) {
  const accessFingerprint = await sha256(
    JSON.stringify([form.accessMode, form.accessPasswordHash]),
  );
  return `application-session:${form.id}:${accessFingerprint}:`;
}

export class ApplicantSessionService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async get(request: Request, form: PublicForm): Promise<Applicant | null> {
    if (form.accessMode === "account_required") {
      const session = await createAuth(this.env).api.getSession({
        headers: request.headers,
      });
      if (!session?.user || !session.user.emailVerified) return null;
      return {
        personId: session.user.id,
        email: session.user.email.toLowerCase(),
        name: session.user.name,
      };
    }

    const rawToken = cookieValue(request, await cookieName(form.id));
    if (!rawToken) return null;
    const tokenHash = await sha256(rawToken);
    const token = await this.env.DB.prepare(
      `
      SELECT identifier FROM verification_tokens
       WHERE value = ? AND expires_at > unixepoch()
       LIMIT 1
    `,
    )
      .bind(tokenHash)
      .first<{ identifier: string }>();
    const prefix = await applicationSessionIdentifierPrefix(form);
    if (!token?.identifier.startsWith(prefix)) return null;
    const personId = token.identifier.slice(prefix.length);
    const row = await this.env.DB.prepare(
      `
      SELECT id AS personId, email, display_name AS name
        FROM people WHERE id = ? AND email_verified = 1
    `,
    )
      .bind(personId)
      .first<Applicant>();
    return row ?? null;
  }

  async requestCode(form: PublicForm, emailInput: string, password: string) {
    if (form.accessMode === "account_required") {
      throw new ApplicantInputError(
        "This form requires a Program Cue account. Use the sign-in link instead.",
      );
    }
    const email = emailInput.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || email.length > 254)
      throw new ApplicantInputError("Enter a valid email address");

    if (form.accessMode === "password_protected") {
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

    const demo = String(this.env.DEMO_MODE) === "true";
    const delivery = demo ? null : requireEmailDelivery(this.env);
    const code = demo
      ? DEMO_CODE
      : String(
          crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000,
        ).padStart(6, "0");
    const codeHash = await sha256(
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
          id, event_id, form_id, email, token_hash, status, attempt_count, expires_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', 0, unixepoch() + 600, unixepoch())
        ON CONFLICT(token_hash) DO UPDATE SET
          status = 'pending', attempt_count = 0, expires_at = unixepoch() + 600,
          verified_at = NULL, consumed_at = NULL, created_at = unixepoch()
        WHERE submission_email_verifications.event_id = excluded.event_id
          AND submission_email_verifications.form_id = excluded.form_id
          AND submission_email_verifications.email = excluded.email COLLATE NOCASE
      `,
      ).bind(tokenId, form.eventId, form.id, email, codeHash),
    ]);

    if (!delivery) {
      return { demoCode: DEMO_CODE };
    }
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        authorization: `Bearer ${delivery.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: delivery.from,
        to: [email],
        subject: `Your ${form.eventName} application code`,
        text: `Your Program Cue verification code is ${code}. It expires in ten minutes.`,
      }),
    });
    if (!response.ok) {
      const details = await response.text();
      console.error("Verification email delivery failed", {
        status: response.status,
        details: details.slice(0, 240),
      });
      throw new ApplicantDeliveryError();
    }
    return { demoCode: null };
  }

  async verifyCode(form: PublicForm, emailInput: string, codeInput: string) {
    const email = emailInput.trim().toLowerCase();
    const codeHash = await sha256(
      `application-code:${requireApplicantPepper(this.env)}:${form.id}:${email}:${codeInput.trim()}`,
    );
    const person = await this.env.DB.prepare(
      `
      SELECT id AS personId, email, display_name AS name FROM people WHERE email = ? COLLATE NOCASE
    `,
    )
      .bind(email)
      .first<Applicant>();
    if (!person)
      throw new ApplicantInputError("The applicant record no longer exists");

    const rawSession = crypto.randomUUID() + crypto.randomUUID();
    const sessionHash = await sha256(rawSession);
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
      applicant: person,
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
        .bind(await sha256(rawToken))
        .run();
    }
    return `${name}=; Path=/apply; HttpOnly; SameSite=Lax; Max-Age=0`;
  }

  static hashPassword(value: string, pepper: string) {
    if (pepper.length < 32)
      throw new ApplicantConfigurationError(
        "BETTER_AUTH_SECRET must be configured with at least 32 characters",
      );
    return sha256(`form-password:${pepper}:${value}`);
  }
}
