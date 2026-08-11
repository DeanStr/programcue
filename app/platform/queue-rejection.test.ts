import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";
import { rejectUnsupportedQueueMessage } from "../../workers/index";
import {
  handleProgramCueQueueMessage,
  PROGRAM_CUE_QUEUE_MAX_ATTEMPTS,
} from "../../workers/communications-queue";

function failNextPrepare(environment: CloudflareEnvironment) {
  let pending = true;
  const database = new Proxy(environment.DB, {
    get(target, property) {
      if (property === "prepare") {
        return (query: string) => {
          if (pending) {
            pending = false;
            throw new Error("Transient D1 read failure");
          }
          return target.prepare(query);
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { ...environment, DB: database } as CloudflareEnvironment;
}

describe("unsupported Queue messages", () => {
  it("keeps a pre-claim infrastructure failure retryable until the final delivery", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const createOperation = async () => {
      const operationId = crypto.randomUUID();
      const body = {
        type: "integration.accelevents.export" as const,
        operationId,
        runId: crypto.randomUUID(),
        connectionId: crypto.randomUUID(),
        connectionRevision: 1,
        organisationId: "org-future-events",
        eventId: "evt-foe-2025",
      };
      await env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total
         ) VALUES (?, ?, ?, 'person-demo-admin', ?, ?, ?, 'queued', ?, 1)`,
      )
        .bind(
          operationId,
          body.organisationId,
          body.eventId,
          body.type,
          `queue-retry:${operationId}`,
          operationId,
          JSON.stringify(body),
        )
        .run();
      return body;
    };

    const retryable = await createOperation();
    const retry = vi.fn();
    const ack = vi.fn();
    await handleProgramCueQueueMessage(
      {
        id: "pre-claim-retryable",
        timestamp: new Date(),
        attempts: 1,
        body: retryable,
        retry,
        ack,
      } satisfies Message,
      failNextPrepare(testEnv),
    );
    expect(retry).toHaveBeenCalledOnce();
    expect(ack).not.toHaveBeenCalled();
    await expect(
      env.DB.prepare(
        `SELECT status, attempt_count AS attemptCount,
                completed_at AS completedAt
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(retryable.operationId)
        .first(),
    ).resolves.toEqual({
      status: "retrying",
      attemptCount: 1,
      completedAt: null,
    });

    const exhausted = await createOperation();
    const exhaustedRetry = vi.fn();
    await handleProgramCueQueueMessage(
      {
        id: "pre-claim-exhausted",
        timestamp: new Date(),
        attempts: PROGRAM_CUE_QUEUE_MAX_ATTEMPTS,
        body: exhausted,
        retry: exhaustedRetry,
        ack: vi.fn(),
      } satisfies Message,
      failNextPrepare(testEnv),
    );
    expect(exhaustedRetry).toHaveBeenCalledOnce();
    await expect(
      env.DB.prepare(
        `SELECT status, progress_failed AS progressFailed,
                completed_at IS NOT NULL AS completed
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(exhausted.operationId)
        .first(),
    ).resolves.toEqual({
      status: "failed",
      progressFailed: 1,
      completed: 1,
    });
  });

  it("only fails the exact eligible durable operation identity", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const operationId = crypto.randomUUID();
    const idempotencyKey = `unknown-operation-${crypto.randomUUID()}`;
    await env.DB.prepare(
      `
      INSERT INTO operation_jobs (
        id, organisation_id, event_id, requested_by_person_id, type,
        idempotency_key, correlation_id, status, payload_json
      ) VALUES (?, 'org-future-events', 'evt-foe-2025', 'person-demo-admin',
                'future.unsupported', ?, ?, 'queued', '{}')
    `,
    )
      .bind(operationId, idempotencyKey, crypto.randomUUID())
      .run();
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const mismatchedAck = vi.fn();
    await rejectUnsupportedQueueMessage(
      {
        body: {
          type: "future.unsupported",
          operationId,
          eventId: "evt-foe-2025",
          organisationId: "org-future-events",
          idempotencyKey: "different-idempotency-key",
        },
        ack: mismatchedAck,
      } as unknown as Message,
      testEnv,
    );
    expect(mismatchedAck).toHaveBeenCalledOnce();
    expect(JSON.parse(String(warning.mock.calls[0]?.[0]))).toMatchObject({
      sourceRevision: "test-revision",
      subsystem: "queue",
      event: "unsupported-operation-unmatched",
      eventId: "evt-foe-2025",
      operationId,
    });
    expect(
      await env.DB.prepare(
        `
      SELECT status FROM operation_jobs WHERE id = ?
    `,
      )
        .bind(operationId)
        .first(),
    ).toEqual({ status: "queued" });

    const matchingAck = vi.fn();
    await rejectUnsupportedQueueMessage(
      {
        body: {
          type: "future.unsupported",
          operationId,
          eventId: "evt-foe-2025",
          organisationId: "org-future-events",
          idempotencyKey,
        },
        ack: matchingAck,
      } as unknown as Message,
      testEnv,
    );

    expect(matchingAck).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        `
      SELECT status, progress_total AS progressTotal,
             progress_failed AS progressFailed, last_error AS lastError
        FROM operation_jobs WHERE id = ?
    `,
      )
        .bind(operationId)
        .first(),
    ).toMatchObject({
      status: "failed",
      progressTotal: 1,
      progressFailed: 1,
      lastError:
        "No queue consumer is registered for operation type future.unsupported.",
    });
    expect(
      await env.DB.prepare(
        `
      SELECT COUNT(*) AS count FROM audit_events
       WHERE event_id = 'evt-foe-2025' AND entity_id = ?
         AND action = 'operation.unsupported'
    `,
      )
        .bind(operationId)
        .first(),
    ).toEqual({ count: 1 });

    const replayAck = vi.fn();
    await rejectUnsupportedQueueMessage(
      {
        body: {
          type: "future.unsupported",
          operationId,
          eventId: "evt-foe-2025",
          organisationId: "org-future-events",
          idempotencyKey,
        },
        ack: replayAck,
      } as unknown as Message,
      testEnv,
    );

    expect(replayAck).toHaveBeenCalledOnce();
    expect(
      await env.DB.prepare(
        `
      SELECT status, attempt_count AS attemptCount FROM operation_jobs WHERE id = ?
    `,
      )
        .bind(operationId)
        .first(),
    ).toEqual({ status: "failed", attemptCount: 0 });
    expect(
      await env.DB.prepare(
        `
      SELECT COUNT(*) AS count FROM audit_events
       WHERE event_id = 'evt-foe-2025' AND entity_id = ?
         AND action = 'operation.unsupported'
    `,
      )
        .bind(operationId)
        .first(),
    ).toEqual({ count: 1 });
  });
});
