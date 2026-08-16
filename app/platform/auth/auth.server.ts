import type { Logger } from "@better-auth/core/env";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";

import {
  createEmailProvider,
  emailIdempotencyKey,
} from "~/modules/communications/email-provider.server";
import {
  MICROSOFT_AUTH_CALLBACK_PATH,
  microsoftFormPostPlugin,
} from "~/platform/auth/microsoft-auth-callback.server";
import { createDatabase } from "~/platform/database/db.server";
import { authSchema } from "~/platform/database/schema";
import { sourceRevisionForLog } from "~/platform/observability/source-revision.server";

type ParticipantOAuthEnvironment = CloudflareEnvironment & {
  GOOGLE_AUTH_CLIENT_ID?: string;
  GOOGLE_AUTH_CLIENT_SECRET?: string;
  MICROSOFT_AUTH_CLIENT_ID?: string;
  MICROSOFT_AUTH_CLIENT_SECRET?: string;
};

type ParticipantOAuthCredentials = {
  clientId: string;
  clientSecret: string;
};

const ERROR_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,63}$/u;
const OAUTH_STATE_PATTERN = /^[A-Za-z0-9_-]{20,256}$/u;

type StoredOAuthLinkState = {
  expiresAt?: unknown;
  oauthState?: unknown;
  link?: {
    email?: unknown;
    userId?: unknown;
  };
};

function boundedErrorName(values: ReadonlyArray<unknown>) {
  const error = values.find((value) => value instanceof Error);
  if (!(error instanceof Error)) return "UnknownError";
  const className = error.constructor?.name ?? "";
  return ERROR_NAME_PATTERN.test(className) ? className : "Error";
}

function authenticationLibraryLogger(env: CloudflareEnvironment): Logger {
  return {
    level: "warn",
    log(level, message, ...details) {
      const entry = JSON.stringify({
        level,
        sourceRevision: sourceRevisionForLog(env),
        subsystem: "better-auth",
        event: "library-report",
        errorName: boundedErrorName([message, ...details]),
        message: "The authentication library reported a warning or error.",
      });
      if (level === "error") console.error(entry);
      else console.warn(entry);
    },
  };
}

export class ParticipantOAuthConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParticipantOAuthConfigurationError";
  }
}

function optionalParticipantOAuthCredentials(
  env: ParticipantOAuthEnvironment,
  provider: "Google" | "Microsoft",
  clientIdName: "GOOGLE_AUTH_CLIENT_ID" | "MICROSOFT_AUTH_CLIENT_ID",
  clientSecretName:
    | "GOOGLE_AUTH_CLIENT_SECRET"
    | "MICROSOFT_AUTH_CLIENT_SECRET",
): ParticipantOAuthCredentials | null {
  const clientId = env[clientIdName]?.trim() ?? "";
  const clientSecret = env[clientSecretName]?.trim() ?? "";
  if (!clientId && !clientSecret) return null;
  if (!clientId || !clientSecret) {
    throw new ParticipantOAuthConfigurationError(
      `${provider} participant sign-in requires both ${clientIdName} and ${clientSecretName}.`,
    );
  }
  return { clientId, clientSecret };
}

export function participantOAuthConfiguration(
  environment: CloudflareEnvironment,
) {
  const env = environment as ParticipantOAuthEnvironment;
  return {
    google: optionalParticipantOAuthCredentials(
      env,
      "Google",
      "GOOGLE_AUTH_CLIENT_ID",
      "GOOGLE_AUTH_CLIENT_SECRET",
    ),
    microsoft: optionalParticipantOAuthCredentials(
      env,
      "Microsoft",
      "MICROSOFT_AUTH_CLIENT_ID",
      "MICROSOFT_AUTH_CLIENT_SECRET",
    ),
  };
}

export function participantOAuthProviderOptions(
  environment: CloudflareEnvironment,
) {
  const participantOAuth = participantOAuthConfiguration(environment);
  return {
    ...(participantOAuth.google
      ? {
          google: {
            ...participantOAuth.google,
            accessType: "online" as const,
            disableDefaultScope: true,
            disableIdTokenSignIn: true,
            scope: ["openid", "email", "profile"],
          },
        }
      : {}),
    ...(participantOAuth.microsoft
      ? {
          microsoft: {
            ...participantOAuth.microsoft,
            disableDefaultScope: true,
            disableIdTokenSignIn: true,
            disableProfilePhoto: true,
            responseMode: "form_post" as const,
            scope: ["openid", "email", "profile"],
            tenantId: "common",
          },
        }
      : {}),
  };
}

