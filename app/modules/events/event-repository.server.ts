import { and, asc, eq } from "drizzle-orm";

import { createDatabase } from "~/platform/database/db.server";
import { events, rooms } from "~/platform/database/schema";
import type {
  AdministratorInvitationInput,
  EventSetupInput,
} from "./event-schema";

export type EventAdministrator = {
  id: string;
  name: string;
  email: string;
  status: "Active" | "Invited" | "Expired";
};

export type EventSetup = {
  id: string;
  organisationId: string;
  organisationName: string;
  name: string;
  timezone: string;
  startDate: string;
  endDate: string;
  venue: string;
  city: string;
  publicSlug: string;
  brandAccent: string;
  description: string;
  repositoryProvider: "d1" | "airtable";
  retentionMonths: 12 | 24 | 36;
  submissionAccessMode:
    "email_verified" | "account_required" | "password_protected";
  allowAnonymousDrafts: boolean;
  duplicatePersonWarnings: boolean;
  programmePublished: boolean;
  revision: number;
  rooms: Array<{
    id: string;
    name: string;
    capacity: number;
    position: number;
  }>;
  administrators: EventAdministrator[];
};

export class EventRevisionConflictError extends Error {
  constructor() {
    super(
      "This event changed after the page loaded. Refresh and review the latest values before saving.",
    );
    this.name = "EventRevisionConflictError";
  }
}

export class EventSlugConflictError extends Error {
  constructor() {
    super("That public event slug is already in use. Choose a different slug.");
    this.name = "EventSlugConflictError";
  }
}

export class EventRoomInUseError extends Error {
  constructor() {
    super("Move scheduled sessions before removing a room.");
    this.name = "EventRoomInUseError";
  }
}

export class EventRoomOwnershipError extends Error {
  constructor() {
    super("A room identifier belongs to another event. Refresh before saving.");
    this.name = "EventRoomOwnershipError";
  }
}

export class EventPublishedScheduleConflictError extends Error {
  constructor() {
    super(
      "Event dates, timezone, or room capacity cannot be changed in a way that invalidates the published schedule. Create a replacement schedule before changing this boundary.",
    );
    this.name = "EventPublishedScheduleConflictError";
  }
}

export class EventPublishedProgrammeSlugError extends Error {
  constructor() {
    super(
      "The public slug is locked after programme publication so existing public, embed, API and calendar URLs remain valid.",
    );
    this.name = "EventPublishedProgrammeSlugError";
  }
}

export class EventAdministratorAlreadyActiveError extends Error {
  constructor() {
    super("That person is already an active event administrator.");
    this.name = "EventAdministratorAlreadyActiveError";
  }
}

export interface EventRepository {
  getSetup(organisationId: string, eventId: string): Promise<EventSetup | null>;
  saveSetup(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    input: EventSetupInput,
  ): Promise<void>;
  inviteAdministrator(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    input: AdministratorInvitationInput,
  ): Promise<{ membershipId: string }>;
}

function dateFromEpoch(epoch: number) {
  return new Date(epoch * 1_000).toISOString().slice(0, 10);
}

function startOfDayEpoch(date: string) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / 1_000);
}

function endOfDayEpoch(date: string) {
  return Math.floor(Date.parse(`${date}T23:59:59Z`) / 1_000);
}

export class D1EventRepository implements EventRepository {
  constructor(private readonly env: CloudflareEnvironment) {}

