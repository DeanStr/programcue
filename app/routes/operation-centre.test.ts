import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { currentEventCookie } from "~/platform/auth/current-event.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  action,
  loader,
  taskImportTransitionSummary,
} from "./operation-centre";

const workerEnv = env as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";
const organisationId = "org-future-events";

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function request(
  values?: Record<string, string>,
  search = "",
  identity: "administrator" | "owner" = "administrator",
) {
  const selectedEventCookie = currentEventCookie(eventId, workerEnv).split(
    ";",
    1,
  )[0];
  return new Request(`http://localhost/admin/operations${search}`, {
    method: values ? "POST" : "GET",
    headers: {
      cookie: `program_cue_demo_identity=${identity}; ${selectedEventCookie}`,
      origin: "http://localhost",
    },
    ...(values ? { body: new URLSearchParams(values) } : {}),
  });
}

async function seedProjectionRun(
  options: { leased?: boolean; executionLeased?: boolean } = {},
) {
  const existing = await workerEnv.DB.prepare(
    `SELECT id FROM integration_connections
      WHERE event_id = ? AND provider = 'airtable_repository'`,
  )
    .bind(eventId)
    .first<{ id: string }>();
  const connectionId = existing?.id ?? crypto.randomUUID();
  const runId = crypto.randomUUID();
  if (!existing)
    await workerEnv.DB.prepare(
      `INSERT INTO integration_connections (
         id, organisation_id, event_id, provider, status, direction,
         configuration_json, created_at, updated_at
       ) VALUES (?, ?, ?, 'airtable_repository', 'needs_attention',
                 'bidirectional', '{}', unixepoch(), unixepoch())`,
    )
      .bind(connectionId, organisationId, eventId)
      .run();
  await workerEnv.DB.prepare(
    `INSERT INTO integration_runs (
         id, connection_id, idempotency_key, status, direction, dry_run,
         summary_json, started_at, completed_at, created_at
       ) VALUES (?, ?, ?, 'partially_failed', 'bidirectional', 0, ?,
                 unixepoch() - 120, unixepoch(), unixepoch())`,
  )
    .bind(
      runId,
      connectionId,
      `route-recovery:${runId}`,
      JSON.stringify({
        kind: "airtable_event_projection",
        phase: "d1_committed",
        eventId,
        operation: "task.comment.add",
        beforeHash: "before-hash",
        afterHash: "after-hash",
        error: "Airtable request failed",
        ...(options.executionLeased
          ? {
              executionLease: crypto.randomUUID(),
              executionLeaseExpiresAt: Math.floor(Date.now() / 1_000) + 600,
            }
          : {}),
        ...(options.leased ? { recoveryLease: crypto.randomUUID() } : {}),
      }),
    )
    .run();
  return runId;
}

beforeEach(async () => {
  await ensureDemoData(workerEnv);
});

describe("Operation Centre Airtable recovery", () => {
  it("lists only unleased, event-scoped projection failures", async () => {
    const visibleRunId = await seedProjectionRun();
    await seedProjectionRun({ leased: true });
    await seedProjectionRun({ executionLeased: true });

    const result = await loader({
      request: request(),
      params: {},
      context: context(),
    } as never);
    expect(result.airtableRecoveries).toEqual([
      expect.objectContaining({
        runId: visibleRunId,
        status: "partially_failed",
        phase: "d1_committed",
        operation: "task.comment.add",
      }),
    ]);
  });

  it("routes exact-run recovery separately and refuses missing or leased runs", async () => {
    const leasedRunId = await seedProjectionRun({ leased: true });
    const leased = await action({
      request: request({
        intent: "recover-airtable-projection",
        operationId: leasedRunId,
      }),
      params: {},
      context: context(),
    } as never);
    if (leased instanceof Response)
      throw new Error("Airtable recovery returned a raw response.");
    expect(leased.init?.status).toBe(409);
    expect(leased.data).toMatchObject({ ok: false, operationId: leasedRunId });

    const missing = await action({
      request: request({
        intent: "recover-airtable-projection",
        operationId: "run-outside-current-event",
      }),
      params: {},
      context: context(),
    } as never);
    if (missing instanceof Response)
      throw new Error("Missing Airtable recovery returned a raw response.");
    expect(missing.init?.status).toBe(404);
    expect(missing.data).toMatchObject({ ok: false });
  });
});

