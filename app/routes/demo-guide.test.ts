import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { loader as guideLoader } from "./demo-guide";
import { action as roleAction } from "./demo-role";

function context(testEnvironment: CloudflareEnvironment) {
  const provider = new RouterContextProvider();
  provider.set(cloudflareContext, {
    env: testEnvironment,
    ctx: {} as ExecutionContext,
  });
  return provider;
}

async function thrownResponse(operation: Promise<unknown>) {
  try {
    await operation;
  } catch (error) {
    if (error instanceof Response) return error;
    throw error;
  }
  throw new Error("Expected the route to throw a Response.");
}

describe("evaluator demo routes", () => {
  it("allows only POST for demo identity mutations", async () => {
    const response = await thrownResponse(
      roleAction({
        request: new Request("http://localhost/demo/role", { method: "PUT" }),
        params: {},
        context: context(env as unknown as CloudflareEnvironment),
      } as never),
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");

    const selected = await roleAction({
      request: new Request("http://localhost/demo/role", {
        method: "POST",
        body: new URLSearchParams({ role: "evaluator" }),
      }),
      params: {},
      context: context(env as unknown as CloudflareEnvironment),
    } as never);
    expect(selected.status).toBe(302);
    expect(selected.headers.get("set-cookie")).toContain(
      "program_cue_demo_role=evaluator",
    );

    const invalid = await thrownResponse(
      roleAction({
        request: new Request("http://localhost/demo/role", {
          method: "POST",
          body: new URLSearchParams({ role: "committee_chair" }),
        }),
        params: {},
        context: context(env as unknown as CloudflareEnvironment),
      } as never),
    );
    expect(invalid.status).toBe(400);

    const production = await thrownResponse(
      roleAction({
        request: new Request("https://programcue.test/demo/role", {
          method: "POST",
          body: new URLSearchParams({ role: "administrator" }),
        }),
        params: {},
        context: context({
          ...(env as unknown as CloudflareEnvironment),
          APP_ENV: "production",
          DEMO_MODE: "true",
        } as unknown as CloudflareEnvironment),
      } as never),
    );
    expect(production.status).toBe(404);

    const productionGuide = await thrownResponse(
      guideLoader({
        request: new Request("https://programcue.test/demo"),
        params: {},
        context: context({
          ...(env as unknown as CloudflareEnvironment),
          APP_ENV: "production",
          DEMO_MODE: "false",
        }),
      } as never),
    );
    expect(productionGuide.status).toBe(404);
  });

  it("recognises the actual Airtable repository provider identifier", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    await testEnvironment.DB.prepare(
      `INSERT INTO integration_connections (
         id, organisation_id, event_id, provider, status, direction,
         encrypted_credentials, configuration_json, revision, created_at, updated_at
       ) VALUES (
         'demo-guide-airtable', 'org-future-events', 'evt-foe-2025',
         'airtable_repository', 'connected', 'bidirectional',
         'sealed-test-credential', '{}', 1,
         unixepoch(), unixepoch()
       ) ON CONFLICT(id) DO UPDATE SET
           status = 'connected', encrypted_credentials = 'sealed-test-credential'`,
    ).run();

    const result = await guideLoader({
      request: new Request("http://localhost/demo"),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(result.providerConfiguration.airtable).toBe(true);
    expect(result.providerConfiguration.email).toBe(false);
  });

  it("keeps the reset guide available after the evaluator changes the baseline", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await guideLoader({
      request: new Request("http://localhost/demo"),
      params: {},
      context: context(testEnvironment),
    } as never);
    await testEnvironment.DB.prepare(
      `UPDATE schedule_versions SET status = 'draft', published_at = NULL
        WHERE event_id = 'evt-foe-2025' AND status = 'published'`,
    ).run();

    const result = await guideLoader({
      request: new Request("http://localhost/demo"),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(result.baseline.publishedSchedules).toBe(0);
    expect(result.baselineComplete).toBe(false);
  });
});
