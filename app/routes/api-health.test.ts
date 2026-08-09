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
  return loader({
    request: new Request("https://programcue.test/api/v1/health"),
    params: {},
    context: context(testEnvironment),
  } as never);
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
});
