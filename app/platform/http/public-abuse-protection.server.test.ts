import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicAbuseProtection,
  enforcePublicRateLimit,
  type PublicAbuseAction,
  publicAbuseClientConfiguration,
  TurnstileRejectedError,
  TurnstileUnavailableError,
} from "./public-abuse-protection.server";

type AbuseTestEnvironment = CloudflareEnvironment & {
  PROGRAM_CUE_E2E_FIXTURES?: string;
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SITEVERIFY_URL?: string;
};

function productionEnvironment(
  overrides: Partial<AbuseTestEnvironment> = {},
): AbuseTestEnvironment {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    BETTER_AUTH_SECRET:
      "public-abuse-test-pepper-with-at-least-thirty-two-characters",
    TURNSTILE_SITE_KEY: "site-key-test",
    TURNSTILE_SECRET_KEY: "secret-key-test",
    ...overrides,
  } as AbuseTestEnvironment;
}

function protectedRequest(ip = "203.0.113.10") {
  return new Request("https://programcue.test/sign-in", {
    method: "POST",
    headers: { "cf-connecting-ip": ip },
  });
}

function successfulSiteverify(action: PublicAbuseAction = "sign_in") {
  return vi.fn(async () =>
    Response.json({
      success: true,
      hostname: "programcue.test",
      action,
    }),
  );
}

