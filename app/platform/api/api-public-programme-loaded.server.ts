import type { z } from "zod";

import type {
  PublishedProgramme,
  PublishedSession,
  PublishedSpeaker,
} from "~/modules/programme/public-programme-service.server";
import { ApiError } from "./api.server";
import {
  decodePublicCursor,
  encodePublicCursor,
  isoTimestamp,
} from "./api-pagination.server";
import type {
  publicProgrammeQuerySchema,
  publicSessionQuerySchema,
  publicSpeakerQuerySchema,
} from "./api-public-programme-schema";

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

export function apiSession(session: PublishedSession) {
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
