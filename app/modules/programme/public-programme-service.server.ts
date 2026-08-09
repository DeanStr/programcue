import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import {
  eventBoundaryCalendarDate,
  eventLocalEndOfDayEpoch,
} from "~/modules/schedule/schedule-time";

const encoder = new TextEncoder();

export type PublishedSession = {
  id: string;
  slug: string;
  title: string;
  description: string;
  format: string;
  startsAt: number;
  endsAt: number;
  room: string;
  building: string | null;
  level: string | null;
  track: string | null;
  speakerIds: string[];
  speakerNames: string[];
};

export type PublishedProgramme = {
  event: {
    id: string;
    slug: string;
    name: string;
    timezone: string;
    startDate: string;
    endDate: string;
    venue: string | null;
    city: string | null;
    description: string | null;
    brandAccent: string;
  };
  version: { id: string; versionNumber: number; publishedAt: number };
  sessions: PublishedSession[];
};

export class PublishedProgrammeSessionNotFoundError extends Error {
  constructor() {
    super("Published session not found.");
    this.name = "PublishedProgrammeSessionNotFoundError";
  }
}

export class PublishedProgrammeItineraryExpiredError extends Error {
  constructor() {
    super("This event's itinerary is no longer available.");
    this.name = "PublishedProgrammeItineraryExpiredError";
  }
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export class PublicProgrammeService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async getPublished(slug: string): Promise<PublishedProgramme | null> {
    await ensureDemoProgramme(this.env);
    const eventRow = await this.env.DB.prepare(
      `
      SELECT id, slug, name, timezone, starts_at AS startDateMarker,
             ends_at AS endDateMarker,
             venue_name AS venue, city, description, brand_accent AS brandAccent
        FROM events WHERE slug = ? AND programme_published_at IS NOT NULL
    `,
    )
      .bind(slug)
      .first<
        Omit<PublishedProgramme["event"], "startDate" | "endDate"> & {
          startDateMarker: number;
          endDateMarker: number;
        }
      >();
    if (!eventRow) return null;
    const event: PublishedProgramme["event"] = {
      id: eventRow.id,
      slug: eventRow.slug,
      name: eventRow.name,
      timezone: eventRow.timezone,
      startDate: eventBoundaryCalendarDate(eventRow.startDateMarker),
      endDate: eventBoundaryCalendarDate(eventRow.endDateMarker),
      venue: eventRow.venue,
      city: eventRow.city,
      description: eventRow.description,
      brandAccent: eventRow.brandAccent,
    };
    const version = await this.env.DB.prepare(
      `
      SELECT id, version_number AS versionNumber, published_at AS publishedAt
        FROM schedule_versions WHERE event_id = ? AND status = 'published'
       ORDER BY published_at DESC LIMIT 1
    `,
    )
      .bind(event.id)
      .first<PublishedProgramme["version"]>();
    if (!version) return null;
    const rows = await this.env.DB.prepare(
      `
      SELECT s.id, s.slug, s.title, COALESCE(s.description, '') AS description, s.format,
             se.starts_at AS startsAt, se.ends_at AS endsAt, r.name AS room, r.building, r.level,
             t.name AS track,
             (
               SELECT GROUP_CONCAT(ordered.personId, '||')
                 FROM (
                   SELECT ss.person_id AS personId
                     FROM session_speakers ss
                     JOIN people p ON p.id = ss.person_id AND p.profile_status = 'published'
                    WHERE ss.session_id = s.id AND ss.event_id = s.event_id
                      AND ss.visibility = 'public'
                    ORDER BY ss.position, ss.person_id
                 ) ordered
             ) AS speakerIds,
             (
               SELECT GROUP_CONCAT(ordered.displayName, '||')
                 FROM (
                   SELECT p.display_name AS displayName
                     FROM session_speakers ss
                     JOIN people p ON p.id = ss.person_id AND p.profile_status = 'published'
                    WHERE ss.session_id = s.id AND ss.event_id = s.event_id
                      AND ss.visibility = 'public'
                    ORDER BY ss.position, ss.person_id
                 ) ordered
             ) AS speakerNames
        FROM schedule_entries se
        JOIN sessions s ON s.id = se.session_id AND s.event_id = se.event_id
        JOIN rooms r ON r.id = se.room_id AND r.event_id = se.event_id
        LEFT JOIN tracks t ON t.id = s.track_id AND t.event_id = s.event_id AND t.is_public = 1
       WHERE se.event_id = ? AND se.schedule_version_id = ?
         AND s.status = 'published' AND s.visibility = 'public'
       ORDER BY se.starts_at, r.position, s.title
    `,
    )
      .bind(event.id, version.id)
      .all<
        Omit<PublishedSession, "speakerIds" | "speakerNames"> & {
          speakerIds: string | null;
          speakerNames: string | null;
        }
      >();
    return {
      event,
      version,
      sessions: rows.results.map((row) => ({
        ...row,
        speakerIds: row.speakerIds?.split("||") ?? [],
        speakerNames: row.speakerNames?.split("||") ?? [],
      })),
    };
  }

