import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { ensureDemoData } from "~/platform/demo/seed.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  D1EventRepository,
  EventPublishedScheduleConflictError,
  EventPublishedProgrammeSlugError,
  EventRevisionConflictError,
  EventRoomOwnershipError,
  EventSlugConflictError,
} from "./event-repository.server";
import { eventSetupInputSchema } from "./event-schema";
import { EventService } from "./event-service.server";

declare module "cloudflare:test" {
  interface ProvidedEnv {
    DB: D1Database;
    APP_ENV: string;
    DEMO_MODE: string;
    DEFAULT_EVENT_ID: string;
    BETTER_AUTH_URL: string;
  }
}

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

function inputFrom(event: Awaited<ReturnType<EventService["getSetup"]>>) {
  return {
    revision: event.revision,
    name: event.name,
    timezone: event.timezone,
    startDate: event.startDate,
    endDate: event.endDate,
    venue: event.venue,
    city: event.city,
    publicSlug: event.publicSlug,
    brandAccent: event.brandAccent,
    description: event.description,
    repositoryProvider: event.repositoryProvider,
    retentionMonths: event.retentionMonths,
    submissionAccessMode: event.submissionAccessMode,
    allowAnonymousDrafts: event.allowAnonymousDrafts,
    duplicatePersonWarnings: event.duplicatePersonWarnings,
    rooms: event.rooms,
  };
}