/**
 * Microsoft does not normally assert `email_verified`, so an ordinary social
 * sign-in must never treat its email claim as sufficient account-link proof.
 * Better Auth's explicit link endpoint is session-protected and persists the
 * authenticated person's ID/email inside short-lived, signed OAuth state. Only
 * that state-backed callback may treat Microsoft as trusted; Better Auth still
 * requires the returned provider email to exactly match the session email.
 */
export async function trustedParticipantOAuthProviders(
  environment: CloudflareEnvironment,
  request?: Request,
) {
  if (request?.method !== "GET") return [];
  const url = new URL(request.url);
  if (url.pathname !== MICROSOFT_AUTH_CALLBACK_PATH) return [];
  const state = url.searchParams.get("state") ?? "";
  if (!OAUTH_STATE_PATTERN.test(state)) return [];

  const stored = await environment.DB.prepare(
    `
      SELECT value
        FROM verification_tokens
       WHERE identifier = ?
         AND expires_at > unixepoch()
       ORDER BY expires_at DESC
       LIMIT 1
    `,
  )
    .bind(state)
    .first<{ value: string }>();
  if (!stored) return [];

  let payload: StoredOAuthLinkState;
  try {
    payload = JSON.parse(stored.value) as StoredOAuthLinkState;
  } catch {
    return [];
  }
  if (
    payload.oauthState !== state ||
    typeof payload.expiresAt !== "number" ||
    payload.expiresAt <= Date.now() ||
    typeof payload.link?.userId !== "string" ||
    payload.link.userId.length === 0 ||
    typeof payload.link.email !== "string" ||
    payload.link.email.length === 0
  ) {
    return [];
  }
  return ["microsoft"];
}

function requireAuthConfiguration(env: CloudflareEnvironment) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new Response("Authentication server configuration is incomplete.", {
      status: 503,
      statusText: "Authentication configuration unavailable",
    });
  }
  if (!env.BETTER_AUTH_URL) {
    throw new Response("Authentication server configuration is incomplete.", {
      status: 503,
      statusText: "Authentication configuration unavailable",
    });
  }
}

async function sendMagicLink(
  env: CloudflareEnvironment,
  email: string,
  url: string,
) {
  if (!env.AUTH_EMAIL_FROM)
    throw new Error("AUTH_EMAIL_FROM is required to send authentication links");
  const text = `Use this one-time link to sign in to Program Cue:\n\n${url}\n\nThe link expires in five minutes.`;
  await createEmailProvider(env).send({
    from: env.AUTH_EMAIL_FROM,
    to: email,
    subject: "Sign in to Program Cue",
    text,
    html: `<p>Use this one-time link to sign in to Program Cue:</p><p><a href="${url.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}">Sign in to Program Cue</a></p><p>The link expires in five minutes.</p>`,
    idempotencyKey: await emailIdempotencyKey("auth-magic-link", email, url),
  });
}

export function createAuth(env: CloudflareEnvironment) {
  requireAuthConfiguration(env);
  const database = createDatabase(env);

  return betterAuth({
    appName: "Program Cue",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    logger: authenticationLibraryLogger(env),
    database: drizzleAdapter(database, {
      provider: "sqlite",
      schema: authSchema,
    }),
    user: {
      modelName: "user",
    },
    session: {
      modelName: "session",
      expiresIn: 60 * 60 * 24 * 14,
      updateAge: 60 * 60 * 24,
    },
    account: {
      modelName: "account",
      encryptOAuthTokens: true,
      accountLinking: {
        enabled: true,
        allowDifferentEmails: false,
        // Invitation rows have no local credential and start unverified. The
        // provider must still assert a verified matching email before linking.
        requireLocalEmailVerified: false,
        trustedProviders: (request) =>
          trustedParticipantOAuthProviders(env, request),
      },
    },
    verification: { modelName: "verification" },
    socialProviders: participantOAuthProviderOptions(env),
    plugins: [
      magicLink({
        expiresIn: 300,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => sendMagicLink(env, email, url),
      }),
      microsoftFormPostPlugin,
    ],
  });
}

export async function signOutSession(
  env: CloudflareEnvironment,
  request: Request,
) {
  const headers = new Headers(request.headers);
  headers.delete("content-length");
  headers.delete("content-type");
  const endpoint = new URL("/api/auth/sign-out", request.url);
  return createAuth(env).handler(
    new Request(endpoint, { method: "POST", headers }),
  );
}
