import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  AiFeedbackService,
  AiFeedbackTargetError,
} from "./ai-feedback-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
});

async function insertOperation(
  type = "ai.context.run",
  requestedByPersonId = admin.personId,
) {
  const operationId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO operation_jobs (
       id, organisation_id, event_id, requested_by_person_id, type,
       idempotency_key, correlation_id, status, payload_json, result_json,
       progress_total, progress_completed, progress_failed, cancellable,
       created_at, updated_at, completed_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, 'completed', '{}', '{}', 1, 1, 0, 0,
               unixepoch(), unixepoch(), unixepoch())`,
  )
    .bind(
      operationId,
      admin.organisationId,
      admin.eventId,
      requestedByPersonId,
      type,
      `feedback-test:${crypto.randomUUID()}`,
      crypto.randomUUID(),
    )
    .run();
  return operationId;
}

describe("AI operation feedback", () => {
  it("records focused feedback and allows the same operator to update it", async () => {
    const operationId = await insertOperation();
    const service = new AiFeedbackService(
      env as unknown as CloudflareEnvironment,
    );
    await service.save(admin, {
      operationId,
      rating: "not_helpful",
      reason: "unsafe",
      detail: "The recommendation disclosed a private field.",
    });
    await service.save(admin, {
      operationId,
      rating: "helpful",
      reason: null,
      detail: null,
    });

    expect(
      await env.DB.prepare(
        `SELECT rating, reason, detail FROM ai_operation_feedback
          WHERE operation_id = ? AND person_id = ?`,
      )
        .bind(operationId, admin.personId)
        .first(),
    ).toEqual({ rating: "helpful", reason: null, detail: null });
    const audits = await env.DB.prepare(
      `SELECT metadata_json AS metadataJson FROM audit_events
        WHERE event_id = ? AND action = 'assistant.feedback.recorded'
          AND entity_id = ?`,
    )
      .bind(admin.eventId, operationId)
      .all<{ metadataJson: string }>();
    expect(audits.results).toHaveLength(2);
    expect(
      audits.results.map((row) => row.metadataJson).join(" "),
    ).not.toContain("private field");
  });

  it("rejects another person's operation and non-AI targets", async () => {
    const service = new AiFeedbackService(
      env as unknown as CloudflareEnvironment,
    );
    const anotherPersonsOperation = await insertOperation(
      "ai.context.run",
      "person-demo-owner",
    );
    const nonAiOperation = await insertOperation("schedule.calendar_fanout");
    const crossEventOperation = await insertOperation();
    for (const operationId of [anotherPersonsOperation, nonAiOperation]) {
      await expect(
        service.save(admin, {
          operationId,
          rating: "helpful",
          reason: null,
          detail: null,
        }),
      ).rejects.toBeInstanceOf(AiFeedbackTargetError);
    }
    await expect(
      service.save(
        { ...admin, eventId: "event-outside-current-scope" },
        {
          operationId: crossEventOperation,
          rating: "helpful",
          reason: null,
          detail: null,
        },
      ),
    ).rejects.toBeInstanceOf(AiFeedbackTargetError);
    expect(
      await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM ai_operation_feedback
          WHERE operation_id IN (?, ?, ?)`,
      )
        .bind(anotherPersonsOperation, nonAiOperation, crossEventOperation)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("requires a focused reason for negative feedback", async () => {
    const operationId = await insertOperation();
    await expect(
      new AiFeedbackService(env as unknown as CloudflareEnvironment).save(
        admin,
        {
          operationId,
          rating: "not_helpful",
          reason: null,
          detail: null,
        },
      ),
    ).rejects.toThrow(/choose what was wrong/i);
  });
});