describe("Event Setup D1 service", () => {
  it("accepts arbitrary runtime-supported IANA timezones", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const current = await new EventService(testEnv).getSetup(viewer);
    const input = inputFrom(current);

    expect(
      eventSetupInputSchema.parse({ ...input, timezone: "UTC" }).timezone,
    ).toBe("UTC");
    expect(
      eventSetupInputSchema.parse({ ...input, timezone: "Asia/Kathmandu" })
        .timezone,
    ).toBe("Asia/Kathmandu");
    expect(() =>
      eventSetupInputSchema.parse({ ...input, timezone: "Not/A_Timezone" }),
    ).toThrow(/valid IANA timezone/i);
  });

  it("persists tenant-scoped settings and records an audit event", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new EventService(testEnv);
    const original = await service.getSetup(viewer);

    await service.saveSetup(viewer, {
      ...inputFrom(original),
      venue: "Beanfield Centre",
      rooms: [
        ...original.rooms,
        {
          id: "room-test-suite",
          name: "Test Suite",
          capacity: 42,
          position: 5,
        },
      ],
    });

    const saved = await service.getSetup(viewer);
    expect(saved.venue).toBe("Beanfield Centre");
    expect(saved.revision).toBe(original.revision + 1);
    expect(saved.rooms.at(-1)).toMatchObject({
      id: "room-test-suite",
      name: "Test Suite",
      capacity: 42,
    });

    const audit = await env.DB.prepare(
      `
      SELECT actor_person_id AS actorPersonId, action, metadata_json AS metadataJson
        FROM audit_events
       WHERE event_id = ? AND action = 'event.settings.updated'
       ORDER BY created_at DESC
       LIMIT 1
    `,
    )
      .bind(viewer.eventId)
      .first<{ actorPersonId: string; action: string; metadataJson: string }>();
    expect(audit?.actorPersonId).toBe(viewer.personId);
    expect(audit?.action).toBe("event.settings.updated");
    expect(JSON.parse(audit?.metadataJson ?? "{}").revision).toBe(
      saved.revision,
    );
  });

  it("rejects stale revisions without adding rooms or audit records", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new EventService(testEnv);
    const current = await service.getSetup(viewer);
    const auditBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_events",
    ).first<{ count: number }>();

    await expect(
      service.saveSetup(viewer, {
        ...inputFrom(current),
        revision: current.revision - 1,
        rooms: [
          ...current.rooms,
          {
            id: "room-from-stale-write",
            name: "Stale",
            capacity: 10,
            position: 99,
          },
        ],
      }),
    ).rejects.toBeInstanceOf(EventRevisionConflictError);

    const room = await env.DB.prepare(
      "SELECT id FROM rooms WHERE id = 'room-from-stale-write'",
    ).first();
    const auditAfter = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_events",
    ).first<{ count: number }>();
    expect(room).toBeNull();
    expect(auditAfter?.count).toBe(auditBefore?.count);
  });

  it("rejects a room identifier owned by another event without partial changes", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new EventService(testEnv);
    const current = await service.getSetup(viewer);
    const otherOrganisationId = `org-room-owner-${crypto.randomUUID()}`;
    const otherEventId = `event-room-owner-${crypto.randomUUID()}`;
    const foreignRoomId = `room-${crypto.randomUUID()}`;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organisations (id, name, slug) VALUES (?, 'Other organisation', ?)",
      ).bind(otherOrganisationId, `other-org-${crypto.randomUUID()}`),
      env.DB.prepare(
        `INSERT INTO events (
          id, organisation_id, name, slug, timezone, starts_at, ends_at
        ) VALUES (?, ?, 'Other event', ?, 'UTC', unixepoch(), unixepoch() + 86400)`,
      ).bind(
        otherEventId,
        otherOrganisationId,
        `other-event-${crypto.randomUUID()}`,
      ),
      env.DB.prepare(
        "INSERT INTO rooms (id, event_id, name, capacity, position) VALUES (?, ?, 'Foreign room', 20, 0)",
      ).bind(foreignRoomId, otherEventId),
    ]);
    const auditBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE event_id = ? AND action = 'event.settings.updated'",
    )
      .bind(viewer.eventId)
      .first<{ count: number }>();

    await expect(
      service.saveSetup(viewer, {
        ...inputFrom(current),
        name: "Must remain unchanged",
        rooms: [
          ...current.rooms,
          { id: foreignRoomId, name: "Hijacked", capacity: 99, position: 99 },
        ],
      }),
    ).rejects.toBeInstanceOf(EventRoomOwnershipError);

    const after = await service.getSetup(viewer);
    const foreignRoom = await env.DB.prepare(
      "SELECT event_id AS eventId, name FROM rooms WHERE id = ?",
    )
      .bind(foreignRoomId)
      .first<{ eventId: string; name: string }>();
    const auditAfter = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM audit_events WHERE event_id = ? AND action = 'event.settings.updated'",
    )
      .bind(viewer.eventId)
      .first<{ count: number }>();
    expect(after.name).toBe(current.name);
    expect(after.revision).toBe(current.revision);
    expect(foreignRoom).toEqual({
      eventId: otherEventId,
      name: "Foreign room",
    });
    expect(auditAfter?.count).toBe(auditBefore?.count);
  });

  it("rejects date or timezone changes while a schedule is published", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new EventService(testEnv);
    const current = await service.getSetup(viewer);
    await env.DB.prepare(
      `INSERT INTO schedule_versions (
        id, event_id, version_number, name, status, revision,
        created_by_person_id, created_at, published_at
      ) VALUES (?, ?, 1, 'Published boundary', 'published', 1, ?, unixepoch(), unixepoch())`,
    )
      .bind(
        `published-boundary-${crypto.randomUUID()}`,
        viewer.eventId,
        viewer.personId,
      )
      .run();

    await expect(
      service.saveSetup(viewer, {
        ...inputFrom(current),
        timezone: "Europe/London",
      }),
    ).rejects.toBeInstanceOf(EventPublishedScheduleConflictError);

    await expect(service.getSetup(viewer)).resolves.toMatchObject({
      revision: current.revision,
      timezone: current.timezone,
      startDate: current.startDate,
      endDate: current.endDate,
    });
  });

  it("rejects room capacity changes that violate a blocking published schedule", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new EventService(testEnv);
    const current = await service.getSetup(viewer);
    const room = current.rooms[0];
    expect(room.capacity).toBeGreaterThan(1);
    const suffix = crypto.randomUUID().slice(0, 8);
    let published = await env.DB.prepare(
      "SELECT id FROM schedule_versions WHERE event_id = ? AND status = 'published' LIMIT 1",
    )
      .bind(viewer.eventId)
      .first<{ id: string }>();
    if (!published) {
      const nextVersion = await env.DB.prepare(
        "SELECT COALESCE(MAX(version_number), 0) + 1 AS value FROM schedule_versions WHERE event_id = ?",
      )
        .bind(viewer.eventId)
        .first<{ value: number }>();
      const id = `capacity-published-${suffix}`;
      await env.DB.prepare(
        `INSERT INTO schedule_versions (
          id, event_id, version_number, name, status, revision,
          created_by_person_id, created_at, published_at
        ) VALUES (?, ?, ?, 'Capacity boundary', 'published', 1, ?, unixepoch(), unixepoch())`,
      )
        .bind(id, viewer.eventId, nextVersion?.value ?? 1, viewer.personId)
        .run();
      published = { id };
    }
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE schedule_policies SET capacity_action = 'block' WHERE event_id = ?",
      ).bind(viewer.eventId),
      env.DB.prepare(
        `INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes,
          expected_attendance, status, visibility, revision, created_at, updated_at
        ) VALUES (?, ?, 'Capacity boundary session', ?, 'presentation', 30,
                  ?, 'published', 'public', 1, unixepoch(), unixepoch())`,
      ).bind(
        `capacity-session-${suffix}`,
        viewer.eventId,
        `capacity-session-${suffix}`,
        room.capacity,
      ),
      env.DB.prepare(
        `INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 2_000_000_000, 2_000_001_800, 1,
                  unixepoch(), unixepoch())`,
      ).bind(
        `capacity-entry-${suffix}`,
        viewer.eventId,
        published.id,
        `capacity-session-${suffix}`,
        room.id,
      ),
    ]);

    await expect(
      service.saveSetup(viewer, {
        ...inputFrom(current),
        rooms: current.rooms.map((candidate) =>
          candidate.id === room.id
            ? { ...candidate, capacity: room.capacity - 1 }
            : candidate,
        ),
      }),
    ).rejects.toBeInstanceOf(EventPublishedScheduleConflictError);

    await expect(service.getSetup(viewer)).resolves.toMatchObject({
      revision: current.revision,
      rooms: expect.arrayContaining([
        expect.objectContaining({ id: room.id, capacity: room.capacity }),
      ]),
    });
  });

  it("retires a historically referenced room without deleting schedule history", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new EventService(testEnv);
    const current = await service.getSetup(viewer);
    const suffix = crypto.randomUUID().slice(0, 8);
    const roomId = `room-history-${suffix}`;
    const latestScheduleVersion = await env.DB.prepare(
      "SELECT COALESCE(MAX(version_number), 0) AS versionNumber FROM schedule_versions WHERE event_id = ?",
    )
      .bind(viewer.eventId)
      .first<{ versionNumber: number }>();

    await service.saveSetup(viewer, {
      ...inputFrom(current),
      rooms: [
        ...current.rooms,
        { id: roomId, name: "Historic room", capacity: 40, position: 99 },
      ],
    });
    const withRoom = await service.getSetup(viewer);
    const sessionId = `session-history-${suffix}`;
    const scheduleId = `schedule-history-${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, status,
          visibility, revision, created_at, updated_at
        ) VALUES (?, ?, 'Historic session', ?, 'presentation', 30,
                  'archived', 'private', 1, unixepoch(), unixepoch())`,
      ).bind(sessionId, viewer.eventId, `historic-${suffix}`),
      env.DB.prepare(
        `INSERT INTO schedule_versions (
          id, event_id, version_number, name, status, revision,
          created_by_person_id, created_at
        ) VALUES (?, ?, ?, 'Historic version', 'archived', 1, ?, unixepoch())`,
      ).bind(
        scheduleId,
        viewer.eventId,
        (latestScheduleVersion?.versionNumber ?? 0) + 1,
        viewer.personId,
      ),
      env.DB.prepare(
        `INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 2_000_000_000, 2_000_001_800, 1,
                  unixepoch(), unixepoch())`,
      ).bind(
        `entry-history-${suffix}`,
        viewer.eventId,
        scheduleId,
        sessionId,
        roomId,
      ),
    ]);

    await service.saveSetup(viewer, {
      ...inputFrom(withRoom),
      rooms: withRoom.rooms.filter((room) => room.id !== roomId),
    });

    expect((await service.getSetup(viewer)).rooms).not.toContainEqual(
      expect.objectContaining({ id: roomId }),
    );
    await expect(
      env.DB.prepare(
        `SELECT r.name, r.status
           FROM schedule_entries se JOIN rooms r ON r.id = se.room_id
          WHERE se.id = ?`,
      )
        .bind(`entry-history-${suffix}`)
        .first(),
    ).resolves.toEqual({ name: "Historic room", status: "retired" });
  });

  it("keeps a room active while a current schedule references it", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new EventService(testEnv);
    const current = await service.getSetup(viewer);
    const referencedRoomId = current.rooms[0]?.id;
    expect(referencedRoomId).toBeTruthy();
    const suffix = crypto.randomUUID().slice(0, 8);
    const sessionId = `session-current-${suffix}`;
    const scheduleId = `schedule-current-${suffix}`;
    const latestScheduleVersion = await env.DB.prepare(
      "SELECT COALESCE(MAX(version_number), 0) AS versionNumber FROM schedule_versions WHERE event_id = ?",
    )
      .bind(viewer.eventId)
      .first<{ versionNumber: number }>();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, status,
          visibility, revision, created_at, updated_at
        ) VALUES (?, ?, 'Current session', ?, 'presentation', 30,
                  'scheduled', 'private', 1, unixepoch(), unixepoch())`,
      ).bind(sessionId, viewer.eventId, `current-${suffix}`),
      env.DB.prepare(
        `INSERT INTO schedule_versions (
          id, event_id, version_number, name, status, revision,
          created_by_person_id, created_at
        ) VALUES (?, ?, ?, 'Current draft', 'draft', 1, ?, unixepoch())`,
      ).bind(
        scheduleId,
        viewer.eventId,
        (latestScheduleVersion?.versionNumber ?? 0) + 1,
        viewer.personId,
      ),
      env.DB.prepare(
        `INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id,
          starts_at, ends_at, revision, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 2_000_000_000, 2_000_001_800, 1,
                  unixepoch(), unixepoch())`,
      ).bind(
        `entry-current-${suffix}`,
        viewer.eventId,
        scheduleId,
        sessionId,
        referencedRoomId,
      ),
    ]);

    await expect(
      service.saveSetup(viewer, {
        ...inputFrom(current),
        rooms: current.rooms.filter((room) => room.id !== referencedRoomId),
      }),
    ).rejects.toThrow("Move scheduled sessions before removing a room.");

    await expect(service.getSetup(viewer)).resolves.toMatchObject({
      revision: current.revision,
      rooms: expect.arrayContaining([
        expect.objectContaining({ id: referencedRoomId }),
      ]),
    });
  });

  it("reports a public-slug conflict without partially saving Event Setup", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new EventService(testEnv);
    const current = await service.getSetup(viewer);
    await env.DB.prepare(
      `
      INSERT INTO events (id, organisation_id, name, slug, timezone, starts_at, ends_at)
      VALUES ('event-with-reserved-slug', ?, 'Reserved slug event', 'reserved-event-slug',
              'UTC', 1, 2)
    `,
    )
      .bind(viewer.organisationId)
      .run();
    const auditBefore = await env.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM audit_events
       WHERE event_id = ? AND action = 'event.settings.updated'
    `,
    )
      .bind(viewer.eventId)
      .first<{ count: number }>();

    await expect(
      service.saveSetup(viewer, {
        ...inputFrom(current),
        name: "Must not be persisted",
        publicSlug: "reserved-event-slug",
      }),
    ).rejects.toBeInstanceOf(EventSlugConflictError);

    const after = await service.getSetup(viewer);
    const auditAfter = await env.DB.prepare(
      `
      SELECT COUNT(*) AS count FROM audit_events
       WHERE event_id = ? AND action = 'event.settings.updated'
    `,
    )
      .bind(viewer.eventId)
      .first<{ count: number }>();
    expect(after.name).toBe(current.name);
    expect(after.publicSlug).toBe(current.publicSlug);
    expect(after.revision).toBe(current.revision);
    expect(auditAfter?.count).toBe(auditBefore?.count);
  });

  it("locks the event slug after programme publication", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    await testEnv.DB.prepare(
      "UPDATE events SET programme_published_at = unixepoch() WHERE id = ?",
    )
      .bind(viewer.eventId)
      .run();
    const service = new EventService(testEnv);
    const current = await service.getSetup(viewer);
    expect(current.programmePublished).toBe(true);

    await expect(
      service.saveSetup(viewer, {
        ...inputFrom(current),
        publicSlug: `renamed-${crypto.randomUUID().slice(0, 8)}`,
      }),
    ).rejects.toBeInstanceOf(EventPublishedProgrammeSlugError);

    await expect(service.getSetup(viewer)).resolves.toMatchObject({
      publicSlug: current.publicSlug,
      revision: current.revision,
    });
  });

  it("does not expose an event through another organisation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const repository = new D1EventRepository(testEnv);
    await expect(
      repository.getSetup("org-not-authorised", viewer.eventId),
    ).resolves.toBeNull();
  });

  it("fails when an event references a missing organisation", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const db = new Proxy(testEnv.DB, {
      get(target, property) {
        if (property === "prepare") {
          return (query: string) =>
            target.prepare(
              query === "SELECT name FROM organisations WHERE id = ?"
                ? "SELECT name FROM organisations WHERE 0 AND id = ?"
                : query,
            );
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const invalidEnvironment = new Proxy(testEnv, {
      get(target, property) {
        return property === "DB" ? db : Reflect.get(target, property);
      },
    });

    await expect(
      new D1EventRepository(invalidEnvironment).getSetup(
        viewer.organisationId,
        viewer.eventId,
      ),
    ).rejects.toThrow(
      `Event ${viewer.eventId} references missing organisation ${viewer.organisationId}.`,
    );
  });

  it("records an expiring administrator invitation without pretending to send in demo mode", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const result = await new EventService(testEnv).inviteAdministrator(viewer, {
      name: "Invited Admin",
      email: "invited-admin@example.com",
    });
    expect(result.delivery).toBe("demo_not_sent");
    const membership = await env.DB.prepare(
      `
      SELECT m.id, m.accepted_at AS acceptedAt, m.invitation_expires_at AS expiresAt
        FROM memberships m JOIN people p ON p.id = m.person_id
       WHERE m.event_id = ? AND p.email = ? COLLATE NOCASE AND m.role = 'administrator'
    `,
    )
      .bind(viewer.eventId, "invited-admin@example.com")
      .first<{
        id: string;
        acceptedAt: number | null;
        expiresAt: number | null;
      }>();
    expect(membership?.id).toBe(result.membershipId);
    expect(membership?.acceptedAt).toBeNull();
    expect(membership?.expiresAt).toBeGreaterThan(
      Math.floor(Date.now() / 1_000),
    );
  });

  it("hides revoked administrators and labels expired invitations", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new EventService(testEnv);
    const expired = await service.inviteAdministrator(viewer, {
      name: "Expired Admin",
      email: "expired-admin@example.com",
    });
    const revoked = await service.inviteAdministrator(viewer, {
      name: "Revoked Admin",
      email: "revoked-admin@example.com",
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE memberships SET invitation_expires_at = unixepoch() - 1 WHERE id = ?",
      ).bind(expired.membershipId),
      env.DB.prepare(
        "UPDATE memberships SET revoked_at = unixepoch() WHERE id = ?",
      ).bind(revoked.membershipId),
    ]);

    const setup = await service.getSetup(viewer);
    expect(setup.administrators).toContainEqual(
      expect.objectContaining({
        email: "expired-admin@example.com",
        status: "Expired",
      }),
    );
    expect(
      setup.administrators.some(
        (administrator) => administrator.email === "revoked-admin@example.com",
      ),
    ).toBe(false);
  });

  it("fails validation before touching D1", async () => {
    const testEnv = env as unknown as CloudflareEnvironment;
    await ensureDemoData(testEnv);
    const service = new EventService(testEnv);
    const current = await service.getSetup(viewer);

    await expect(
      service.saveSetup(viewer, {
        ...inputFrom(current),
        endDate: "2025-05-19",
        repositoryProvider: "airtable",
      }),
    ).rejects.toThrow();
  });
});
