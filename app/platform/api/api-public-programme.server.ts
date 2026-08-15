import { z } from "zod";

import type {
  PublishedProgramme,
  PublishedSession,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";
import {
  parsePublishedSpeakerArray,
  parsePublishedSpeakerSessionIds,
  PublishedProgrammeSnapshotInvariantError,
  PublicProgrammeService,
} from "~/modules/programme/public-programme-service.server";
import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import { PublishedHeadshotService } from "~/modules/programme/published-headshot-service.server";
import {
  decodePublicCursor,
  encodePublicCursor,
  isoTimestamp,
} from "./api-pagination.server";
import { ApiError } from "./api.server";

const limitSchema = z
  .string()
  .regex(/^\d+$/u, "limit must be a whole number from 1 to 100")
  .transform(Number)
  .pipe(z.number().int().min(1).max(100))
  .default(50);

const timestampSchema = z.iso
  .datetime({ offset: true })
  .transform((value) => Math.floor(Date.parse(value) / 1_000));

const sessionFilters = {
  q: z.string().trim().min(1).max(160).optional(),
  track: z.string().trim().min(1).max(120).optional(),
  room: z.string().trim().min(1).max(120).optional(),
  speakerId: z.string().trim().min(1).max(200).optional(),
  from: timestampSchema.optional(),
  to: timestampSchema.optional(),
};

export const publicProgrammeQuerySchema = z
  .object({
    format: z.enum(["json", "html"]).optional(),
    ...sessionFilters,
  })
  .strict()
  .refine(
    ({ from, to }) => from === undefined || to === undefined || to > from,
    { path: ["to"], message: "to must be after from" },
  );

export const publicSessionQuerySchema = z
  .object({
    ...sessionFilters,
    limit: limitSchema,
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .strict()
  .refine(
    ({ from, to }) => from === undefined || to === undefined || to > from,
    { path: ["to"], message: "to must be after from" },
  );

export const publicSpeakerQuerySchema = z
  .object({
    q: z.string().trim().min(1).max(160).optional(),
    sessionId: z.string().trim().min(1).max(200).optional(),
    limit: limitSchema,
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export const emptyPublicQuerySchema = z.object({}).strict();

export const PUBLIC_CALENDAR_SESSION_LIMIT = 50;
export const PUBLIC_CALENDAR_SESSION_ID_LIMIT = 200;

export const publicCalendarQuerySchema = z
  .object({
    sessions: z
      .string()
      .trim()
      .min(1)
      .max(
        PUBLIC_CALENDAR_SESSION_LIMIT * PUBLIC_CALENDAR_SESSION_ID_LIMIT +
          (PUBLIC_CALENDAR_SESSION_LIMIT - 1),
      )
      .optional(),
    itinerary: z.literal("mine").optional(),
    share: z.string().max(100).optional(),
  })
  .strict()
  .refine(
    ({ sessions, itinerary, share }) =>
      [sessions, itinerary, share].filter((value) => value !== undefined)
        .length <= 1,
    {
      message:
        "Use only one calendar selection: sessions, itinerary, or share.",
    },
  );

type SessionFilter = Pick<
  z.infer<typeof publicSessionQuerySchema>,
  "q" | "track" | "room" | "speakerId" | "from" | "to"
>;

function normalise(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("en");
}

export function filterPublishedSessions(
  sessions: PublishedSession[],
  input: SessionFilter,
) {
  const query = input.q ? normalise(input.q) : null;
  const track = input.track ? normalise(input.track) : null;
  const room = input.room ? normalise(input.room) : null;
  return sessions.filter((session) => {
    if (
      query &&
      !normalise(
        [
          session.title,
          session.description,
          session.track ?? "",
          session.room,
          ...session.speakerNames,
        ].join("\n"),
      ).includes(query)
    )
      return false;
    if (track && normalise(session.track ?? "") !== track) return false;
    if (room && normalise(session.room) !== room) return false;
    if (input.speakerId && !session.speakerIds.includes(input.speakerId))
      return false;
    if (input.from !== undefined && session.startsAt < input.from) return false;
    if (input.to !== undefined && session.startsAt >= input.to) return false;
    return true;
  });
}

function apiSession(session: PublishedSession) {
  return {
    ...session,
    startsAt: isoTimestamp(session.startsAt),
    endsAt: isoTimestamp(session.endsAt),
  };
}

function apiFreshness(programme: PublishedProgramme) {
  return {
    ...programme.freshness,
    fetchedAt: isoTimestamp(programme.freshness.fetchedAt),
    cacheExpiresAt: isoTimestamp(programme.freshness.cacheExpiresAt),
  };
}

export function publicEventResponse(programme: PublishedProgramme) {
  return {
    event: programme.event,
    publication: {
      ...programme.version,
      publishedAt: isoTimestamp(programme.version.publishedAt),
    },
    freshness: apiFreshness(programme),
  };
}

export function publicProgrammeResponse(
  programme: PublishedProgramme,
  input: z.infer<typeof publicProgrammeQuerySchema>,
) {
  const sessions = filterPublishedSessions(programme.sessions, input);
  const filtered = Object.keys(input).some((key) => key !== "format");
  const visibleSpeakerIds = new Set(
    sessions.flatMap((session) => session.speakerIds),
  );
  return {
    event: programme.event,
    version: {
      ...programme.version,
      publishedAt: isoTimestamp(programme.version.publishedAt),
    },
    sessions: sessions.map(apiSession),
    speakers: filtered
      ? programme.speakers.filter((speaker) =>
          visibleSpeakerIds.has(speaker.id),
        )
      : programme.speakers,
    freshness: apiFreshness(programme),
  };
}

function page<T>(
  records: T[],
  collectionRevision: string,
  limit: number,
  cursor?: string,
) {
  const decoded = cursor ? decodePublicCursor(cursor, collectionRevision) : [0];
  const offset = decoded[0];
  if (
    decoded.length !== 1 ||
    typeof offset !== "number" ||
    !Number.isInteger(offset) ||
    offset < 0
  ) {
    throw new ApiError(
      422,
      "INVALID_CURSOR",
      "cursor is invalid or no longer supported",
    );
  }
  const items = records.slice(offset, offset + limit);
  return {
    items,
    nextCursor:
      offset + items.length < records.length
        ? encodePublicCursor(collectionRevision, [offset + items.length])
        : null,
  };
}

async function publicCollectionRevision(
  programme: PublishedProgramme,
  resource: "sessions" | "schedule" | "speakers",
  filters: Record<string, string | number | null>,
) {
  const records =
    resource === "speakers" ? programme.speakers : programme.sessions;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      JSON.stringify({
        publication: [programme.version.id, programme.version.versionNumber],
        resource,
        filters,
        timezone: resource === "schedule" ? programme.event.timezone : null,
        records,
      }),
    ),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function publishedSessionPage(
  programme: PublishedProgramme,
  input: z.infer<typeof publicSessionQuerySchema>,
  resource: "sessions" | "schedule",
) {
  const collectionRevision = await publicCollectionRevision(
    programme,
    resource,
    {
      q: input.q ?? null,
      track: input.track ?? null,
      room: input.room ?? null,
      speakerId: input.speakerId ?? null,
      from: input.from ?? null,
      to: input.to ?? null,
    },
  );
  const result = page(
    filterPublishedSessions(programme.sessions, input),
    collectionRevision,
    input.limit,
    input.cursor,
  );
  return {
    sessions: result.items.map(apiSession),
    nextCursor: result.nextCursor,
    publication: {
      id: programme.version.id,
      versionNumber: programme.version.versionNumber,
    },
    freshness: apiFreshness(programme),
  };
}

export async function publicSessionPage(
  programme: PublishedProgramme,
  input: z.infer<typeof publicSessionQuerySchema>,
) {
  return publishedSessionPage(programme, input, "sessions");
}

export async function publicSchedulePage(
  programme: PublishedProgramme,
  input: z.infer<typeof publicSessionQuerySchema>,
) {
  const sessions = await publishedSessionPage(programme, input, "schedule");
  return {
    entries: sessions.sessions,
    nextCursor: sessions.nextCursor,
    publication: sessions.publication,
    timezone: programme.event.timezone,
    freshness: sessions.freshness,
  };
}

export async function publicSpeakerPage(
  programme: PublishedProgramme,
  input: z.infer<typeof publicSpeakerQuerySchema>,
) {
  const query = input.q ? normalise(input.q) : null;
  const speakers = programme.speakers.filter((speaker) => {
    if (input.sessionId && !speaker.sessionIds.includes(input.sessionId))
      return false;
    return query
      ? normalise(
          [
            speaker.displayName,
            speaker.biography ?? "",
            speaker.organisationName ?? "",
            speaker.jobTitle ?? "",
          ].join("\n"),
        ).includes(query)
      : true;
  });
  const result = page(
    speakers,
    await publicCollectionRevision(programme, "speakers", {
      q: input.q ?? null,
      sessionId: input.sessionId ?? null,
    }),
    input.limit,
    input.cursor,
  );
  return {
    speakers: result.items satisfies PublishedSpeaker[],
    nextCursor: result.nextCursor,
    publication: {
      id: programme.version.id,
      versionNumber: programme.version.versionNumber,
    },
    freshness: apiFreshness(programme),
  };
}

type PublishedPageDescriptor = {
  eventId: string;
  slug: string;
  timezone: string;
  repositoryProvider: "d1" | "airtable";
  eventRevision: number;
  versionId: string;
  versionNumber: number;
  publishedAt: number;
  latestPublicChangeSequence: number;
  missingContent: number;
};

type SessionPageRow = Omit<PublishedSession, "speakerIds" | "speakerNames"> & {
  roomPosition: number;
  speakerIds: string | null;
  speakerNames: string | null;
};

type SpeakerPageRow = Omit<PublishedSpeaker, "imageUrl" | "sessionIds"> & {
  sessionIds: string;
};

function invalidPublicCursor(): never {
  throw new ApiError(
    422,
    "INVALID_CURSOR",
    "cursor is invalid or no longer supported",
  );
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function publishedPageDescriptor(
  env: CloudflareEnvironment,
  slug: string,
) {
  await ensureDemoProgramme(env);
  return env.DB.prepare(
    `
      SELECT event.id AS eventId, event.slug, event.timezone,
             event.repository_provider AS repositoryProvider,
             event.revision AS eventRevision,
             version.id AS versionId,
             version.version_number AS versionNumber,
             version.published_at AS publishedAt,
             COALESCE((
               SELECT MAX(change.sequence)
                 FROM event_changes change
                WHERE change.event_id = event.id
                  AND (
                    change.entity_type = 'event'
                    OR (change.entity_type = 'schedule_version'
                        AND change.entity_id = version.id)
                    OR (
                      change.entity_type = 'session'
                      AND EXISTS (
                        SELECT 1 FROM schedule_entries changed_entry
                         WHERE changed_entry.event_id = event.id
                           AND changed_entry.schedule_version_id = version.id
                           AND changed_entry.session_id = change.entity_id
                      )
                    )
                    OR (
                      change.entity_type = 'person'
                      AND EXISTS (
                        SELECT 1
                          FROM session_speakers changed_relation
                          JOIN schedule_entries changed_entry
                            ON changed_entry.event_id = changed_relation.event_id
                           AND changed_entry.session_id = changed_relation.session_id
                         WHERE changed_relation.event_id = event.id
                           AND changed_entry.schedule_version_id = version.id
                           AND changed_relation.person_id = change.entity_id
                      )
                    )
                    OR (
                      change.entity_type = 'file_version'
                      AND EXISTS (
                        SELECT 1
                          FROM file_versions changed_version
                          JOIN file_assets changed_asset
                            ON changed_asset.id = changed_version.asset_id
                           AND changed_asset.event_id = changed_version.event_id
                          JOIN session_speakers changed_relation
                            ON changed_relation.event_id = changed_asset.event_id
                           AND changed_relation.person_id = changed_asset.target_id
                          JOIN schedule_entries changed_entry
                            ON changed_entry.event_id = changed_relation.event_id
                           AND changed_entry.session_id = changed_relation.session_id
                         WHERE changed_version.id = change.entity_id
                           AND changed_version.event_id = event.id
                           AND changed_asset.target_type = 'person'
                           AND changed_asset.asset_kind = 'headshot'
                           AND changed_entry.schedule_version_id = version.id
                      )
                    )
                  )
             ), 0) AS latestPublicChangeSequence,
             (
               SELECT COUNT(*)
                 FROM schedule_entries entry
                 JOIN sessions session
                   ON session.id = entry.session_id
                  AND session.event_id = entry.event_id
                  AND session.status = 'published'
                  AND session.visibility = 'public'
                 LEFT JOIN schedule_session_contents content
                   ON content.schedule_version_id = entry.schedule_version_id
                  AND content.event_id = entry.event_id
                  AND content.session_id = entry.session_id
                  AND content.visibility = 'public'
                  AND content.content_status = 'approved'
                WHERE entry.event_id = event.id
                  AND entry.schedule_version_id = version.id
                  AND content.session_id IS NULL
             ) AS missingContent
        FROM events event
        JOIN schedule_versions version
          ON version.id = (
            SELECT candidate.id
              FROM schedule_versions candidate
             WHERE candidate.event_id = event.id
               AND candidate.status = 'published'
             ORDER BY candidate.published_at DESC,
                      candidate.version_number DESC
             LIMIT 1
          )
         AND version.event_id = event.id
       WHERE event.slug = ? AND event.activation_status = 'active'
         AND event.programme_published_at IS NOT NULL
    `,
  )
    .bind(slug)
    .first<PublishedPageDescriptor>();
}

async function pageCollectionRevision(
  descriptor: PublishedPageDescriptor,
  resource: "sessions" | "schedule" | "speakers",
  filters: Record<string, string | number | null>,
) {
  return sha256Hex(
    JSON.stringify({
      publication: [
        descriptor.versionId,
        descriptor.versionNumber,
        descriptor.publishedAt,
        descriptor.eventRevision,
        descriptor.latestPublicChangeSequence,
      ],
      resource,
      filters,
      timezone: resource === "schedule" ? descriptor.timezone : null,
    }),
  );
}

function d1Freshness(descriptor: PublishedPageDescriptor) {
  return {
    source: "d1" as const,
    fetchedAt: isoTimestamp(descriptor.publishedAt),
    cacheExpiresAt: null,
    cached: false as const,
  };
}

function publication(descriptor: PublishedPageDescriptor) {
  return {
    id: descriptor.versionId,
    versionNumber: descriptor.versionNumber,
  };
}

function sessionCursorSort(cursor: string | undefined, revision: string) {
  if (!cursor) return null;
  const sort = decodePublicCursor(cursor, revision);
  if (
    sort.length !== 4 ||
    typeof sort[0] !== "number" ||
    typeof sort[1] !== "number" ||
    typeof sort[2] !== "string" ||
    typeof sort[3] !== "string"
  ) {
    return invalidPublicCursor();
  }
  return sort as [number, number, string, string];
}

async function d1PublishedSessionPage(
  env: CloudflareEnvironment,
  descriptor: PublishedPageDescriptor,
  input: z.infer<typeof publicSessionQuerySchema>,
  resource: "sessions" | "schedule",
) {
  const filters = {
    q: input.q ?? null,
    track: input.track ?? null,
    room: input.room ?? null,
    speakerId: input.speakerId ?? null,
    from: input.from ?? null,
    to: input.to ?? null,
  };
  const revision = await pageCollectionRevision(descriptor, resource, filters);
  const cursor = sessionCursorSort(input.cursor, revision);
  const predicates: string[] = [];
  const bindings: Array<string | number> = [
    descriptor.eventId,
    descriptor.versionId,
  ];
  if (input.q) {
    predicates.push(`(
      instr(lower(content.title), lower(?)) > 0
      OR instr(lower(COALESCE(content.description, '')), lower(?)) > 0
      OR instr(lower(COALESCE(t.name, '')), lower(?)) > 0
      OR instr(lower(r.name), lower(?)) > 0
      OR EXISTS (
        SELECT 1
          FROM session_speakers search_relation
          JOIN people search_person
            ON search_person.id = search_relation.person_id
         WHERE search_relation.session_id = s.id
           AND search_relation.event_id = s.event_id
           AND search_relation.visibility = 'public'
           AND search_person.profile_status = 'published'
           AND instr(lower(search_person.display_name), lower(?)) > 0
      )
    )`);
    bindings.push(input.q, input.q, input.q, input.q, input.q);
  }
  if (input.track) {
    predicates.push("t.name = ? COLLATE NOCASE");
    bindings.push(input.track);
  }
  if (input.room) {
    predicates.push("r.name = ? COLLATE NOCASE");
    bindings.push(input.room);
  }
  if (input.speakerId) {
    predicates.push(`EXISTS (
      SELECT 1 FROM session_speakers filter_relation
       WHERE filter_relation.session_id = s.id
         AND filter_relation.event_id = s.event_id
         AND filter_relation.person_id = ?
         AND filter_relation.visibility = 'public'
    )`);
    bindings.push(input.speakerId);
  }
  if (input.from !== undefined) {
    predicates.push("se.starts_at >= ?");
    bindings.push(input.from);
  }
  if (input.to !== undefined) {
    predicates.push("se.starts_at < ?");
    bindings.push(input.to);
  }
  if (cursor) {
    predicates.push(`(
      se.starts_at > ?
      OR (se.starts_at = ? AND r.position > ?)
      OR (se.starts_at = ? AND r.position = ?
          AND content.title > ?)
      OR (se.starts_at = ? AND r.position = ?
          AND content.title = ? AND s.id > ?)
    )`);
    bindings.push(
      cursor[0],
      cursor[0],
      cursor[1],
      cursor[0],
      cursor[1],
      cursor[2],
      cursor[0],
      cursor[1],
      cursor[2],
      cursor[3],
    );
  }
  bindings.push(input.limit + 1);
  const rows = await env.DB.prepare(
    `
      SELECT s.id, content.slug, content.title,
             COALESCE(content.description, '') AS description,
             content.format, se.starts_at AS startsAt, se.ends_at AS endsAt,
             r.name AS room, r.building, r.level, r.position AS roomPosition,
             t.name AS track,
             (
               SELECT json_group_array(ordered.personId)
                 FROM (
                   SELECT relation.person_id AS personId
                     FROM session_speakers relation
                     JOIN people person
                       ON person.id = relation.person_id
                      AND person.profile_status = 'published'
                    WHERE relation.session_id = s.id
                      AND relation.event_id = s.event_id
                      AND relation.visibility = 'public'
                    ORDER BY relation.position, relation.person_id
                 ) ordered
             ) AS speakerIds,
             (
               SELECT json_group_array(ordered.displayName)
                 FROM (
                   SELECT person.display_name AS displayName
                     FROM session_speakers relation
                     JOIN people person
                       ON person.id = relation.person_id
                      AND person.profile_status = 'published'
                    WHERE relation.session_id = s.id
                      AND relation.event_id = s.event_id
                      AND relation.visibility = 'public'
                    ORDER BY relation.position, relation.person_id
                 ) ordered
             ) AS speakerNames
        FROM schedule_entries se
        JOIN schedule_versions current_version
          ON current_version.id = se.schedule_version_id
         AND current_version.event_id = se.event_id
         AND current_version.status = 'published'
        JOIN sessions s
          ON s.id = se.session_id AND s.event_id = se.event_id
        JOIN schedule_session_contents content
          ON content.schedule_version_id = se.schedule_version_id
         AND content.event_id = se.event_id
         AND content.session_id = s.id
        JOIN rooms r ON r.id = se.room_id AND r.event_id = se.event_id
        LEFT JOIN tracks t
          ON t.id = content.track_id AND t.event_id = content.event_id
         AND t.is_public = 1
       WHERE se.event_id = ? AND se.schedule_version_id = ?
         AND s.status = 'published' AND s.visibility = 'public'
         AND content.visibility = 'public'
         ${predicates.length ? `AND ${predicates.join(" AND ")}` : ""}
       ORDER BY se.starts_at, r.position, content.title, s.id
       LIMIT ?
    `,
  )
    .bind(...bindings)
    .all<SessionPageRow>();
  const hasMore = rows.results.length > input.limit;
  const selected = rows.results.slice(0, input.limit);
  const sessions = selected.map((row) => {
    const { roomPosition: _roomPosition, ...session } = row;
    return apiSession({
      ...session,
      speakerIds: parsePublishedSpeakerArray(
        descriptor.versionId,
        row.id,
        "speaker IDs",
        row.speakerIds,
      ),
      speakerNames: parsePublishedSpeakerArray(
        descriptor.versionId,
        row.id,
        "speaker names",
        row.speakerNames,
      ),
    });
  });
  const last = selected.at(-1);
  const body = {
    sessions,
    nextCursor:
      hasMore && last
        ? encodePublicCursor(revision, [
            last.startsAt,
            last.roomPosition,
            last.title,
            last.id,
          ])
        : null,
    publication: publication(descriptor),
    freshness: d1Freshness(descriptor),
  };
  return { body, contentRevision: await sha256Hex(JSON.stringify(body)) };
}

function speakerCursorSort(cursor: string | undefined, revision: string) {
  if (!cursor) return null;
  const sort = decodePublicCursor(cursor, revision);
  if (
    sort.length !== 2 ||
    typeof sort[0] !== "string" ||
    typeof sort[1] !== "string"
  ) {
    return invalidPublicCursor();
  }
  return sort as [string, string];
}

async function d1PublishedSpeakerPage(
  env: CloudflareEnvironment,
  descriptor: PublishedPageDescriptor,
  input: z.infer<typeof publicSpeakerQuerySchema>,
) {
  const revision = await pageCollectionRevision(descriptor, "speakers", {
    q: input.q ?? null,
    sessionId: input.sessionId ?? null,
  });
  const cursor = speakerCursorSort(input.cursor, revision);
  const predicates: string[] = [];
  const bindings: Array<string | number> = [
    descriptor.eventId,
    descriptor.versionId,
    descriptor.eventId,
    descriptor.versionId,
  ];
  if (input.q) {
    predicates.push(`(
      instr(lower(p.display_name), lower(?)) > 0
      OR instr(lower(COALESCE(p.biography, '')), lower(?)) > 0
      OR instr(lower(COALESCE(p.organisation_name, '')), lower(?)) > 0
      OR instr(lower(COALESCE(p.job_title, '')), lower(?)) > 0
    )`);
    bindings.push(input.q, input.q, input.q, input.q);
  }
  if (input.sessionId) {
    predicates.push(`EXISTS (
      SELECT 1
        FROM session_speakers filter_relation
        JOIN sessions filter_session
          ON filter_session.id = filter_relation.session_id
         AND filter_session.event_id = filter_relation.event_id
        JOIN schedule_entries filter_entry
          ON filter_entry.session_id = filter_session.id
         AND filter_entry.event_id = filter_session.event_id
        JOIN schedule_session_contents filter_content
          ON filter_content.schedule_version_id = filter_entry.schedule_version_id
         AND filter_content.event_id = filter_entry.event_id
         AND filter_content.session_id = filter_session.id
       WHERE filter_relation.person_id = p.id
         AND filter_relation.event_id = ?
         AND filter_relation.session_id = ?
         AND filter_relation.visibility = 'public'
         AND filter_session.status = 'published'
         AND filter_session.visibility = 'public'
         AND filter_entry.schedule_version_id = ?
         AND filter_content.visibility = 'public'
    )`);
    bindings.push(descriptor.eventId, input.sessionId, descriptor.versionId);
  }
  if (cursor) {
    predicates.push(`(
      p.display_name COLLATE NOCASE > ? COLLATE NOCASE
      OR (p.display_name = ? COLLATE NOCASE AND p.id > ?)
    )`);
    bindings.push(cursor[0], cursor[0], cursor[1]);
  }
  bindings.push(input.limit + 1);
  const rows = await env.DB.prepare(
    `
      SELECT p.id, p.display_name AS displayName, p.biography,
             p.pronunciation, p.organisation_name AS organisationName,
             p.job_title AS jobTitle,
             (
               SELECT json_group_array(ordered.sessionId)
                 FROM (
                   SELECT linked_session.id AS sessionId
                     FROM session_speakers linked_relation
                     JOIN sessions linked_session
                       ON linked_session.id = linked_relation.session_id
                      AND linked_session.event_id = linked_relation.event_id
                     JOIN schedule_entries linked_entry
                       ON linked_entry.session_id = linked_session.id
                      AND linked_entry.event_id = linked_session.event_id
                     JOIN schedule_session_contents linked_content
                       ON linked_content.schedule_version_id = linked_entry.schedule_version_id
                      AND linked_content.event_id = linked_entry.event_id
                      AND linked_content.session_id = linked_session.id
                    WHERE linked_relation.person_id = p.id
                      AND linked_session.event_id = ?
                      AND linked_entry.schedule_version_id = ?
                      AND linked_session.status = 'published'
                      AND linked_session.visibility = 'public'
                      AND linked_content.visibility = 'public'
                      AND linked_relation.visibility = 'public'
                    ORDER BY linked_entry.starts_at, linked_session.id
                 ) ordered
             ) AS sessionIds
        FROM people p
        JOIN session_speakers relation ON relation.person_id = p.id
        JOIN sessions session
          ON session.id = relation.session_id
         AND session.event_id = relation.event_id
        JOIN schedule_entries entry
          ON entry.session_id = session.id AND entry.event_id = session.event_id
        JOIN schedule_versions current_version
          ON current_version.id = entry.schedule_version_id
         AND current_version.event_id = entry.event_id
         AND current_version.status = 'published'
        JOIN schedule_session_contents content
          ON content.schedule_version_id = entry.schedule_version_id
         AND content.event_id = entry.event_id
         AND content.session_id = session.id
       WHERE session.event_id = ? AND entry.schedule_version_id = ?
         AND session.status = 'published' AND session.visibility = 'public'
         AND content.visibility = 'public'
         AND relation.visibility = 'public'
         AND p.profile_status = 'published'
         ${predicates.length ? `AND ${predicates.join(" AND ")}` : ""}
       GROUP BY p.id
       ORDER BY p.display_name COLLATE NOCASE, p.id
       LIMIT ?
    `,
  )
    .bind(...bindings)
    .all<SpeakerPageRow>();
  const hasMore = rows.results.length > input.limit;
  const selected = rows.results.slice(0, input.limit);
  const speakers = selected.map((speaker) => ({
    ...speaker,
    imageUrl: null,
    sessionIds: parsePublishedSpeakerSessionIds(
      descriptor.versionId,
      speaker.id,
      speaker.sessionIds,
    ),
  }));
  const withHeadshots = await new PublishedHeadshotService(
    env,
  ).withPublishedPageHeadshotUrls(
    { id: descriptor.eventId, slug: descriptor.slug },
    { id: descriptor.versionId },
    speakers,
  );
  const last = selected.at(-1);
  const body = {
    speakers: withHeadshots,
    nextCursor:
      hasMore && last
        ? encodePublicCursor(revision, [last.displayName, last.id])
        : null,
    publication: publication(descriptor),
    freshness: d1Freshness(descriptor),
  };
  return { body, contentRevision: await sha256Hex(JSON.stringify(body)) };
}

export async function getPublicSessionPage(
  env: CloudflareEnvironment,
  slug: string,
  input: z.infer<typeof publicSessionQuerySchema>,
  resource: "sessions" | "schedule" = "sessions",
) {
  const descriptor = requirePublishedProgramme(
    await publishedPageDescriptor(env, slug),
  );
  if (descriptor.repositoryProvider === "d1" && descriptor.missingContent > 0) {
    throw new PublishedProgrammeSnapshotInvariantError(
      descriptor.versionId,
      descriptor.missingContent,
    );
  }
  if (descriptor.repositoryProvider === "airtable") {
    const programme = requirePublishedProgramme(
      await new PublicProgrammeService(env).getPublished(slug),
    );
    const body =
      resource === "schedule"
        ? await publicSchedulePage(programme, input)
        : await publicSessionPage(programme, input);
    return { body, contentRevision: programme.contentRevision };
  }
  const page = await d1PublishedSessionPage(env, descriptor, input, resource);
  if (resource !== "schedule") return page;
  const body = {
    entries: page.body.sessions,
    nextCursor: page.body.nextCursor,
    publication: page.body.publication,
    timezone: descriptor.timezone,
    freshness: page.body.freshness,
  };
  return { body, contentRevision: await sha256Hex(JSON.stringify(body)) };
}

export async function getPublicSpeakerPage(
  env: CloudflareEnvironment,
  slug: string,
  input: z.infer<typeof publicSpeakerQuerySchema>,
) {
  const descriptor = requirePublishedProgramme(
    await publishedPageDescriptor(env, slug),
  );
  if (descriptor.repositoryProvider === "d1" && descriptor.missingContent > 0) {
    throw new PublishedProgrammeSnapshotInvariantError(
      descriptor.versionId,
      descriptor.missingContent,
    );
  }
  if (descriptor.repositoryProvider === "airtable") {
    const programme = requirePublishedProgramme(
      await new PublicProgrammeService(env).getPublished(slug),
    );
    return {
      body: await publicSpeakerPage(programme, input),
      contentRevision: programme.contentRevision,
    };
  }
  return d1PublishedSpeakerPage(env, descriptor, input);
}

export function requirePublishedProgramme<T>(programme: T | null): T {
  if (!programme) {
    throw new ApiError(
      404,
      "EVENT_NOT_FOUND",
      "Published event programme not found",
    );
  }
  return programme;
}

async function publicResourceRevision(
  request: Request,
  contentRevision: string,
) {
  const url = new URL(request.url);
  url.searchParams.sort();
  const resource = `${url.pathname}${url.search}`;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${resource}\n${contentRevision}`),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function publishedProgrammeCacheHeaders(
  request: Request,
  programme: Pick<PublishedProgramme, "contentRevision">,
  representationRevision = "",
) {
  return {
    "cache-control":
      "public, max-age=0, s-maxage=300, stale-while-revalidate=60, must-revalidate",
    etag: `"program-cue-publication-${await publicResourceRevision(request, `${programme.contentRevision}\n${representationRevision}`)}"`,
  } as const;
}

export function publishedProgrammeNotModified(request: Request, etag: string) {
  const candidate = request.headers.get("if-none-match");
  if (!candidate) return false;
  return (
    candidate.trim() === "*" ||
    candidate.split(",").some((value) => value.trim() === etag)
  );
}
