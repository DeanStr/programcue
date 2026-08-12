import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { ReadinessService } from "./readiness-service.server";

const viewer: Viewer = {
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

describe("D1-backed command centre", () => {
  it("derives getting-started completion from authoritative event records", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await testEnv.DB.prepare(
      "UPDATE events SET description = NULL WHERE id = ?",
    )
      .bind(viewer.eventId)
      .run();

    const incomplete = await new ReadinessService(testEnv).getCommandCentre(
      viewer,
    );
    expect(incomplete.setupGuide.map((step) => step.key)).toEqual([
      "event-details",
      "application-form",
      "review-plan",
      "participant-tasks",
      "communications",
      "publication",
    ]);
    expect(
      incomplete.setupGuide.find((step) => step.key === "event-details"),
    ).toMatchObject({ complete: false, href: "/admin/event" });

    await testEnv.DB.prepare(
      "UPDATE events SET description = 'A configured event.' WHERE id = ?",
    )
      .bind(viewer.eventId)
      .run();
    const completed = await new ReadinessService(testEnv).getCommandCentre(
      viewer,
    );
    expect(
      completed.setupGuide.find((step) => step.key === "event-details"),
    ).toMatchObject({ complete: true });
  });

  it("fails closed before calculating readiness from an unreadable Airtable projection", async () => {
    const unavailable = new Error("Airtable projection is unavailable.");
    const assertReadable = vi.fn(async () => {
      throw unavailable;
    });
    const service = new ReadinessService(
      env as unknown as CloudflareEnvironment,
      {
        airtable: { assertReadable } as unknown as AirtableProviderBoundary,
      },
    );

    await expect(service.getCommandCentre(viewer)).rejects.toBe(unavailable);
    expect(assertReadable).toHaveBeenCalledWith(viewer);
  });

  it("derives workflow scores and exact blockers from event records", async () => {
    await env.DB.batch([
      env.DB.prepare(
        `
        INSERT INTO task_instances (
          id, event_id, target_type, target_id, title, task_type, impact,
          status, readiness_state, readiness_percent, due_at, created_at, updated_at
        ) VALUES (
          'readiness-task-overdue', ?, 'speaker', 'person-demo-speaker',
          'Upload slides', 'file_upload', 'critical', 'overdue', 'overdue', 0,
          unixepoch() - 60, unixepoch(), unixepoch()
        )
      `,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `
        INSERT INTO submissions (
          id, event_id, public_reference, title, status, answers_json,
          submitted_snapshot_json, revision, submitted_at, created_at, updated_at
        ) VALUES (
          'readiness-submission', ?, 'PC-READINESS', 'Unassigned proposal',
          'submitted', '{}', '{"formVersionId":"readiness-form-version","versionNumber":1,"schema":{"introduction":"","fields":[]},"answers":{},"speakers":[{"name":"Readiness Speaker","email":"readiness@example.com"}]}',
          1, unixepoch(), unixepoch(), unixepoch()
        )
      `,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `
        INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, status, visibility, revision, created_at, updated_at
        ) VALUES ('readiness-session', ?, 'Accepted but unscheduled', 'accepted-unscheduled', 'presentation', 45, 'unscheduled', 'public', 1, unixepoch(), unixepoch())
      `,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `
        INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, created_at)
        VALUES (?, 'task', 'readiness-task-overdue', 'updated', unixepoch())
      `,
      ).bind(viewer.eventId),
    ]);

    const snapshot = await new ReadinessService(
      env as unknown as CloudflareEnvironment,
    ).getCommandCentre(viewer);
    expect(snapshot.eventTimezone).toBe("America/Toronto");
    expect(snapshot.readiness.percentage).toBeLessThan(100);
    expect(snapshot.readiness.declaredBlockers).toBeGreaterThan(0);
    expect(snapshot.blockers.map((blocker) => blocker.key)).toEqual(
      expect.arrayContaining([
        "overdue_tasks",
        "critical_tasks",
        "speaker_assets",
        "unassigned_reviews",
        "unscheduled_sessions",
      ]),
    );
    expect(
      snapshot.workflows.find((workflow) => workflow.key === "speakers")?.score,
    ).toBe(0);
    expect(snapshot.cursor).toBeGreaterThan(0);
  });

  it("keeps mutations committed during snapshot reads newer than its cursor", async () => {
    const baseEnv = env as unknown as CloudflareEnvironment;
    let injected = false;
    const racingDb = new Proxy(baseEnv.DB, {
      get(target, property) {
        if (property !== "prepare") {
          const value = Reflect.get(target, property);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes("FROM task_instances")) return statement;
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              if (statementProperty !== "bind") {
                const value = Reflect.get(statementTarget, statementProperty);
                return typeof value === "function"
                  ? value.bind(statementTarget)
                  : value;
              }
              return (...values: unknown[]) => {
                const bound = statementTarget.bind(...values);
                return new Proxy(bound, {
                  get(boundTarget, boundProperty) {
                    if (boundProperty !== "all") {
                      const value = Reflect.get(boundTarget, boundProperty);
                      return typeof value === "function"
                        ? value.bind(boundTarget)
                        : value;
                    }
                    return async () => {
                      if (!injected) {
                        injected = true;
                        await target
                          .prepare(
                            `INSERT INTO event_changes (
                              event_id, entity_type, entity_id, change_type, created_at
                            ) VALUES (?, 'task', 'snapshot-race', 'updated', unixepoch())`,
                          )
                          .bind(viewer.eventId)
                          .run();
                      }
                      return boundTarget.all();
                    };
                  },
                });
              };
            },
          });
        };
      },
    });
    const racingEnv = new Proxy(baseEnv, {
      get(target, property) {
        return property === "DB" ? racingDb : Reflect.get(target, property);
      },
    });

    const snapshot = await new ReadinessService(racingEnv).getCommandCentre(
      viewer,
    );
    const current = await baseEnv.DB.prepare(
      "SELECT COALESCE(MAX(sequence), 0) AS cursor FROM event_changes WHERE event_id = ?",
    )
      .bind(viewer.eventId)
      .first<{ cursor: number }>();

    expect(injected).toBe(true);
    expect(current!.cursor).toBeGreaterThan(snapshot.cursor);
  });

  it("counts unresolved operations outside the five rows shown in the command centre", async () => {
    const prefix = crypto.randomUUID();
    const failedId = `readiness-failed-${prefix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO operation_jobs (
          id, organisation_id, event_id, type, idempotency_key, correlation_id,
          status, payload_json, progress_total, progress_failed, created_at, updated_at
        ) VALUES (?, ?, ?, 'test.failure', ?, ?, 'failed', '{}', 1, 1,
                  unixepoch() - 1000, unixepoch() - 1000)`,
      ).bind(
        failedId,
        viewer.organisationId,
        viewer.eventId,
        `readiness-failed-key-${prefix}`,
        `readiness-failed-correlation-${prefix}`,
      ),
      ...Array.from({ length: 6 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO operation_jobs (
            id, organisation_id, event_id, type, idempotency_key, correlation_id,
            status, payload_json, progress_total, progress_completed, created_at, updated_at
          ) VALUES (?, ?, ?, 'test.completed', ?, ?, 'completed', '{}', 1, 1,
                    unixepoch() + ?, unixepoch() + ?)`,
        ).bind(
          `readiness-completed-${prefix}-${index}`,
          viewer.organisationId,
          viewer.eventId,
          `readiness-completed-key-${prefix}-${index}`,
          `readiness-completed-correlation-${prefix}-${index}`,
          index + 1,
          index + 1,
        ),
      ),
    ]);

    const snapshot = await new ReadinessService(
      env as unknown as CloudflareEnvironment,
    ).getCommandCentre(viewer);
    expect(snapshot.operations).toHaveLength(5);
    expect(snapshot.operations.map((operation) => operation.id)).not.toContain(
      failedId,
    );
    expect(
      snapshot.blockers.find((blocker) => blocker.key === "operation_failures")
        ?.count,
    ).toBeGreaterThanOrEqual(1);
    const operations = snapshot.workflows.find(
      (workflow) => workflow.key === "operations",
    );
    expect(operations?.total).toBeGreaterThan(snapshot.operations.length);
    expect(operations?.score).toBeLessThan(100);
  });

  it("does not treat intentional cancellations as incomplete readiness work", async () => {
    const before = await new ReadinessService(
      env as unknown as CloudflareEnvironment,
    ).getCommandCentre(viewer);
    const communicationId = crypto.randomUUID();
    const deliveryId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO communications (
          id, event_id, idempotency_key, kind, channel, status, audience_json,
          content_snapshot_json, recipient_count, created_at, updated_at
        ) VALUES (?, ?, ?, 'optional', 'email', 'cancelled', '{}', '{}', 1,
                  unixepoch(), unixepoch())`,
      ).bind(communicationId, viewer.eventId, `cancelled-${communicationId}`),
      env.DB.prepare(
        `INSERT INTO communication_deliveries (
          id, event_id, communication_id, recipient_address, channel, provider,
          idempotency_key, status, created_at, updated_at
        ) VALUES (?, ?, ?, 'cancelled@example.com', 'email', 'resend', ?,
                  'cancelled', unixepoch(), unixepoch())`,
      ).bind(
        deliveryId,
        viewer.eventId,
        communicationId,
        `cancelled-${deliveryId}`,
      ),
      env.DB.prepare(
        `INSERT INTO operation_jobs (
          id, organisation_id, event_id, type, idempotency_key, correlation_id,
          status, payload_json, progress_total, created_at, updated_at
        ) VALUES (?, ?, ?, 'test.cancelled', ?, ?, 'cancelled', '{}', 1,
                  unixepoch(), unixepoch())`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        `cancelled-${operationId}`,
        `cancelled-${operationId}`,
      ),
    ]);

    const after = await new ReadinessService(
      env as unknown as CloudflareEnvironment,
    ).getCommandCentre(viewer);
    expect(after.workflows.find(({ key }) => key === "communications")).toEqual(
      before.workflows.find(({ key }) => key === "communications"),
    );
    expect(after.workflows.find(({ key }) => key === "operations")).toEqual(
      before.workflows.find(({ key }) => key === "operations"),
    );
    expect(after.deliveryHealth).toEqual(before.deliveryHealth);
  });

  it("rejects a viewer whose organisation does not own the event", async () => {
    await expect(
      new ReadinessService(
        env as unknown as CloudflareEnvironment,
      ).getCommandCentre({
        ...viewer,
        organisationId: "org-not-owner",
      }),
    ).rejects.toMatchObject({ status: 404 });
  });
});
