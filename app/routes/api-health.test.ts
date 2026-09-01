import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { loader } from "./api-health";

function context(testEnvironment: CloudflareEnvironment) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: testEnvironment,
    ctx: {} as ExecutionContext,
  });
  return context;
}

async function health(testEnvironment: CloudflareEnvironment) {
  const environment = {
    ...testEnvironment,
    SOURCE_REVISION: testEnvironment.SOURCE_REVISION ?? "test-revision",
  } as unknown as CloudflareEnvironment;
  return loader({
    request: new Request("https://programcue.test/api/v1/health"),
    params: {},
    context: context(environment),
  } as never);
}

function providerKey(offset: number) {
  return btoa(
    String.fromCharCode(
      ...Array.from({ length: 32 }, (_, index) => (index + offset) % 256),
    ),
  );
}

afterEach(() => vi.restoreAllMocks());

describe("service readiness", () => {
  it("reports ready only after validating runtime mode and the D1 baseline", async () => {
    const response = await health(env as unknown as CloudflareEnvironment);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      service: "program-cue",
      environment: "test",
      sourceRevision: "test-revision",
    });
  });

  it("fails when production is accidentally configured with demo access", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await health({
      ...(env as unknown as CloudflareEnvironment),
      APP_ENV: "production",
      DEMO_MODE: "true",
    } as unknown as CloudflareEnvironment);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RUNTIME_CONFIGURATION_INVALID" },
    });
  });

  it("fails when the D1 binding or baseline schema is unavailable", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await health({
      ...(env as unknown as CloudflareEnvironment),
      DB: {
        prepare() {
          return {
            first: async () => {
              throw new Error("no such table: events");
            },
          };
        },
      } as unknown as D1Database,
    } as CloudflareEnvironment);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "DATABASE_UNAVAILABLE" },
    });
  });

  it("fails without exposing an invalid production source revision", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await health({
      ...(env as unknown as CloudflareEnvironment),
      APP_ENV: "production",
      DEMO_MODE: "false",
      SOURCE_REVISION: "not-a-git-revision",
    } as unknown as CloudflareEnvironment);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RUNTIME_CONFIGURATION_INVALID" },
    });
    expect(log).toHaveBeenCalledOnce();
    expect(String(log.mock.calls[0]?.[0])).toContain(
      '"sourceRevision":"invalid"',
    );
    expect(String(log.mock.calls[0]?.[0])).not.toContain("not-a-git-revision");
  });

  it("fails production readiness when a required platform binding is missing", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const production = completeProductionEnvironment();
    for (const overrides of [
      { OPERATIONS_QUEUE: undefined },
      { IMAGES: undefined },
    ]) {
      const response = await health({
        ...production,
        ...overrides,
      } as unknown as CloudflareEnvironment);

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "RUNTIME_CONFIGURATION_INVALID" },
      });
    }
  });

  it("fails production readiness when the selected email provider is not production-safe", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await health({
      ...completeProductionEnvironment(),
      EMAIL_PROVIDER: "mailpit",
    } as unknown as CloudflareEnvironment);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RUNTIME_CONFIGURATION_INVALID" },
    });
  });

  it("fails production readiness when resource embed providers are unknown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await health({
      ...completeProductionEnvironment(),
      RESOURCE_EMBED_PROVIDERS: "youtube,unknown",
    } as unknown as CloudflareEnvironment);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RUNTIME_CONFIGURATION_INVALID" },
    });
  });

  it("fails production readiness when Google Maps is enabled without its key", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const response = await health({
      ...completeProductionEnvironment(),
      RESOURCE_EMBED_PROVIDERS: "google_maps",
      GOOGLE_MAPS_EMBED_API_KEY: undefined,
    } as unknown as CloudflareEnvironment);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "RUNTIME_CONFIGURATION_INVALID" },
    });
  });

  it("does not require a Google Maps key when that provider is disabled", async () => {
    const response = await health({
      ...completeProductionEnvironment(),
      RESOURCE_EMBED_PROVIDERS: "youtube,vimeo",
      GOOGLE_MAPS_EMBED_API_KEY: undefined,
    } as unknown as CloudflareEnvironment);

    expect(response.status).toBe(200);
  });

  it("fails production readiness without an independent anonymous itinerary secret", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const production = completeProductionEnvironment();
    for (const itinerarySecret of [
      undefined,
      "too-short",
      production.BETTER_AUTH_SECRET,
    ]) {
      const response = await health({
        ...production,
        ANONYMOUS_ITINERARY_SECRET: itinerarySecret,
      } as unknown as CloudflareEnvironment);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "RUNTIME_CONFIGURATION_INVALID" },
      });
    }
  });

  it("requires a canonical 128-bit evaluation access code", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const production = {
      ...completeProductionEnvironment(),
      EVALUATION_MODE: "true",
      EVALUATION_SESSION_SECRET:
        "evaluation-session-secret-with-more-than-thirty-two-characters",
    } as unknown as CloudflareEnvironment;
    for (const accessCode of [
      "human-readable-evaluation-code",
      "0123456789abcdef0123456789abcdeg",
    ]) {
      const response = await health({
        ...production,
        EVALUATION_ACCESS_CODE: accessCode,
      } as CloudflareEnvironment);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "RUNTIME_CONFIGURATION_INVALID" },
      });
    }

    const response = await health({
      ...production,
      EVALUATION_ACCESS_CODE: "0123456789abcdef0123456789abcdef",
    } as CloudflareEnvironment);
    expect(response.status).toBe(200);
  });

  it("requires independent scanner dispatch and callback secrets", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const production = completeProductionEnvironment();
    for (const overrides of [
      { FILE_SCANNER_DISPATCH_SECRET: "too-short" },
      { FILE_SCANNER_WEBHOOK_SECRET: "too-short" },
      {
        FILE_SCANNER_DISPATCH_SECRET: production.FILE_SCANNER_WEBHOOK_SECRET,
      },
    ]) {
      const response = await health({
        ...production,
        ...overrides,
      } as unknown as CloudflareEnvironment);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({
        error: { code: "RUNTIME_CONFIGURATION_INVALID" },
      });
    }
  });

  it("requires exact and independent provider credential rotation keys", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const production = completeProductionEnvironment();
    for (const overrides of [
      { CALENDAR_CREDENTIALS_KEY: btoa("too-short") },
      {
        INTEGRATION_CREDENTIALS_PREVIOUS_KEY:
          production.INTEGRATION_CREDENTIALS_KEY,
      },
      {
        INTEGRATION_CREDENTIALS_PREVIOUS_KEY:
          production.CALENDAR_CREDENTIALS_KEY,
      },
      {
        CALENDAR_CREDENTIALS_PREVIOUS_KEY: providerKey(4),
        WEBHOOK_CREDENTIALS_PREVIOUS_KEY: providerKey(4),
      },
      { WEBHOOK_CREDENTIALS_KEY: production.CALENDAR_CREDENTIALS_KEY },
      { WEBHOOK_CREDENTIALS_PREVIOUS_KEY: "not base64%%%" },
    ]) {
      const response = await health({
        ...production,
        ...overrides,
      } as CloudflareEnvironment);
      expect(response.status).toBe(503);
    }
  });

  it("accepts complete local production bindings without calling providers", async () => {
    const response = await health(completeProductionEnvironment());
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
      environment: "production",
      sourceRevision: "1234567",
    });
  });
});

