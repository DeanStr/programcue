import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action as operationCentreAction } from "~/routes/operation-centre";
import { OperationService } from "./operation-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("operation retries", () => {
  it("reports a committed queue failure from the route action", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const operationId = crypto.randomUUID();
    const payload = { type: "test.operation", operationId };
    await env.DB.prepare(
      `
      INSERT INTO operation_jobs (
        id, organisation_id, event_id, requested_by_person_id, type,
        idempotency_key, correlation_id, status, payload_json,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'test.operation', ?, ?, 'failed', ?,
                'Initial failure', unixepoch(), unixepoch())
    `,
    )
      .bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `test-operation:${operationId}`,
        crypto.randomUUID(),
        JSON.stringify(payload),
      )
      .run();
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async () => {
          throw new Error("Queue unavailable in route test");
        },
      },
    } as unknown as CloudflareEnvironment;
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: testEnv,
      ctx: {} as ExecutionContext,
    });
    const result = await operationCentreAction({
      request: new Request("http://localhost/admin/operations", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ intent: "retry", operationId }),
      }),
      params: {},
      context,
    } as never);

    if (result instanceof Response)
      throw new Error("The known queue failure returned an untyped response.");
    expect(result.init?.status).toBe(503);
    expect(result.data).toMatchObject({
      ok: false,
      committed: true,
      operationId,
    });
    expect(
      await env.DB.prepare(
        "SELECT status, last_error AS lastError FROM operation_jobs WHERE id = ?",
      )
        .bind(operationId)
        .first(),
    ).toEqual({
      status: "queue_failed",
      lastError: "Queue unavailable in route test",
    });
  });

  it("increments attempts only when a consumer claims retried work", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const operationId = crypto.randomUUID();
    const payload = { type: "test.operation", operationId };
    await env.DB.prepare(
      `
      INSERT INTO operation_jobs (
        id, organisation_id, event_id, requested_by_person_id, type,
        idempotency_key, correlation_id, status, payload_json,
        attempt_count, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'test.operation', ?, ?, 'failed', ?, 1,
                'First provider attempt failed', unixepoch(), unixepoch())
    `,
    )
      .bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `test-operation:${operationId}`,
        crypto.randomUUID(),
        JSON.stringify(payload),
      )
      .run();

    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      },
    } as unknown as CloudflareEnvironment;
    await new OperationService(testEnv).retry(viewer, operationId);

    expect(queued).toEqual([payload]);
    const operation = await env.DB.prepare(
      `
      SELECT status, attempt_count AS attemptCount, last_error AS lastError
        FROM operation_jobs WHERE id = ?
    `,
    )
      .bind(operationId)
      .first<{
        status: string;
        attemptCount: number;
        lastError: string | null;
      }>();
    expect(operation).toEqual({
      status: "queued",
      attemptCount: 1,
      lastError: null,
    });
  });

  it("recovers an expired processing lease but rejects an active one", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const expiredId = crypto.randomUUID();
    const activeId = crypto.randomUUID();
    const payload = (operationId: string) => ({
      type: "test.operation",
      operationId,
    });
    for (const [operationId, offset] of [
      [expiredId, -1],
      [activeId, 60],
    ] as const) {
      await env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json,
          attempt_count, claim_token, claim_expires_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'test.operation', ?, ?, 'running', ?, 1, ?,
                  unixepoch() + ?, unixepoch(), unixepoch())
      `,
      )
        .bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          `test-operation:${operationId}`,
          crypto.randomUUID(),
          JSON.stringify(payload(operationId)),
          `claim-${operationId}`,
          offset,
        )
        .run();
    }

    const queued: unknown[] = [];
    const testEnv = {
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      },
    } as unknown as CloudflareEnvironment;
    const service = new OperationService(testEnv);
    const listedBeforeRetry = await service.list(viewer);
    expect(
      listedBeforeRetry.find((item) => item.id === expiredId)?.retryable,
    ).toBe(true);
    expect(
      listedBeforeRetry.find((item) => item.id === activeId)?.retryable,
    ).toBe(false);
    await service.retry(viewer, expiredId);
    await expect(service.retry(viewer, activeId)).rejects.toThrow(
      "expired processing lease",
    );

    expect(queued).toEqual([payload(expiredId)]);
    expect(
      await env.DB.prepare(
        `SELECT status, claim_token AS claimToken, claim_expires_at AS claimExpiresAt
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(expiredId)
        .first(),
    ).toEqual({ status: "queued", claimToken: null, claimExpiresAt: null });
    expect(
      await env.DB.prepare(
        `SELECT status, claim_token AS claimToken FROM operation_jobs WHERE id = ?`,
      )
        .bind(activeId)
        .first(),
    ).toEqual({ status: "running", claimToken: `claim-${activeId}` });
  });

  it("re-enqueues stale queued intent but leaves recently queued work alone", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const staleId = crypto.randomUUID();
    const freshId = crypto.randomUUID();
    const payload = (operationId: string) => ({
      type: "test.operation",
      operationId,
    });
    for (const [operationId, ageSeconds] of [
      [staleId, 61],
      [freshId, 0],
    ] as const) {
      await env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'test.operation', ?, ?, 'queued', ?,
                  unixepoch() - ?, unixepoch() - ?)
      `,
      )
        .bind(
          operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          `test-operation:${operationId}`,
          crypto.randomUUID(),
          JSON.stringify(payload(operationId)),
          ageSeconds,
          ageSeconds,
        )
        .run();
    }

    const queued: unknown[] = [];
    const service = new OperationService({
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      },
    } as unknown as CloudflareEnvironment);
    const listed = await service.list(viewer);
    expect(listed.find((item) => item.id === staleId)?.retryable).toBe(true);
    expect(listed.find((item) => item.id === freshId)?.retryable).toBe(false);

    await service.retry(viewer, staleId);
    await expect(service.retry(viewer, freshId)).rejects.toThrow(
      "stale queued operations",
    );
    expect(queued).toEqual([payload(staleId)]);
  });
});
