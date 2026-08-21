import { z } from "zod";

import { readBoundedResponseJson } from "~/platform/http/read-response";
import { requiresProductionSecurity } from "~/platform/runtime-environment.server";

const SITEVERIFY_URL =
  "https://challenges.cloudflare.com/turnstile/v0/siteverify";
const SITEVERIFY_RESPONSE_MAX_BYTES = 16_384;
const RATE_LIMIT_RETENTION_SECONDS = 3_600;
const RATE_LIMIT_CLEANUP_BATCH_SIZE = 100;

type AbuseEnvironment = CloudflareEnvironment & {
  PROGRAM_CUE_E2E_FIXTURES?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SITEVERIFY_URL?: string;
};

type RatePolicy = {
  dimension: "ip" | "email" | "ip_email";
  limit: number;
  windowSeconds: number;
  blockSeconds: number;
};

const policies = {
  social_sign_in: [
    { dimension: "ip", limit: 10, windowSeconds: 900, blockSeconds: 1_800 },
  ],
  sign_in: [
    { dimension: "ip", limit: 10, windowSeconds: 900, blockSeconds: 1_800 },
    { dimension: "email", limit: 5, windowSeconds: 900, blockSeconds: 1_800 },
    {
      dimension: "ip_email",
      limit: 4,
      windowSeconds: 600,
      blockSeconds: 1_800,
    },
  ],
  application_request_code: [
    { dimension: "ip", limit: 20, windowSeconds: 3_600, blockSeconds: 3_600 },
    { dimension: "email", limit: 5, windowSeconds: 900, blockSeconds: 1_800 },
    {
      dimension: "ip_email",
      limit: 3,
      windowSeconds: 600,
      blockSeconds: 1_800,
    },
  ],
  application_verify_code: [
    { dimension: "ip", limit: 30, windowSeconds: 900, blockSeconds: 1_800 },
    { dimension: "email", limit: 10, windowSeconds: 900, blockSeconds: 1_800 },
    {
      dimension: "ip_email",
      limit: 8,
      windowSeconds: 600,
      blockSeconds: 1_800,
    },
  ],
  application_start_anonymous: [
    { dimension: "ip", limit: 10, windowSeconds: 3_600, blockSeconds: 3_600 },
  ],
  application_file_upload: [
    { dimension: "ip", limit: 10, windowSeconds: 3_600, blockSeconds: 3_600 },
    {
      dimension: "ip_email",
      limit: 5,
      windowSeconds: 3_600,
      blockSeconds: 3_600,
    },
  ],
  application_profile_import: [
    { dimension: "ip", limit: 30, windowSeconds: 3_600, blockSeconds: 3_600 },
    {
      dimension: "email",
      limit: 10,
      windowSeconds: 3_600,
      blockSeconds: 3_600,
    },
    {
      dimension: "ip_email",
      limit: 8,
      windowSeconds: 3_600,
      blockSeconds: 3_600,
    },
  ],
  public_itinerary_create: [
    { dimension: "ip", limit: 10, windowSeconds: 3_600, blockSeconds: 3_600 },
  ],
  evaluation_unlock: [
    { dimension: "ip", limit: 20, windowSeconds: 3_600, blockSeconds: 3_600 },
  ],
  evaluation_reset: [
    { dimension: "ip", limit: 5, windowSeconds: 3_600, blockSeconds: 3_600 },
  ],
  programme_preview: [
    { dimension: "ip", limit: 60, windowSeconds: 60, blockSeconds: 60 },
  ],
} as const satisfies Record<string, ReadonlyArray<RatePolicy>>;

export type PublicAbuseAction = keyof typeof policies;

export class AbuseProtectionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AbuseProtectionConfigurationError";
  }
}

export class AbuseRateLimitError extends Error {
  constructor(public readonly retryAfterSeconds: number) {
    super("Too many requests. Wait before trying again.");
    this.name = "AbuseRateLimitError";
  }
}

export class TurnstileRejectedError extends Error {
  constructor() {
    super("Complete the security check and try again.");
    this.name = "TurnstileRejectedError";
  }
}

export class TurnstileUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super(
      "The security check is temporarily unavailable. Try again later.",
      options,
    );
    this.name = "TurnstileUnavailableError";
  }
}

function configuredValue(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) {
    throw new AbuseProtectionConfigurationError(
      `${name} is required for public production forms.`,
    );
  }
  return value.trim();
}

function productionConfiguration(env: AbuseEnvironment) {
  const rateLimitPepper = rateLimitConfiguration(env);
  return {
    siteKey: configuredValue(env.TURNSTILE_SITE_KEY, "TURNSTILE_SITE_KEY"),
    secretKey: configuredValue(
      env.TURNSTILE_SECRET_KEY,
      "TURNSTILE_SECRET_KEY",
    ),
    siteverifyUrl: siteverifyUrl(env),
    rateLimitPepper,
  };
}

