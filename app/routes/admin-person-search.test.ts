import { env } from "cloudflare:test";
import { serializeSignedCookie } from "better-call";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { loader } from "./admin-person-search";

const administratorId = "person-demo-admin";
const eventId = "evt-foe-2025";

function productionEnvironment() {
  return {
    ...(env as unknown as CloudflareEnvironment),
    APP_ENV: "production",
    DEMO_MODE: "false",
    EVALUATION_MODE: "false",
  } as unknown as CloudflareEnvironment;
}

function context(environment: CloudflareEnvironment) {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return value;
}

async function administratorCookies(environment: CloudflareEnvironment) {
  const token = `person-search-${crypto.randomUUID()}`;
  await environment.DB.prepare(
    `INSERT INTO auth_sessions (
       id, person_id, token, expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, unixepoch() + 3600, unixepoch(), unixepoch())`,
  )
    .bind(crypto.randomUUID(), administratorId, token)
    .run();
  const session = await serializeSignedCookie(
    "better-auth.session_token",
    token,
    String(environment.BETTER_AUTH_SECRET),
  );
  return `${session}; ${currentEventCookie(eventId, environment).split(";", 1)[0]}`;
}

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
});

describe("administrator person search", () => {
  it("returns reserved evaluator-alias restrictions through the inline lookup contract", async () => {
    const environment = productionEnvironment();
    const result = await loader({
      request: new Request(
        "https://app.programcue.test/admin/people/search?query=sam.reviewer%40sbek-test.example.com",
        { headers: { cookie: await administratorCookies(environment) } },
      ),
      params: {},
      context: context(environment),
    } as never);

    if (!("data" in result))
      throw new Error("Reserved alias search returned a successful result.");
    expect(result.init?.status).toBe(422);
    expect(result.data).toEqual({
      query: "sam.reviewer@sbek-test.example.com",
      matches: [],
      error:
        "Evaluator email aliases can be used only through a signed production-evaluation session in the dedicated evaluation organisation.",
    });
  });
});
