import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action as operationCentreAction } from "~/routes/operation-centre";
import { OperationService } from "./operation-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Jordan Alvarez",
  email: "sbek-organizer@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

function selectedEventCookie(environment: CloudflareEnvironment) {
  return `program_cue_demo_identity=administrator; ${currentEventCookie(viewer.eventId, environment).split(";", 1)[0]}`;
}

async function seedFailedAcceleventsOperation() {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.batch([
    env.DB.prepare(
      `DELETE FROM operation_jobs
        WHERE event_id = ? AND type = 'integration.accelevents.export'`,
    ).bind(viewer.eventId),
    env.DB.prepare(
      `DELETE FROM integration_connections
        WHERE event_id = ? AND provider = 'accelevents'`,
    ).bind(viewer.eventId),
  ]);
  const connectionId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const successfulItemId = crypto.randomUUID();
  const failedItemId = crypto.randomUUID();
  const successfulRunItemId = crypto.randomUUID();
  const failedRunItemId = crypto.randomUUID();
  const payload = {
    type: "integration.accelevents.export" as const,
    operationId,
    runId,
    connectionId,
    connectionRevision: 1,
    organisationId: viewer.organisationId,
    eventId: viewer.eventId,
  };
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO integration_connections (
         id, organisation_id, event_id, provider, status, direction,
         configuration_json, created_at, updated_at
       ) VALUES (?, ?, ?, 'accelevents', 'connected', 'outbound',
                 '{}', unixepoch(), unixepoch())`,
    ).bind(connectionId, viewer.organisationId, viewer.eventId),
    env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed,
         completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'integration.accelevents.export', ?, ?,
                 'partially_failed', ?, 2, 1, 1,
                 unixepoch(), unixepoch(), unixepoch())`,
    ).bind(
      operationId,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      `accelevents-operation:${operationId}`,
      crypto.randomUUID(),
      JSON.stringify(payload),
    ),
    env.DB.prepare(
      `INSERT INTO integration_runs (
         id, connection_id, operation_id, idempotency_key, status,
         direction, dry_run, summary_json, started_at, completed_at, created_at
       ) VALUES (?, ?, ?, ?, 'partially_failed', 'outbound', 0,
                 '{"total":2,"completed":1,"failed":1}',
                 unixepoch(), unixepoch(), unixepoch())`,
    ).bind(runId, connectionId, operationId, `run:${runId}`),
    env.DB.prepare(
      `INSERT INTO integration_run_items (
         id, run_id, entity_type, entity_id, external_id, action, status,
         diff_json, attempt_count, updated_at
       ) VALUES (?, ?, 'speaker', 'speaker-success', 'external-speaker',
                 'create', 'succeeded', '{}', 1, unixepoch())`,
    ).bind(successfulRunItemId, runId),
    env.DB.prepare(
      `INSERT INTO integration_run_items (
         id, run_id, entity_type, entity_id, action, status,
         diff_json, attempt_count, error_code, error_message, updated_at
       ) VALUES (?, ?, 'session', 'session-failed', 'create', 'failed',
                 '{}', 1, 'PROVIDER_ERROR', 'Provider rejected it', unixepoch())`,
    ).bind(failedRunItemId, runId),
    env.DB.prepare(
      `INSERT INTO operation_items (
         id, operation_id, item_key, entity_type, entity_id, status,
         result_json, completed_at, updated_at
       ) VALUES (?, ?, 'speaker:speaker-success', 'speaker', 'speaker-success',
                 'completed', '{"externalId":"external-speaker"}',
                 unixepoch(), unixepoch())`,
    ).bind(successfulItemId, operationId),
    env.DB.prepare(
      `INSERT INTO operation_items (
         id, operation_id, item_key, entity_type, entity_id, status,
         result_json, attempt_count, error_code, error_message,
         completed_at, updated_at
       ) VALUES (?, ?, 'session:session-failed', 'session', 'session-failed',
                 'failed', '{}', 1, 'PROVIDER_ERROR', 'Provider rejected it',
                 unixepoch(), unixepoch())`,
    ).bind(failedItemId, operationId),
  ]);
  return {
    operationId,
    runId,
    successfulItemId,
    failedItemId,
    successfulRunItemId,
    failedRunItemId,
    payload,
  };
}

