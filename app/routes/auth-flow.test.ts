import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { serializeSignedCookie } from "better-call";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { createAuth } from "~/platform/auth/auth.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action as applicationAction } from "./application-form";
import { loader as homeLoader } from "./home";
import { action as signInAction } from "./sign-in";
import { action as signOutAction } from "./sign-out";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    BETTER_AUTH_SECRET: string;
    AUTH_EMAIL_FROM: string;
    RESEND_API_KEY: string;
  }
}

function productionEnv() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    DEMO_MODE: "false",
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

async function sessionCookie(personId: string) {
  const token = `session-${crypto.randomUUID()}`;
  await env.DB.prepare(
    `
    INSERT INTO auth_sessions (
      id, person_id, token, expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, unixepoch() + 3600, unixepoch(), unixepoch())
  `,
  )
    .bind(crypto.randomUUID(), personId, token)
    .run();
  const cookie = await serializeSignedCookie(
    "better-auth.session_token",
    token,
    String((env as unknown as CloudflareEnvironment).BETTER_AUTH_SECRET),
  );
  return { token, cookie };
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
  it.each([
    ["secret", { BETTER_AUTH_SECRET: undefined }],
    ["base URL", { BETTER_AUTH_URL: undefined }],
  ])("fails fast with 503 when the auth %s is missing", (_name, override) => {
    let thrown: unknown;
    try {
      createAuth({
        ...productionEnv(),
        ...override,
      } as unknown as CloudflareEnvironment);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Response);
    expect((thrown as Response).status).toBe(503);
    expect((thrown as Response).statusText).toBe(
      "Authentication configuration unavailable",
    );
  });

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
      body: { email: "olivia@example.com", callbackURL: "/admin/event" },
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
    expect(email.to).toEqual(["olivia@example.com"]);
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
    expect(safeReturnTo("/speaker/dashboard?tab=files")).toBe(
      "/speaker/dashboard?tab=files",
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
      async () =>
        new Response(JSON.stringify({ id: "email-test" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", delivery);
    const testContext = context(productionEnv());

    const eligible = await signInAction({
      request: formRequest("http://localhost/sign-in", {
        email: "olivia@example.com",
        returnTo: "/speaker/dashboard?tab=files",
      }),
      params: {},
      context: testContext,
    } as never);
    const unknown = await signInAction({
      request: formRequest("http://localhost/sign-in", {
        email: `unknown-${crypto.randomUUID()}@example.com`,
        returnTo: "/speaker/dashboard?tab=files",
      }),
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
      message:
        "If this address is eligible, a one-time sign-in link will arrive shortly.",
    });
    expect(delivery).toHaveBeenCalledTimes(2);
    for (const [, init] of delivery.mock.calls as unknown as Array<
      [string, RequestInit]
    >) {
      const delivered = JSON.parse(String(init.body)) as { text: string };
      const link = delivered.text.match(/https?:\/\/\S+/)?.[0];
      expect(new URL(link!).searchParams.get("callbackURL")).toBe(
        "/speaker/dashboard?tab=files",
      );
    }
  });

  it("does not disclose provider errors and rejects non-POST sign-in requests", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response("provider-secret-detail", { status: 500 }),
      ),
    );
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const testContext = context(productionEnv());
    const failed = await signInAction({
      request: formRequest("http://localhost/sign-in", {
        email: "olivia@example.com",
        returnTo: "/admin/event",
      }),
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

  it("routes each authenticated event role to its own surface", async () => {
    const testEnv = productionEnv();
    for (const [personId, expected] of [
      ["person-demo-admin", "/admin/event"],
      ["person-demo-evaluator", "/review/workbench"],
      ["person-demo-speaker", "/speaker/dashboard"],
      ["person-demo-submitter", "/apply/form"],
    ] as const) {
      const { cookie } = await sessionCookie(personId);
      const response = await homeLoader({
        request: new Request("http://localhost/", {
          headers: { cookie },
        }),
        params: {},
        context: context(testEnv),
      } as never);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(expected);
    }
  });

  it("deletes the durable session through a same-origin POST sign-out", async () => {
    const testEnv = productionEnv();
    const { token, cookie } = await sessionCookie("person-demo-admin");
    const response = await signOutAction({
      request: formRequest(
        "http://localhost/sign-out",
        { returnTo: "/admin/tasks" },
        { cookie },
      ),
      params: {},
      context: context(testEnv),
    } as never);

    if (!(response instanceof Response)) {
      throw new Error("Account sign-out did not return a redirect response.");
    }
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/sign-in?returnTo=%2Fadmin%2Ftasks",
    );
    expect(response.headers.get("set-cookie")).toContain(
      "better-auth.session_token=",
    );
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(
      await env.DB.prepare("SELECT id FROM auth_sessions WHERE token = ?")
        .bind(token)
        .first(),
    ).toBeNull();
  });

  it("rejects cross-origin and non-POST sign-out attempts without deleting the session", async () => {
    const testEnv = productionEnv();
    const { token, cookie } = await sessionCookie("person-demo-admin");
    const crossOrigin = await signOutAction({
      request: formRequest(
        "http://localhost/sign-out",
        { returnTo: "/admin/event" },
        { cookie, origin: "https://attacker.example" },
      ),
      params: {},
      context: context(testEnv),
    } as never);
    expect(crossOrigin.status).toBe(403);
    expect(
      await env.DB.prepare("SELECT id FROM auth_sessions WHERE token = ?")
        .bind(token)
        .first(),
    ).not.toBeNull();

    const wrongMethod = await signOutAction({
      request: new Request("http://localhost/sign-out", { method: "DELETE" }),
      params: {},
      context: context(testEnv),
    } as never);
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get("allow")).toBe("POST");
  });

  it("signs Better Auth users out from an account-required application", async () => {
    await env.DB.prepare(
      `
      UPDATE form_definitions SET access_mode = 'account_required'
       WHERE event_id = 'evt-foe-2025' AND public_slug = 'form'
    `,
    ).run();
    await env.DB.prepare(
      `
      UPDATE form_versions
         SET settings_snapshot_json = json_set(
           settings_snapshot_json, '$.accessMode', 'account_required'
         )
       WHERE event_id = 'evt-foe-2025' AND status = 'published'
         AND form_id = (
           SELECT id FROM form_definitions
            WHERE event_id = 'evt-foe-2025' AND public_slug = 'form'
         )
    `,
    ).run();
    const testEnv = productionEnv();
    const { token, cookie } = await sessionCookie("person-demo-submitter");
    const response = await applicationAction({
      request: formRequest(
        "http://localhost/apply/form",
        { _intent: "sign_out" },
        { cookie },
      ),
      params: { slug: "form" },
      context: context(testEnv),
    } as never);

    if (!(response instanceof Response)) {
      throw new Error(
        "Application sign-out did not return a redirect response.",
      );
    }
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "/sign-in?returnTo=%2Fapply%2Fform",
    );
    expect(
      await env.DB.prepare("SELECT id FROM auth_sessions WHERE token = ?")
        .bind(token)
        .first(),
    ).toBeNull();
  });
});
