import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  DataExportIdempotencyConflictError,
  DataExportService,
} from "~/platform/operations/data-export-service.server";

const viewer: Viewer = {
  personId: "person-demo-owner",
  name: "Morgan Chen",
  email: "morgan.owner@example.com",
  role: "owner",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("event CSV exports", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare(
      "DELETE FROM operation_jobs WHERE event_id = ? AND type = 'data.export'",
    )
      .bind(viewer.eventId)
      .run();
  });

  it("exports authorised event records, neutralises formulas and audits the download", async () => {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO rooms (id, event_id, name, capacity, position)
       VALUES ('export-formula-room', ?, '=IMPORTXML(1)', 20, 999)`,
    )
      .bind(viewer.eventId)
      .run();
    await env.DB.prepare(
      `INSERT OR IGNORE INTO rooms (id, event_id, name, capacity, position)
       VALUES ('export-whitespace-formula-room', ?, '  +1+1', 20, 1000)`,
    )
      .bind(viewer.eventId)
      .run();
    const exported = await new DataExportService(
      env as unknown as CloudflareEnvironment,
    ).export(viewer, "rooms", crypto.randomUUID());

    expect(exported.csv).toContain("id,name,capacity,position,status\r\n");
    expect(exported.csv).toContain(
      "export-formula-room,'=IMPORTXML(1),20,999,active",
    );
    expect(exported.csv).toContain(
      "export-whitespace-formula-room,'  +1+1,20,1000,active",
    );
    expect(
      await env.DB.prepare(
        "SELECT status, progress_total AS total, progress_completed AS completed FROM operation_jobs WHERE id = ?",
      )
        .bind(exported.operationId)
        .first(),
    ).toEqual({
      status: "completed",
      total: exported.rowCount,
      completed: exported.rowCount,
    });
    expect(
      await env.DB.prepare(
        "SELECT action FROM audit_events WHERE entity_type = 'operation' AND entity_id = ?",
      )
        .bind(exported.operationId)
        .first(),
    ).toEqual({ action: "data.exported" });
  });

  it("includes active organisation-scoped owners in every authorised event people export", async () => {
    const exported = await new DataExportService(
      env as unknown as CloudflareEnvironment,
    ).export(viewer, "people", crypto.randomUUID());

    expect(exported.csv).toContain(
      "person-demo-owner,morgan.owner@example.com,Morgan Chen",
    );
  });

  it("exports every ordered submission track from authoritative selections", async () => {
    const submissionId = `export-multi-track-${crypto.randomUUID()}`;
    const reference = `EXPORT-MULTI-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO submissions (
           id, event_id, public_reference, title, category, format, status,
           answers_json, submitted_snapshot_json, submitted_at, created_at, updated_at
         ) VALUES (?, ?, ?, 'Multi-track export proposal', 'AI & Innovation',
                   'Presentation', 'submitted', '{}', '{"answers":{},"speakers":[]}',
                   unixepoch(), unixepoch(), unixepoch())`,
      ).bind(submissionId, viewer.eventId, reference),
      env.DB.prepare(
        `INSERT INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES (?, ?, 'demo-track-ai', 'AI & Innovation', 0)`,
      ).bind(submissionId, viewer.eventId),
      env.DB.prepare(
        `INSERT INTO submission_track_selections (
           submission_id, event_id, track_id, track_name_snapshot, position
         ) VALUES (?, ?, 'demo-track-operations', 'Event Operations', 1)`,
      ).bind(submissionId, viewer.eventId),
    ]);
    try {
      const exported = await new DataExportService(
        env as unknown as CloudflareEnvironment,
      ).export(viewer, "submissions", crypto.randomUUID());
      expect(exported.csv).toContain(
        "id,publicReference,title,tracks,format,status,submitterEmail",
      );
      const row = exported.csv
        .split("\r\n")
        .find((candidate) => candidate.includes(reference));
      expect(row).toContain("demo-track-ai");
      expect(row).toContain("demo-track-operations");
      expect(row!.indexOf("demo-track-ai")).toBeLessThan(
        row!.indexOf("demo-track-operations"),
      );
    } finally {
      await env.DB.prepare(
        "DELETE FROM submissions WHERE id = ? AND event_id = ?",
      )
        .bind(submissionId, viewer.eventId)
        .run();
    }
  });

  it("fails closed when the event is outside the viewer organisation", async () => {
    await expect(
      new DataExportService(env as unknown as CloudflareEnvironment).export(
        { ...viewer, organisationId: "different-organisation" },
        "rooms",
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects event-scoped administrators and records no export", async () => {
    const eventAdministrator: Viewer = {
      ...viewer,
      personId: "person-demo-admin",
      name: "Olivia Bennett",
      email: "olivia@example.com",
      role: "administrator",
    };

    await expect(
      new DataExportService(env as unknown as CloudflareEnvironment).export(
        eventAdministrator,
        "rooms",
        crypto.randomUUID(),
      ),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ? AND type = 'data.export'",
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ count: 0 });
  });

  it("replays one durable operation for a stable export intent", async () => {
    const service = new DataExportService(
      env as unknown as CloudflareEnvironment,
    );
    const intent = crypto.randomUUID();
    const first = await service.export(viewer, "rooms", intent);
    const second = await service.export(viewer, "rooms", intent);

    expect(second.operationId).toBe(first.operationId);
    expect(second.csv).toBe(first.csv);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ? AND type = 'data.export'",
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM audit_events WHERE event_id = ? AND action = 'data.exported' AND entity_id = ?",
      )
        .bind(viewer.eventId, first.operationId)
        .first(),
    ).toEqual({ count: 1 });
  });

  it("rejects an export retry when the event data snapshot changed", async () => {
    const service = new DataExportService(
      env as unknown as CloudflareEnvironment,
    );
    const intent = crypto.randomUUID();
    const first = await service.export(viewer, "rooms", intent);
    const changedRoomId = `export-retry-change-${crypto.randomUUID()}`;

    try {
      await env.DB.prepare(
        `INSERT INTO rooms (id, event_id, name, capacity, position)
         VALUES (?, ?, 'Changed after export', 12, 1001)`,
      )
        .bind(changedRoomId, viewer.eventId)
        .run();

      await expect(service.export(viewer, "rooms", intent)).rejects.toThrow(
        DataExportIdempotencyConflictError,
      );
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ? AND type = 'data.export'",
        )
          .bind(viewer.eventId)
          .first(),
      ).toEqual({ count: 1 });
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM audit_events WHERE event_id = ? AND action = 'data.exported' AND entity_id = ?",
        )
          .bind(viewer.eventId, first.operationId)
          .first(),
      ).toEqual({ count: 1 });
    } finally {
      await env.DB.prepare("DELETE FROM rooms WHERE id = ?")
        .bind(changedRoomId)
        .run();
    }
  });
});
