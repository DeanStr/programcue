import { betterAuth } from "better-auth";
import type { Logger } from "@better-auth/core/env";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";

import {
  createEmailProvider,
  emailIdempotencyKey,
} from "~/modules/communications/email-provider.server";
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
    "GOOGLE_AUTH_CLIENT_SECRET" | "MICROSOFT_AUTH_CLIENT_SECRET",
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
            disableSignUp: true,
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
            disableSignUp: true,
            scope: ["openid", "email", "profile"],
            tenantId: "common",
          },
        }
      : {}),
  };
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
      },
    },
    verification: { modelName: "verification" },
    socialProviders: participantOAuthProviderOptions(env),
    plugins: [
      magicLink({
        disableSignUp: true,
        expiresIn: 300,
        storeToken: "hashed",
        sendMagicLink: async ({ email, url }) => sendMagicLink(env, email, url),
      }),
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
