import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  currentEventCookie,
  loadCurrentEventAdminShellContext,
} from "~/platform/auth/current-event.server";
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

describe("non-actionable operation failure alerts", () => {
  it("acknowledges and archives a terminal failure without changing its recorded outcome", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const operationId = `ai-context-failure-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         result_json, progress_total, progress_failed, last_error, cancellable,
         completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'ai.context.run', ?, ?, 'failed', ?, ?, 1, 1, ?, 0,
                 unixepoch(), unixepoch(), unixepoch())`,
    )
      .bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `ai-context-failure:${operationId}`,
        operationId,
        JSON.stringify({ runId: operationId }),
        JSON.stringify({ errorType: "HistoricalContextFailure" }),
        "The AI context run failed before the bug was corrected.",
      )
      .run();

    const before = await loadCurrentEventAdminShellContext(testEnv, viewer, [
      "administrator",
    ]);
    const listedBefore = await new OperationService(testEnv).find(
      viewer,
      operationId,
    );
    expect(listedBefore).toMatchObject({
      status: "failed",
      retryable: false,
      cancellable: false,
      alertAcknowledgedAt: null,
      canAcknowledgeFailure: true,
    });

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
        body: new URLSearchParams({
          intent: "acknowledge-failure",
          operationId,
        }),
      }),
      params: {},
      context,
    } as never);
    if (result instanceof Response)
      throw new Error("The acknowledgement returned a raw response.");
    expect(result.init?.status).toBe(207);
    expect(result.data).toMatchObject({
      ok: false,
      committed: true,
      operationId,
      message:
        "Your change was saved, but other open views could not be updated automatically. Refresh them before continuing.",
    });

    const persisted = await testEnv.DB.prepare(
      `SELECT status, last_error AS lastError, result_json AS resultJson,
              alert_acknowledged_at AS alertAcknowledgedAt,
              alert_acknowledged_by_person_id AS alertAcknowledgedByPersonId
         FROM operation_jobs WHERE id = ?`,
    )
      .bind(operationId)
      .first<{
        status: string;
        lastError: string | null;
        resultJson: string | null;
        alertAcknowledgedAt: number | null;
        alertAcknowledgedByPersonId: string | null;
      }>();
    expect(persisted).toMatchObject({
      status: "failed",
      lastError: "The AI context run failed before the bug was corrected.",
      resultJson: JSON.stringify({ errorType: "HistoricalContextFailure" }),
      alertAcknowledgedAt: expect.any(Number),
      alertAcknowledgedByPersonId: viewer.personId,
    });
    await expect(
      testEnv.DB.prepare(
        `UPDATE operation_jobs
            SET alert_acknowledged_by_person_id = NULL
          WHERE id = ?`,
      )
        .bind(operationId)
        .run(),
    ).rejects.toThrow(
      "operation failure acknowledgement requires timestamp and actor",
    );
    await expect(
      testEnv.DB.prepare(
        `UPDATE operation_jobs
            SET alert_acknowledged_at = NULL
          WHERE id = ?`,
      )
        .bind(operationId)
        .run(),
    ).rejects.toThrow(
      "operation failure acknowledgement requires timestamp and actor",
    );
    await expect(
      testEnv.DB.prepare(
        `SELECT action, actor_person_id AS actorPersonId,
                json_extract(metadata_json, '$.type') AS operationType,
                json_extract(metadata_json, '$.status') AS operationStatus
           FROM audit_events
          WHERE entity_type = 'operation' AND entity_id = ?
            AND action = 'operation.failure_acknowledged'`,
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({
      action: "operation.failure_acknowledged",
      actorPersonId: viewer.personId,
      operationType: "ai.context.run",
      operationStatus: "failed",
    });
    await expect(
      testEnv.DB.prepare(
        `SELECT entity_type AS entityType, entity_id AS entityId,
                change_type AS changeType, correlation_id AS correlationId
           FROM event_changes
          WHERE entity_type = 'operation' AND entity_id = ?
          ORDER BY sequence DESC
          LIMIT 1`,
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({
      entityType: "operation",
      entityId: operationId,
      changeType: "updated",
      correlationId: operationId,
    });

    const listedAfter = await new OperationService(testEnv).find(
      viewer,
      operationId,
    );
    expect(listedAfter).toMatchObject({
      status: "failed",
      alertAcknowledgedAt: expect.any(Number),
      alertAcknowledgedByName: expect.any(String),
      canAcknowledgeFailure: false,
    });
    const blankActorId = `person-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO people (id, email, display_name, email_verified)
       VALUES (?, ?, '', 1)`,
    )
      .bind(blankActorId, `${blankActorId}@example.test`)
      .run();
    await testEnv.DB.prepare(
      `UPDATE operation_jobs
          SET alert_acknowledged_by_person_id = ?
        WHERE id = ?`,
    )
      .bind(blankActorId, operationId)
      .run();
    await expect(
      new OperationService(testEnv).find(viewer, operationId),
    ).rejects.toThrow(
      `Operation ${operationId} has inconsistent failure acknowledgement attribution.`,
    );
    await testEnv.DB.prepare(
      `UPDATE operation_jobs
          SET alert_acknowledged_by_person_id = ?
        WHERE id = ?`,
    )
      .bind(viewer.personId, operationId)
      .run();
    const after = await loadCurrentEventAdminShellContext(testEnv, viewer, [
      "administrator",
    ]);
    expect(after.notificationCounts.failedOperations).toBe(
      before.notificationCounts.failedOperations - 1,
    );
    await expect(
      new OperationService(testEnv).acknowledgeFailure(viewer, operationId),
    ).rejects.toThrow("already been acknowledged");
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE entity_type = 'operation' AND entity_id = ?
            AND action = 'operation.failure_acknowledged'`,
      )
        .bind(operationId)
        .first(),
    ).resolves.toEqual({ count: 1 });
  });

  it("applies acknowledgement to non-AI terminal operation types by capability", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const operationId = `data-export-failure-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json, last_error,
         cancellable, completed_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'data.export', ?, ?, 'failed', '{}', ?, 0,
                 unixepoch(), unixepoch(), unixepoch())`,
    )
      .bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `data-export-failure:${operationId}`,
        operationId,
        "The historical export cannot be resumed.",
      )
      .run();

    const service = new OperationService(testEnv);
    await expect(service.find(viewer, operationId)).resolves.toMatchObject({
      type: "data.export",
      retryable: false,
      cancellable: false,
      canAcknowledgeFailure: true,
    });
    await expect(
      service.acknowledgeFailure(viewer, operationId),
    ).resolves.toMatchObject({ changeSequence: expect.any(Number) });
    await expect(service.find(viewer, operationId)).resolves.toMatchObject({
      status: "failed",
      lastError: "The historical export cannot be resumed.",
      alertAcknowledgedAt: expect.any(Number),
      canAcknowledgeFailure: false,
    });
  });

  it("refuses acknowledgement while a safe retry or cancel action exists", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const retryableId = `retryable-failure-${crypto.randomUUID()}`;
    const cancellableId = `cancellable-failure-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, cancellable,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'webhook.deliver', ?, ?, 'failed', '{}', 0,
                   unixepoch(), unixepoch())`,
      ).bind(
        retryableId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `retryable-failure:${retryableId}`,
        retryableId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, cancellable,
           created_at, updated_at
         ) VALUES (?, ?, ?, ?, 'communication.send', ?, ?, 'failed', '{}', 1,
                   unixepoch(), unixepoch())`,
      ).bind(
        cancellableId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `cancellable-failure:${cancellableId}`,
        cancellableId,
      ),
    ]);

    const service = new OperationService(testEnv);
    await expect(
      service.acknowledgeFailure(
        { ...viewer, organisationId: "another-organisation" },
        retryableId,
      ),
    ).rejects.toThrow("Operation not found");
    await expect(
      service.acknowledgeFailure(viewer, retryableId),
    ).rejects.toThrow("no retry or cancel action in the Operation Centre");
    await expect(
      service.acknowledgeFailure(viewer, cancellableId),
    ).rejects.toThrow("no retry or cancel action in the Operation Centre");
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count FROM operation_jobs
          WHERE id IN (?, ?) AND alert_acknowledged_at IS NOT NULL`,
      )
        .bind(retryableId, cancellableId)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });
});