describe("operation retries", () => {
  it("reports a committed queue failure from the route action", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const operationId = crypto.randomUUID();
    const payload = {
      type: "webhook.deliver",
      operationId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
    };
    await env.DB.prepare(
      `
      INSERT INTO operation_jobs (
        id, organisation_id, event_id, requested_by_person_id, type,
        idempotency_key, correlation_id, status, payload_json,
        last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'webhook.deliver', ?, ?, 'failed', ?,
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
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          cookie: selectedEventCookie(testEnv),
        },
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
    const payload = {
      type: "webhook.deliver",
      operationId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
    };
    await env.DB.prepare(
      `
      INSERT INTO operation_jobs (
        id, organisation_id, event_id, requested_by_person_id, type,
        idempotency_key, correlation_id, status, payload_json,
        attempt_count, last_error, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'webhook.deliver', ?, ?, 'failed', ?, 1,
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
      type: "webhook.deliver",
      operationId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
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
        ) VALUES (?, ?, ?, ?, 'webhook.deliver', ?, ?, 'running', ?, 1, ?,
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
      type: "webhook.deliver",
      operationId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
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
        ) VALUES (?, ?, ?, ?, 'webhook.deliver', ?, ?, 'queued', ?,
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

  it("refuses to queue a saved payload whose tenant identity does not match the operation", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const operationId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'webhook.deliver', ?, ?, 'failed', ?,
                 'Initial failure', unixepoch(), unixepoch())`,
    )
      .bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `mismatched-payload:${operationId}`,
        crypto.randomUUID(),
        JSON.stringify({
          type: "webhook.deliver",
          operationId: "another-operation",
          eventId: viewer.eventId,
          organisationId: viewer.organisationId,
        }),
      )
      .run();
    const queued: unknown[] = [];
    const service = new OperationService({
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      },
    } as unknown as CloudflareEnvironment);

    await expect(service.retry(viewer, operationId)).rejects.toThrow(
      "does not match the operation tenant identity",
    );
    expect(queued).toEqual([]);
    await expect(
      env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
        .bind(operationId)
        .first(),
    ).resolves.toEqual({ status: "failed" });
  });

  it("restarts every failed delivery before explicitly retrying a communication", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const operationId = crypto.randomUUID();
    const communicationId = crypto.randomUUID();
    const idempotencyKey = `communication-retry:${crypto.randomUUID()}`;
    const savedPayload = {
      type: "communication.send",
      operationId,
      communicationId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
      idempotencyKey,
      includeFailed: true,
    };
    const deliveries = Array.from({ length: 13 }, (_, index) => ({
      id: crypto.randomUUID(),
      key: `delivery:${index}`,
      address: `retry-${index}@example.com`,
      status: index === 12 ? "sent" : "failed",
    }));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, result_json,
           progress_total, progress_completed, progress_failed,
           completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'communication.send', ?, ?, 'partially_failed',
                   ?, '{"failed":12}', 13, 13, 12,
                   unixepoch(), unixepoch(), unixepoch())`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        idempotencyKey,
        crypto.randomUUID(),
        JSON.stringify(savedPayload),
      ),
      env.DB.prepare(
        `INSERT INTO communications (
           id, event_id, operation_id, idempotency_key, kind, channel, status,
           audience_json, content_snapshot_json, recipient_count,
           created_by_person_id, created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'transactional', 'email', 'partially_failed',
                   '{}', '{}', 13, ?, unixepoch(), unixepoch())`,
      ).bind(
        communicationId,
        viewer.eventId,
        operationId,
        idempotencyKey,
        viewer.personId,
      ),
      env.DB.prepare(
        `INSERT INTO communication_deliveries (
           id, event_id, communication_id, recipient_address, source_values_json,
           channel, idempotency_key, status, failure_code, failure_message,
           created_at, updated_at
         )
         SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.address'),
                '{}', 'email', json_extract(value, '$.key'),
                json_extract(value, '$.status'),
                CASE WHEN json_extract(value, '$.status') = 'failed' THEN 'PROVIDER_ERROR' END,
                CASE WHEN json_extract(value, '$.status') = 'failed' THEN 'Try later' END,
                unixepoch(), unixepoch()
           FROM json_each(?)`,
      ).bind(viewer.eventId, communicationId, JSON.stringify(deliveries)),
      env.DB.prepare(
        `INSERT INTO operation_items (
           id, operation_id, item_key, entity_type, entity_id, status,
           error_code, error_message, completed_at, updated_at
         )
         SELECT lower(hex(randomblob(16))), ?, json_extract(value, '$.key'),
                'communication_delivery', json_extract(value, '$.id'),
                CASE WHEN json_extract(value, '$.status') = 'failed'
                     THEN 'failed' ELSE 'completed' END,
                CASE WHEN json_extract(value, '$.status') = 'failed' THEN 'PROVIDER_ERROR' END,
                CASE WHEN json_extract(value, '$.status') = 'failed' THEN 'Try later' END,
                unixepoch(), unixepoch()
           FROM json_each(?)`,
      ).bind(operationId, JSON.stringify(deliveries)),
    ]);

    const queued: unknown[] = [];
    await new OperationService({
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment).retry(viewer, operationId);

    const retriedPayload = { ...savedPayload };
    delete (retriedPayload as { includeFailed?: boolean }).includeFailed;
    expect(queued).toEqual([retriedPayload]);
    await expect(
      env.DB.prepare(
        `SELECT status, payload_json AS payloadJson, result_json AS resultJson,
                progress_completed AS completed, progress_failed AS failed
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({
      status: "queued",
      payloadJson: JSON.stringify(retriedPayload),
      resultJson: null,
      completed: 0,
      failed: 0,
    });
    await expect(
      env.DB.prepare("SELECT status FROM communications WHERE id = ?")
        .bind(communicationId)
        .first(),
    ).resolves.toEqual({ status: "queued" });
    await expect(
      env.DB.prepare(
        `SELECT status, COUNT(*) AS count FROM communication_deliveries
          WHERE communication_id = ? GROUP BY status ORDER BY status`,
      )
        .bind(communicationId)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { status: "queued", count: 12 },
        { status: "sent", count: 1 },
      ],
    });
    await expect(
      env.DB.prepare(
        `SELECT status, COUNT(*) AS count FROM operation_items
          WHERE operation_id = ? GROUP BY status ORDER BY status`,
      )
        .bind(operationId)
        .all(),
    ).resolves.toMatchObject({
      results: [
        { status: "completed", count: 1 },
        { status: "pending", count: 12 },
      ],
    });
  });

  it("does not offer Queue retry for preview-owned operation types", async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    const operationId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         last_error, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'session.bulk', ?, ?, 'failed', ?,
                 'Preview became stale', unixepoch(), unixepoch())`,
    )
      .bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `session-bulk:${operationId}`,
        crypto.randomUUID(),
        JSON.stringify({ type: "session.bulk", operationId }),
      )
      .run();
    const queued: unknown[] = [];
    const service = new OperationService({
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      },
    } as unknown as CloudflareEnvironment);

    expect(
      (await service.list(viewer)).find((item) => item.id === operationId)
        ?.retryable,
    ).toBe(false);
    await expect(service.retry(viewer, operationId)).rejects.toThrow(
      "no retryable Queue consumer",
    );
    expect(queued).toEqual([]);
  });

  it("retries only one failed Accelevents item without resending successes", async () => {
    const seeded = await seedFailedAcceleventsOperation();
    const queued: unknown[] = [];
    const service = new OperationService({
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => {
          queued.push(message);
        },
      },
    } as unknown as CloudflareEnvironment);

    await service.retryItem(viewer, seeded.operationId, seeded.failedItemId);

    expect(queued).toEqual([
      { ...seeded.payload, itemId: seeded.failedRunItemId },
    ]);
    await expect(
      env.DB.prepare(`SELECT status FROM operation_items WHERE id = ?`)
        .bind(seeded.failedItemId)
        .first(),
    ).resolves.toEqual({ status: "pending" });
    await expect(
      env.DB.prepare(`SELECT status FROM operation_items WHERE id = ?`)
        .bind(seeded.successfulItemId)
        .first(),
    ).resolves.toEqual({ status: "completed" });
    await expect(
      env.DB.prepare(`SELECT status FROM integration_run_items WHERE id = ?`)
        .bind(seeded.successfulRunItemId)
        .first(),
    ).resolves.toEqual({ status: "succeeded" });
    await expect(
      service.retryItem(viewer, seeded.operationId, seeded.failedItemId),
    ).rejects.toThrow("Only a failed Accelevents run item");
  });

  it("keeps a selected Accelevents item retryable when its Queue send is rejected", async () => {
    const seeded = await seedFailedAcceleventsOperation();
    const service = new OperationService({
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async () => {
          throw new Error("Queue rejected the selected item.");
        },
      },
    } as unknown as CloudflareEnvironment);

    await expect(
      service.retryItem(viewer, seeded.operationId, seeded.failedItemId),
    ).rejects.toMatchObject({
      name: "OperationQueueUnavailableError",
      operationId: seeded.operationId,
    });
    await expect(
      env.DB.prepare(
        `SELECT status, progress_completed AS completed,
                progress_failed AS failed
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(seeded.operationId)
        .first(),
    ).resolves.toEqual({ status: "partially_failed", completed: 1, failed: 1 });
    await expect(
      env.DB.prepare(
        `SELECT status, error_code AS errorCode
           FROM operation_items WHERE id = ?`,
      )
        .bind(seeded.failedItemId)
        .first(),
    ).resolves.toEqual({ status: "failed", errorCode: "QUEUE_UNAVAILABLE" });
    await expect(
      env.DB.prepare(
        `SELECT status, error_code AS errorCode
           FROM integration_run_items WHERE id = ?`,
      )
        .bind(seeded.failedRunItemId)
        .first(),
    ).resolves.toEqual({ status: "failed", errorCode: "QUEUE_UNAVAILABLE" });

    const queued: unknown[] = [];
    await new OperationService({
      ...(env as unknown as CloudflareEnvironment),
      OPERATIONS_QUEUE: {
        send: async (message: unknown) => queued.push(message),
      },
    } as unknown as CloudflareEnvironment).retryItem(
      viewer,
      seeded.operationId,
      seeded.failedItemId,
    );
    expect(queued).toEqual([
      { ...seeded.payload, itemId: seeded.failedRunItemId },
    ]);
  });

  it("skips one failed Accelevents item with a reason and finalises counts", async () => {
    const seeded = await seedFailedAcceleventsOperation();
    const context = new RouterContextProvider();
    context.set(cloudflareContext, {
      env: env as unknown as CloudflareEnvironment,
      ctx: {} as ExecutionContext,
    });
    const result = await operationCentreAction({
      request: new Request(
        `http://localhost/admin/operations?operation=${seeded.operationId}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            cookie: selectedEventCookie(
              env as unknown as CloudflareEnvironment,
            ),
          },
          body: new URLSearchParams({
            intent: "skip-item",
            operationId: seeded.operationId,
            itemId: seeded.failedItemId,
            reason: "The record was corrected manually in Accelevents.",
          }),
        },
      ),
      params: {},
      context,
    } as never);
    if (result instanceof Response)
      throw new Error("The skip result unexpectedly returned a Response.");
    expect(result.data).toMatchObject({ ok: true });
    await expect(
      env.DB.prepare(
        `SELECT status, progress_completed AS completed,
                progress_failed AS failed
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(seeded.operationId)
        .first(),
    ).resolves.toEqual({ status: "completed", completed: 2, failed: 0 });
    await expect(
      env.DB.prepare(
        `SELECT status, error_code AS errorCode, error_message AS errorMessage
           FROM integration_run_items WHERE id = ?`,
      )
        .bind(seeded.failedRunItemId)
        .first(),
    ).resolves.toEqual({
      status: "skipped",
      errorCode: "OPERATOR_SKIPPED",
      errorMessage: "The record was corrected manually in Accelevents.",
    });
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE action = 'integration.run.item_skipped'
            AND entity_id = ? AND event_id = ?`,
      )
        .bind(seeded.failedRunItemId, viewer.eventId)
        .first(),
    ).resolves.toEqual({ count: 1 });
  });
});
