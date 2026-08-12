import { env } from "cloudflare:test";

import { ensureDemoData } from "~/platform/demo/seed.server";
import type { Viewer } from "~/platform/auth/authorize.server";

export const scheduleTestViewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

export const scheduleTestEnv = new Proxy(
  env as unknown as CloudflareEnvironment,
  {
    get(target, property, receiver) {
      if (property === "OPERATIONS_QUEUE") {
        return {
          send: async () => ({
            metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
          }),
        } satisfies Pick<Queue, "send">;
      }
      return Reflect.get(target, property, receiver);
    },
  },
);

export async function prepareScheduleServiceTest() {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM schedule_versions WHERE event_id = ?").bind(
      scheduleTestViewer.eventId,
    ),
    env.DB.prepare(
      "UPDATE events SET programme_published_at = NULL WHERE id = ?",
    ).bind(scheduleTestViewer.eventId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO schedule_policies (event_id) VALUES (?)",
    ).bind(scheduleTestViewer.eventId),
    env.DB.prepare(
      `UPDATE schedule_policies
          SET room_overlap_action = 'block', speaker_overlap_action = 'block',
              required_resource_overlap_action = 'block',
              exclusive_track_overlap_action = 'warn',
              event_boundary_action = 'block', capacity_action = 'warn',
              minimum_turnaround_minutes = 0
        WHERE event_id = ?`,
    ).bind(scheduleTestViewer.eventId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO tracks (id, event_id, name, slug, position) VALUES ('schedule-test-track', ?, 'Operations', 'operations', 0)",
    ).bind(scheduleTestViewer.eventId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO sessions (id, event_id, track_id, title, slug, format, duration_minutes, expected_attendance, status, visibility, revision, created_at, updated_at) VALUES ('schedule-test-one', ?, 'schedule-test-track', 'First test session', 'first-test-session', 'presentation', 60, 100, 'unscheduled', 'public', 1, unixepoch(), unixepoch())`,
    ).bind(scheduleTestViewer.eventId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO sessions (id, event_id, track_id, title, slug, format, duration_minutes, expected_attendance, status, visibility, revision, created_at, updated_at) VALUES ('schedule-test-two', ?, 'schedule-test-track', 'Second test session', 'second-test-session', 'panel', 60, 100, 'unscheduled', 'public', 1, unixepoch(), unixepoch())`,
    ).bind(scheduleTestViewer.eventId),
    env.DB.prepare(
      `UPDATE sessions
          SET status = 'unscheduled', required_resources_json = '[]'
        WHERE event_id = ?
          AND id IN ('schedule-test-one', 'schedule-test-two')`,
    ).bind(scheduleTestViewer.eventId),
    env.DB.prepare(
      `UPDATE rooms SET resources_json = '[]'
        WHERE event_id = ? AND id IN ('main', '301a')`,
    ).bind(scheduleTestViewer.eventId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO session_speakers (session_id, event_id, person_id, position, role_label, visibility) VALUES ('schedule-test-one', ?, 'person-demo-speaker', 0, 'Speaker', 'public')",
    ).bind(scheduleTestViewer.eventId),
    env.DB.prepare(
      "INSERT OR IGNORE INTO session_speakers (session_id, event_id, person_id, position, role_label, visibility) VALUES ('schedule-test-two', ?, 'person-demo-submitter', 0, 'Speaker', 'public')",
    ).bind(scheduleTestViewer.eventId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO memberships (
         id, organisation_id, event_id, person_id, role, invited_at,
         accepted_at, created_at
       ) VALUES (
         'schedule-test-submitter-speaker', ?, ?, 'person-demo-submitter',
         'speaker', unixepoch(), unixepoch(), unixepoch()
       )`,
    ).bind(scheduleTestViewer.organisationId, scheduleTestViewer.eventId),
    env.DB.prepare(
      `UPDATE memberships
          SET accepted_at = unixepoch(), invitation_expires_at = NULL,
              revoked_at = NULL
        WHERE event_id = ? AND person_id = 'person-demo-submitter'
          AND role = 'speaker'`,
    ).bind(scheduleTestViewer.eventId),
  ]);
}

export async function approveScheduledTestContent(
  versionId: string,
  scope: Pick<Viewer, "eventId" | "personId"> = scheduleTestViewer,
) {
  const result = await env.DB.prepare(
    `UPDATE schedule_session_contents
        SET content_status = 'approved',
            approved_by_person_id = ?, approved_at = unixepoch()
      WHERE event_id = ? AND schedule_version_id = ?
        AND session_id IN (
          SELECT session_id FROM schedule_entries
           WHERE event_id = ? AND schedule_version_id = ?
        )`,
  )
    .bind(scope.personId, scope.eventId, versionId, scope.eventId, versionId)
    .run();
  if ((result.meta.changes ?? 0) === 0) {
    throw new Error(
      "The publication test has no scheduled content to approve.",
    );
  }
}
