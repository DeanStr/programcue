import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./admin-event-new";

const workerEnv = env as unknown as CloudflareEnvironment;

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(values?: Record<string, string>) {
  return new Request("http://localhost/admin/events/new", {
    method: values ? "POST" : "GET",
    headers: {
      cookie:
        "program_cue_demo_role=administrator; program_cue_event=evt-foe-2025",
      origin: "http://localhost",
    },
    ...(values ? { body: new URLSearchParams(values) } : {}),
  });
}

beforeEach(async () => {
  await ensureDemoData(workerEnv);
  await env.DB.prepare(
    `INSERT OR REPLACE INTO memberships (
       id, organisation_id, event_id, person_id, role,
       invited_at, accepted_at, created_at
     ) VALUES (
       'membership-new-event-route-admin', 'org-future-events', NULL,
       'person-demo-admin', 'administrator', unixepoch(), unixepoch(), unixepoch()
     )`,
  ).run();
});

describe("new event route", () => {
  it("loads blank-event defaults for an organisation administrator", async () => {
    const result = await loader({
      request: request(),
      params: {},
      context: context(),
    } as never);

    expect(result).toMatchObject({
      timezone: "America/Toronto",
      airtableTableName: "Program Cue Rooms",
    });
  });

  it("creates a blank D1 event without requiring hidden Airtable fields", async () => {
    const token = crypto.randomUUID().slice(0, 8);
    const response = await action({
      request: request({
        intent: "create",
        name: `Route blank event ${token}`,
        slug: `route-blank-event-${token}`,
        timezone: "UTC",
        startDate: "2027-10-01",
        endDate: "2027-10-02",
        repositoryProvider: "d1",
        tableName: "Program Cue Rooms",
      }),
      params: {},
      context: context(),
    } as never);
    if (response instanceof Response)
      throw new Error("New event action returned a raw response.");

    expect(response.data).toMatchObject({
      ok: true,
      committed: true,
      result: { repositoryProvider: "d1" },
    });
    expect(
      await env.DB.prepare(
        "SELECT repository_provider AS provider FROM events WHERE slug = ?",
      )
        .bind(`route-blank-event-${token}`)
        .first(),
    ).toEqual({ provider: "d1" });
  });
});
