import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { reconcileInterruptedAiOperations } from "./ai-operation-lease.server";

const organisationId = "org-future-events";
const eventId = "evt-foe-2025";
const personId = "person-demo-admin";

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
});

describe("AI operation leases", () => {
  it("atomically fails and audits expired synchronous AI claims without retrying them", async () => {
    const expired = [
      [crypto.randomUUID(), "ai.assistant.run"],
      [crypto.randomUUID(), "ai.context.run"],
      [crypto.randomUUID(), "ai.proposal.revision"],
    ] as const;
    const activeId = crypto.randomUUID();
    const unrelatedId = crypto.randomUUID();
    for (const [operationId, type] of [
      ...expired,
      [activeId, "ai.context.run"],
      [unrelatedId, "webhook.deliver"],
    ] as const) {
      await env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total, progress_completed, progress_failed, attempt_count,
           cancellable, claim_token, claim_expires_at, started_at, created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'running', '{}', 1, 0, 0, 1, 0,
                   ?, unixepoch() + ?, unixepoch(), unixepoch(), unixepoch())`,
      )
        .bind(
          operationId,
          organisationId,
          eventId,
          personId,
          type,
          `test-ai-operation:${operationId}`,
          operationId,
          `claim-${operationId}`,
          operationId === activeId ? 60 : -1,
        )
        .run();
    }

    await expect(
      reconcileInterruptedAiOperations(env as unknown as CloudflareEnvironment),
    ).resolves.toBe(3);
    await expect(
      reconcileInterruptedAiOperations(env as unknown as CloudflareEnvironment),
    ).resolves.toBe(0);

    for (const [operationId] of expired) {
      const operation = await env.DB.prepare(
        `SELECT status, progress_failed AS progressFailed,
                claim_token AS claimToken,
                claim_expires_at AS claimExpiresAt,
                json_extract(result_json, '$.errorType') AS errorType,
                json_extract(result_json, '$.retrySafe') AS retrySafe
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first();
      expect(operation).toEqual({
        status: "failed",
        progressFailed: 1,
        claimToken: null,
        claimExpiresAt: null,
        errorType: "InterruptedAiOperation",
        retrySafe: 0,
      });
      expect(
        await env.DB.prepare(
          `SELECT COUNT(*) AS count FROM audit_events
            WHERE correlation_id = ? AND action = 'assistant.interrupted'
              AND entity_type = 'operation' AND entity_id = ?`,
        )
          .bind(operationId, operationId)
          .first(),
      ).toEqual({ count: 1 });
    }
    for (const operationId of [activeId, unrelatedId]) {
      expect(
        await env.DB.prepare(
          `SELECT status, claim_token AS claimToken
             FROM operation_jobs WHERE id = ?`,
        )
          .bind(operationId)
          .first(),
      ).toEqual({ status: "running", claimToken: `claim-${operationId}` });
    }
  });

  it("leaves an expired claim untouched when interruption evidence cannot commit", async () => {
    const operationId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed, attempt_count,
         cancellable, claim_token, claim_expires_at, started_at, created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, 'ai.context.run', ?, ?, 'running', '{}',
                 1, 0, 0, 1, 0, ?, unixepoch() - 1,
                 unixepoch(), unixepoch(), unixepoch())`,
    )
      .bind(
        operationId,
        organisationId,
        eventId,
        personId,
        `test-ai-operation:${operationId}`,
        operationId,
        `claim-${operationId}`,
      )
      .run();
    await env.DB.prepare(
      `CREATE TRIGGER reject_ai_interruption_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action = 'assistant.interrupted'
       BEGIN
         SELECT RAISE(ABORT, 'AI interruption audit rejected by test');
       END`,
    ).run();
    try {
      await expect(
        reconcileInterruptedAiOperations(
          env as unknown as CloudflareEnvironment,
        ),
      ).rejects.toThrow("AI interruption audit rejected by test");
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_ai_interruption_audit").run();
    }

    expect(
      await env.DB.prepare(
        `SELECT status, claim_token AS claimToken,
                claim_expires_at IS NOT NULL AS hasClaimExpiry
           FROM operation_jobs WHERE id = ?`,
      )
        .bind(operationId)
        .first(),
    ).toEqual({
      status: "running",
      claimToken: `claim-${operationId}`,
      hasClaimExpiry: 1,
    });
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE correlation_id = ? AND action = 'assistant.interrupted'`,
      )
        .bind(operationId)
        .first(),
    ).toEqual({ count: 0 });
  });
});
