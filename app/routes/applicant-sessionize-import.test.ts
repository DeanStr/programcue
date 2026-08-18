import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action } from "./applicant-sessionize-import";

function context(
  environment: CloudflareEnvironment = env as unknown as CloudflareEnvironment,
) {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return provider;
}

beforeEach(async () => {
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await ensureDemoSubmissionForm(testEnv);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("applicant Sessionize profile import route", () => {
  it("rejects non-POST requests without contacting the provider", async () => {
    const result = await action({
      request: new Request("http://localhost/apply/form/import/sessionize"),
      params: { slug: "form" },
      context: context(),
    } as never);

    expect(result.status).toBe(405);
    expect(result.headers.get("allow")).toBe("POST");
  });

  it("requires a verified applicant and prevents caching the denial", async () => {
    const result = await action({
      request: new Request("http://localhost/apply/form/import/sessionize", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile: "avery-example" }),
      }),
      params: { slug: "form" },
      context: context(),
    } as never);

    expect(result.status).toBe(401);
    expect(result.headers.get("cache-control")).toBe("private, no-store");
    await expect(result.json()).resolves.toEqual({
      error: "Verify your applicant email before importing a public profile.",
    });
  });

  it("rate-limits a verified production applicant before another provider request", async () => {
    const base = env as unknown as CloudflareEnvironment;
    const pepper =
      "sessionize-route-rate-limit-pepper-with-thirty-two-characters";
    const demoEnvironment = {
      ...base,
      APP_ENV: "development",
      DEMO_MODE: "true",
      BETTER_AUTH_SECRET: pepper,
    } as unknown as CloudflareEnvironment;
    const service = new SubmissionService(demoEnvironment);
    const form = await service.getPublicForm("form");
    const email = `sessionize-${crypto.randomUUID()}@example.com`;
    const requested = await service.applicants.requestCode(form, email, "");
    if (!requested.demoCode) throw new Error("Demo verification code missing.");
    const verified = await service.applicants.verifyCode(
      form,
      email,
      requested.demoCode,
    );
    const productionEnvironment = {
      ...demoEnvironment,
      APP_ENV: "production",
      DEMO_MODE: "false",
    } as CloudflareEnvironment;
    const provider = vi.fn(
      async () =>
        new Response(
          `<!doctype html><html><body>
          <h1 class="c-s-speaker-info__name">Avery Example</h1>
          <p class="c-s-speaker-info__tagline">Makes systems clear</p>
          <div class="c-s-speaker-info__bio"><p>Practical public biography.</p></div>
        </body></html>`,
          { headers: { "content-type": "text/html" } },
        ),
    );
    vi.stubGlobal("fetch", provider);
    const invoke = () =>
      action({
        request: new Request(
          "https://programcue.test/apply/form/import/sessionize",
          {
            method: "POST",
            headers: {
              "cf-connecting-ip": "203.0.113.222",
              "content-type": "application/json",
              cookie: `__Host-${verified.cookie.split(";", 1)[0]!}`,
            },
            body: JSON.stringify({ profile: "avery-example" }),
          },
        ),
        params: { slug: "form" },
        context: context(productionEnvironment),
      } as never);

    for (let attempt = 0; attempt < 8; attempt += 1) {
      expect((await invoke()).status).toBe(200);
    }
    const limited = await invoke();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("retry-after")).toMatch(/^\d+$/u);
    expect(provider).toHaveBeenCalledTimes(8);
  });
});
