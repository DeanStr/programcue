import { requireRuntimeMode } from "~/platform/runtime-environment.server";
import type { EmailProvider, EmailProviderName } from "./email-provider";
import { MailpitEmailProvider } from "./mailpit.server";
import { ResendEmailProvider } from "./resend.server";

type EmailProviderEnvironment = {
  APP_ENV?: unknown;
  DEMO_MODE?: unknown;
  EMAIL_PROVIDER?: unknown;
  RESEND_API_KEY?: string;
  MAILPIT_SEND_API_URL?: string;
  MAILPIT_SEND_API_USERNAME?: string;
  MAILPIT_SEND_API_PASSWORD?: string;
};

export type EmailProviderConfiguration =
  | { provider: "resend"; apiKey: string }
  | {
      provider: "mailpit";
      endpoint: string;
      username?: string;
      password?: string;
    };

export class EmailProviderConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailProviderConfigurationError";
  }
}

function optionalMailpitCredentials(environment: EmailProviderEnvironment) {
  const username = environment.MAILPIT_SEND_API_USERNAME?.trim() ?? "";
  const password = environment.MAILPIT_SEND_API_PASSWORD?.trim() ?? "";
  if (Boolean(username) !== Boolean(password)) {
    throw new EmailProviderConfigurationError(
      "Mailpit Send API authentication requires both MAILPIT_SEND_API_USERNAME and MAILPIT_SEND_API_PASSWORD.",
    );
  }
  return username && password ? { username, password } : {};
}

function mailpitEndpoint(environment: EmailProviderEnvironment) {
  const configured = environment.MAILPIT_SEND_API_URL?.trim();
  if (!configured) {
    throw new EmailProviderConfigurationError(
      "MAILPIT_SEND_API_URL is required when EMAIL_PROVIDER=mailpit.",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(configured);
  } catch {
    throw new EmailProviderConfigurationError(
      "MAILPIT_SEND_API_URL must be an absolute HTTP or HTTPS URL.",
    );
  }
  if (
    !["http:", "https:"].includes(endpoint.protocol) ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !endpoint.pathname.endsWith("/api/v1/send")
  ) {
    throw new EmailProviderConfigurationError(
      "MAILPIT_SEND_API_URL must be an absolute HTTP or HTTPS /api/v1/send endpoint without embedded credentials, query or fragment.",
    );
  }
  return endpoint.toString();
}

export function requireEmailProviderConfiguration(
  environment: EmailProviderEnvironment,
): EmailProviderConfiguration {
  const runtime = requireRuntimeMode(environment);
  const selected = environment.EMAIL_PROVIDER;
  if (selected !== "resend" && selected !== "mailpit") {
    throw new EmailProviderConfigurationError(
      "EMAIL_PROVIDER must be explicitly configured as resend or mailpit.",
    );
  }
  if (runtime.appEnvironment === "production" && selected !== "resend") {
    throw new EmailProviderConfigurationError(
      "Production email delivery requires EMAIL_PROVIDER=resend; Mailpit is local/test only.",
    );
  }
  if (selected === "resend") {
    const apiKey = environment.RESEND_API_KEY?.trim();
    if (!apiKey) {
      throw new EmailProviderConfigurationError(
        "RESEND_API_KEY is required when EMAIL_PROVIDER=resend.",
      );
    }
    return { provider: selected, apiKey };
  }
  if (
    runtime.appEnvironment !== "demo" &&
    runtime.appEnvironment !== "development" &&
    runtime.appEnvironment !== "test"
  ) {
    throw new EmailProviderConfigurationError(
      "EMAIL_PROVIDER=mailpit is permitted only in demo, development and test runtimes.",
    );
  }
  return {
    provider: selected,
    endpoint: mailpitEndpoint(environment),
    ...optionalMailpitCredentials(environment),
  };
}

export function emailProviderConfigurationIssue(
  environment: EmailProviderEnvironment,
) {
  try {
    requireEmailProviderConfiguration(environment);
    return null;
  } catch (error) {
    if (error instanceof Error) return error.message;
    return "Email provider configuration is invalid.";
  }
}

export function createEmailProvider(
  environment: EmailProviderEnvironment,
  fetcher: typeof fetch = fetch,
): EmailProvider {
  const configuration = requireEmailProviderConfiguration(environment);
  return configuration.provider === "resend"
    ? new ResendEmailProvider(configuration.apiKey, fetcher)
    : new MailpitEmailProvider(
        configuration.endpoint,
        configuration.username,
        configuration.password,
        fetcher,
      );
}

export function emailProviderLabel(provider: EmailProviderName) {
  return provider === "resend" ? "Resend" : "Mailpit";
}

export async function emailIdempotencyKey(
  purpose: string,
  ...values: string[]
) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify([purpose, ...values])),
  );
  const token = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `${purpose}:${token}`;
}
