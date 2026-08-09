import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";
import { rejectUnsupportedQueueMessage } from "../../workers/index";

describe("unsupported Queue messages", () => {
  it("only fails the exact eligible durable operation identity", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const operationId = crypto.randomUUID();
    const idempotencyKey = `unknown-operation-${crypto.randomUUID()}`;
    await env.DB.prepare(`
      INSERT INTO operation_jobs (
        id, organisation_id, event_id, requested_by_person_id, type,
        idempotency_key, correlation_id, status, payload_json
      ) VALUES (?, 'org-future-events', 'evt-foe-2025', 'person-demo-admin',
                'future.unsupported', ?, ?, 'queued', '{}')
    `).bind(operationId, idempotencyKey, crypto.randomUUID()).run();
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    const mismatchedAck = vi.fn();
    await rejectUnsupportedQueueMessage({
      body: {
        type: "future.unsupported",
        operationId,
        eventId: "evt-foe-2025",
        organisationId: "org-future-events",
        idempotencyKey: "different-idempotency-key",
      },
      ack: mismatchedAck,
    } as unknown as Message, testEnv);
    expect(mismatchedAck).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`
      SELECT status FROM operation_jobs WHERE id = ?
    `).bind(operationId).first()).toEqual({ status: "queued" });

    const matchingAck = vi.fn();
    await rejectUnsupportedQueueMessage({
      body: {
        type: "future.unsupported",
        operationId,
        eventId: "evt-foe-2025",
        organisationId: "org-future-events",
        idempotencyKey,
      },
      ack: matchingAck,
    } as unknown as Message, testEnv);

    expect(matchingAck).toHaveBeenCalledOnce();
    expect(await env.DB.prepare(`
      SELECT status, progress_total AS progressTotal,
             progress_failed AS progressFailed, last_error AS lastError
        FROM operation_jobs WHERE id = ?
    `).bind(operationId).first()).toMatchObject({
      status: "failed",
      progressTotal: 1,
      progressFailed: 1,
      lastError: "No queue consumer is registered for operation type future.unsupported.",
    });
    expect(await env.DB.prepare(`
      SELECT COUNT(*) AS count FROM audit_events
       WHERE event_id = 'evt-foe-2025' AND entity_id = ?
         AND action = 'operation.unsupported'
    `).bind(operationId).first()).toEqual({ count: 1 });
  });
});