describe("Operation Centre import presentation", () => {
  it("limits organisation activity to organisation-wide administrators", async () => {
    await expect(
      loader({
        request: request(
          undefined,
          "?panel=activity&activityScope=organisation",
        ),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 403 });

    const ownerResult = await loader({
      request: request(
        undefined,
        "?panel=activity&activityScope=organisation",
        "owner",
      ),
      params: {},
      context: context(),
    } as never);
    expect(ownerResult).toMatchObject({
      activityScope: "organisation",
      canViewOrganisationActivity: true,
    });
  });

  it("paginates the complete type-filtered failure history without overlap", async () => {
    const prefix = crypto.randomUUID();
    const operationType = `test.pagination.${prefix}`;
    await workerEnv.DB.prepare(
      `WITH RECURSIVE sequence(value) AS (
         VALUES (1)
         UNION ALL SELECT value + 1 FROM sequence WHERE value < 51
       )
       INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json, last_error,
         completed_at, created_at, updated_at
       )
       SELECT ? || ':' || value, ?, ?, 'person-demo-admin', ?,
              ? || ':key:' || value, ? || ':correlation:' || value,
              'failed', '{}', 'Paginated historical failure',
              value, value, value
         FROM sequence`,
    )
      .bind(prefix, organisationId, eventId, operationType, prefix, prefix)
      .run();

    const first = await loader({
      request: request(
        undefined,
        `?status=failed&type=${encodeURIComponent(operationType)}&page=1`,
      ),
      params: {},
      context: context(),
    } as never);
    const second = await loader({
      request: request(
        undefined,
        `?status=failed&type=${encodeURIComponent(operationType)}&page=2`,
      ),
      params: {},
      context: context(),
    } as never);

    expect(first.failurePagination).toEqual({
      page: 1,
      pageSize: 50,
      total: 51,
      from: 1,
      to: 50,
      hasPrevious: false,
      hasNext: true,
    });
    expect(second.failurePagination).toEqual({
      page: 2,
      pageSize: 50,
      total: 51,
      from: 51,
      to: 51,
      hasPrevious: true,
      hasNext: false,
    });
    expect(first.operations).toHaveLength(50);
    expect(second.operations).toHaveLength(1);
    const firstIds = new Set(first.operations.map(({ id }) => id));
    expect(second.operations.every(({ id }) => !firstIds.has(id))).toBe(true);

    await expect(
      loader({
        request: request(
          undefined,
          `?status=failed&type=${encodeURIComponent(operationType)}&page=3`,
        ),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      loader({
        request: request(undefined, "?status=failed&page=0"),
        params: {},
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("queries failures directly so an old alert is not hidden by recent successful work", async () => {
    const failureId = `older-failure-${crypto.randomUUID()}`;
    const fillerPrefix = crypto.randomUUID();
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json, last_error,
           completed_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'person-demo-admin', 'data.export', ?, ?,
                   'failed', '{}', 'Historical export failure', 1, 1, 1)`,
      ).bind(
        failureId,
        organisationId,
        eventId,
        `older-failure-key-${fillerPrefix}`,
        failureId,
      ),
      workerEnv.DB.prepare(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (1)
           UNION ALL SELECT value + 1 FROM sequence WHERE value < 101
         )
         INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           completed_at, created_at, updated_at
         )
         SELECT ? || ':' || value, ?, ?, 'person-demo-admin', 'data.export',
                ? || ':key:' || value, ? || ':correlation:' || value,
                'completed', '{}', unixepoch(), unixepoch(), unixepoch()
           FROM sequence`,
      ).bind(fillerPrefix, organisationId, eventId, fillerPrefix, fillerPrefix),
    ]);

    const result = await loader({
      request: request(undefined, "?status=failed&type=data.export"),
      params: {},
      context: context(),
    } as never);

    expect(result.operations).toContainEqual(
      expect.objectContaining({
        id: failureId,
        status: "failed",
        canAcknowledgeFailure: true,
      }),
    );
  });

  it("loads a directly selected operation outside the recent list window", async () => {
    const operationId = `older-import-${crypto.randomUUID()}`;
    const fillerPrefix = crypto.randomUUID();
    await workerEnv.DB.batch([
      workerEnv.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           created_at, updated_at
         ) VALUES (?, ?, ?, 'person-demo-admin', 'data.import', ?, ?,
                   'received', '{"resource":"tasks"}', 1, 1)`,
      ).bind(
        operationId,
        organisationId,
        eventId,
        `older-import-key-${fillerPrefix}`,
        operationId,
      ),
      workerEnv.DB.prepare(
        `WITH RECURSIVE sequence(value) AS (
           VALUES (1)
           UNION ALL SELECT value + 1 FROM sequence WHERE value < 101
         )
         INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           completed_at, created_at, updated_at
         )
         SELECT ? || ':' || value, ?, ?, 'person-demo-admin', 'data.export',
                ? || ':key:' || value, ? || ':correlation:' || value,
                'completed', '{}', unixepoch(), unixepoch(), unixepoch()
           FROM sequence`,
      ).bind(fillerPrefix, organisationId, eventId, fillerPrefix, fillerPrefix),
    ]);

    const result = await loader({
      request: request(
        undefined,
        `?operation=${encodeURIComponent(operationId)}`,
      ),
      params: {},
      context: context(),
    } as never);

    expect(result.operations).toEqual([
      expect.objectContaining({
        id: operationId,
        type: "data.import",
        status: "received",
      }),
    ]);
    expect(result.selectedOperation).toMatchObject({ id: operationId });
    expect(result.operationDetail).toEqual({ items: [], audit: [] });
  });

  it("exposes exact task lifecycle transitions from durable preview rows", () => {
    expect(
      taskImportTransitionSummary({
        rowNumber: 2,
        action: "update",
        values: {
          id: "task-imported",
          title: "Imported task",
          expectedStatus: "in_progress",
          status: "completed",
          statusTransition: "complete",
        },
      }),
    ).toEqual({
      taskId: "task-imported",
      title: "Imported task",
      beforeStatus: "in_progress",
      afterStatus: "completed",
      transition: "complete",
    });
    expect(
      taskImportTransitionSummary({
        values: { statusTransition: "none" },
      }),
    ).toBeNull();
  });

  it("fails fast when a durable task transition preview is malformed", () => {
    expect(() =>
      taskImportTransitionSummary({
        values: {
          id: "task-imported",
          title: "Imported task",
          expectedStatus: "in_progress",
          status: "completed",
          statusTransition: "invented",
        },
      }),
    ).toThrow("invalid lifecycle transition");
  });
});