  async getSetup(
    organisationId: string,
    eventId: string,
  ): Promise<EventSetup | null> {
    const db = createDatabase(this.env);
    const [event] = await db
      .select()
      .from(events)
      .where(
        and(eq(events.id, eventId), eq(events.organisationId, organisationId)),
      )
      .limit(1);
    if (!event) return null;

    const [roomRows, organisation, administrators] = await Promise.all([
      db
        .select({
          id: rooms.id,
          name: rooms.name,
          capacity: rooms.capacity,
          position: rooms.position,
        })
        .from(rooms)
        .where(and(eq(rooms.eventId, eventId), eq(rooms.status, "active")))
        .orderBy(asc(rooms.position), asc(rooms.name)),
      this.env.DB.prepare("SELECT name FROM organisations WHERE id = ?")
        .bind(organisationId)
        .first<{ name: string }>(),
      this.env.DB.prepare(
        `
        SELECT p.id, p.display_name AS name, p.email,
               CASE
                 WHEN m.accepted_at IS NOT NULL THEN 'Active'
                 WHEN m.invitation_expires_at <= unixepoch() THEN 'Expired'
                 ELSE 'Invited'
               END AS status
          FROM memberships m
          JOIN people p ON p.id = m.person_id
         WHERE m.organisation_id = ? AND m.event_id = ? AND m.role = 'administrator'
           AND m.revoked_at IS NULL
         ORDER BY m.accepted_at IS NULL, p.display_name
      `,
      )
        .bind(organisationId, eventId)
        .all<EventAdministrator>(),
    ]);
    if (!organisation) {
      throw new Error(
        `Event ${eventId} references missing organisation ${organisationId}.`,
      );
    }

    return {
      id: event.id,
      organisationId,
      organisationName: organisation.name,
      name: event.name,
      timezone: event.timezone,
      startDate: dateFromEpoch(event.startsAt),
      endDate: dateFromEpoch(event.endsAt),
      venue: event.venueName ?? "",
      city: event.city ?? "",
      publicSlug: event.slug,
      brandAccent: event.brandAccent,
      description: event.description ?? "",
      repositoryProvider:
        event.repositoryProvider as EventSetup["repositoryProvider"],
      retentionMonths: event.retentionMonths as EventSetup["retentionMonths"],
      submissionAccessMode:
        event.submissionAccessMode as EventSetup["submissionAccessMode"],
      allowAnonymousDrafts: event.allowAnonymousDrafts,
      duplicatePersonWarnings: event.duplicatePersonWarnings,
      programmePublished: event.programmePublishedAt !== null,
      revision: event.revision,
      rooms: roomRows,
      administrators: administrators.results,
    };
  }

  async saveSetup(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    input: EventSetupInput,
  ): Promise<void> {
    const capacityRequirements = await this.env.DB.prepare(
      `
      SELECT entry.room_id AS roomId,
             MAX(session.expected_attendance) AS requiredCapacity
        FROM events event
        JOIN schedule_versions version
          ON version.event_id = event.id AND version.status = 'published'
        JOIN schedule_entries entry
          ON entry.event_id = version.event_id
         AND entry.schedule_version_id = version.id
        JOIN sessions session
          ON session.event_id = entry.event_id AND session.id = entry.session_id
        JOIN schedule_policies policy
          ON policy.event_id = event.id AND policy.capacity_action = 'block'
       WHERE event.id = ? AND event.organisation_id = ? AND event.revision = ?
         AND session.expected_attendance IS NOT NULL
       GROUP BY entry.room_id
    `,
    )
      .bind(eventId, organisationId, input.revision)
      .all<{ roomId: string; requiredCapacity: number }>();
    const requestedCapacity = new Map(
      input.rooms.map((room) => [room.id, room.capacity]),
    );
    if (
      capacityRequirements.results.some((requirement) => {
        const capacity = requestedCapacity.get(requirement.roomId);
        return (
          capacity !== undefined && capacity < requirement.requiredCapacity
        );
      })
    ) {
      throw new EventPublishedScheduleConflictError();
    }

    const operationId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const roomIds = input.rooms.map((room) => room.id);
    const roomIdsJson = JSON.stringify(roomIds);
    const keepClause = "id NOT IN (SELECT value FROM json_each(?))";
    const removedRoomClause =
      "removed.id NOT IN (SELECT value FROM json_each(?))";

    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE events
           SET name = ?, slug = ?, timezone = ?, starts_at = ?, ends_at = ?, venue_name = ?, city = ?,
               description = ?, brand_accent = ?, repository_provider = ?, retention_months = ?,
               submission_access_mode = ?, allow_anonymous_drafts = ?, duplicate_person_warnings = ?,
               revision = revision + 1, last_operation_id = ?, last_updated_by_person_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ? AND revision = ?
           AND (programme_published_at IS NULL OR slug = ?)
           AND (
             (timezone = ? AND starts_at = ? AND ends_at = ?)
             OR NOT EXISTS (
               SELECT 1 FROM schedule_versions
               WHERE event_id = events.id AND status = 'published'
             )
           )
           AND NOT EXISTS (
             SELECT 1
               FROM rooms removed
               JOIN schedule_entries entry
                 ON entry.event_id = removed.event_id AND entry.room_id = removed.id
               JOIN schedule_versions version
                 ON version.event_id = entry.event_id
                AND version.id = entry.schedule_version_id
              WHERE removed.event_id = events.id AND removed.status = 'active'
                AND ${removedRoomClause}
                AND version.status IN ('draft','publishing','published')
           )
           AND NOT EXISTS (
             SELECT 1 FROM rooms requested
              WHERE requested.id IN (SELECT value FROM json_each(?))
                AND requested.event_id <> events.id
           )
      `,
      ).bind(
        input.name,
        input.publicSlug,
        input.timezone,
        startOfDayEpoch(input.startDate),
        endOfDayEpoch(input.endDate),
        input.venue || null,
        input.city || null,
        input.description || null,
        input.brandAccent.toLowerCase(),
        input.repositoryProvider,
        input.retentionMonths,
        input.submissionAccessMode,
        input.allowAnonymousDrafts ? 1 : 0,
        input.duplicatePersonWarnings ? 1 : 0,
        operationId,
        actorPersonId,
        eventId,
        organisationId,
        input.revision,
        input.publicSlug,
        input.timezone,
        startOfDayEpoch(input.startDate),
        endOfDayEpoch(input.endDate),
        roomIdsJson,
        roomIdsJson,
      ),
      ...input.rooms.map((room) =>
        this.env.DB.prepare(
          `
        INSERT INTO rooms (id, event_id, name, capacity, position)
        SELECT ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM events WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          capacity = excluded.capacity,
          position = excluded.position,
          status = 'active'
        WHERE rooms.event_id = excluded.event_id
      `,
        ).bind(
          room.id,
          eventId,
          room.name,
          room.capacity,
          room.position,
          eventId,
          organisationId,
          operationId,
        ),
      ),
      this.env.DB.prepare(
        `
        UPDATE rooms
           SET status = 'retired'
         WHERE event_id = ? AND status = 'active'
           AND ${keepClause}
           AND EXISTS (
             SELECT 1 FROM events WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(eventId, roomIdsJson, eventId, organisationId, operationId),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'event.settings.updated', 'event', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM events WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        auditId,
        organisationId,
        eventId,
        actorPersonId,
        eventId,
        JSON.stringify({
          revision: input.revision + 1,
          roomCount: input.rooms.length,
        }),
        eventId,
        organisationId,
        operationId,
      ),
    ];

