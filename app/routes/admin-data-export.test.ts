import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { action, loader } from "./admin-data-export";

const workerEnv = env as unknown as CloudflareEnvironment;
const eventId = "evt-foe-2025";

function context() {
  const value = new RouterContextProvider();
  value.set(cloudflareContext, {
    env: workerEnv,
    ctx: {} as ExecutionContext,
  });
  return value;
}

function exportRequest(
  role: "owner" | "administrator" | "speaker",
  options: {
    origin?: string;
    eventId?: string;
    idempotencyKey?: string | null;
  } = {},
) {
  const headers = new Headers({
    cookie: [
      `program_cue_demo_role=${role}`,
      `program_cue_event=${options.eventId ?? eventId}`,
    ]
      .filter(Boolean)
      .join("; "),
  });
  if (options.origin !== undefined) headers.set("origin", options.origin);
  const body = new URLSearchParams();
  if (options.idempotencyKey !== null) {
    body.set("idempotencyKey", options.idempotencyKey ?? crypto.randomUUID());
  }
  return new Request("http://localhost/admin/exports/rooms.csv", {
    method: "POST",
    headers,
    body,
  });
}

async function exportMutationCounts() {
  const [operations, audits, changes] = await Promise.all([
    workerEnv.DB.prepare(
      "SELECT count(*) AS total FROM operation_jobs WHERE type = 'data.export'",
    ).first<{ total: number }>(),
    workerEnv.DB.prepare(
      "SELECT count(*) AS total FROM audit_events WHERE action = 'data.exported'",
    ).first<{ total: number }>(),
    workerEnv.DB.prepare(
      `SELECT count(*) AS total FROM event_changes
        WHERE entity_type = 'operation'
          AND entity_id IN (SELECT id FROM operation_jobs WHERE type = 'data.export')`,
    ).first<{ total: number }>(),
  ]);
  return {
    operations: operations?.total ?? 0,
    audits: audits?.total ?? 0,
    changes: changes?.total ?? 0,
  };
}

beforeEach(async () => {
  await ensureDemoData(workerEnv);
});

describe("event CSV export route", () => {
  it("rejects GET with Allow: POST and records no export side effects", async () => {
    const before = await exportMutationCounts();

    const response = loader();

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await exportMutationCounts()).toEqual(before);
  });

  it("requires an exact same-origin POST before creating an export", async () => {
    const before = await exportMutationCounts();

    for (const origin of [undefined, "null", "https://attacker.example"]) {
      const response = await action({
        request: exportRequest("administrator", { origin }),
        params: { resource: "rooms" },
        context: context(),
      } as never);
      expect(response.status).toBe(403);
    }

    expect(await exportMutationCounts()).toEqual(before);
  });

  it("requires organisation-owner authority", async () => {
    const before = await exportMutationCounts();

    await expect(
      action({
        request: exportRequest("speaker", { origin: "http://localhost" }),
        params: { resource: "rooms" },
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      action({
        request: exportRequest("administrator", {
          origin: "http://localhost",
          eventId: "event-outside-current-scope",
        }),
        params: { resource: "rooms" },
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 403 });

    expect(await exportMutationCounts()).toEqual(before);
  });

  it("returns an audited CSV attachment for an authorised same-origin POST", async () => {
    const response = await action({
      request: exportRequest("owner", { origin: "http://localhost" }),
      params: { resource: "rooms" },
      context: context(),
    } as never);

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="program-cue-rooms.csv"',
    );
    const operationId = response.headers.get("x-program-cue-operation");
    expect(operationId).toBeTruthy();
    expect(await response.text()).toContain(
      "id,name,capacity,position,status\r\n",
    );
    expect(
      await workerEnv.DB.prepare(
        `SELECT organisation_id AS organisationId, event_id AS eventId, status
           FROM operation_jobs WHERE id = ? AND type = 'data.export'`,
      )
        .bind(operationId)
        .first(),
    ).toEqual({
      organisationId: "org-future-events",
      eventId,
      status: "completed",
    });
    expect(
      await workerEnv.DB.prepare(
        `SELECT event_id AS eventId, action
           FROM audit_events WHERE entity_type = 'operation' AND entity_id = ?`,
      )
        .bind(operationId)
        .first(),
    ).toEqual({ eventId, action: "data.exported" });
  });

  it("converges retries with the same caller intent on one export operation", async () => {
    const idempotencyKey = crypto.randomUUID();
    const before = await exportMutationCounts();
    const first = await action({
      request: exportRequest("owner", {
        origin: "http://localhost",
        idempotencyKey,
      }),
      params: { resource: "rooms" },
      context: context(),
    } as never);
    const second = await action({
      request: exportRequest("owner", {
        origin: "http://localhost",
        idempotencyKey,
      }),
      params: { resource: "rooms" },
      context: context(),
    } as never);

    expect(second.headers.get("x-program-cue-operation")).toBe(
      first.headers.get("x-program-cue-operation"),
    );
    expect(await second.text()).toBe(await first.text());
    expect(await exportMutationCounts()).toEqual({
      operations: before.operations + 1,
      audits: before.audits + 1,
      changes: before.changes + 1,
    });
  });

  it("returns a conflict instead of changing an existing export snapshot", async () => {
    const idempotencyKey = crypto.randomUUID();
    const changedRoomId = `route-export-retry-${crypto.randomUUID()}`;
    const before = await exportMutationCounts();
    const first = await action({
      request: exportRequest("owner", {
        origin: "http://localhost",
        idempotencyKey,
      }),
      params: { resource: "rooms" },
      context: context(),
    } as never);

    try {
      await workerEnv.DB.prepare(
        `INSERT INTO rooms (id, event_id, name, capacity, position)
         VALUES (?, ?, 'Changed after route export', 12, 1002)`,
      )
        .bind(changedRoomId, eventId)
        .run();

      await expect(
        action({
          request: exportRequest("owner", {
            origin: "http://localhost",
            idempotencyKey,
          }),
          params: { resource: "rooms" },
          context: context(),
        } as never),
      ).rejects.toMatchObject({ status: 409 });
      expect(await exportMutationCounts()).toEqual({
        operations: before.operations + 1,
        audits: before.audits + 1,
        changes: before.changes + 1,
      });
      expect(first.headers.get("x-program-cue-operation")).toBeTruthy();
    } finally {
      await workerEnv.DB.prepare("DELETE FROM rooms WHERE id = ?")
        .bind(changedRoomId)
        .run();
    }
  });

  it("rejects a missing export intent without side effects", async () => {
    const before = await exportMutationCounts();
    await expect(
      action({
        request: exportRequest("owner", {
          origin: "http://localhost",
          idempotencyKey: null,
        }),
        params: { resource: "rooms" },
        context: context(),
      } as never),
    ).rejects.toMatchObject({ status: 422 });
    expect(await exportMutationCounts()).toEqual(before);
  });
});
