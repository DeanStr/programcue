import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { createAuth } from "~/platform/auth/auth.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { loader as authApiLoader } from "./auth-api";
import { action as signInAction } from "./sign-in";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    BETTER_AUTH_SECRET: string;
    AUTH_EMAIL_FROM: string;
    EMAIL_PROVIDER: string;
    RESEND_API_KEY: string;
  }
}

function productionEnv() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    EMAIL_PROVIDER: "resend",
    TURNSTILE_SITE_KEY: "test-turnstile-site-key",
    TURNSTILE_SECRET_KEY: "test-turnstile-secret-key",
  } as CloudflareEnvironment;
}

function context(testEnv: CloudflareEnvironment) {
  const context = new RouterContextProvider();
  context.set(cloudflareContext, {
    env: testEnv,
    ctx: {} as ExecutionContext,
  });
  return context;
}

function formRequest(
  url: string,
  values: Record<string, string>,
  headers: Record<string, string> = {},
) {
  return new Request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: "http://localhost",
      ...headers,
    },
    body: new URLSearchParams(values),
  });
}

beforeEach(async () => {
  const demoEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(demoEnv);
  await ensureDemoSubmissionForm(demoEnv);
  await env.DB.prepare(
    `
    UPDATE form_definitions
       SET access_mode = 'email_verified', access_password_hash = NULL
     WHERE event_id = 'evt-foe-2025' AND public_slug = 'form'
  `,
  ).run();
  await env.DB.prepare(
    `
    UPDATE form_versions
       SET settings_snapshot_json = json_set(
         settings_snapshot_json, '$.accessMode', 'email_verified'
       )
     WHERE event_id = 'evt-foe-2025'
       AND form_id = (
         SELECT id FROM form_definitions
          WHERE event_id = 'evt-foe-2025' AND public_slug = 'form'
       )
  `,
  ).run();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("production authentication routes", () => {
  it("creates a hashed magic-link verification for an invited person and calls the configured delivery boundary", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    const delivery = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "email-test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", delivery);

    await createAuth(testEnv).api.signInMagicLink({
      body: {
        email: "sbek-organizer@example.com",
        callbackURL: "/admin/event",
      },
      headers: new Headers({ origin: "http://localhost" }),
    });

    expect(delivery).toHaveBeenCalledOnce();
    const [url, init] = delivery.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.headers).toMatchObject({
      authorization: "Bearer test-resend-key",
    });
    const email = JSON.parse(String(init.body)) as {
      to: string[];
      text: string;
    };
    expect(email.to).toEqual(["sbek-organizer@example.com"]);
    const deliveredToken = new URL(
      email.text.match(/https?:\/\/\S+/)?.[0] ?? "http://invalid",
    ).searchParams.get("token");
    expect(deliveredToken).toBeTruthy();

    const verification = await env.DB.prepare(
      `
      SELECT identifier, value
        FROM verification_tokens
       ORDER BY created_at DESC
       LIMIT 1
    `,
    ).first<{ identifier: string; value: string }>();
    expect(verification).not.toBeNull();
    expect(verification?.identifier).not.toBe(deliveredToken);
    expect(verification?.value).not.toBe(deliveredToken);
  });

  it("accepts only safe same-origin return paths", () => {
    expect(safeReturnTo("/participant/dashboard?tab=files")).toBe(
      "/participant/dashboard?tab=files",
    );
    expect(safeReturnTo("https://attacker.example/path")).toBe("/");
    expect(safeReturnTo("//attacker.example/path")).toBe("/");
    expect(safeReturnTo("/\\attacker.example/path")).toBe("/");
    expect(safeReturnTo("/\t/attacker.example/path")).toBe("/");
    expect(safeReturnTo("/sign-in?returnTo=/sign-in")).toBe("/");
    expect(safeReturnTo("/api/auth/sign-out")).toBe("/");
  });

  it("keeps eligible and unknown sign-in requests observationally identical", async () => {
    const delivery = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input).includes("siteverify")
              ? { success: true, hostname: "localhost", action: "sign_in" }
              : { id: "email-test" },
          ),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", delivery);
    const testContext = context(productionEnv());
    const unknownEmail = `unknown-${crypto.randomUUID()}@example.com`;

    const eligible = await signInAction({
      request: formRequest(
        "http://localhost/sign-in",
        {
          _intent: "email_magic_link",
          email: "sbek-organizer@example.com",
          returnTo: "/participant/dashboard?tab=files",
          "turnstile-token": "turnstile-token",
        },
        { "cf-connecting-ip": "203.0.113.10" },
      ),
      params: {},
      context: testContext,
    } as never);
    const unknown = await signInAction({
      request: formRequest(
        "http://localhost/sign-in",
        {
          _intent: "email_magic_link",
          email: unknownEmail,
          returnTo: "/participant/dashboard?tab=files",
          "turnstile-token": "turnstile-token",
        },
        { "cf-connecting-ip": "203.0.113.11" },
      ),
      params: {},
      context: testContext,
    } as never);

    if (eligible instanceof Response || unknown instanceof Response) {
      throw new Error(
        "A valid sign-in request unexpectedly returned a raw response.",
      );
    }
    expect(eligible.data).toEqual(unknown.data);
    expect(eligible.data).toEqual({
      ok: true,
      message: "A one-time sign-in link will arrive shortly.",
    });
    const emailCalls = (
      delivery.mock.calls as unknown as Array<[string, RequestInit]>
    ).filter(([url]) => !String(url).includes("siteverify"));
    expect(emailCalls).toHaveLength(2);
    for (const [, init] of emailCalls) {
      const delivered = JSON.parse(String(init.body)) as { text: string };
      const link = delivered.text.match(/https?:\/\/\S+/)?.[0];
      expect(new URL(link!).searchParams.get("callbackURL")).toBe(
        "/participant/dashboard?tab=files",
      );
      expect(new URL(link!).searchParams.get("newUserCallbackURL")).toBe("/");
    }
    const unknownDelivery = JSON.parse(String(emailCalls[1]![1].body)) as {
      text: string;
    };
    const unknownLink = unknownDelivery.text.match(/https?:\/\/\S+/u)?.[0];
    const verified = await authApiLoader({
      request: new Request(unknownLink!),
      params: { "*": "magic-link/verify" },
      context: testContext,
    } as never);
    expect(verified.status).toBe(302);
    expect(new URL(verified.headers.get("location")!).pathname).toBe("/");
    await expect(
      env.DB.prepare(
        "SELECT email_verified AS emailVerified FROM people WHERE email = ?",
      )
        .bind(unknownEmail)
        .first<{ emailVerified: number }>(),
    ).resolves.toEqual({ emailVerified: 1 });
  });

  it("does not disclose provider errors and rejects non-POST sign-in requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).includes("siteverify")
          ? Response.json({
              success: true,
              hostname: "localhost",
              action: "sign_in",
            })
          : new Response("provider-secret-detail", { status: 500 }),
      ),
    );
    const logging = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const testContext = context(productionEnv());
    const failed = await signInAction({
      request: formRequest(
        "http://localhost/sign-in",
        {
          _intent: "email_magic_link",
          email: "sbek-organizer@example.com",
          returnTo: "/admin/event",
          "turnstile-token": "turnstile-token",
        },
        { "cf-connecting-ip": "203.0.113.12" },
      ),
      params: {},
      context: testContext,
    } as never);

    if (failed instanceof Response) {
      throw new Error(
        "The provider failure unexpectedly returned a raw response.",
      );
    }
    expect(failed.init?.status).toBe(503);
    expect(failed.data).toEqual({
      ok: false,
      message:
        "Sign-in email could not be requested right now. Please try again later.",
    });
    expect(JSON.stringify(failed.data)).not.toContain("provider-secret-detail");
    expect(logging).toHaveBeenCalledOnce();
    const output = String(logging.mock.calls[0]?.[0]);
    expect(JSON.parse(output)).toMatchObject({
      subsystem: "authentication",
      event: "magic-link-request-failed",
      errorName: "ResendDeliveryError",
    });
    expect(output).not.toContain("provider-secret-detail");
    expect(output).not.toContain("sbek-organizer@example.com");

    const rejected = await signInAction({
      request: new Request("http://localhost/sign-in", { method: "PUT" }),
      params: {},
      context: testContext,
    } as never);
    if (!(rejected instanceof Response)) {
      throw new Error(
        "A non-POST sign-in request was not rejected as a response.",
      );
    }
    expect(rejected.status).toBe(405);
    expect(rejected.headers.get("allow")).toBe("POST");
  });
});
