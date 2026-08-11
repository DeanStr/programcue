import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  SessionBulkService,
  SessionBulkStateError,
} from "~/platform/operations/session-bulk-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("session bulk operations", () => {
  beforeAll(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status, visibility
         ) VALUES ('bulk-tag-session', ?, 'Bulk tag session', 'bulk-tag-session',
                   'presentation', 30, 'unscheduled', 'public')`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status, visibility
         ) VALUES ('bulk-archive-session', ?, 'Bulk archive session', 'bulk-archive-session',
                   'presentation', 30, 'cancelled', 'public')`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status, visibility
         ) VALUES ('bulk-stale-session', ?, 'Bulk stale session', 'bulk-stale-session',
                   'presentation', 30, 'unscheduled', 'public')`,
      ).bind(viewer.eventId),
      env.DB.prepare(
        `INSERT INTO sessions (
           id, event_id, title, slug, format, duration_minutes, status, visibility
         ) VALUES ('bulk-authority-session', ?, 'Bulk authority session', 'bulk-authority-session',
                   'presentation', 30, 'unscheduled', 'public')`,
      ).bind(viewer.eventId),
    ]);
  });

  it("previews, confirms and safely undoes a tag assignment", async () => {
    const service = new SessionBulkService(
      env as unknown as CloudflareEnvironment,
    );
    const preview = await service.preview(viewer, {
      action: "add_tag",
      sessionIds: ["bulk-tag-session"],
      tagName: "Featured",
      colourToken: "indigo",
    });

    expect(preview).toMatchObject({ changeCount: 1, invalidCount: 0 });
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM tags WHERE event_id = ? AND name = 'Featured'",
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ count: 0 });

    await service.confirm(viewer, preview.operationId);
    expect(
      await env.DB.prepare(
        `SELECT s.revision, t.name
           FROM sessions s
           JOIN session_tags st ON st.session_id = s.id AND st.event_id = s.event_id
           JOIN tags t ON t.id = st.tag_id AND t.event_id = st.event_id
          WHERE s.id = 'bulk-tag-session' AND s.event_id = ?`,
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ revision: 2, name: "Featured" });

    const inverse = await service.prepareUndo(viewer, preview.operationId);
    expect(inverse).toMatchObject({
      action: "remove_tag",
      undoOf: preview.operationId,
      changeCount: 1,
    });
    await service.confirm(viewer, inverse.operationId);

    expect(
      await env.DB.prepare(
        `SELECT s.revision, COUNT(st.tag_id) AS tagCount,
                EXISTS(SELECT 1 FROM tags t WHERE t.event_id = ? AND t.name = 'Featured') AS tagExists
           FROM sessions s
           LEFT JOIN session_tags st ON st.session_id = s.id AND st.event_id = s.event_id
          WHERE s.id = 'bulk-tag-session' AND s.event_id = ?
          GROUP BY s.id, s.revision`,
      )
        .bind(viewer.eventId, viewer.eventId)
        .first(),
    ).toEqual({ revision: 3, tagCount: 0, tagExists: 0 });
    expect(
      await env.DB.prepare(
        "SELECT json_extract(result_json, '$.undoneBy') AS undoneBy FROM operation_jobs WHERE id = ?",
      )
        .bind(preview.operationId)
        .first(),
    ).toEqual({ undoneBy: inverse.operationId });
  });

  it("archives and restores the exact previous session status", async () => {
    const service = new SessionBulkService(
      env as unknown as CloudflareEnvironment,
    );
    const preview = await service.preview(viewer, {
      action: "archive",
      sessionIds: ["bulk-archive-session"],
      tagId: null,
      tagName: null,
      colourToken: null,
    });
    await service.confirm(viewer, preview.operationId);

    expect(
      await env.DB.prepare(
        `SELECT s.status, s.revision, a.previous_status AS previousStatus
           FROM sessions s
           JOIN session_archives a ON a.session_id = s.id AND a.event_id = s.event_id
          WHERE s.id = 'bulk-archive-session' AND s.event_id = ?`,
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ status: "archived", revision: 2, previousStatus: "cancelled" });

    const inverse = await service.prepareUndo(viewer, preview.operationId);
    await service.confirm(viewer, inverse.operationId);
    expect(
      await env.DB.prepare(
        `SELECT s.status, s.revision,
                EXISTS(SELECT 1 FROM session_archives a WHERE a.session_id = s.id) AS archived
           FROM sessions s
          WHERE s.id = 'bulk-archive-session' AND s.event_id = ?`,
      )
        .bind(viewer.eventId)
        .first(),
    ).toEqual({ status: "cancelled", revision: 3, archived: 0 });
  });

  it("fails a stale preview without applying a partial mutation", async () => {
    const service = new SessionBulkService(
      env as unknown as CloudflareEnvironment,
    );
    const preview = await service.preview(viewer, {
      action: "add_tag",
      sessionIds: ["bulk-stale-session"],
      tagName: "Stale preview tag",
    });
    await env.DB.prepare(
      "UPDATE sessions SET revision = revision + 1 WHERE id = 'bulk-stale-session' AND event_id = ?",
    )
      .bind(viewer.eventId)
      .run();

    await expect(
      service.confirm(viewer, preview.operationId),
    ).rejects.toBeInstanceOf(SessionBulkStateError);
    expect(
      await env.DB.prepare(
        `SELECT o.status,
                EXISTS(SELECT 1 FROM tags t WHERE t.event_id = ? AND t.name = 'Stale preview tag') AS tagCreated
           FROM operation_jobs o WHERE o.id = ?`,
      )
        .bind(viewer.eventId, preview.operationId)
        .first(),
    ).toEqual({ status: "failed", tagCreated: 0 });
  });

  it("rejects Airtable-authoritative bulk work before intent or session changes", async () => {
    const service = new SessionBulkService(
      env as unknown as CloudflareEnvironment,
    );
    const input = {
      action: "archive",
      sessionIds: ["bulk-authority-session"],
    };
    const preview = await service.preview(viewer, input);
    await env.DB.prepare(
      "UPDATE events SET repository_provider = 'airtable' WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .run();
    try {
      const before = await env.DB.prepare(
        "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ? AND type = 'session.bulk'",
      )
        .bind(viewer.eventId)
        .first<{ count: number }>();
      await expect(service.preview(viewer, input)).rejects.toThrow(
        "Session bulk actions are unavailable while Airtable is authoritative",
      );
      expect(
        await env.DB.prepare(
          "SELECT COUNT(*) AS count FROM operation_jobs WHERE event_id = ? AND type = 'session.bulk'",
        )
          .bind(viewer.eventId)
          .first(),
      ).toEqual(before);

      await expect(
        service.confirm(viewer, preview.operationId),
      ).rejects.toThrow(
        "Session bulk actions are unavailable while Airtable is authoritative",
      );
      expect(
        await env.DB.prepare("SELECT status FROM operation_jobs WHERE id = ?")
          .bind(preview.operationId)
          .first(),
      ).toEqual({ status: "received" });
      expect(
        await env.DB.prepare(
          "SELECT status, revision FROM sessions WHERE id = 'bulk-authority-session' AND event_id = ?",
        )
          .bind(viewer.eventId)
          .first(),
      ).toEqual({ status: "unscheduled", revision: 1 });
    } finally {
      await env.DB.prepare(
        "UPDATE events SET repository_provider = 'd1' WHERE id = ? AND organisation_id = ?",
      )
        .bind(viewer.eventId, viewer.organisationId)
        .run();
    }
  });
});
