import { and, asc, eq } from "drizzle-orm";

import { createDatabase } from "~/platform/database/db.server";
import { events, rooms, tracks } from "~/platform/database/schema";
import {
  parseEventFilePolicy,
  type EventFilePolicy,
} from "~/modules/files/file-policy";
import { parseSessionFormatsConfiguration } from "./event-configuration";
import { eventResourceSchema } from "./event-schema";
import type {
  AdministratorInvitationInput,
  EventSetupInput,
} from "./event-schema";
import { EventAdministratorRepository } from "./event-administrator-repository.server";

export type EventAdministrator = {
  id: string;
  name: string;
  email: string;
  scope: "event" | "organisation";
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
  participantLogoUrl: string;
  participantWelcomeText: string;
  participantSupportUrl: string;
  description: string;
  repositoryProvider: "d1" | "airtable";
  repositoryLockedAt: number | null;
  repositoryConnection: {
    id: string;
    status: string;
    baseId: string;
    tableId: string;
    tableName: string;
    hasCredentials: boolean;
    updatedAt: number;
    authoritativeEntities: readonly [
      "rooms",
      "event_configuration",
      "forms",
      "submissions",
      "evaluations",
      "sessions",
      "tasks",
      "published_programme",
    ];
  } | null;
  repositoryFreshness: {
    source: "d1" | "airtable";
    scope: "rooms" | "event_data";
    fetchedAt: number;
    cacheExpiresAt: number | null;
    cached: boolean;
  };
  retentionMonths: 12 | 24 | 36;
  submissionAccessMode:
    "email_verified" | "account_required" | "password_protected";
  allowAnonymousDrafts: boolean;
  duplicatePersonWarnings: boolean;
  filePolicy: EventFilePolicy;
  programmePublished: boolean;
  revision: number;
  sessionFormats: EventSetupInput["sessionFormats"];
  rooms: Array<{
    id: string;
    name: string;
    capacity: number;
    resources: string[];
    position: number;
  }>;
  tracks: EventSetupInput["tracks"];
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

export class EventTrackInUseError extends Error {
  constructor() {
    super(
      "A track used by a published form, submission or session cannot be removed. Keep it configured and create a replacement track if needed.",
    );
    this.name = "EventTrackInUseError";
  }
}

export class EventTrackOwnershipError extends Error {
  constructor() {
    super(
      "A track identifier belongs to another event. Refresh before saving.",
    );
    this.name = "EventTrackOwnershipError";
  }
}

export class EventSessionFormatInUseError extends Error {
  constructor() {
    super("Reassign sessions before removing one of their configured formats.");
    this.name = "EventSessionFormatInUseError";
  }
}

export class EventResourceConfigurationError extends Error {
  constructor() {
    super(
      "Every required session resource must remain configured in its assigned room and in at least one active room.",
    );
    this.name = "EventResourceConfigurationError";
  }
}

export class EventConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EventConfigurationError";
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

export {
  EventAdministratorAlreadyActiveError,
  EventAdministratorNotFoundError,
} from "./event-administrator-repository.server";
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
    command?: {
      operationId: string;
      personId: string;
      membershipId: string;
      auditId: string;
    },
  ): Promise<{ membershipId: string }>;
  revokeAdministrator(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    membershipId: string,
    command?: { operationId: string; auditId: string },
  ): Promise<{ membershipId: string; scope: "event" | "organisation" }>;
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

function parseResources(value: string, roomId: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new EventConfigurationError(
      `Room ${roomId} has invalid resource inventory JSON.`,
    );
  }
  const result = eventResourceSchema.array().max(50).safeParse(parsed);
  if (!result.success || new Set(result.data).size !== result.data.length) {
    throw new EventConfigurationError(
      `Room ${roomId} has invalid or duplicate resource inventory entries.`,
    );
  }
  return result.data;
}

function parseSessionFormats(value: string) {
  try {
    return parseSessionFormatsConfiguration(value);
  } catch (error) {
    throw new EventConfigurationError(
      error instanceof Error
        ? error.message
        : "The event has invalid session-format configuration.",
    );
  }
}

function parseFilePolicy(value: string) {
  try {
    return parseEventFilePolicy(value);
  } catch (error) {
    throw new EventConfigurationError(
      error instanceof Error
        ? error.message
        : "The event has invalid file-policy configuration.",
    );
  }
}

