import { requireRuntimeMode } from "~/platform/runtime-environment.server";
import type { EmailProvider, EmailProviderName } from "./email-provider";
import { MailpitEmailProvider } from "./mailpit.server";
import { ResendEmailProvider } from "./resend.server";

type EmailProviderEnvironment = {
  APP_ENV?: unknown;
  DEMO_MODE?: unknown;
  EVALUATION_MODE?: unknown;
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

/**
 * A stable slug naming which part of the email configuration is wrong.
 *
 * The message names the exact variable, which suits a fail-fast startup error
 * but must not reach a log line. `reason` is safe to log, and without it every
 * fault here arrives as one class name with no way to tell a missing provider
 * selection from a missing credential.
 */
export type EmailProviderConfigurationReason =
  | "provider-selection"
  | "credentials"
  | "endpoint"
  | "runtime";

export class EmailProviderConfigurationError extends Error {
  constructor(
    message: string,
    readonly reason: EmailProviderConfigurationReason = "provider-selection",
  ) {
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
      "credentials",
    );
  }
  return username && password ? { username, password } : {};
}

function mailpitEndpoint(environment: EmailProviderEnvironment) {
  const configured = environment.MAILPIT_SEND_API_URL?.trim();
  if (!configured) {
    throw new EmailProviderConfigurationError(
      "MAILPIT_SEND_API_URL is required when EMAIL_PROVIDER=mailpit.",
      "endpoint",
    );
  }
  let endpoint: URL;
  try {
    endpoint = new URL(configured);
  } catch {
    throw new EmailProviderConfigurationError(
      "MAILPIT_SEND_API_URL must be an absolute HTTP or HTTPS URL.",
      "endpoint",
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
      "endpoint",
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
      "provider-selection",
    );
  }
  if (runtime.appEnvironment === "production" && selected !== "resend") {
    throw new EmailProviderConfigurationError(
      "Production email delivery requires EMAIL_PROVIDER=resend; Mailpit is local/test only.",
      "runtime",
    );
  }
  if (selected === "resend") {
    const apiKey = environment.RESEND_API_KEY?.trim();
    if (!apiKey) {
      throw new EmailProviderConfigurationError(
        "RESEND_API_KEY is required when EMAIL_PROVIDER=resend.",
        "credentials",
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
      "runtime",
    );
  }
  return {
    provider: selected,
    endpoint: mailpitEndpoint(environment),
    ...optionalMailpitCredentials(environment),
  };
}

/**
 * A readable summary for operators, not the underlying configuration error.
 * Every failure mode above names a deployment variable the reader cannot set
 * from the product, so the specific message stays in `requireEmailProviderConfiguration`
 * for logs and fail-fast paths while callers render this instead.
 */
export function emailProviderConfigurationIssue(
  environment: EmailProviderEnvironment,
) {
  try {
    requireEmailProviderConfiguration(environment);
    return null;
  } catch {
    return "Email delivery is not configured for this installation.";
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
