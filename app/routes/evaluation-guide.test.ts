import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { requireAuthenticatedPerson } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./evaluation-guide";

function context(environment: CloudflareEnvironment) {
  const routerContext = new RouterContextProvider();
  routerContext.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return routerContext;
}

function productionEnvironment() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: "true",
    BETTER_AUTH_SECRET:
      "evaluation-route-better-auth-secret-with-thirty-two-characters",
    EVALUATION_ACCESS_CODE: "evaluation-access-code-2026",
    EVALUATION_SESSION_SECRET:
      "evaluation-session-secret-with-more-than-thirty-two-characters",
  } as CloudflareEnvironment;
}

function request(
  body: Record<string, string>,
  options: { cookie?: string; ip?: string } = {},
) {
  return new Request("https://app.programcue.test/evaluate", {
    method: "POST",
    headers: {
      origin: "https://app.programcue.test",
      "cf-connecting-ip": options.ip ?? "203.0.113.150",
      ...(options.cookie ? { cookie: options.cookie } : {}),
    },
    body: new URLSearchParams(body),
  });
}

function responseCookieHeader(response: Response) {
  const headers = response.headers as Headers & {
    getSetCookie?: () => string[];
  };
  const values = headers.getSetCookie?.() ?? [headers.get("set-cookie") ?? ""];
  return values
    .filter(Boolean)
    .map((value) => value.split(";", 1)[0])
    .join("; ");
}

async function recordFixtureReset(environment: CloudflareEnvironment) {
  await environment.DB.prepare(
    `INSERT INTO audit_events (
       id, organisation_id, event_id, actor_id, action,
       entity_type, entity_id, metadata_json, created_at
     ) VALUES (?, 'org-future-events', 'evt-foe-2025', 'test-operator',
               'evaluation.fixture.reset', 'event', 'evt-foe-2025', '{}',
               unixepoch())`,
  )
    .bind(crypto.randomUUID())
    .run();
}

describe("production evaluation guide", () => {
  it("is absent outside the exact production evaluation mode", async () => {
    await expect(
      loader({
        request: new Request("http://localhost/evaluate"),
        params: {},
        context: context(env as unknown as CloudflareEnvironment),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("unlocks a fixed persona and authenticates it through normal server authorization", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const environment = productionEnvironment();
    await recordFixtureReset(environment);
    const unlocked = await action({
      request: request({
        _intent: "unlock",
        accessCode: "evaluation-access-code-2026",
      }),
      params: {},
      context: context(environment),
    } as never);
    expect(unlocked).toBeInstanceOf(Response);
    expect((unlocked as Response).status).toBe(303);
    expect((unlocked as Response).headers.get("location")).toBe("/evaluate");
    const unlockedCookies = responseCookieHeader(unlocked as Response);
    await expect(
      loader({
        request: new Request("https://app.programcue.test/evaluate", {
          headers: { cookie: unlockedCookies },
        }),
        params: {},
        context: context(environment),
      } as never),
    ).resolves.toMatchObject({
      unlocked: true,
      eventName: "Future of Events 2025",
    });

    const selected = await action({
      request: request(
        { _intent: "select_identity", identity: "organizer" },
        { cookie: unlockedCookies },
      ),
      params: {},
      context: context(environment),
    } as never);
    expect(selected).toBeInstanceOf(Response);
    expect((selected as Response).status).toBe(303);
    expect((selected as Response).headers.get("location")).toBe(
      "/admin/command",
    );
    expect(
      (selected as Response).headers.get("x-remix-reload-document"),
    ).toBe("true");
    const selectedCookies = responseCookieHeader(selected as Response);
    await expect(
      requireAuthenticatedPerson(
        new Request("https://app.programcue.test/admin/command", {
          headers: { cookie: selectedCookies },
        }),
        environment,
      ),
    ).resolves.toMatchObject({
      personId: "person-demo-admin",
      evaluation: true,
      demo: false,
    });
  });

  it("rate-limits repeated access-code attempts", async () => {
    const environment = productionEnvironment();
    const ip = "203.0.113.151";
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const result = await action({
        request: request(
          { _intent: "unlock", accessCode: `wrong-code-${attempt}` },
          { ip },
        ),
        params: {},
        context: context(environment),
      } as never);
      if (result instanceof Response) {
        throw new Error("Invalid evaluation code returned a raw response.");
      }
      expect(result.init?.status).toBe(401);
    }
    const limited = await action({
      request: request(
        { _intent: "unlock", accessCode: "one-attempt-too-many" },
        { ip },
      ),
      params: {},
      context: context(environment),
    } as never);
    if (limited instanceof Response) {
      throw new Error(
        "Rate-limited evaluation access returned a raw response.",
      );
    }
    expect(limited.init?.status).toBe(429);
    expect(new Headers(limited.init?.headers).get("retry-after")).toBeTruthy();
  });
});
