import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { magicLink } from "better-auth/plugins";

import { createDatabase } from "~/platform/database/db.server";
import { authSchema } from "~/platform/database/schema";

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
  if (!env.RESEND_API_KEY)
    throw new Error("RESEND_API_KEY is required to send authentication links");
  if (!env.AUTH_EMAIL_FROM)
    throw new Error("AUTH_EMAIL_FROM is required to send authentication links");

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.RESEND_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      from: env.AUTH_EMAIL_FROM,
      to: [email],
      subject: "Sign in to Program Cue",
      text: `Use this one-time link to sign in to Program Cue:\n\n${url}\n\nThe link expires in five minutes.`,
    }),
  });

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Authentication email delivery failed (${response.status}): ${details.slice(0, 300)}`,
    );
  }
}

export function createAuth(env: CloudflareEnvironment) {
  requireAuthConfiguration(env);
  const database = createDatabase(env);

  return betterAuth({
    appName: "Program Cue",
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
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
    account: { modelName: "account" },
    verification: { modelName: "verification" },
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
