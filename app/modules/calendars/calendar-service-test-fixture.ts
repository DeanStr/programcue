import { env } from "cloudflare:test";

import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";

export const calendarTestViewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

export async function scheduledSpeakerEnvironment() {
  const queued: unknown[] = [];
  const realtime: unknown[] = [];
  const eventChannel = {
    idFromName(name: string) {
      return name;
    },
    get() {
      return {
        async fetch(_input: RequestInfo | URL, init?: RequestInit) {
          realtime.push(JSON.parse(String(init?.body)));
          return Response.json({ accepted: true });
        },
      };
    },
  };
  const testEnv = {
    ...(env as unknown as CloudflareEnvironment),
    DB: env.DB,
    RESEND_API_KEY: "test-resend-key",
    OPERATIONS_QUEUE: {
      send: async (message: unknown) => {
        queued.push(message);
      },
    },
    EVENT_CHANNEL: eventChannel,
  } as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await env.DB.prepare("DELETE FROM calendar_invitations WHERE event_id = ?")
    .bind(calendarTestViewer.eventId)
    .run();
  await env.DB.prepare(
    `
    INSERT OR IGNORE INTO sender_profiles (
      id, event_id, name, from_name, from_email, provider, status, created_at, updated_at
    ) VALUES ('sender-calendar-tests', ?, 'Calendar test', 'Future of Events', 'calendar@example.com',
              'resend', 'verified', unixepoch(), unixepoch())
  `,
  )
    .bind(calendarTestViewer.eventId)
    .run();
  const token = crypto.randomUUID().slice(0, 8);
  const sessionId = `session-calendar-${token}`;
  const version = await env.DB.prepare(
    "SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM schedule_versions WHERE event_id = ?",
  )
    .bind(calendarTestViewer.eventId)
    .first<{ value: number }>();
  const scheduleVersionId = `schedule-calendar-${token}`;
  const startsAt = Math.floor(Date.parse("2025-05-20T14:00:00Z") / 1_000);
  const endsAt = Math.floor(Date.parse("2025-05-20T15:00:00Z") / 1_000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE schedule_versions SET status = 'archived'
      WHERE event_id = ? AND status = 'published'`,
    ).bind(calendarTestViewer.eventId),
    env.DB.prepare(
      `INSERT INTO sessions (
      id, event_id, title, slug, description, format, duration_minutes, status, visibility, created_at, updated_at
    ) VALUES (?, ?, 'Calendar lifecycle session', ?, 'A reliable lifecycle test.', 'presentation', 60, 'published', 'public', unixepoch(), unixepoch())`,
    ).bind(
      sessionId,
      calendarTestViewer.eventId,
      `calendar-lifecycle-${token}`,
    ),
    env.DB.prepare(
      `INSERT INTO session_speakers (
        session_id, event_id, person_id, position,
        participation_status, participation_confirmed_at, visibility
      ) VALUES (?, ?, 'person-demo-speaker', 0, 'confirmed', unixepoch(), 'public')`,
    ).bind(sessionId, calendarTestViewer.eventId),
    env.DB.prepare(
      `INSERT INTO schedule_versions (
      id, event_id, version_number, name, status, created_by_person_id, created_at, published_at
    ) VALUES (?, ?, ?, 'Calendar tests', 'published', ?, unixepoch(), unixepoch())`,
    ).bind(
      scheduleVersionId,
      calendarTestViewer.eventId,
      version?.value ?? 1,
      calendarTestViewer.personId,
    ),
    env.DB.prepare(
      `INSERT INTO schedule_entries (
      id, event_id, schedule_version_id, session_id, room_id, starts_at, ends_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, 'main', ?, ?, unixepoch(), unixepoch())`,
    ).bind(
      `entry-calendar-${token}`,
      calendarTestViewer.eventId,
      scheduleVersionId,
      sessionId,
      startsAt,
      endsAt,
    ),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE schedule_session_contents
          SET content_status = 'approved', approved_by_person_id = ?,
              approved_at = unixepoch(), approval_source = 'editorial'
        WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?`,
    ).bind(
      calendarTestViewer.personId,
      scheduleVersionId,
      calendarTestViewer.eventId,
      sessionId,
    ),
    env.DB.prepare(
      `UPDATE session_content_revisions
          SET content_status = 'approved', created_by_person_id = ?
        WHERE schedule_version_id = ? AND event_id = ? AND session_id = ?`,
    ).bind(
      calendarTestViewer.personId,
      scheduleVersionId,
      calendarTestViewer.eventId,
      sessionId,
    ),
  ]);
  return {
    testEnv,
    queued,
    realtime,
    sessionId,
    scheduleVersionId,
    startsAt,
    endsAt,
  };
}