    try {
      const results = await this.env.DB.batch(statements);
      const [updated] = results;
      if ((updated.meta.changes ?? 0) !== 1) {
        const current = await this.env.DB.prepare(
          `
          SELECT revision, slug, programme_published_at AS programmePublishedAt,
                 timezone, starts_at AS startsAt, ends_at AS endsAt,
                 EXISTS (
                   SELECT 1 FROM schedule_versions
                    WHERE event_id = events.id AND status = 'published'
                 ) AS hasPublishedSchedule
            FROM events
           WHERE id = ? AND organisation_id = ?
        `,
        )
          .bind(eventId, organisationId)
          .first<{
            revision: number;
            slug: string;
            programmePublishedAt: number | null;
            timezone: string;
            startsAt: number;
            endsAt: number;
            hasPublishedSchedule: number;
          }>();
        if (
          current?.revision === input.revision &&
          current.slug !== input.publicSlug
        ) {
          const conflictingSlug = await this.env.DB.prepare(
            "SELECT 1 FROM events WHERE slug = ? AND id <> ? LIMIT 1",
          )
            .bind(input.publicSlug, eventId)
            .first();
          if (conflictingSlug) throw new EventSlugConflictError();
          if (current.programmePublishedAt !== null)
            throw new EventPublishedProgrammeSlugError();
        }
        if (
          current?.revision === input.revision &&
          current.hasPublishedSchedule &&
          (current.timezone !== input.timezone ||
            current.startsAt !== startOfDayEpoch(input.startDate) ||
            current.endsAt !== endOfDayEpoch(input.endDate))
        ) {
          throw new EventPublishedScheduleConflictError();
        }
        if (current?.revision === input.revision) {
          if (roomIds.length) {
            const foreignRoom = await this.env.DB.prepare(
              `SELECT 1 FROM rooms
                WHERE id IN (SELECT value FROM json_each(?))
                  AND event_id <> ? LIMIT 1`,
            )
              .bind(roomIdsJson, eventId)
              .first();
            if (foreignRoom) throw new EventRoomOwnershipError();
          }
          const activeRoomReference = await this.env.DB.prepare(
            `
            SELECT 1
              FROM rooms removed
              JOIN schedule_entries entry
                ON entry.event_id = removed.event_id AND entry.room_id = removed.id
              JOIN schedule_versions version
                ON version.event_id = entry.event_id
               AND version.id = entry.schedule_version_id
             WHERE removed.event_id = ? AND removed.status = 'active'
               AND ${removedRoomClause}
               AND version.status IN ('draft','publishing','published')
             LIMIT 1
          `,
          )
            .bind(eventId, roomIdsJson)
            .first();
          if (activeRoomReference) throw new EventRoomInUseError();
        }
        throw new EventRevisionConflictError();
      }
      const roomResults = results.slice(1, 1 + input.rooms.length);
      if (roomResults.some((result) => (result.meta.changes ?? 0) !== 1)) {
        throw new Error(
          "Every requested room must be persisted with the event update.",
        );
      }
    } catch (error) {
      if (
        error instanceof EventRevisionConflictError ||
        error instanceof EventRoomOwnershipError
      )
        throw error;
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: events\.slug/i.test(error.message)
      ) {
        throw new EventSlugConflictError();
      }
      if (error instanceof Error && /foreign key/i.test(error.message))
        throw new EventRoomInUseError();
      throw error;
    }
  }

  async inviteAdministrator(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    input: AdministratorInvitationInput,
  ): Promise<{ membershipId: string }> {
    const personId = crypto.randomUUID();
    await this.env.DB.prepare(
      `
        INSERT INTO people (
          id, email, display_name, email_verified, profile_status, created_at, updated_at
        ) VALUES (?, ?, ?, 0, 'draft', unixepoch(), unixepoch())
        ON CONFLICT(email) DO NOTHING
      `,
    )
      .bind(personId, input.email, input.name)
      .run();

    const person = await this.env.DB.prepare(
      `
      SELECT p.id
        FROM people p
        JOIN events e ON e.id = ? AND e.organisation_id = ?
       WHERE p.email = ? COLLATE NOCASE
    `,
    )
      .bind(eventId, organisationId, input.email)
      .first<{ id: string }>();
    if (!person)
      throw new Error(
        "The administrator could not be added to the authorised event.",
      );

    const existing = await this.env.DB.prepare(
      `
      SELECT id, accepted_at AS acceptedAt, revoked_at AS revokedAt
        FROM memberships
       WHERE organisation_id = ? AND event_id = ? AND person_id = ? AND role = 'administrator'
    `,
    )
      .bind(organisationId, eventId, person.id)
      .first<{
        id: string;
        acceptedAt: number | null;
        revokedAt: number | null;
      }>();
    if (existing?.acceptedAt && !existing.revokedAt)
      throw new EventAdministratorAlreadyActiveError();

    const membershipId = existing?.id ?? crypto.randomUUID();
    if (existing) {
      await this.env.DB.prepare(
        `
        UPDATE memberships
           SET invited_at = unixepoch(), invitation_expires_at = unixepoch() + 604800,
               accepted_at = NULL, revoked_at = NULL
         WHERE id = ? AND organisation_id = ? AND event_id = ?
      `,
      )
        .bind(membershipId, organisationId, eventId)
        .run();
    } else {
      await this.env.DB.prepare(
        `
        INSERT INTO memberships (
          id, organisation_id, event_id, person_id, role, invited_at,
          invitation_expires_at, accepted_at, created_at
        )
        VALUES (?, ?, ?, ?, 'administrator', unixepoch(), unixepoch() + 604800, NULL, unixepoch())
      `,
      )
        .bind(membershipId, organisationId, eventId, person.id)
        .run();
    }

    await this.env.DB.prepare(
      `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) VALUES (?, ?, ?, ?, 'membership.administrator.invited', 'membership', ?, ?, unixepoch())
      `,
    )
      .bind(
        crypto.randomUUID(),
        organisationId,
        eventId,
        actorPersonId,
        membershipId,
        JSON.stringify({ email: input.email }),
      )
      .run();
    return { membershipId };
  }
}