function completeProductionEnvironment() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    SOURCE_REVISION: "1234567",
    DB: env.DB,
    FILES: {},
    IMAGES: {},
    BACKUPS: {},
    OPERATIONS_QUEUE: {},
    EVENT_CHANNEL: {},
    PROGRAM_CUE_AGENT: {},
    D1_BACKUP_WORKFLOW: {},
    AI: {},
    DEFAULT_EVENT_ID: "evt-production",
    PUBLIC_EVENT_SLUG: "production-event",
    BETTER_AUTH_URL: "https://programcue.test",
    AUTH_EMAIL_FROM: "Program Cue <ops@programcue.test>",
    EMAIL_PROVIDER: "resend",
    TURNSTILE_SITE_KEY: "turnstile-site-key",
    CLOUDFLARE_ACCOUNT_ID: "a".repeat(32),
    D1_DATABASE_ID: "11111111-1111-4111-8111-111111111111",
    R2_ACCOUNT_ID: "b".repeat(32),
    R2_BUCKET_NAME: "program-cue-files",
    FILE_SCANNER_API_URL: "https://scanner.programcue.test",
    CORS_ALLOWED_ORIGINS: "https://programcue.test",
    EMBED_FRAME_ANCESTORS: "https://programme.programcue.test",
    RESOURCE_EMBED_PROVIDERS: "youtube,vimeo,google_maps",
    GOOGLE_MAPS_EMBED_API_KEY: "production-google-maps-key-1234567890",
    BETTER_AUTH_SECRET: "a".repeat(32),
    ANONYMOUS_ITINERARY_SECRET: "z".repeat(32),
    RESEND_API_KEY: "resend-key",
    RESEND_WEBHOOK_SECRET: "resend-webhook-secret",
    CALENDAR_CREDENTIALS_KEY: providerKey(1),
    GOOGLE_CALENDAR_CLIENT_ID: "google-calendar-client",
    GOOGLE_CALENDAR_CLIENT_SECRET: "google-calendar-secret",
    MICROSOFT_CALENDAR_CLIENT_ID: "microsoft-calendar-client",
    MICROSOFT_CALENDAR_CLIENT_SECRET: "microsoft-calendar-secret",
    GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
    GOOGLE_AUTH_CLIENT_SECRET: "google-auth-secret",
    MICROSOFT_AUTH_CLIENT_ID: "microsoft-auth-client",
    MICROSOFT_AUTH_CLIENT_SECRET: "microsoft-auth-secret",
    INTEGRATION_CREDENTIALS_KEY: providerKey(2),
    WEBHOOK_CREDENTIALS_KEY: providerKey(3),
    TURNSTILE_SECRET_KEY: "turnstile-secret",
    FILE_SCANNER_DISPATCH_SECRET:
      "scanner-dispatch-secret-at-least-32-characters",
    FILE_SCANNER_WEBHOOK_SECRET:
      "scanner-webhook-secret-at-least-32-characters",
    R2_ACCESS_KEY_ID: "r2-access-key",
    R2_SECRET_ACCESS_KEY: "r2-secret-key",
    D1_REST_API_TOKEN: "d1-api-token",
  } as unknown as CloudflareEnvironment;
}
