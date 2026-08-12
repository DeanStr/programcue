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
        body: new URLSearchParams({ identity: "evaluator" }),
      }),
      params: {},
      context: context(env as unknown as CloudflareEnvironment),
    } as never);
    expect(selected.status).toBe(302);
    expect(selected.headers.get("set-cookie")).toContain(
      "program_cue_demo_identity=evaluator",
    );

    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare(
      `DELETE FROM memberships
        WHERE event_id = 'evt-foe-2025'
          AND person_id = 'person-sbek-reviewer' AND role = 'evaluator'`,
    ).run();
    const sbekReviewer = await roleAction({
      request: new Request("http://localhost/demo/role", {
        method: "POST",
        body: new URLSearchParams({ identity: "sbek_reviewer" }),
      }),
      params: {},
      context: context(env as unknown as CloudflareEnvironment),
    } as never);
    expect(sbekReviewer.status).toBe(302);
    expect(sbekReviewer.headers.get("location")).toBe("/demo");
    expect(sbekReviewer.headers.get("set-cookie")).toContain(
      "program_cue_demo_identity=sbek_reviewer",
    );

    const invalid = await thrownResponse(
      roleAction({
        request: new Request("http://localhost/demo/role", {
          method: "POST",
          body: new URLSearchParams({ identity: "committee_chair" }),
        }),
        params: {},
        context: context(env as unknown as CloudflareEnvironment),
      } as never),
    );
    expect(invalid.status).toBe(400);

    const guidedTask = await roleAction({
      request: new Request("http://localhost/demo/role", {
        method: "POST",
        body: new URLSearchParams({
          identity: "administrator",
          returnTo: "/admin/submissions/form",
        }),
      }),
      params: {},
      context: context(env as unknown as CloudflareEnvironment),
    } as never);
    expect(guidedTask.headers.get("location")).toBe("/admin/submissions/form");

    const unsafeReturn = await thrownResponse(
      roleAction({
        request: new Request("http://localhost/demo/role", {
          method: "POST",
          body: new URLSearchParams({
            identity: "administrator",
            returnTo: "https://attacker.example/steal",
          }),
        }),
        params: {},
        context: context(env as unknown as CloudflareEnvironment),
      } as never),
    );
    expect(unsafeReturn.status).toBe(400);

    const production = await thrownResponse(
      roleAction({
        request: new Request("https://programcue.test/demo/role", {
          method: "POST",
          body: new URLSearchParams({ identity: "administrator" }),
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
    expect(result.viewer).toBeNull();
    expect(result.providerConfiguration.airtable).toBe(true);
    expect(result.providerConfiguration.email).toBe(false);
  });

  it("preserves a safe private destination while an anonymous evaluator chooses an identity", async () => {
    const result = await guideLoader({
      request: new Request(
        "http://localhost/demo?returnTo=%2Fadmin%2Fschedule%3Fview%3Dtimeline",
      ),
      params: {},
      context: context(env as unknown as CloudflareEnvironment),
    } as never);
    expect(result.viewer).toBeNull();
    expect(result.returnTo).toBe("/admin/schedule?view=timeline");
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

  it("detects exact SBEK identity and second-speaker work as baseline drift", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await guideLoader({
      request: new Request("http://localhost/demo"),
      params: {},
      context: context(testEnvironment),
    } as never);
    await testEnvironment.DB.batch([
      testEnvironment.DB.prepare(
        `UPDATE people SET display_name = 'Stale Priya'
          WHERE id = 'person-sbek-speaker'`,
      ),
      testEnvironment.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role, invited_at,
           accepted_at, created_at
         ) VALUES (
           'demo-guide-sbek-speaker2', 'org-future-events', 'evt-foe-2025',
           'person-sbek-speaker2', 'speaker', unixepoch(), unixepoch(),
           unixepoch()
         )`,
      ),
      testEnvironment.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, owner_person_id, title,
           impact, created_at, updated_at
         ) VALUES (
           'demo-guide-sbek-speaker2-task', 'evt-foe-2025', 'speaker',
           'person-sbek-speaker2', 'person-sbek-speaker2', 'Fixture drift',
           'medium', unixepoch(), unixepoch()
         )`,
      ),
      testEnvironment.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, submitter_person_id, submitter_email,
           public_reference, title, status, created_at, updated_at
         ) VALUES (
           'demo-guide-sbek-speaker2-submission', 'evt-foe-2025',
           'person-sbek-speaker2', 'sbek-speaker2@example.com',
           'SBEK-DRIFT', 'An evaluator-created title', 'draft',
           unixepoch(), unixepoch()
         )`,
      ),
    ]);

    const changed = await guideLoader({
      request: new Request("http://localhost/demo"),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(changed.baseline).toMatchObject({
      sbekPeople: 3,
      sbekSpeakerMemberships: 1,
      sbekSpeakerTasks: 1,
      sbekFixtureSubmissions: 1,
    });
    expect(changed.baselineComplete).toBe(false);
  });

  it("sends an activated SBEK reviewer to their real workbench", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnvironment);
    await testEnvironment.DB.prepare(
      `INSERT INTO memberships (
         id, organisation_id, event_id, person_id, role, invited_at,
         accepted_at, created_at
       ) VALUES (
         'demo-guide-sbek-reviewer', 'org-future-events', 'evt-foe-2025',
         'person-sbek-reviewer', 'evaluator', unixepoch(), unixepoch(),
         unixepoch()
       ) ON CONFLICT(id) DO UPDATE SET
           accepted_at = unixepoch(), revoked_at = NULL`,
    ).run();

    const selected = await guideLoader({
      request: new Request("http://localhost/demo", {
        headers: {
          cookie: "program_cue_demo_identity=sbek_reviewer",
        },
      }),
      params: {},
      context: context(testEnvironment),
    } as never);
    expect(selected.viewer).toMatchObject({
      name: "Sam Whitfield",
      role: "evaluator",
      destination: "/review/workbench",
    });
  });
});