  async itinerary(programme: PublishedProgramme, visitorToken: string | null) {
    if (!visitorToken) return [] as string[];
    const visitorHash = await sha256(visitorToken);
    const rows = await this.env.DB.prepare(
      `
      SELECT i.session_id AS sessionId
        FROM public_itineraries p JOIN public_itinerary_items i ON i.itinerary_id = p.id
        JOIN schedule_entries se ON se.session_id = i.session_id AND se.event_id = p.event_id
       WHERE p.event_id = ? AND p.visitor_key_hash = ?
         AND (p.expires_at IS NULL OR p.expires_at > unixepoch())
         AND se.schedule_version_id = ?
       ORDER BY se.starts_at
    `,
    )
      .bind(programme.event.id, visitorHash, programme.version.id)
      .all<{ sessionId: string }>();
    return rows.results.map((row) => row.sessionId);
  }

  async updateItinerary(
    programme: PublishedProgramme,
    visitorToken: string | null,
    sessionId: string,
    intent: "add" | "remove",
  ) {
    const published = programme.sessions.some(
      (session) => session.id === sessionId,
    );
    if (!published) throw new PublishedProgrammeSessionNotFoundError();
    // The fixed demo programme is durable reference data rather than a live event.
    // Production itineraries retain the event-relative expiry without extension.
    const expiresAt =
      String(this.env.DEMO_MODE) === "true"
        ? null
        : eventLocalEndOfDayEpoch(
            Math.floor(
              Date.parse(`${programme.event.endDate}T00:00:00Z`) / 1_000,
            ),
            programme.event.timezone,
          ) +
          365 * 86_400;
    if (expiresAt !== null && expiresAt <= Math.floor(Date.now() / 1_000)) {
      throw new PublishedProgrammeItineraryExpiredError();
    }
    let token: string;
    let visitorHash: string;
    let existing: { id: string; expiresAt: number | null } | null = null;
    if (visitorToken) {
      const candidateHash = await sha256(visitorToken);
      existing = await this.env.DB.prepare(
        `SELECT id, expires_at AS expiresAt FROM public_itineraries
            WHERE event_id = ? AND visitor_key_hash = ?`,
      )
        .bind(programme.event.id, candidateHash)
        .first<{ id: string; expiresAt: number | null }>();
      const existingIsActive =
        existing !== null &&
        (existing.expiresAt === null ||
          existing.expiresAt > Math.floor(Date.now() / 1_000));
      if (existingIsActive || existing === null) {
        token = visitorToken;
        visitorHash = candidateHash;
      } else {
        token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
        visitorHash = await sha256(token);
        existing = null;
      }
    } else {
      token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
      visitorHash = await sha256(token);
    }
    const itineraryId = existing?.id ?? crypto.randomUUID();
    if (intent === "add") {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO public_itineraries (id, event_id, visitor_key_hash, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())`,
        ).bind(itineraryId, programme.event.id, visitorHash, expiresAt),
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO public_itinerary_items (itinerary_id, session_id, created_at)
           SELECT p.id, s.id, unixepoch()
             FROM public_itineraries p
             JOIN sessions s ON s.id = ? AND s.event_id = p.event_id
            WHERE p.event_id = ? AND p.visitor_key_hash = ?
              AND (p.expires_at IS NULL OR p.expires_at > unixepoch())
              AND s.status = 'published' AND s.visibility = 'public'`,
        ).bind(sessionId, programme.event.id, visitorHash),
      ]);
    } else if (existing) {
      await this.env.DB.prepare(
        `DELETE FROM public_itinerary_items
          WHERE itinerary_id = ? AND session_id = ?
            AND EXISTS (
              SELECT 1 FROM public_itineraries p
               WHERE p.id = public_itinerary_items.itinerary_id
                 AND (p.expires_at IS NULL OR p.expires_at > unixepoch())
            )`,
      )
        .bind(itineraryId, sessionId)
        .run();
    }
    const cookieRetention = await this.env.DB.prepare(
      `SELECT CASE
                WHEN SUM(CASE WHEN expires_at IS NULL THEN 1 ELSE 0 END) > 0
                  THEN NULL
                ELSE MAX(expires_at)
              END AS expiresAt
         FROM public_itineraries
        WHERE visitor_key_hash = ?
          AND (expires_at IS NULL OR expires_at > unixepoch())`,
    )
      .bind(visitorHash)
      .first<{ expiresAt: number | null }>();
    if (!cookieRetention) {
      throw new Error("Itinerary cookie retention query returned no result.");
    }
    return { token, expiresAt: cookieRetention.expiresAt };
  }
}

export function readCookie(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}