async function storedScopeKey(input: {
  action: PublicAbuseAction;
  tenantId: string;
  dimension: "ip" | "email" | "ip_email";
  ip: string;
  email: string;
}) {
  const value =
    input.dimension === "ip"
      ? input.ip
      : input.dimension === "email"
        ? input.email
        : `${input.ip}\n${input.email}`;
  const raw =
    `program-cue:abuse:v1:` +
    `public-abuse-test-pepper-with-at-least-thirty-two-characters:` +
    `${input.action}:${input.tenantId}:${input.dimension}:${value}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(raw),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("public abuse protection", () => {
  it("makes the demo bypass explicit without accepting a hidden production fallback", async () => {
    const demoEnvironment = env as unknown as AbuseTestEnvironment;
    expect(publicAbuseClientConfiguration(demoEnvironment)).toEqual({
      mode: "demo",
      turnstileSiteKey: null,
    });
    await expect(
      enforcePublicAbuseProtection({
        env: demoEnvironment,
        request: new Request("http://localhost/sign-in", { method: "POST" }),
        action: "sign_in",
        tenantId: "authentication",
        email: "person@example.com",
        turnstileToken: "",
      }),
    ).resolves.toEqual({ mode: "demo" });
  });

  it.each(["TURNSTILE_SITE_KEY", "TURNSTILE_SECRET_KEY"] as const)(
    "fails before rendering a production public form when %s is missing",
    (key) => {
      expect(() =>
        publicAbuseClientConfiguration(
          productionEnvironment({ [key]: undefined }),
        ),
      ).toThrow(AbuseProtectionConfigurationError);
    },
  );

  it("requires the Cloudflare connection address in production", async () => {
    await expect(
      enforcePublicAbuseProtection({
        env: productionEnvironment(),
        request: new Request("https://programcue.test/sign-in", {
          method: "POST",
        }),
        action: "sign_in",
        tenantId: "authentication",
        email: "person@example.com",
        turnstileToken: "valid-token",
      }),
    ).rejects.toBeInstanceOf(AbuseProtectionConfigurationError);
  });

  it("allows a loopback Siteverify endpoint only for the explicit E2E fixture", async () => {
    const tokenValidation = successfulSiteverify();
    vi.stubGlobal("fetch", tokenValidation);
    const unique = crypto.randomUUID();
    const call = (overrides: Partial<AbuseTestEnvironment>) =>
      enforcePublicAbuseProtection({
        env: productionEnvironment({
          TURNSTILE_SITEVERIFY_URL: "http://127.0.0.1:8788/siteverify",
          ...overrides,
        }),
        request: protectedRequest(`203.0.113.${unique.charCodeAt(0)}`),
        action: "sign_in",
        tenantId: `siteverify-${unique}`,
        email: `siteverify-${unique}@example.com`,
        turnstileToken: "valid-token",
      });

    await expect(call({})).rejects.toBeInstanceOf(
      AbuseProtectionConfigurationError,
    );
    await expect(call({ PROGRAM_CUE_E2E_FIXTURES: "true" })).resolves.toEqual({
      mode: "protected",
    });
    expect(tokenValidation).toHaveBeenCalledWith(
      "http://127.0.0.1:8788/siteverify",
      expect.objectContaining({ method: "POST", redirect: "manual" }),
    );
  });

  it("does not follow Siteverify redirects", async () => {
    const tokenValidation = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 307,
        headers: { location: "https://attacker.example/siteverify" },
      }),
    );
    vi.stubGlobal("fetch", tokenValidation);
    const unique = crypto.randomUUID();

    await expect(
      enforcePublicAbuseProtection({
        env: productionEnvironment(),
        request: protectedRequest("203.0.113.43"),
        action: "sign_in",
        tenantId: `siteverify-redirect-${unique}`,
        email: `siteverify-redirect-${unique}@example.com`,
        turnstileToken: "valid-token",
      }),
    ).rejects.toBeInstanceOf(TurnstileUnavailableError);
    expect(tokenValidation).toHaveBeenCalledTimes(1);
    expect(tokenValidation).toHaveBeenCalledWith(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      expect.objectContaining({ redirect: "manual" }),
    );
  });

  it("applies tenant/IP/email-scoped D1 limits and stores no raw identifier", async () => {
    const tokenValidation = successfulSiteverify();
    vi.stubGlobal("fetch", tokenValidation);
    const unique = crypto.randomUUID();
    const email = `limited-${unique}@example.com`;
    const ip = "203.0.113.42";
    const call = () =>
      enforcePublicAbuseProtection({
        env: productionEnvironment(),
        request: protectedRequest(ip),
        action: "sign_in",
        tenantId: `tenant-${unique}`,
        email,
        turnstileToken: "valid-token",
      });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(call()).resolves.toEqual({ mode: "protected" });
    }
    await expect(call()).rejects.toBeInstanceOf(AbuseRateLimitError);
    expect(tokenValidation).toHaveBeenCalledTimes(5);

    const rows = await env.DB.prepare(
      "SELECT scope_key AS scopeKey FROM abuse_rate_limits WHERE updated_at >= unixepoch() - 5",
    ).all<{ scopeKey: string }>();
    expect(rows.results.some((row) => row.scopeKey.includes(email))).toBe(
      false,
    );
    expect(rows.results.some((row) => row.scopeKey.includes(ip))).toBe(false);
    expect(
      rows.results.every((row) => /^[a-f0-9]{64}$/.test(row.scopeKey)),
    ).toBe(true);
  });

  it("rate-limits verified profile imports without invoking Turnstile", async () => {
    const provider = vi.fn();
    vi.stubGlobal("fetch", provider);
    const unique = crypto.randomUUID();
    const call = () =>
      enforcePublicRateLimit({
        env: productionEnvironment(),
        request: protectedRequest("203.0.113.43"),
        action: "application_profile_import",
        tenantId: `event-${unique}`,
        email: `applicant-${unique}@example.com`,
      });

    for (let attempt = 0; attempt < 8; attempt += 1) {
      await expect(call()).resolves.toEqual({ mode: "protected" });
    }
    await expect(call()).rejects.toBeInstanceOf(AbuseRateLimitError);
    expect(provider).not.toHaveBeenCalled();
  });

  it("binds successful Turnstile validation to the route action and hostname", async () => {
    const tokenValidation = successfulSiteverify("application_request_code");
    vi.stubGlobal("fetch", tokenValidation);
    await enforcePublicAbuseProtection({
      env: productionEnvironment(),
      request: new Request("https://programcue.test/apply/cfp", {
        method: "POST",
        headers: { "cf-connecting-ip": "2001:db8::1" },
      }),
      action: "application_request_code",
      tenantId: `event-${crypto.randomUUID()}`,
      email: "applicant@example.com",
      turnstileToken: "turnstile-response",
    });

    const [, init] = tokenValidation.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    const body = init.body as FormData;
    expect(body.get("secret")).toBe("secret-key-test");
    expect(body.get("response")).toBe("turnstile-response");
    expect(body.get("remoteip")).toBe("2001:db8::1");
  });

  it("rejects a mismatched Turnstile result and fails closed on provider errors", async () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({
          success: false,
          hostname: "attacker.example",
          action: "secret-provider-action",
          "error-codes": ["secret-provider-code"],
        }),
      ),
    );
    await expect(
      enforcePublicAbuseProtection({
        env: productionEnvironment(),
        request: protectedRequest("203.0.113.80"),
        action: "sign_in",
        tenantId: `mismatch-${crypto.randomUUID()}`,
        email: "mismatch@example.com",
        turnstileToken: "mismatched-token",
      }),
    ).rejects.toBeInstanceOf(TurnstileRejectedError);
    expect(warning).toHaveBeenCalledOnce();
    const warningEntry = String(warning.mock.calls[0]?.[0]);
    expect(JSON.parse(warningEntry)).toMatchObject({
      subsystem: "public-abuse-protection",
      event: "turnstile-rejected",
      action: "sign_in",
      hostnameMatched: false,
      actionMatched: false,
      providerErrorCount: 1,
    });
    expect(warningEntry).not.toContain("attacker.example");
    expect(warningEntry).not.toContain("secret-provider-action");
    expect(warningEntry).not.toContain("secret-provider-code");

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unavailable", { status: 503 })),
    );
    await expect(
      enforcePublicAbuseProtection({
        env: productionEnvironment(),
        request: protectedRequest("203.0.113.81"),
        action: "sign_in",
        tenantId: `unavailable-${crypto.randomUUID()}`,
        email: "unavailable@example.com",
        turnstileToken: "provider-error-token",
      }),
    ).rejects.toBeInstanceOf(TurnstileUnavailableError);
  });

  it("fails closed when Siteverify returns an oversized response body", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("x".repeat(20_000), { status: 200 })),
    );

    await expect(
      enforcePublicAbuseProtection({
        env: productionEnvironment(),
        request: protectedRequest("203.0.113.82"),
        action: "sign_in",
        tenantId: `oversized-${crypto.randomUUID()}`,
        email: "oversized@example.com",
        turnstileToken: "oversized-provider-response-token",
      }),
    ).rejects.toBeInstanceOf(TurnstileUnavailableError);
  });

  it("charges rejected Turnstile attempts only to the source IP", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: false })),
    );
    const tenantId = `lockout-${crypto.randomUUID()}`;
    const ip = "203.0.113.92";
    const email = `victim-${crypto.randomUUID()}@example.com`;
    await expect(
      enforcePublicAbuseProtection({
        env: productionEnvironment(),
        request: protectedRequest(ip),
        action: "sign_in",
        tenantId,
        email,
        turnstileToken: "invalid-token",
      }),
    ).rejects.toBeInstanceOf(TurnstileRejectedError);

    const keys = await Promise.all(
      (["ip", "email", "ip_email"] as const).map((dimension) =>
        storedScopeKey({
          action: "sign_in",
          tenantId,
          dimension,
          ip,
          email,
        }),
      ),
    );
    const rows = await Promise.all(
      keys.map((key) =>
        env.DB.prepare(
          "SELECT request_count AS requestCount FROM abuse_rate_limits WHERE scope_key = ?",
        )
          .bind(key)
          .first<{ requestCount: number }>(),
      ),
    );
    expect(rows).toEqual([{ requestCount: 1 }, null, null]);
  });

  it("removes expired rate-limit rows while retaining an active block", async () => {
    const suffix = crypto.randomUUID();
    const expiredKeys = [
      `expired-abuse-${suffix}-1`,
      `expired-abuse-${suffix}-2`,
    ];
    const blockedKey = `blocked-abuse-${suffix}`;
    await env.DB.batch([
      ...expiredKeys.map((key) =>
        env.DB.prepare(
          `INSERT INTO abuse_rate_limits (
             scope_key, window_started_at, request_count, blocked_until, updated_at
           ) VALUES (?, unixepoch() - 7200, 1, unixepoch() - 3600,
                     unixepoch() - 7200)`,
        ).bind(key),
      ),
      env.DB.prepare(
        `INSERT INTO abuse_rate_limits (
           scope_key, window_started_at, request_count, blocked_until, updated_at
         ) VALUES (?, unixepoch() - 7200, 1, unixepoch() + 3600,
                   unixepoch() - 7200)`,
      ).bind(blockedKey),
    ]);
    vi.stubGlobal("fetch", successfulSiteverify());

    await enforcePublicAbuseProtection({
      env: productionEnvironment(),
      request: protectedRequest("203.0.113.115"),
      action: "sign_in",
      tenantId: `cleanup-${suffix}`,
      email: `cleanup-${suffix}@example.com`,
      turnstileToken: "valid-token",
    });

    const retained = await env.DB.prepare(
      `SELECT scope_key AS scopeKey FROM abuse_rate_limits
        WHERE scope_key IN (?, ?, ?) ORDER BY scope_key`,
    )
      .bind(...expiredKeys, blockedKey)
      .all<{ scopeKey: string }>();
    expect(retained.results).toEqual([{ scopeKey: blockedKey }]);
  });
});