function rateLimitConfiguration(env: AbuseEnvironment) {
  const rateLimitPepper = configuredValue(
    env.BETTER_AUTH_SECRET,
    "BETTER_AUTH_SECRET",
  );
  if (rateLimitPepper.length < 32) {
    throw new AbuseProtectionConfigurationError(
      "BETTER_AUTH_SECRET must contain at least 32 characters for public abuse protection.",
    );
  }
  return rateLimitPepper;
}

export function publicAbuseClientConfiguration(env: AbuseEnvironment) {
  if (!requiresProductionSecurity(env.APP_ENV)) {
    return { mode: "demo" as const, turnstileSiteKey: null };
  }
  const configuration = productionConfiguration(env);
  return {
    mode: "protected" as const,
    turnstileSiteKey: configuration.siteKey,
  };
}

function connectingIp(request: Request) {
  const value = request.headers.get("cf-connecting-ip")?.trim();
  if (!value || value.length > 64 || value.includes(",")) {
    throw new AbuseProtectionConfigurationError(
      "CF-Connecting-IP is required for public production forms.",
    );
  }
  return value;
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

async function scopeKey(input: {
  action: PublicAbuseAction;
  tenantId: string;
  dimension: RatePolicy["dimension"];
  ip: string;
  email: string;
  pepper: string;
}) {
  const value =
    input.dimension === "ip"
      ? input.ip
      : input.dimension === "email"
        ? input.email
        : `${input.ip}\n${input.email}`;
  return sha256(
    `program-cue:abuse:v1:${input.pepper}:${input.action}:${input.tenantId}:${input.dimension}:${value}`,
  );
}

async function consumeRateLimit(
  database: D1Database,
  key: string,
  policy: RatePolicy,
  now: number,
) {
  const cutoff = now - policy.windowSeconds;
  const [, consumed] = await database.batch([
    database
      .prepare(
        `DELETE FROM abuse_rate_limits
          WHERE scope_key IN (
            SELECT scope_key
              FROM abuse_rate_limits
             WHERE updated_at <= ?
               AND COALESCE(blocked_until, 0) <= ?
             ORDER BY updated_at, scope_key
             LIMIT ?
          )`,
      )
      .bind(
        now - RATE_LIMIT_RETENTION_SECONDS,
        now,
        RATE_LIMIT_CLEANUP_BATCH_SIZE,
      ),
    database
      .prepare(
        `
      INSERT INTO abuse_rate_limits (
        scope_key, window_started_at, request_count, blocked_until, updated_at
      ) VALUES (?, ?, 1, 0, ?)
      ON CONFLICT(scope_key) DO UPDATE SET
        request_count = CASE
          WHEN abuse_rate_limits.window_started_at <= ? THEN 1
          ELSE abuse_rate_limits.request_count + 1
        END,
        window_started_at = CASE
          WHEN abuse_rate_limits.window_started_at <= ? THEN excluded.window_started_at
          ELSE abuse_rate_limits.window_started_at
        END,
        blocked_until = CASE
          WHEN abuse_rate_limits.blocked_until > excluded.window_started_at
            THEN abuse_rate_limits.blocked_until
          WHEN (
            CASE
              WHEN abuse_rate_limits.window_started_at <= ? THEN 1
              ELSE abuse_rate_limits.request_count + 1
            END
          ) > ? THEN excluded.window_started_at + ?
          ELSE 0
        END,
        updated_at = excluded.updated_at
      RETURNING request_count AS requestCount, blocked_until AS blockedUntil
    `,
      )
      .bind(
        key,
        now,
        now,
        cutoff,
        cutoff,
        cutoff,
        policy.limit,
        policy.blockSeconds,
      ),
  ]);
  const row = consumed.results?.[0] as
    | { requestCount: number; blockedUntil: number }
    | undefined;
  if (!row) {
    throw new Error("The D1 abuse-rate-limit mutation returned no state.");
  }
  if (row.blockedUntil > now || row.requestCount > policy.limit) {
    throw new AbuseRateLimitError(Math.max(1, row.blockedUntil - now));
  }
}

const siteverifyResponseSchema = z.object({
  success: z.boolean(),
  hostname: z.string().optional(),
  action: z.string().optional(),
  "error-codes": z.array(z.string()).optional(),
});

function siteverifyUrl(env: AbuseEnvironment) {
  const configured = env.TURNSTILE_SITEVERIFY_URL?.trim();
  if (!configured) return SITEVERIFY_URL;
  let parsed: URL;
  try {
    parsed = new URL(configured);
  } catch {
    throw new AbuseProtectionConfigurationError(
      "TURNSTILE_SITEVERIFY_URL must be a valid URL.",
    );
  }
  if (
    env.PROGRAM_CUE_E2E_FIXTURES !== "true" ||
    parsed.protocol !== "http:" ||
    (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") ||
    parsed.username ||
    parsed.password
  ) {
    throw new AbuseProtectionConfigurationError(
      "TURNSTILE_SITEVERIFY_URL is restricted to the loopback E2E fixture.",
    );
  }
  return parsed.href;
}

async function verifyTurnstile(input: {
  request: Request;
  token: string;
  action: PublicAbuseAction;
  ip: string;
  secretKey: string;
  siteverifyUrl: string;
}) {
  const token = input.token.trim();
  if (!token || token.length > 2_048) throw new TurnstileRejectedError();

  const body = new FormData();
  body.set("secret", input.secretKey);
  body.set("response", token);
  body.set("remoteip", input.ip);
  let response: Response;
  try {
    response = await fetch(input.siteverifyUrl, {
      method: "POST",
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new TurnstileUnavailableError({ cause: error });
  }
  if (response.status >= 300 && response.status < 400) {
    throw new TurnstileUnavailableError({
      cause: new Error("Turnstile Siteverify returned a redirect."),
    });
  }
  if (!response.ok) {
    throw new TurnstileUnavailableError({
      cause: new Error(
        `Turnstile Siteverify returned HTTP ${response.status}.`,
      ),
    });
  }

  let parsed: z.infer<typeof siteverifyResponseSchema>;
  try {
    parsed = siteverifyResponseSchema.parse(
      await readBoundedResponseJson(response, SITEVERIFY_RESPONSE_MAX_BYTES),
    );
  } catch (error) {
    throw new TurnstileUnavailableError({ cause: error });
  }
  const expectedHostname = new URL(input.request.url).hostname;
  const errorCodes = parsed["error-codes"] ?? [];
  if (
    errorCodes.includes("missing-input-secret") ||
    errorCodes.includes("invalid-input-secret")
  ) {
    throw new AbuseProtectionConfigurationError(
      "TURNSTILE_SECRET_KEY was rejected by Siteverify.",
    );
  }
  if (errorCodes.includes("internal-error")) {
    throw new TurnstileUnavailableError({
      cause: new Error("Turnstile Siteverify reported an internal error."),
    });
  }
  if (
    !parsed.success ||
    parsed.action !== input.action ||
    parsed.hostname !== expectedHostname
  ) {
    console.warn(
      JSON.stringify({
        level: "warning",
        subsystem: "public-abuse-protection",
        event: "turnstile-rejected",
        action: input.action,
        hostnameMatched: parsed.hostname === expectedHostname,
        actionMatched: parsed.action === input.action,
        providerErrorCount: errorCodes.length,
        message: "Turnstile rejected a public request.",
      }),
    );
    throw new TurnstileRejectedError();
  }
}

export async function enforcePublicAbuseProtection(input: {
  env: AbuseEnvironment;
  request: Request;
  action: PublicAbuseAction;
  tenantId: string;
  email: string;
  turnstileToken: string;
}) {
  if (!requiresProductionSecurity(input.env.APP_ENV)) {
    return { mode: "demo" as const };
  }
  const configuration = productionConfiguration(input.env);
  const ip = connectingIp(input.request);
  const email = input.email.trim().toLowerCase();
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new AbuseProtectionConfigurationError(
      "A tenant scope is required for public abuse protection.",
    );
  }

  const now = Math.floor(Date.now() / 1_000);
  const actionPolicies = policies[input.action];
  for (const policy of actionPolicies.filter(
    (candidate) => candidate.dimension === "ip",
  )) {
    await consumeRateLimit(
      input.env.DB,
      await scopeKey({
        action: input.action,
        tenantId,
        dimension: policy.dimension,
        ip,
        email,
        pepper: configuration.rateLimitPepper,
      }),
      policy,
      now,
    );
  }
  await verifyTurnstile({
    request: input.request,
    token: input.turnstileToken,
    action: input.action,
    ip,
    secretKey: configuration.secretKey,
    siteverifyUrl: configuration.siteverifyUrl,
  });
  for (const policy of actionPolicies.filter(
    (candidate) => candidate.dimension !== "ip",
  )) {
    await consumeRateLimit(
      input.env.DB,
      await scopeKey({
        action: input.action,
        tenantId,
        dimension: policy.dimension,
        ip,
        email,
        pepper: configuration.rateLimitPepper,
      }),
      policy,
      now,
    );
  }
  return { mode: "protected" as const };
}

export async function enforcePublicRateLimit(input: {
  env: AbuseEnvironment;
  request: Request;
  action: PublicAbuseAction;
  tenantId: string;
  email: string;
}) {
  if (!requiresProductionSecurity(input.env.APP_ENV)) {
    return { mode: "demo" as const };
  }
  const rateLimitPepper = rateLimitConfiguration(input.env);
  const ip = connectingIp(input.request);
  const email = input.email.trim().toLowerCase();
  const tenantId = input.tenantId.trim();
  if (!tenantId) {
    throw new AbuseProtectionConfigurationError(
      "A tenant scope is required for public abuse protection.",
    );
  }

  const now = Math.floor(Date.now() / 1_000);
  for (const policy of policies[input.action]) {
    await consumeRateLimit(
      input.env.DB,
      await scopeKey({
        action: input.action,
        tenantId,
        dimension: policy.dimension,
        ip,
        email,
        pepper: rateLimitPepper,
      }),
      policy,
      now,
    );
  }
  return { mode: "protected" as const };
}
