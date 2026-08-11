import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { action as applicationAction } from "./application-form";
import { action as authApiAction } from "./auth-api";
import { action as signInAction, loader as signInLoader } from "./sign-in";

type ProtectedEnvironment = CloudflareEnvironment & {
  TURNSTILE_SECRET_KEY?: string;
  TURNSTILE_SITE_KEY?: string;
};

function productionEnvironment(overrides: Partial<ProtectedEnvironment> = {}) {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    BETTER_AUTH_URL: "http://localhost",
    BETTER_AUTH_SECRET:
      "protected-sign-in-test-secret-with-at-least-thirty-two-characters",
    TURNSTILE_SITE_KEY: "sign-in-site-key",
    TURNSTILE_SECRET_KEY: "sign-in-secret-key",
    ...overrides,
  } as ProtectedEnvironment;
}

function context(environment: ProtectedEnvironment) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return context;
}

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await ensureDemoSubmissionForm(env as unknown as CloudflareEnvironment);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("sign-in abuse boundary", () => {
  it("fails before rendering the production sign-in form when Turnstile is unconfigured", async () => {
    await expect(
      signInLoader({
        request: new Request("http://localhost/sign-in"),
        params: {},
        context: context(
          productionEnvironment({ TURNSTILE_SECRET_KEY: undefined }),
        ),
      } as never),
    ).rejects.toThrow("TURNSTILE_SECRET_KEY");
  });

  it("requires a hostname/action-bound Turnstile result before requesting a magic link", async () => {
    const requests: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requests.push(url);
        if (url.includes("challenges.cloudflare.com")) {
          return Response.json({
            success: true,
            hostname: "localhost",
            action: "sign_in",
          });
        }
        if (url === "https://api.resend.com/emails") {
          return Response.json({ id: "email-protected-sign-in" });
        }
        throw new Error(`Unexpected request to ${url}`);
      }),
    );
    const request = new Request("http://localhost/sign-in", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.120",
        origin: "http://localhost",
      },
      body: new URLSearchParams({
        _intent: "email_magic_link",
        email: "olivia@example.com",
        returnTo: "/admin/event",
        "turnstile-token": "browser-challenge-token",
      }),
    });
    const result = await signInAction({
      request,
      params: {},
      context: context(productionEnvironment()),
    } as never);
    if (result instanceof Response) {
      throw new Error(
        "Protected sign-in unexpectedly returned a raw response.",
      );
    }
    expect(result.data).toMatchObject({ ok: true });
    expect(requests).toEqual([
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      "https://api.resend.com/emails",
    ]);
  });

  it.each([
    "/api/auth/sign-in/magic-link",
    "/api/auth/sign-in/magic-link/",
    "/api/auth//sign-in/social",
    "/api/auth/sign-in/%6Dagic-link",
    "/api/auth/sign-up/email",
    "/api/auth/link-social/",
    "/api/auth/sign-in/%E0%A4%A",
  ])("does not expose a direct authentication mutation at %s", async (path) => {
    const response = await authApiAction({
      request: new Request(`http://localhost${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "olivia@example.com" }),
      }),
      params: {},
      context: context(productionEnvironment()),
    } as never);
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain("protected sign-in form");
  });

  it("rejects social sign-in before Better Auth creates state when the challenge is missing", async () => {
    const testEnvironment = productionEnvironment({
      GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
      GOOGLE_AUTH_CLIENT_SECRET: "google-auth-secret",
    });
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM verification_tokens",
    ).first<{ count: number }>();

    const response = await signInAction({
      request: new Request("http://localhost/sign-in", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "203.0.113.123",
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          _intent: "social_sign_in",
          provider: "google",
          returnTo: "/speaker/dashboard",
        }),
      }),
      params: {},
      context: context(testEnvironment),
    } as never);

    if (response instanceof Response) {
      throw new Error("Rejected social sign-in returned a raw response.");
    }
    expect(response.init?.status).toBe(422);
    expect(response.data).toMatchObject({
      ok: false,
      message: "Complete the security check and try again.",
    });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM verification_tokens",
      ).first<{ count: number }>(),
    ).toEqual(before);
  });

  it("does not expose direct social sign-in with caller-selected scopes", async () => {
    const response = await authApiAction({
      request: new Request("http://localhost/api/auth/sign-in/social", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          provider: "google",
          scopes: ["https://www.googleapis.com/auth/calendar"],
        }),
      }),
      params: {},
      context: context(
        productionEnvironment({
          GOOGLE_AUTH_CLIENT_ID: "google-auth-client",
          GOOGLE_AUTH_CLIENT_SECRET: "google-auth-secret",
        }),
      ),
    } as never);
    expect(response.status).toBe(404);
    await expect(response.text()).resolves.toContain("protected sign-in form");
  });

  it("protects application email delivery and anonymous draft creation at the route boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.includes("challenges.cloudflare.com")) {
          return Response.json({
            success: true,
            hostname: "localhost",
            action: "application_request_code",
          });
        }
        if (url === "https://api.resend.com/emails") {
          return Response.json({ id: "email-protected-application" });
        }
        throw new Error(`Unexpected request to ${url}`);
      }),
    );
    const email = `protected-${crypto.randomUUID()}@example.com`;
    const requestCode = await applicationAction({
      request: new Request("http://localhost/apply/form", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "203.0.113.121",
          origin: "http://localhost",
        },
        body: new URLSearchParams({
          _intent: "request_code",
          email,
          "turnstile-token": "application-challenge-token",
        }),
      }),
      params: { slug: "form" },
      context: context(productionEnvironment()),
    } as never);
    if (requestCode instanceof Response) {
      throw new Error("Application code request unexpectedly redirected.");
    }
    expect(requestCode.data).toMatchObject({ ok: true, email });

    const anonymousWithoutChallenge = await applicationAction({
      request: new Request("http://localhost/apply/form", {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "203.0.113.122",
          origin: "http://localhost",
        },
        body: new URLSearchParams({ _intent: "start_anonymous" }),
      }),
      params: { slug: "form" },
      context: context(productionEnvironment()),
    } as never);
    if (anonymousWithoutChallenge instanceof Response) {
      throw new Error("Rejected anonymous draft unexpectedly redirected.");
    }
    expect(anonymousWithoutChallenge.init?.status).toBe(422);
    expect(anonymousWithoutChallenge.data).toMatchObject({
      ok: false,
      message: "Complete the security check and try again.",
    });
  });
});
