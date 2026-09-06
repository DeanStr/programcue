import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { z } from "zod";

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
      resultSchema: z.object({ value: z.string() }),
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
      resultSchema: z.object({ value: z.string() }),
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

it.each(["null", "[]", "{}", '{"value":42}'])(
  "rejects malformed durable response %s without repeating the command",
  async (responseJson) => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new ApiPersonIdempotencyService(testEnv);
    let executions = 0;
    let recoveries = 0;
    const options = {
      viewer,
      scope: "person.test.invalid-result",
      idempotencyKey: crypto.randomUUID(),
      input: {},
      resultSchema: z.object({ value: z.string() }),
      execute: async () => {
        executions += 1;
        return { value: "committed" };
      },
      recover: async () => {
        recoveries += 1;
        return null;
      },
    };
    await service.run(options);
    await testEnv.DB.prepare(
      "UPDATE idempotency_records SET response_json = ? WHERE scope = ? AND idempotency_key = ?",
    )
      .bind(responseJson, options.scope, options.idempotencyKey)
      .run();
    await expect(service.run(options)).rejects.toThrow(
      "API command result failed validation",
    );
    expect(executions).toBe(1);
    expect(recoveries).toBe(0);
    expect(
      await testEnv.DB.prepare(
        "SELECT status FROM idempotency_records WHERE scope = ? AND idempotency_key = ?",
      )
        .bind(options.scope, options.idempotencyKey)
        .first(),
    ).toEqual({ status: "completed" });
  },
);

it("validates encoded storage before restoring a command result", async () => {
  const testEnv = env as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  const service = new ApiPersonIdempotencyService(testEnv);
  let restores = 0;
  const options = {
    viewer,
    scope: "person.test.encoded",
    idempotencyKey: crypto.randomUUID(),
    input: {},
    resultSchema: z.object({ value: z.string() }),
    execute: async () => ({ value: "committed" }),
    recover: async () => null,
    storage: {
      schema: z.object({ savedValue: z.string() }),
      store: (result: { value: string }) => ({ savedValue: result.value }),
      restore: (stored: { savedValue: string }) => {
        restores += 1;
        return { value: stored.savedValue };
      },
    },
  };
  await service.run(options);
  await expect(service.run(options)).resolves.toEqual({
    result: { value: "committed" },
    replayed: true,
  });
  await testEnv.DB.prepare(
    "UPDATE idempotency_records SET response_json = '{}' WHERE scope = ? AND idempotency_key = ?",
  )
    .bind(options.scope, options.idempotencyKey)
    .run();
  await expect(service.run(options)).rejects.toThrow(
    "API command result failed validation",
  );
  expect(restores).toBe(1);
});

it.each(["result", "storage"] as const)(
  "retains the claim when %s validation fails after execution",
  async (invalidBoundary) => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new ApiPersonIdempotencyService(testEnv);
    let executions = 0;
    let recoveryAvailable = false;
    const options = {
      viewer,
      scope: "person.test.completion-failure",
      idempotencyKey: crypto.randomUUID(),
      input: {},
      resultSchema: z.object({ value: z.string().min(1) }),
      execute: async () => {
        executions += 1;
        return { value: invalidBoundary === "result" ? "" : "committed" };
      },
      recover: async () => (recoveryAvailable ? { value: "committed" } : null),
      storage: {
        schema: z.object({ savedValue: z.string().min(1) }),
        store: (result: { value: string }) => ({
          savedValue:
            invalidBoundary === "storage" && !recoveryAvailable
              ? ""
              : result.value,
        }),
        restore: (stored: { savedValue: string }) => ({
          value: stored.savedValue,
        }),
      },
    };

    const failure = await service.run(options).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(
      await testEnv.DB.prepare(
        "SELECT status FROM idempotency_records WHERE scope = ? AND idempotency_key = ?",
      )
        .bind(options.scope, options.idempotencyKey)
        .first(),
    ).toEqual({ status: "processing" });
    // A server result-integrity failure must not become a client validation 422.
    expect(failure).not.toBeInstanceOf(z.ZodError);
    await expect(service.run(options)).rejects.toMatchObject({
      status: 409,
      code: "IDEMPOTENCY_REQUEST_IN_PROGRESS",
    });

    recoveryAvailable = true;
    await expect(service.run(options)).resolves.toEqual({
      result: { value: "committed" },
      replayed: true,
    });
    await expect(service.run(options)).resolves.toEqual({
      result: { value: "committed" },
      replayed: true,
    });
    expect(executions).toBe(1);
  },
);
