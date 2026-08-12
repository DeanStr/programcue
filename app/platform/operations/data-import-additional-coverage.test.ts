import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

import {
  acceptEventInvitation,
  requireEventRole,
  type Viewer,
} from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { INITIAL_EVENT_SESSION_FORMATS_JSON } from "~/modules/events/event-configuration";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import {
  DataImportService,
  DataImportStateError,
} from "~/platform/operations/data-import-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

async function createRoomImportEvent(suffix: string) {
  const eventId = `event-room-import-${suffix}`;
  const roomId = `room-import-${suffix}`;
  const roomName = `Import room ${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO events (
         id, organisation_id, name, slug, timezone, starts_at, ends_at,
         session_formats_json, file_policy_json
       ) VALUES (?, ?, ?, ?, 'UTC', 1760000000, 1760086400, ?, ?)`,
    ).bind(
      eventId,
      viewer.organisationId,
      `Room import event ${suffix}`,
      `room-import-event-${suffix}`,
      INITIAL_EVENT_SESSION_FORMATS_JSON,
      CANONICAL_EVENT_FILE_POLICY_JSON,
    ),
    env.DB.prepare(
      `INSERT INTO rooms (
         id, event_id, name, capacity, position, status
       ) VALUES (?, ?, ?, 100, 0, 'active')`,
    ).bind(roomId, eventId, roomName),
  ]);
  return {
    eventId,
    roomId,
    roomName,
    viewer: { ...viewer, eventId },
  };
}

async function addPublishedRoomUse(
  eventId: string,
  roomId: string,
  suffix: string,
  expectedAttendance: number,
) {
  const sessionId = `session-room-import-${suffix}`;
  const versionId = `schedule-room-import-${suffix}`;
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE schedule_policies
          SET capacity_action = 'block', updated_at = unixepoch()
        WHERE event_id = ?`,
    ).bind(eventId),
    env.DB.prepare(
      `INSERT INTO sessions (
         id, event_id, title, slug, format, duration_minutes,
         expected_attendance, status, visibility
       ) VALUES (?, ?, ?, ?, 'presentation', 45, ?, 'published', 'public')`,
    ).bind(
      sessionId,
      eventId,
      `Scheduled import session ${suffix}`,
      `scheduled-import-session-${suffix}`,
      expectedAttendance,
    ),
    env.DB.prepare(
      `INSERT INTO schedule_versions (
         id, event_id, version_number, name, status, created_by_person_id,
         published_at
       ) VALUES (?, ?, 1, 'Import guard schedule', 'published', ?, unixepoch())`,
    ).bind(versionId, eventId, viewer.personId),
    env.DB.prepare(
      `INSERT INTO schedule_entries (
         id, event_id, schedule_version_id, session_id, room_id,
         starts_at, ends_at
       ) VALUES (?, ?, ?, ?, ?, 1760010000, 1760012700)`,
    ).bind(
      `entry-room-import-${suffix}`,
      eventId,
      versionId,
      sessionId,
      roomId,
    ),
  ]);
}

describe("CSV imports", () => {
  beforeEach(async () => {
    await ensureDemoData(env as unknown as CloudflareEnvironment);
    await env.DB.prepare(
      "DELETE FROM operation_jobs WHERE event_id = ? AND type = 'data.import'",
    )
      .bind(viewer.eventId)
      .run();
  });

  describe("additional workflow coverage", () => {
    it("shows row-level reconciliation errors and refuses confirmation", async () => {
      const service = new DataImportService(
        env as unknown as CloudflareEnvironment,
      );
      const preview = await service.preview(viewer, {
        resource: "sessions",
        fileName: "sessions.csv",
        csv: [
          "slug,title,description,trackSlug,format,durationMinutes,expectedAttendance,status,visibility",
          "missing-track,Missing track,,does-not-exist,presentation,45,100,unscheduled,public",
        ].join("\n"),
      });
      expect(preview).toMatchObject({ validCount: 0, invalidCount: 1 });
      expect(
        await env.DB.prepare(
          "SELECT status, error_code AS errorCode, error_message AS errorMessage FROM operation_items WHERE operation_id = ?",
        )
          .bind(preview.operationId)
          .first(),
      ).toMatchObject({
        status: "failed",
        errorCode: "VALIDATION_ERROR",
        errorMessage: "trackSlug does not match a track in this event",
      });
      await expect(
        service.confirm(viewer, preview.operationId),
      ).rejects.toBeInstanceOf(DataImportStateError);
    });
  });
});
