import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  DEMO_IDENTITY,
  DEMO_ORGANISATION_ID,
  SBEK_SECOND_SPEAKER,
} from "./demo-identities";
import { CANONICAL_EVENT_FILE_POLICY_JSON } from "~/modules/files/file-policy";
import { INITIAL_EVENT_SESSION_FORMATS_JSON } from "~/modules/events/event-configuration";

export {
  DEMO_IDENTITY_COOKIE,
  DEMO_IDENTITIES,
  DEMO_IDENTITY,
  isDemoIdentityKey,
  type DemoIdentityKey,
} from "./demo-identities";

const DEMO_ADMIN_ID = DEMO_IDENTITY.personId;

const DEMO_PUBLIC_SESSION_DESCRIPTIONS: Record<string, string> = {
  "demo-session-1":
    "A practical session about the future of attendee engagement. Explore inclusive registration, calm wayfinding and measurable moments that help people feel informed, welcomed and ready to participate from the first touchpoint through the closing conversation.",
  "demo-session-2":
    "A practical session about AI in event operations. Learn the concrete patterns, trade-offs and small operational choices that make a modern conference easier to navigate and more useful for every attendee.",
  "demo-session-3":
    "A practical session about designing inclusive hybrid experiences. Learn the concrete patterns, trade-offs and small operational choices that make a modern conference easier to navigate and more useful for every attendee.",
  "demo-session-4":
    "A practical session about community and connection. Learn the concrete patterns, trade-offs and small operational choices that make a modern conference easier to navigate and more useful for every attendee.",
  "demo-session-5":
    "A practical session about building better event data. Learn the concrete patterns, trade-offs and small operational choices that make a modern conference easier to navigate and more useful for every attendee.",
};

