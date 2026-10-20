import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { ParticipantRetentionService } from "~/modules/privacy/participant-retention-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  runDemonstrationReadinessScenario,
  seedReadinessAcceptanceEvent,
} from "~/platform/demo/assistant-readiness-fixture.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  cancelAiOperationLease,
  failAiOperationLease,
  reconcileInterruptedAiOperations,
  startAiOperationLease,
} from "./ai-operation-lease.server";
import { listAssistantRunReports } from "./ai-run-report.server";

const runtime = env as unknown as CloudflareEnvironment;
const organiser: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

beforeEach(async () => {
  await ensureDemoData(runtime);
});

describe("stored assistant report validation", () => {
  it("keeps a migrated historical operation out of retained reports without hiding current runs", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "no_blockers",
    );
    expect(fixture.error).toBeNull();
    const historicalRunId = crypto.randomUUID();
    await env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json, result_json
       ) VALUES (?, ?, ?, ?, 'ai.assistant.run', ?, ?, 'completed', ?, ?)`,
    )
      .bind(
        historicalRunId,
        fixture.viewer.organisationId,
        fixture.eventId,
        fixture.viewer.personId,
        historicalRunId,
        historicalRunId,
        JSON.stringify({
          runId: historicalRunId,
          provider: "OpenAI",
          model: "previous-model",
          instructionHash: "previous-instruction-hash",
          reportUnavailableReason: "predates_retained_reports",
        }),
        JSON.stringify({
          provider: "OpenAI",
          model: "previous-model",
          evidenceCount: 0,
          proposalIds: [],
        }),
      )
      .run();
    const reports = await listAssistantRunReports(runtime, fixture.viewer);
    expect(reports.map((report) => report.runId)).toEqual([
      fixture.result?.runId,
    ]);
    expect(reports[0].outcome).toBe("Answered");
  });

  it("omits reports deliberately redacted by completed participant retention", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      { ...organiser, personId: "person-demo-owner", role: "owner" },
      "no_blockers",
    );
    expect(fixture.error).toBeNull();
    expect(fixture.reports).toHaveLength(1);
    await env.DB.prepare(
      `UPDATE events SET starts_at = unixepoch('2020-01-01'),
                         ends_at = unixepoch('2020-01-02'), retention_months = 12
        WHERE id = ?`,
    )
      .bind(fixture.eventId)
      .run();
    const retention = await new ParticipantRetentionService(
      runtime,
    ).anonymiseExpiredParticipants(fixture.viewer, {
      confirmation: "Assistant acceptance event",
      acknowledged: true,
    });
    expect(retention.complete).toBe(true);
    expect(await listAssistantRunReports(runtime, fixture.viewer)).toEqual([]);
  });

  it("rejects redacted report data without completed participant retention", async () => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "no_blockers",
    );
    expect(fixture.error).toBeNull();
    await env.DB.prepare(
      `UPDATE operation_jobs SET payload_json = ? WHERE id = ? AND event_id = ?`,
    )
      .bind(
        JSON.stringify({
          redacted: true,
          reason: "event_retention_period_elapsed",
        }),
        fixture.result?.runId,
        fixture.eventId,
      )
      .run();
    await expect(
      listAssistantRunReports(runtime, fixture.viewer),
    ).rejects.toThrow("contains invalid stored report data");
  });

  it.each([
    [
      "missing request label",
      "payload_json = json_remove(payload_json, '$.requestLabel')",
    ],
    [
      "invalid request label",
      "payload_json = json_set(payload_json, '$.requestLabel', 7)",
    ],
    [
      "missing provider",
      "payload_json = json_remove(payload_json, '$.provider')",
    ],
    ["invalid model", "payload_json = json_set(payload_json, '$.model', 7)"],
    ["missing result", "result_json = NULL"],
    ["missing answer", "result_json = json_remove(result_json, '$.answer')"],
    ["empty answer", "result_json = json_set(result_json, '$.answer', '')"],
    [
      "missing evidence",
      "result_json = json_remove(result_json, '$.evidence')",
    ],
    [
      "invalid evidence",
      "result_json = json_set(result_json, '$.evidence', 'unavailable')",
    ],
    [
      "missing measurements",
      "result_json = json_remove(result_json, '$.measurements')",
    ],
    [
      "invalid measurements",
      "result_json = json_set(result_json, '$.measurements.totals.inputTokens', 'unknown')",
    ],
    [
      "missing returned model",
      "result_json = json_remove(result_json, '$.model')",
    ],
  ])("rejects a completed run with %s", async (_label, mutation) => {
    const fixture = await runDemonstrationReadinessScenario(
      runtime,
      organiser,
      "no_blockers",
    );
    expect(fixture.error).toBeNull();
    expect(fixture.reports[0].outcome).toBe("Answered");
    await env.DB.prepare(
      `UPDATE operation_jobs SET ${mutation} WHERE id = ? AND event_id = ?`,
    )
      .bind(fixture.result?.runId, fixture.eventId)
      .run();
    await expect(
      listAssistantRunReports(runtime, fixture.viewer),
    ).rejects.toThrow(
      `Assistant run ${fixture.result?.runId} contains invalid stored report data.`,
    );
  });

  it.each(["running", "failed", "cancelled", "interrupted"] as const)(
    "retains a valid %s run without inventing a final result",
    async (state) => {
      const { viewer } = await seedReadinessAcceptanceEvent(
        runtime,
        organiser,
        "no_blockers",
      );
      const runId = crypto.randomUUID();
      const requestLabel = "Inspect event readiness";
      const lease = await startAiOperationLease(runtime, viewer, {
        id: runId,
        type: "ai.assistant.run",
        payload: { runId, provider: "OpenAI", model: "fixture", requestLabel },
        audit: {
          actorKind: "person",
          action: "assistant.requested",
          entityType: "assistant_run",
          entityId: runId,
          correlationId: runId,
          metadata: { operationId: runId },
        },
      });
      const error = {
        errorType: "TestFailure",
        message: "Explicit test failure",
      };
      const audit = {
        actorKind: "agent" as const,
        action: "assistant.failed",
        entityType: "assistant_run",
        entityId: runId,
        correlationId: runId,
        metadata: error,
      };
      if (state === "failed")
        await failAiOperationLease(runtime, viewer, lease, error, audit);
      if (state === "cancelled")
        await cancelAiOperationLease(runtime, viewer, lease, error, audit);
      if (state === "interrupted") {
        await env.DB.prepare(
          "UPDATE operation_jobs SET claim_expires_at = 0 WHERE id = ?",
        )
          .bind(runId)
          .run();
        await reconcileInterruptedAiOperations(runtime);
      }
      const [report] = await listAssistantRunReports(runtime, viewer);
      expect(report).toMatchObject({
        runId,
        requestLabel,
        status: state === "interrupted" ? "failed" : state,
        answer: null,
        evidence: [],
        provider: "OpenAI",
        model: "fixture",
      });
      expect(report.measurements).toBeUndefined();
      expect(report.outcome).not.toBe("Answered");
    },
  );
});