export class D1EventRepository implements EventRepository {
  private readonly administrators: EventAdministratorRepository;

  constructor(private readonly env: CloudflareEnvironment) {
    this.administrators = new EventAdministratorRepository(env);
  }
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

    const [roomRows, trackRows, organisation, administrators] =
      await Promise.all([
        db
          .select({
            id: rooms.id,
            name: rooms.name,
            capacity: rooms.capacity,
            resourcesJson: rooms.resourcesJson,
            position: rooms.position,
          })
          .from(rooms)
          .where(and(eq(rooms.eventId, eventId), eq(rooms.status, "active")))
          .orderBy(asc(rooms.position), asc(rooms.name)),
        db
          .select({
            id: tracks.id,
            name: tracks.name,
            slug: tracks.slug,
            colourToken: tracks.colourToken,
            position: tracks.position,
            exclusive: tracks.exclusive,
            isPublic: tracks.isPublic,
          })
          .from(tracks)
          .where(eq(tracks.eventId, eventId))
          .orderBy(asc(tracks.position), asc(tracks.name)),
        this.env.DB.prepare("SELECT name FROM organisations WHERE id = ?")
          .bind(organisationId)
          .first<{ name: string }>(),
        this.env.DB.prepare(
          `
        SELECT m.id, p.display_name AS name, p.email,
               CASE WHEN m.event_id IS NULL THEN 'organisation' ELSE 'event' END AS scope,
               CASE
                 WHEN m.accepted_at IS NOT NULL THEN 'Active'
                 WHEN m.invited_at IS NULL
                   OR m.invitation_expires_at IS NULL
                   OR m.invitation_expires_at <= unixepoch() THEN 'Expired'
                 ELSE 'Invited'
               END AS status
          FROM memberships m
          JOIN people p ON p.id = m.person_id
         WHERE m.organisation_id = ?
           AND (m.event_id = ? OR m.event_id IS NULL)
           AND m.role = 'administrator'
           AND m.revoked_at IS NULL
         ORDER BY m.event_id IS NOT NULL, m.accepted_at IS NULL,
                  p.display_name COLLATE NOCASE, m.id
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
      participantLogoUrl: event.participantLogoUrl ?? "",
      participantWelcomeText: event.participantWelcomeText ?? "",
      participantSupportUrl: event.participantSupportUrl ?? "",
      description: event.description ?? "",
      repositoryProvider:
        event.repositoryProvider as EventSetup["repositoryProvider"],
      repositoryLockedAt: event.repositoryLockedAt,
      repositoryConnection: null,
      repositoryFreshness: {
        source: "d1",
        scope: "rooms",
        fetchedAt: event.updatedAt,
        cacheExpiresAt: null,
        cached: false,
      },
      retentionMonths: event.retentionMonths as EventSetup["retentionMonths"],
      submissionAccessMode:
        event.submissionAccessMode as EventSetup["submissionAccessMode"],
      allowAnonymousDrafts: event.allowAnonymousDrafts,
      duplicatePersonWarnings: event.duplicatePersonWarnings,
      filePolicy: parseFilePolicy(event.filePolicyJson),
      programmePublished: event.programmePublishedAt !== null,
      revision: event.revision,
      sessionFormats: parseSessionFormats(event.sessionFormatsJson),
      rooms: roomRows.map(({ resourcesJson, ...room }) => ({
        ...room,
        resources: parseResources(resourcesJson, room.id),
      })),
      tracks: trackRows,
      administrators: administrators.results,
    };
  }

  async validateSetup(
    organisationId: string,
    eventId: string,
    input: EventSetupInput,
  ) {
    const current = await this.env.DB.prepare(
      `SELECT revision, slug, repository_provider AS repositoryProvider,
              programme_published_at AS programmePublishedAt,
              timezone, starts_at AS startsAt, ends_at AS endsAt,
              EXISTS (
                SELECT 1 FROM schedule_versions
                 WHERE event_id = events.id AND status = 'published'
              ) AS hasPublishedSchedule
         FROM events
        WHERE id = ? AND organisation_id = ?`,
    )
      .bind(eventId, organisationId)
      .first<{
        revision: number;
        slug: string;
        repositoryProvider: "d1" | "airtable";
        programmePublishedAt: number | null;
        timezone: string;
        startsAt: number;
        endsAt: number;
        hasPublishedSchedule: number;
      }>();
    if (!current || current.revision !== input.revision)
      throw new EventRevisionConflictError();

    if (current.slug !== input.publicSlug) {
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
      current.hasPublishedSchedule &&
      (current.timezone !== input.timezone ||
        current.startsAt !== startOfDayEpoch(input.startDate) ||
        current.endsAt !== endOfDayEpoch(input.endDate))
    ) {
      throw new EventPublishedScheduleConflictError();
    }

    const roomIdsJson = JSON.stringify(input.rooms.map((room) => room.id));
    const trackIdsJson = JSON.stringify(input.tracks.map((track) => track.id));
    if (input.rooms.length) {
      const foreignRoom = await this.env.DB.prepare(
        `SELECT 1 FROM rooms
          WHERE id IN (SELECT value FROM json_each(?))
            AND event_id <> ? LIMIT 1`,
      )
        .bind(roomIdsJson, eventId)
        .first();
      if (foreignRoom) throw new EventRoomOwnershipError();
    }
    if (input.tracks.length) {
      const foreignTrack = await this.env.DB.prepare(
        `SELECT 1 FROM tracks
          WHERE id IN (SELECT value FROM json_each(?))
            AND event_id <> ? LIMIT 1`,
      )
        .bind(trackIdsJson, eventId)
        .first();
      if (foreignTrack) throw new EventTrackOwnershipError();
    }
    const activeRoomReference = await this.env.DB.prepare(
      `SELECT 1
         FROM rooms removed
         JOIN schedule_entries entry
           ON entry.event_id = removed.event_id AND entry.room_id = removed.id
         JOIN schedule_versions version
           ON version.event_id = entry.event_id
          AND version.id = entry.schedule_version_id
        WHERE removed.event_id = ? AND removed.status = 'active'
          AND removed.id NOT IN (SELECT value FROM json_each(?))
          AND version.status IN ('draft','publishing','published')
        LIMIT 1`,
    )
      .bind(eventId, roomIdsJson)
      .first();
    if (activeRoomReference) throw new EventRoomInUseError();
    const removedTrackReference = await this.env.DB.prepare(
      `SELECT 1
         FROM tracks removed
        WHERE removed.event_id = ?
          AND removed.id NOT IN (SELECT value FROM json_each(?))
          AND (
            EXISTS (
              SELECT 1 FROM sessions session
               WHERE session.event_id = removed.event_id
                 AND session.track_id = removed.id
            )
            OR EXISTS (
              SELECT 1 FROM submission_track_selections selection
               WHERE selection.event_id = removed.event_id
                 AND selection.track_id = removed.id
            )
            OR EXISTS (
              SELECT 1 FROM form_versions version,
                            json_each(version.routing_json, '$.trackNames') routed_track
               WHERE version.event_id = removed.event_id
                 AND version.status = 'published'
                 AND routed_track.key = removed.id
            )
          )
        LIMIT 1`,
    )
      .bind(eventId, trackIdsJson)
      .first();
    if (removedTrackReference) throw new EventTrackInUseError();

    const sessionRows = await this.env.DB.prepare(
      `SELECT id, format, required_resources_json AS requiredResourcesJson
         FROM sessions WHERE event_id = ?`,
    )
      .bind(eventId)
      .all<{
        id: string;
        format: string;
        requiredResourcesJson: string;
      }>();
    const configuredFormats = new Set(
      input.sessionFormats.map((format) => format.key),
    );
    if (
      sessionRows.results.some(
        (session) => !configuredFormats.has(session.format),
      )
    ) {
      throw new EventSessionFormatInUseError();
    }
    const resourceInventory = new Set(
      input.rooms.flatMap((room) => room.resources),
    );
    const requiredResources = new Map(
      sessionRows.results.map((session) => [
        session.id,
        parseResources(session.requiredResourcesJson, `session ${session.id}`),
      ]),
    );
    if (
      [...requiredResources.values()].some((resources) =>
        resources.some((resource) => !resourceInventory.has(resource)),
      )
    ) {
      throw new EventResourceConfigurationError();
    }
    const requestedRoomResources = new Map(
      input.rooms.map((room) => [room.id, new Set(room.resources)]),
    );
    const scheduledSessions = await this.env.DB.prepare(
      `SELECT entry.session_id AS sessionId, entry.room_id AS roomId
         FROM schedule_entries entry
         JOIN schedule_versions version
           ON version.id = entry.schedule_version_id
          AND version.event_id = entry.event_id
        WHERE entry.event_id = ?
          AND version.status IN ('draft','publishing','published')`,
    )
      .bind(eventId)
      .all<{ sessionId: string; roomId: string }>();
    if (
      scheduledSessions.results.some((entry) => {
        const roomResources = requestedRoomResources.get(entry.roomId);
        return (requiredResources.get(entry.sessionId) ?? []).some(
          (resource) => !roomResources?.has(resource),
        );
      })
    ) {
      throw new EventResourceConfigurationError();
    }
    const capacityRequirements = await this.env.DB.prepare(
      `SELECT entry.room_id AS roomId,
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
        GROUP BY entry.room_id`,
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
    return current;
  }

  async saveSetup(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    input: EventSetupInput,
  ): Promise<void> {
    await this.validateSetup(organisationId, eventId, input);

    const operationId = crypto.randomUUID();
    const auditId = crypto.randomUUID();
    const roomIds = input.rooms.map((room) => room.id);
    const roomIdsJson = JSON.stringify(roomIds);
    const trackIds = input.tracks.map((track) => track.id);
    const trackIdsJson = JSON.stringify(trackIds);
    const sessionFormatsJson = JSON.stringify(input.sessionFormats);
    const filePolicyJson = JSON.stringify(input.filePolicy);
    const resourceInventory = [
      ...new Set(input.rooms.flatMap((room) => room.resources)),
    ];
    const resourceInventoryJson = JSON.stringify(resourceInventory);
    const roomConfigurationJson = JSON.stringify(input.rooms);
    const keepClause = "id NOT IN (SELECT value FROM json_each(?))";
    const removedRoomClause =
      "removed.id NOT IN (SELECT value FROM json_each(?))";

    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `
        UPDATE events
           SET name = ?, slug = ?, timezone = ?, starts_at = ?, ends_at = ?, venue_name = ?, city = ?,
               description = ?, brand_accent = ?, participant_logo_url = ?,
               participant_welcome_text = ?, participant_support_url = ?,
               session_formats_json = ?,
               repository_provider = ?, retention_months = ?,
               submission_access_mode = ?, allow_anonymous_drafts = ?, duplicate_person_warnings = ?,
               file_policy_json = ?,
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
           AND NOT EXISTS (
             SELECT 1 FROM tracks requested
              WHERE requested.id IN (SELECT value FROM json_each(?))
                AND requested.event_id <> events.id
           )
           AND NOT EXISTS (
             SELECT 1
               FROM tracks removed
               JOIN sessions session
                 ON session.event_id = removed.event_id
                AND session.track_id = removed.id
              WHERE removed.event_id = events.id
                AND removed.id NOT IN (SELECT value FROM json_each(?))
           )
           AND NOT EXISTS (
             SELECT 1 FROM sessions configured
              WHERE configured.event_id = events.id
                AND configured.format NOT IN (
                  SELECT json_extract(value, '$.key') FROM json_each(?)
                )
           )
           AND NOT EXISTS (
             SELECT 1
               FROM sessions configured,
                    json_each(configured.required_resources_json) required
              WHERE configured.event_id = events.id
                AND required.value NOT IN (SELECT value FROM json_each(?))
           )
           AND NOT EXISTS (
             SELECT 1
               FROM schedule_entries entry
               JOIN schedule_versions version
                 ON version.id = entry.schedule_version_id
                AND version.event_id = entry.event_id
               JOIN sessions configured
                 ON configured.id = entry.session_id
                AND configured.event_id = entry.event_id
               JOIN json_each(configured.required_resources_json) required
              WHERE entry.event_id = events.id
                AND version.status IN ('draft','publishing','published')
                AND NOT EXISTS (
                  SELECT 1
                    FROM json_each(?) requested_room
                    JOIN json_each(
                      json_extract(requested_room.value, '$.resources')
                    ) requested_resource
                   WHERE json_extract(requested_room.value, '$.id') = entry.room_id
                     AND requested_resource.value = required.value
                )
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
        input.participantLogoUrl || null,
        input.participantWelcomeText || null,
        input.participantSupportUrl || null,
        sessionFormatsJson,
        input.repositoryProvider,
        input.retentionMonths,
        input.submissionAccessMode,
        input.allowAnonymousDrafts ? 1 : 0,
        input.duplicatePersonWarnings ? 1 : 0,
        filePolicyJson,
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
        trackIdsJson,
        trackIdsJson,
        sessionFormatsJson,
        resourceInventoryJson,
        roomConfigurationJson,
      ),
      ...input.rooms.map((room) =>
        this.env.DB.prepare(
          `
        INSERT INTO rooms (
          id, event_id, name, capacity, resources_json, position
        )
        SELECT ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM events WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          capacity = excluded.capacity,
          resources_json = excluded.resources_json,
          position = excluded.position,
          status = 'active'
        WHERE rooms.event_id = excluded.event_id
      `,
        ).bind(
          room.id,
          eventId,
          room.name,
          room.capacity,
          JSON.stringify(room.resources),
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
      ...input.tracks.map((track) =>
        this.env.DB.prepare(
          `
        INSERT INTO tracks (
          id, event_id, name, slug, colour_token, position, exclusive, is_public
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          slug = excluded.slug,
          colour_token = excluded.colour_token,
          position = excluded.position,
          exclusive = excluded.exclusive,
          is_public = excluded.is_public
        WHERE tracks.event_id = excluded.event_id
      `,
        ).bind(
          track.id,
          eventId,
          track.name,
          track.slug,
          track.colourToken,
          track.position,
          track.exclusive ? 1 : 0,
          track.isPublic ? 1 : 0,
          eventId,
          organisationId,
          operationId,
        ),
      ),
      this.env.DB.prepare(
        `DELETE FROM tracks
          WHERE event_id = ?
            AND id NOT IN (SELECT value FROM json_each(?))
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
            )`,
      ).bind(eventId, trackIdsJson, eventId, organisationId, operationId),
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
          trackCount: input.tracks.length,
          sessionFormatCount: input.sessionFormats.length,
          resourceCount: resourceInventory.length,
          filePolicy: input.filePolicy,
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
          await this.validateSetup(organisationId, eventId, input);
        }
        throw new EventRevisionConflictError();
      }
      const roomResults = results.slice(1, 1 + input.rooms.length);
      if (roomResults.some((result) => (result.meta.changes ?? 0) !== 1)) {
        throw new Error(
          "Every requested room must be persisted with the event update.",
        );
      }
      const trackResults = results.slice(
        2 + input.rooms.length,
        2 + input.rooms.length + input.tracks.length,
      );
      if (trackResults.some((result) => (result.meta.changes ?? 0) !== 1)) {
        throw new Error(
          "Every requested track must be persisted with the event update.",
        );
      }
    } catch (error) {
      if (
        error instanceof EventRevisionConflictError ||
        error instanceof EventRoomOwnershipError ||
        error instanceof EventTrackOwnershipError ||
        error instanceof EventTrackInUseError ||
        error instanceof EventSessionFormatInUseError ||
        error instanceof EventResourceConfigurationError
      )
        throw error;
      if (
        error instanceof Error &&
        /UNIQUE constraint failed: events\.slug/i.test(error.message)
      ) {
        throw new EventSlugConflictError();
      }
      throw error;
    }
  }
  inviteAdministrator(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    input: AdministratorInvitationInput,
    command?: {
      operationId: string;
      personId: string;
      membershipId: string;
      auditId: string;
    },
  ) {
    return this.administrators.inviteAdministrator(
      organisationId,
      eventId,
      actorPersonId,
      input,
      command,
    );
  }

  revokeAdministrator(
    organisationId: string,
    eventId: string,
    actorPersonId: string,
    membershipId: string,
    command?: { operationId: string; auditId: string },
  ) {
    return this.administrators.revokeAdministrator(
      organisationId,
      eventId,
      actorPersonId,
      membershipId,
      command,
    );
  }
}
