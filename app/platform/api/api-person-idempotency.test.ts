import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { ApiPersonIdempotencyService } from "./api-person-idempotency.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("person API idempotency", () => {
  it("returns a canonical recovered result when execution throws after commit", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new ApiPersonIdempotencyService(testEnv);
    const idempotencyKey = `person-recovered-${crypto.randomUUID()}`;
    let committed = false;
    let executions = 0;
    const options = {
      viewer,
      scope: "person.test.recovered",
      idempotencyKey,
      input: { value: "one" },
      execute: async () => {
        executions += 1;
        committed = true;
        throw new Error("Response persistence connection closed.");
      },
      recover: async () => (committed ? { value: "committed" } : null),
    };

    await expect(service.run(options)).resolves.toEqual({
      result: { value: "committed" },
      replayed: false,
    });
    await expect(service.run(options)).resolves.toEqual({
      result: { value: "committed" },
      replayed: true,
    });
    expect(executions).toBe(1);
  });

  it("preserves a committed partial failure instead of recovering it as success", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new ApiPersonIdempotencyService(testEnv);
    const idempotencyKey = `person-committed-partial-${crypto.randomUUID()}`;
    let executions = 0;
    let recoveries = 0;
    const committedFailure = Object.assign(
      new Error("The provider did not complete."),
      { committed: true as const },
    );
    const options = {
      viewer,
      scope: "person.test.committed-partial",
      idempotencyKey,
      input: { value: "one" },
      execute: async () => {
        executions += 1;
        throw committedFailure;
      },
      recover: async () => {
        recoveries += 1;
        return { value: "primary-row-only" };
      },
    };

    await expect(service.run(options)).rejects.toBe(committedFailure);
    await expect(service.run(options)).rejects.toMatchObject({
      status: 503,
      code: "IDEMPOTENCY_COMMITTED_PARTIAL",
      details: { committed: true },
    });
    expect(executions).toBe(1);
    expect(recoveries).toBe(0);
    await expect(
      testEnv.DB.prepare(
        `SELECT status, response_status AS responseStatus
           FROM idempotency_records
          WHERE event_id = ? AND actor_id = ? AND scope = ?
            AND idempotency_key = ?`,
      )
        .bind(
          viewer.eventId,
          `person:${viewer.personId}`,
          options.scope,
          idempotencyKey,
        )
        .first(),
    ).resolves.toMatchObject({ status: "failed", responseStatus: 503 });
  });
});