export async function ensureDemoData(env: CloudflareEnvironment) {
  if (String(env.DEMO_MODE) !== "true") return;
  if (!env.DB) throw new Error("Required Cloudflare binding DB is unavailable");
  await env.DB.batch([
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO organisations (id, name, slug, created_at, updated_at)
      VALUES (?, 'Future Events Association', 'future-events-association', unixepoch(), unixepoch())
    `,
    ).bind(DEMO_ORGANISATION_ID),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO people (
        id, email, display_name, email_verified, profile_status, created_at, updated_at
      ) VALUES (?, ?, ?, 1, ?, unixepoch(), unixepoch())
    `,
    ).bind(
      DEMO_ADMIN_ID,
      DEMO_IDENTITY.email,
      DEMO_IDENTITY.name,
      DEMO_IDENTITY.profileStatus,
    ),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO organisation_ai_settings (
        organisation_id, provider, model, revision,
        last_updated_by_person_id, created_at, updated_at
      ) VALUES (?, 'openai', 'gpt-5.6-terra', 1, ?, unixepoch(), unixepoch())
    `,
    ).bind(DEMO_ORGANISATION_ID, DEMO_ADMIN_ID),
    ...[
      ...Object.entries(DEMO_IDENTITIES)
        .filter(([identityKey]) => identityKey !== "administrator")
        .map(([, identity]) => identity),
      SBEK_SECOND_SPEAKER,
    ].map((identity) =>
      env.DB.prepare(
        `
        INSERT OR IGNORE INTO people (
          id, email, display_name, email_verified, profile_status, created_at, updated_at
        ) VALUES (?, ?, ?, 1, ?, unixepoch(), unixepoch())
      `,
      ).bind(
        identity.personId,
        identity.email,
        identity.name,
        identity.profileStatus,
      ),
    ),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO events (
        id, organisation_id, name, slug, timezone, starts_at, ends_at,
        venue_name, city, description, brand_accent, repository_provider,
        session_formats_json,
        retention_months, submission_access_mode, allow_anonymous_drafts,
        duplicate_person_warnings, file_policy_json, revision, last_updated_by_person_id,
        created_at, updated_at
      ) VALUES (
        ?, ?, 'Future of Events 2025', 'future-of-events-2025', 'America/Toronto',
        unixepoch('2025-05-20T00:00:00Z'), unixepoch('2025-05-22T23:59:59Z'),
        'Metro Toronto Convention Centre', 'Toronto',
        'The conference for modern event professionals.', '#4f46e5', 'd1',
        ?, 24, 'email_verified', 1, 1, ?, 1, ?, unixepoch(), unixepoch()
      )
    `,
    ).bind(
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      INITIAL_EVENT_SESSION_FORMATS_JSON,
      CANONICAL_EVENT_FILE_POLICY_JSON,
      DEMO_ADMIN_ID,
    ),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO memberships (
        id, organisation_id, event_id, person_id, role, invited_at, accepted_at, created_at
      ) VALUES ('membership-demo-admin', ?, ?, ?, 'administrator', unixepoch(), unixepoch(), unixepoch())
    `,
    ).bind(DEMO_ORGANISATION_ID, DEMO_EVENT_ID, DEMO_ADMIN_ID),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO memberships (
        id, organisation_id, event_id, person_id, role, invited_at, accepted_at, created_at
      ) VALUES ('membership-demo-owner', ?, NULL, ?, 'owner', unixepoch(), unixepoch(), unixepoch())
    `,
    ).bind(DEMO_ORGANISATION_ID, DEMO_IDENTITIES.owner.personId),
    ...(["evaluator", "submitter", "speaker"] as const).map((identityKey) => {
      const identity = DEMO_IDENTITIES[identityKey];
      return env.DB.prepare(
        `
        INSERT OR IGNORE INTO memberships (
          id, organisation_id, event_id, person_id, role, invited_at, accepted_at, created_at
        ) VALUES (?, ?, ?, ?, ?, unixepoch(), unixepoch(), unixepoch())
      `,
      ).bind(
        `membership-demo-${identityKey}`,
        DEMO_ORGANISATION_ID,
        DEMO_EVENT_ID,
        identity.personId,
        identity.role,
      );
    }),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO memberships (
        id, organisation_id, event_id, person_id, role, invited_at, accepted_at, created_at
      ) VALUES ('membership-demo-submitter-speaker', ?, ?, ?, 'speaker', unixepoch(), unixepoch(), unixepoch())
    `,
    ).bind(
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_IDENTITIES.submitter.personId,
    ),
    ...[
      ["main", "Main Stage", 1200],
      ["301a", "Room 301A", 300],
      ["301b", "Room 301B", 200],
      ["302", "Room 302", 150],
      ["303", "Room 303", 150],
    ].map(([id, name, capacity], position) =>
      env.DB.prepare(
        `
      INSERT OR IGNORE INTO rooms (id, event_id, name, capacity, position)
      VALUES (?, ?, ?, ?, ?)
    `,
      ).bind(id, DEMO_EVENT_ID, name, capacity, position),
    ),
    ...[
      ["demo-track-leadership", "Leadership", "leadership", "#7c3aed", 0],
      ["demo-track-ai", "AI & Innovation", "ai-innovation", "#4f46e5", 1],
      [
        "demo-track-experience",
        "Experience Design",
        "experience-design",
        "#0f766e",
        2,
      ],
      [
        "demo-track-operations",
        "Event Operations",
        "event-operations",
        "#b45309",
        3,
      ],
    ].map(([id, name, slug, colour, position]) =>
      env.DB.prepare(
        `INSERT OR IGNORE INTO tracks (
           id, event_id, name, slug, colour_token, position, exclusive, is_public
         ) VALUES (?, ?, ?, ?, ?, ?, 0, 1)`,
      ).bind(id, DEMO_EVENT_ID, name, slug, colour, position),
    ),
  ]);
}

export async function ensureDemoProgramme(env: CloudflareEnvironment) {
  if (String(env.DEMO_MODE) !== "true") return;
  await ensureDemoData(env);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE people
          SET biography = CASE
                WHEN biography IS NULL OR biography = '' THEN ?
                ELSE biography
              END,
              organisation_name = COALESCE(NULLIF(organisation_name, ''), 'Northstar Events'),
              job_title = COALESCE(NULLIF(job_title, ''), 'Product Strategy Lead'),
              updated_at = unixepoch()
        WHERE id = 'person-demo-submitter' AND profile_status = 'published'`,
    ).bind(
      "Alex Morgan designs data-informed attendee experiences and practical operating systems for teams running complex events.",
    ),
    env.DB.prepare(
      `UPDATE people
          SET biography = CASE
                WHEN biography IS NULL OR biography = 'Priya helps event teams design useful, inclusive technology experiences.' THEN ?
                ELSE biography
              END,
              pronunciation = COALESCE(pronunciation, 'PREE-yah SHAH'),
              organisation_name = COALESCE(NULLIF(organisation_name, ''), 'EventLab'),
              job_title = COALESCE(NULLIF(job_title, ''), 'Director of Experience Design'),
              updated_at = unixepoch()
        WHERE id = 'person-demo-speaker' AND profile_status = 'published'`,
    ).bind(
      "Priya Shah helps event teams design useful, inclusive technology experiences. Her work brings together service design, accessible interaction patterns and the practical details that help busy conferences feel calm, welcoming and easy to navigate for every attendee.",
    ),
  ]);
  const updatePublishedDemoDescriptions = async () => {
    await env.DB.batch(
      Object.entries(DEMO_PUBLIC_SESSION_DESCRIPTIONS).map(
        ([sessionId, description]) =>
          env.DB.prepare(
            `UPDATE schedule_session_contents
                  SET description = ?, content_status = 'approved',
                      approved_by_person_id = ?,
                      approved_at = COALESCE(approved_at, unixepoch()),
                      updated_at = unixepoch()
                WHERE schedule_version_id = 'demo-schedule-published'
                  AND event_id = ? AND session_id = ?
                  AND visibility = 'public'
                  AND (description IS NULL OR length(description) <= 180)`,
          ).bind(description, DEMO_ADMIN_ID, DEMO_EVENT_ID, sessionId),
      ),
    );
    await env.DB.prepare(
      `UPDATE session_content_revisions
          SET description = (
                SELECT content.description
                  FROM schedule_session_contents content
                 WHERE content.schedule_version_id = session_content_revisions.schedule_version_id
                   AND content.event_id = session_content_revisions.event_id
                   AND content.session_id = session_content_revisions.session_id
              ),
              content_status = 'approved',
              created_by_person_id = COALESCE(created_by_person_id, ?)
        WHERE schedule_version_id = 'demo-schedule-published'
          AND event_id = ? AND revision_number = 1`,
    )
      .bind(DEMO_ADMIN_ID, DEMO_EVENT_ID)
      .run();
  };
  const published = await env.DB.prepare(
    "SELECT id FROM schedule_versions WHERE event_id = ? AND status = 'published'",
  )
    .bind(DEMO_EVENT_ID)
    .first();
  if (published) {
    await updatePublishedDemoDescriptions();
    return;
  }
  const sessions = [
    [
      "demo-session-1",
      "The Future of Attendee Engagement",
      "future-attendee-engagement",
      "keynote",
      "demo-track-leadership",
      45,
      900,
    ],
    [
      "demo-session-2",
      "AI in Event Operations",
      "ai-event-operations",
      "presentation",
      "demo-track-ai",
      60,
      260,
    ],
    [
      "demo-session-3",
      "Designing Inclusive Hybrid Experiences",
      "inclusive-hybrid",
      "workshop",
      "demo-track-experience",
      60,
      180,
    ],
    [
      "demo-session-4",
      "Community and Connection",
      "community-connection",
      "panel",
      "demo-track-operations",
      45,
      140,
    ],
    [
      "demo-session-5",
      "Building Better Event Data",
      "better-event-data",
      "breakout",
      "demo-track-ai",
      60,
      130,
    ],
  ] as const;
  const entries = [
    [
      "demo-entry-1",
      "demo-session-1",
      "main",
      "2025-05-20T13:00:00Z",
      "2025-05-20T13:45:00Z",
    ],
    [
      "demo-entry-2",
      "demo-session-2",
      "301a",
      "2025-05-20T14:00:00Z",
      "2025-05-20T15:00:00Z",
    ],
    [
      "demo-entry-3",
      "demo-session-3",
      "301b",
      "2025-05-20T15:15:00Z",
      "2025-05-20T16:15:00Z",
    ],
    [
      "demo-entry-4",
      "demo-session-4",
      "302",
      "2025-05-21T13:30:00Z",
      "2025-05-21T14:15:00Z",
    ],
    [
      "demo-entry-5",
      "demo-session-5",
      "303",
      "2025-05-21T17:00:00Z",
      "2025-05-21T18:00:00Z",
    ],
  ] as const;
  await env.DB.batch([
    ...[
      ["demo-track-leadership", "Leadership", "leadership", "#7c3aed", 0],
      ["demo-track-ai", "AI & Innovation", "ai-innovation", "#4f46e5", 1],
      [
        "demo-track-experience",
        "Experience Design",
        "experience-design",
        "#0f766e",
        2,
      ],
      [
        "demo-track-operations",
        "Event Operations",
        "event-operations",
        "#b45309",
        3,
      ],
    ].map(([id, name, slug, colour, position]) =>
      env.DB.prepare(
        `
      INSERT OR IGNORE INTO tracks (id, event_id, name, slug, colour_token, position, exclusive, is_public)
      VALUES (?, ?, ?, ?, ?, ?, 0, 1)
    `,
      ).bind(id, DEMO_EVENT_ID, name, slug, colour, position),
    ),
    ...sessions.map(
      ([id, title, slug, format, trackId, duration, attendance]) =>
        env.DB.prepare(
          `
      INSERT OR IGNORE INTO sessions (
        id, event_id, track_id, title, slug, description, format, duration_minutes,
        expected_attendance, status, visibility, revision, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'published', 'public', 1, unixepoch(), unixepoch())
    `,
        ).bind(
          id,
          DEMO_EVENT_ID,
          trackId,
          title,
          slug,
          `A practical session about ${title.toLowerCase()}.`,
          format,
          duration,
          attendance,
        ),
    ),
    ...sessions.map(([id], position) =>
      env.DB.prepare(
        `
      INSERT OR IGNORE INTO session_speakers (
        session_id, event_id, person_id, position, role_label,
        participation_status, participation_confirmed_at, visibility
      )
      VALUES (?, ?, ?, 0, 'Speaker', 'confirmed', unixepoch(), 'public')
    `,
      ).bind(
        id,
        DEMO_EVENT_ID,
        position % 2 === 0
          ? DEMO_IDENTITIES.speaker.personId
          : DEMO_IDENTITIES.submitter.personId,
      ),
    ),
    env.DB.prepare(
      `
      INSERT OR IGNORE INTO schedule_versions (
        id, event_id, version_number, name, status, revision, created_by_person_id, created_at, published_at
      ) VALUES ('demo-schedule-published', ?, 1, 'Published demo programme', 'published', 1, ?, unixepoch(), unixepoch())
    `,
    ).bind(DEMO_EVENT_ID, DEMO_ADMIN_ID),
    ...entries.map(([id, sessionId, roomId, startsAt, endsAt]) =>
      env.DB.prepare(
        `
      INSERT OR IGNORE INTO schedule_entries (
        id, event_id, schedule_version_id, session_id, room_id, starts_at, ends_at, revision, created_at, updated_at
      ) VALUES (?, ?, 'demo-schedule-published', ?, ?, unixepoch(?), unixepoch(?), 1, unixepoch(), unixepoch())
    `,
      ).bind(id, DEMO_EVENT_ID, sessionId, roomId, startsAt, endsAt),
    ),
    env.DB.prepare(
      "UPDATE events SET programme_published_at = COALESCE(programme_published_at, unixepoch()), updated_at = unixepoch() WHERE id = ?",
    ).bind(DEMO_EVENT_ID),
  ]);
  await updatePublishedDemoDescriptions();
}
