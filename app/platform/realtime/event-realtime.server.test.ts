import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  notifyApiChange,
  recordApiChange,
} from "~/platform/api/api-realtime.server";
import {
  EventChangeNotFoundError,
  EventRealtimeConfigurationError,
  EventRealtimeService,
} from "./event-realtime.server";
import { recordRouteChange } from "./route-realtime.server";

const viewer: Viewer = {
  personId: "person-admin-demo",
  name: "Alex Morgan",
  email: "admin@programcue.test",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

function environmentWithChannel(deliveries: unknown[]) {
  const stub = {
    async fetch(_input: RequestInfo | URL, init?: RequestInit) {
      deliveries.push(JSON.parse(String(init?.body)));
      return Response.json({ accepted: true });
    },
  };
  const namespace = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return stub;
    },
  };
  return {
    ...(env as unknown as CloudflareEnvironment),
    DB: env.DB,
    EVENT_CHANNEL: namespace,
  } as unknown as CloudflareEnvironment;
}

describe("event realtime service", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
  });

  it("commits a tenant-scoped cursor before broadcasting its invalidation", async () => {
    const deliveries: unknown[] = [];
    const service = new EventRealtimeService(
      environmentWithChannel(deliveries),
    );
    const change = await service.recordChange(viewer, {
      entityType: "session",
      entityId: "session-demo-opening",
      changeType: "updated",
      correlationId: "corr-realtime-test",
    });

    expect(change.cursor).toBeGreaterThan(0);
    expect(deliveries).toEqual([change]);
    const committed = await env.DB.prepare(
      `
      SELECT sequence FROM event_changes WHERE sequence = ? AND event_id = ?
    `,
    )
      .bind(change.cursor, viewer.eventId)
      .first<{ sequence: number }>();
    expect(committed?.sequence).toBe(change.cursor);
  });

  it("provides bounded, event-isolated D1 cursor pages", async () => {
    const service = new EventRealtimeService(environmentWithChannel([]));
    const before = await service.getLatestCursor(viewer);
    await service.recordChange(viewer, {
      entityType: "task",
      entityId: "task-1",
      changeType: "updated",
    });
    await service.recordChange(viewer, {
      entityType: "task",
      entityId: "task-2",
      changeType: "progress",
    });

    const first = await service.getChangesSince(
      viewer,
      before,
      1,
    );
    expect(first.changes).toHaveLength(1);
    expect(first.hasMore).toBe(true);
    expect(first.pollAfterMs).toBe(0);
    const second = await service.getChangesSince(viewer, first.cursor, 1000);
    expect(second.changes).toHaveLength(1);
    expect(second.hasMore).toBe(false);
    expect(second.pollAfterMs).toBeLessThanOrEqual(30_000);

    await expect(
      service.getChangesSince({ ...viewer, organisationId: "another-org" }, 0),
    ).rejects.toBeInstanceOf(EventChangeNotFoundError);
    await expect(
      service.getLatestCursor({ ...viewer, organisationId: "another-org" }),
    ).rejects.toBeInstanceOf(EventChangeNotFoundError);
  });

  it("fails clearly when realtime publication is required but its binding is missing", async () => {
    const service = new EventRealtimeService({
      DB: env.DB,
    } as unknown as CloudflareEnvironment);
    const before = await env.DB.prepare(
      `
      SELECT COALESCE(MAX(sequence), 0) AS cursor FROM event_changes WHERE event_id = ?
    `,
    )
      .bind(viewer.eventId)
      .first<{ cursor: number }>();
    await expect(
      service.recordChange(viewer, {
        entityType: "schedule",
        entityId: "schedule-demo",
        changeType: "published",
      }),
    ).rejects.toBeInstanceOf(EventRealtimeConfigurationError);

    const fallback = await service.getChangesSince(
      viewer,
      Number(before?.cursor ?? 0),
    );
    expect(
      fallback.changes.some((change) => change.entityType === "schedule"),
    ).toBe(true);
  });

  it("reports a committed mutation honestly when its live broadcast is unavailable", async () => {
    const before = await env.DB.prepare(
      `
      SELECT COALESCE(MAX(sequence), 0) AS cursor
        FROM event_changes
       WHERE event_id = ?
    `,
    )
      .bind(viewer.eventId)
      .first<{ cursor: number }>();

    const failure = await recordRouteChange(
      { DB: env.DB } as unknown as CloudflareEnvironment,
      viewer,
      {
        entityType: "task_instance",
        entityId: "task-committed",
        changeType: "progress",
      },
    );

    expect(failure).toEqual({
      ok: false,
      committed: true,
      entityId: "task-committed",
      message:
        "Your change was saved, but live updates could not be broadcast: EVENT_CHANNEL Durable Object binding is required for realtime event updates. Refresh other open views before continuing.",
    });

    const committed = await env.DB.prepare(
      `
      SELECT entity_type AS entityType, entity_id AS entityId, change_type AS changeType
        FROM event_changes
       WHERE event_id = ? AND sequence > ?
       ORDER BY sequence DESC
       LIMIT 1
    `,
    )
      .bind(viewer.eventId, Number(before?.cursor ?? 0))
      .first<{
        entityType: string;
        entityId: string | null;
        changeType: string;
      }>();
    expect(committed).toEqual({
      entityType: "task_instance",
      entityId: "task-committed",
      changeType: "progress",
    });
  });

  it("returns committed API success metadata instead of a retryable error when live invalidation fails", async () => {
    const environment = {
      DB: env.DB,
    } as unknown as CloudflareEnvironment;
    const service = new EventRealtimeService(environment);
    const existing = await service.commitChange(viewer, {
      entityType: "task_instance",
      entityId: "api-task-committed",
      changeType: "created",
    });

    await expect(
      notifyApiChange(
        environment,
        { ...viewer, keyId: "api-key-realtime", scopes: new Set() },
        existing.cursor,
        "api-task-committed",
      ),
    ).resolves.toMatchObject({
      changeCursor: existing.cursor,
      realtimeWarning: expect.stringContaining("mutation committed"),
    });

    const recorded = await recordApiChange(
      environment,
      { ...viewer, keyId: "api-key-realtime", scopes: new Set() },
      {
        entityType: "schedule_version",
        entityId: "api-schedule-committed",
        changeType: "published",
      },
    );
    expect(recorded).toMatchObject({
      changeCursor: expect.any(Number),
      realtimeWarning: expect.stringContaining("mutation committed"),
    });
    expect(recorded.realtimeWarning).not.toContain(
      "EVENT_CHANNEL Durable Object binding",
    );
  });
});
