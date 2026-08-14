import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import { ProgrammeAdminService } from "./programme-admin-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

describe("programme administration overview", () => {
  it("reads attendee-facing content from the published snapshot", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnvironment);
    const published = await env.DB.prepare(
      `SELECT session.id, content.title, content.visibility
         FROM schedule_versions version
         JOIN schedule_entries entry
           ON entry.schedule_version_id = version.id
          AND entry.event_id = version.event_id
         JOIN sessions session
           ON session.id = entry.session_id AND session.event_id = entry.event_id
         JOIN schedule_session_contents content
           ON content.schedule_version_id = entry.schedule_version_id
          AND content.event_id = entry.event_id
          AND content.session_id = entry.session_id
        WHERE version.event_id = ? AND version.status = 'published'
        ORDER BY version.version_number DESC, entry.starts_at, session.id
        LIMIT 1`,
    )
      .bind(admin.eventId)
      .first<{ id: string; title: string; visibility: string }>();
    expect(published).not.toBeNull();

    await env.DB.prepare(
      `UPDATE sessions
          SET title = 'Unpublished draft title', visibility = 'private',
              revision = revision + 1, updated_at = unixepoch()
        WHERE id = ? AND event_id = ?`,
    )
      .bind(published!.id, admin.eventId)
      .run();

    const overview = await new ProgrammeAdminService(
      testEnvironment,
    ).getOverview(admin);
    expect(
      overview.sessions.find((session) => session.id === published!.id),
    ).toMatchObject({
      title: published!.title,
      visibility: published!.visibility,
      track: expect.any(String),
      format: expect.any(String),
    });
    expect(overview.eventName).toBe("Future of Events 2027");
    expect(overview.brandAccent).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it("does not offer private track names as public embed filters", async () => {
    const testEnvironment = env as unknown as CloudflareEnvironment;
    await ensureDemoProgramme(testEnvironment);
    const published = await env.DB.prepare(
      `SELECT content.session_id AS sessionId, content.track_id AS trackId
         FROM schedule_versions version
         JOIN schedule_session_contents content
           ON content.schedule_version_id = version.id
          AND content.event_id = version.event_id
         JOIN tracks track
           ON track.id = content.track_id AND track.event_id = content.event_id
        WHERE version.event_id = ? AND version.status = 'published'
          AND track.is_public = 1
        LIMIT 1`,
    )
      .bind(admin.eventId)
      .first<{ sessionId: string; trackId: string }>();
    expect(published).not.toBeNull();

    await env.DB.prepare(
      `UPDATE tracks SET is_public = 0 WHERE id = ? AND event_id = ?`,
    )
      .bind(published!.trackId, admin.eventId)
      .run();

    const overview = await new ProgrammeAdminService(
      testEnvironment,
    ).getOverview(admin);
    expect(
      overview.sessions.find((session) => session.id === published!.sessionId),
    ).toMatchObject({ track: null });
  });
});
