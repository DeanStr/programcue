import { serializeSignedCookie } from "better-call";
import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import {
  currentEventCookie,
  resolveCurrentEventId,
} from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action as applicationAction } from "./application-form";
import { loader as homeLoader } from "./home";
import { action as signOutAction } from "./sign-out";

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

function validatedProductionEnv() {
  return productionEnv();
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
  it("routes each authenticated event role to its own surface", async () => {
    const testEnv = validatedProductionEnv();
    for (const [personId, expected] of [
      ["person-demo-admin", "/admin/event"],
      ["person-demo-evaluator", "/review/workbench"],
      ["person-demo-speaker", "/participant/dashboard"],
      ["person-demo-submitter", "/participant/dashboard"],
    ] as const) {
      const { cookie } = await sessionCookie(personId);
      const eventCookie = currentEventCookie("evt-foe-2025", testEnv).split(
        ";",
        1,
      )[0];
      const response = await homeLoader({
        request: new Request("http://localhost/", {
          headers: { cookie: `${cookie}; ${eventCookie}` },
        }),
        params: {},
        context: context(testEnv),
      } as never);
      expect(response).toBeInstanceOf(Response);
      expect((response as Response).status).toBe(302);
      expect((response as Response).headers.get("location")).toBe(expected);
    }
  });

  it("establishes the sole event while routing home without repeating authentication", async () => {
    const testEnv = validatedProductionEnv();
    const { cookie } = await sessionCookie("person-demo-admin");
    const response = await homeLoader({
      request: new Request("http://localhost/", {
        headers: { cookie },
      }),
      params: {},
      context: context(testEnv),
    } as never);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("location")).toBe("/admin/event");
    expect((response as Response).headers.get("set-cookie")).toContain(
      "__Host-program_cue_event=evt-foe-2025",
    );
  });

  it("clears a stale event selection and redirects home to explicit selection", async () => {
    const testEnv = validatedProductionEnv();
    const { cookie } = await sessionCookie("person-demo-admin");
    const staleEventCookie = currentEventCookie(
      "evt-no-longer-authorised",
      testEnv,
    ).split(";", 1)[0];

    const response = await homeLoader({
      request: new Request("http://localhost/", {
        headers: { cookie: `${cookie}; ${staleEventCookie}` },
      }),
      params: {},
      context: context(testEnv),
    } as never).catch((error: unknown) => error);

    expect(response).toBeInstanceOf(Response);
    expect((response as Response).status).toBe(302);
    expect((response as Response).headers.get("location")).toBe(
      "/events/select?returnTo=%2F",
    );
    expect((response as Response).headers.get("set-cookie")).toContain(
      "__Host-program_cue_event=; Max-Age=0",
    );
    expect((response as Response).headers.get("cache-control")).toBe(
      "private, no-store",
    );
  });

  it("keeps an authenticated identity without memberships outside private workspaces", async () => {
    const personId = `person-no-access-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `INSERT INTO people (
         id, email, display_name, email_verified, profile_status
       ) VALUES (?, ?, 'No access', 1, 'draft')`,
    )
      .bind(personId, `${personId}@example.com`)
      .run();
    const { cookie } = await sessionCookie(personId);
    const request = new Request("http://localhost/", { headers: { cookie } });

    await expect(
      homeLoader({
        request,
        params: {},
        context: context(validatedProductionEnv()),
      } as never),
    ).resolves.toEqual({ hasWorkspaceAccess: false });
    await expect(
      resolveCurrentEventId(
        new Request("http://localhost/admin/event", { headers: { cookie } }),
        validatedProductionEnv(),
        ["owner", "administrator"],
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("establishes an initial event only on safe navigation and never during a mutation", async () => {
    const testEnv = validatedProductionEnv();
    const { cookie } = await sessionCookie("person-demo-admin");
    const initial = await resolveCurrentEventId(
      new Request("http://localhost/admin/event", { headers: { cookie } }),
      testEnv,
      ["administrator"],
    ).catch((error: unknown) => error);
    expect(initial).toBeInstanceOf(Response);
    expect((initial as Response).status).toBe(302);
    expect((initial as Response).headers.get("location")).toBe("/admin/event");
    expect((initial as Response).headers.get("set-cookie")).toContain(
      "__Host-program_cue_event=evt-foe-2025",
    );

    await expect(
      resolveCurrentEventId(
        new Request("http://localhost/admin/event", {
          method: "POST",
          headers: { cookie, origin: "http://localhost" },
        }),
        testEnv,
        ["administrator"],
      ),
    ).rejects.toMatchObject({ status: 428 });
  });

  it("redirects a sole pending invitation to explicit selection without accepting it during navigation", async () => {
    const testEnv = validatedProductionEnv();
    const { cookie } = await sessionCookie("person-demo-evaluator");
    await env.DB.prepare(
      `UPDATE memberships
          SET accepted_at = NULL, invited_at = unixepoch(),
              invitation_expires_at = unixepoch() + 300, revoked_at = NULL
        WHERE id = 'membership-demo-evaluator'`,
    ).run();
    const auditBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM audit_events
        WHERE entity_id = 'membership-demo-evaluator'
          AND action = 'membership.accepted'`,
    ).first<{ count: number }>();

    const result = await resolveCurrentEventId(
      new Request("http://localhost/review/workbench", {
        headers: { cookie },
      }),
      testEnv,
      ["evaluator"],
    ).catch((error: unknown) => error);

    expect(result).toBeInstanceOf(Response);
    expect((result as Response).status).toBe(302);
    expect((result as Response).headers.get("location")).toBe(
      "/events/select?returnTo=%2Freview%2Fworkbench",
    );
    expect((result as Response).headers.has("set-cookie")).toBe(false);
    expect(
      await env.DB.prepare(
        `SELECT accepted_at AS acceptedAt
           FROM memberships
          WHERE id = 'membership-demo-evaluator'`,
      ).first<{ acceptedAt: number | null }>(),
    ).toEqual({ acceptedAt: null });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count
           FROM audit_events
          WHERE entity_id = 'membership-demo-evaluator'
            AND action = 'membership.accepted'`,
      ).first<{ count: number }>(),
    ).toEqual(auditBefore);
  });

  it("deletes the durable session through a same-origin POST sign-out", async () => {
    const testEnv = validatedProductionEnv();
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
    expect(response.headers.get("set-cookie")).toContain(
      "__Host-program_cue_event=",
    );
    expect(
      await env.DB.prepare("SELECT id FROM auth_sessions WHERE token = ?")
        .bind(token)
        .first(),
    ).toBeNull();
  });

  it("returns a selected demo identity to a genuinely anonymous browser", async () => {
    const response = await signOutAction({
      request: formRequest(
        "http://localhost/sign-out",
        {},
        {
          cookie:
            "program_cue_demo_identity=administrator; program_cue_event=evt-foe-2025",
        },
      ),
      params: {},
      context: context(env as unknown as CloudflareEnvironment),
    } as never);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/demo");
    expect(response.headers.get("set-cookie")).toContain(
      "program_cue_demo_identity=;",
    );
    expect(response.headers.get("set-cookie")).toContain("program_cue_event=;");
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
