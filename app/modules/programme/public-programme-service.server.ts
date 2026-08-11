import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import { AirtableProgrammeRepository } from "~/modules/airtable/airtable-programme-repository.server";
import { eventBoundaryCalendarDate } from "~/modules/schedule/schedule-time";
import {
  PublicItineraryService,
  type ItineraryIdentity,
} from "./public-itinerary-service.server";
export {
  PublishedProgrammeItineraryExpiredError,
  PublishedProgrammeItineraryNotFoundError,
  PublishedProgrammeSessionNotFoundError,
} from "./public-itinerary-service.server";
export type { ItineraryIdentity } from "./public-itinerary-service.server";

const encoder = new TextEncoder();
const PUBLIC_HEADSHOT_CONTENT_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
] as const;

type PublishedHeadshot = {
  personId: string;
  versionId: string;
  objectKey: string;
  objectEtag: string;
  contentType: (typeof PUBLIC_HEADSHOT_CONTENT_TYPES)[number];
};

export function publishedHeadshotPath(eventSlug: string, personId: string) {
  return `/public/programme/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(personId)}/headshot`;
}

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

export type PublishedSpeaker = {
  id: string;
  displayName: string;
  imageUrl: string | null;
  biography: string | null;
  pronunciation: string | null;
  organisationName: string | null;
  jobTitle: string | null;
  sessionIds: string[];
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
  speakers: PublishedSpeaker[];
  freshness:
    | {
        source: "d1";
        fetchedAt: number;
        cacheExpiresAt: null;
        cached: false;
      }
    | {
        source: "airtable";
        fetchedAt: number;
        cacheExpiresAt: number;
        cached: boolean;
      };
  /** Hash of every public representation input, including freshness data. */
  contentRevision: string;
};

export class PublishedProgrammeSnapshotInvariantError extends Error {
  constructor(versionId: string, missingContent: number) {
    super(
      `Published schedule version ${versionId} is missing ${missingContent} session-content snapshot${missingContent === 1 ? "" : "s"}.`,
    );
    this.name = "PublishedProgrammeSnapshotInvariantError";
  }
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function publicContentRevision(
  programme: Omit<PublishedProgramme, "contentRevision">,
) {
  return sha256(
    JSON.stringify({
      event: [
        programme.event.id,
        programme.event.slug,
        programme.event.name,
        programme.event.timezone,
        programme.event.startDate,
        programme.event.endDate,
        programme.event.venue,
        programme.event.city,
        programme.event.description,
        programme.event.brandAccent,
      ],
      version: [
        programme.version.id,
        programme.version.versionNumber,
        programme.version.publishedAt,
      ],
      sessions: programme.sessions.map((session) => [
        session.id,
        session.slug,
        session.title,
        session.description,
        session.format,
        session.startsAt,
        session.endsAt,
        session.room,
        session.building,
        session.level,
        session.track,
        session.speakerIds,
        session.speakerNames,
      ]),
      speakers: programme.speakers.map((speaker) => [
        speaker.id,
        speaker.displayName,
        speaker.imageUrl,
        speaker.biography,
        speaker.pronunciation,
        speaker.organisationName,
        speaker.jobTitle,
        speaker.sessionIds,
      ]),
      freshness: [
        programme.freshness.source,
        programme.freshness.fetchedAt,
        programme.freshness.cacheExpiresAt,
        programme.freshness.cached,
      ],
    }),
  );
}

async function withPublicContentRevision(
  programme: Omit<PublishedProgramme, "contentRevision">,
): Promise<PublishedProgramme> {
  return {
    ...programme,
    contentRevision: await publicContentRevision(programme),
  };
}

export class PublicProgrammeService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async publishedHeadshotPersonIds(eventId: string, versionId: string) {
    const rows = await this.env.DB.prepare(
      `
      SELECT DISTINCT person.id AS personId
        FROM schedule_versions published_version
        JOIN schedule_entries entry
          ON entry.schedule_version_id = published_version.id
         AND entry.event_id = published_version.event_id
        JOIN sessions session
          ON session.id = entry.session_id AND session.event_id = entry.event_id
        JOIN schedule_session_contents content
          ON content.schedule_version_id = entry.schedule_version_id
         AND content.event_id = entry.event_id
         AND content.session_id = entry.session_id
        JOIN session_speakers relation
          ON relation.session_id = entry.session_id
         AND relation.event_id = entry.event_id
        JOIN people person
          ON person.id = relation.person_id
        JOIN file_assets asset
          ON asset.event_id = entry.event_id
         AND asset.target_type = 'person'
         AND asset.target_id = person.id
         AND asset.asset_kind = 'headshot'
         AND asset.status = 'active'
        JOIN file_versions version
          ON version.id = asset.current_version_id
         AND version.asset_id = asset.id
         AND version.event_id = asset.event_id
       WHERE published_version.id = ? AND published_version.event_id = ?
         AND published_version.status = 'published'
         AND session.status = 'published' AND content.visibility = 'public'
         AND relation.visibility = 'public'
         AND person.profile_status = 'published'
         AND version.upload_status = 'uploaded'
         AND version.signature_status = 'valid'
         AND version.scan_status = 'clean'
         AND version.released_at IS NOT NULL
         AND version.replaced_at IS NULL AND version.deleted_at IS NULL
         AND version.object_etag IS NOT NULL
         AND version.detected_content_type IN ('image/jpeg', 'image/png', 'image/webp')
    `,
    )
      .bind(versionId, eventId)
      .all<{ personId: string }>();
    return new Set(rows.results.map((row) => row.personId));
  }

  private async withPublishedHeadshotUrls(
    event: Pick<PublishedProgramme["event"], "id" | "slug">,
    version: Pick<PublishedProgramme["version"], "id">,
    speakers: PublishedSpeaker[],
  ) {
    const personIds = await this.publishedHeadshotPersonIds(
      event.id,
      version.id,
    );
    return speakers.map((speaker) => ({
      ...speaker,
      imageUrl: personIds.has(speaker.id)
        ? publishedHeadshotPath(event.slug, speaker.id)
        : null,
    }));
  }

  private async findPublishedHeadshot(
    slug: string,
    personId: string,
  ): Promise<PublishedHeadshot | null> {
    return this.env.DB.prepare(
      `
      SELECT person.id AS personId, version.id AS versionId,
             version.object_key AS objectKey,
             version.object_etag AS objectEtag,
             version.detected_content_type AS contentType
        FROM events event
        JOIN schedule_versions published_version
          ON published_version.id = (
            SELECT candidate.id
              FROM schedule_versions candidate
             WHERE candidate.event_id = event.id
               AND candidate.status = 'published'
             ORDER BY candidate.published_at DESC,
                      candidate.version_number DESC
             LIMIT 1
          )
         AND published_version.event_id = event.id
        JOIN schedule_entries entry
          ON entry.schedule_version_id = published_version.id
         AND entry.event_id = published_version.event_id
        JOIN sessions session
          ON session.id = entry.session_id AND session.event_id = entry.event_id
        JOIN schedule_session_contents content
          ON content.schedule_version_id = entry.schedule_version_id
         AND content.event_id = entry.event_id
         AND content.session_id = entry.session_id
        JOIN session_speakers relation
          ON relation.session_id = entry.session_id
         AND relation.event_id = entry.event_id
        JOIN people person
          ON person.id = relation.person_id
        JOIN file_assets asset
          ON asset.event_id = event.id
         AND asset.target_type = 'person'
         AND asset.target_id = person.id
         AND asset.asset_kind = 'headshot'
         AND asset.status = 'active'
        JOIN file_versions version
          ON version.id = asset.current_version_id
         AND version.asset_id = asset.id
         AND version.event_id = asset.event_id
       WHERE event.slug = ? AND event.programme_published_at IS NOT NULL
         AND person.id = ? AND person.profile_status = 'published'
         AND session.status = 'published' AND content.visibility = 'public'
         AND relation.visibility = 'public'
         AND version.upload_status = 'uploaded'
         AND version.signature_status = 'valid'
         AND version.scan_status = 'clean'
         AND version.released_at IS NOT NULL
         AND version.replaced_at IS NULL AND version.deleted_at IS NULL
         AND version.object_etag IS NOT NULL
         AND version.detected_content_type IN ('image/jpeg', 'image/png', 'image/webp')
       ORDER BY asset.updated_at DESC, asset.id
       LIMIT 1
    `,
    )
      .bind(slug, personId)
      .first<PublishedHeadshot>();
  }

  async getPublishedHeadshot(
    slug: string,
    personId: string,
  ): Promise<Response | null> {
    await ensureDemoProgramme(this.env);
    const headshot = await this.findPublishedHeadshot(slug, personId);
    if (!headshot) return null;
    if (!this.env.FILES) {
      throw new Error("Required private R2 binding FILES is unavailable.");
    }
    const object = await this.env.FILES.get(headshot.objectKey);
    if (!object) {
      throw new Error("The released public headshot R2 object is missing.");
    }
    if (object.httpEtag !== headshot.objectEtag) {
      throw new Error(
        "The released public headshot R2 object no longer matches its scanned version.",
      );
    }
    const current = await this.findPublishedHeadshot(slug, personId);
    if (
      !current ||
      current.versionId !== headshot.versionId ||
      current.objectKey !== headshot.objectKey ||
      current.objectEtag !== headshot.objectEtag
    ) {
      return null;
    }
    return new Response(object.body, {
      headers: {
        "access-control-allow-origin": "*",
        "cache-control": "no-store",
        "content-disposition": "inline",
        "content-length": String(object.size),
        "content-type": headshot.contentType,
        "cross-origin-resource-policy": "cross-origin",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  }

  async getPublished(slug: string): Promise<PublishedProgramme | null> {
    await ensureDemoProgramme(this.env);
    const eventRow = await this.env.DB.prepare(
      `
      SELECT id, slug, name, timezone, starts_at AS startDateMarker,
             ends_at AS endDateMarker,
             venue_name AS venue, city, description, brand_accent AS brandAccent,
             organisation_id AS organisationId,
             repository_provider AS repositoryProvider
        FROM events WHERE slug = ? AND programme_published_at IS NOT NULL
    `,
    )
      .bind(slug)
      .first<
        Omit<PublishedProgramme["event"], "startDate" | "endDate"> & {
          startDateMarker: number;
          endDateMarker: number;
          organisationId: string;
          repositoryProvider: "d1" | "airtable";
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
       ORDER BY published_at DESC, version_number DESC LIMIT 1
    `,
    )
      .bind(event.id)
      .first<PublishedProgramme["version"]>();
    if (!version) return null;
    if (eventRow.repositoryProvider === "airtable") {
      const snapshot = await new AirtableProgrammeRepository(
        this.env,
      ).readPublished(eventRow.organisationId, event.id, version.id);
      return withPublicContentRevision({
        event,
        version,
        sessions: snapshot.sessions,
        speakers: await this.withPublishedHeadshotUrls(
          event,
          version,
          snapshot.speakers,
        ),
        freshness: snapshot.freshness,
      });
    }
    const snapshotIntegrity = await this.env.DB.prepare(
      `SELECT COUNT(*) AS missingContent
         FROM schedule_entries entry
         LEFT JOIN schedule_session_contents content
           ON content.schedule_version_id = entry.schedule_version_id
          AND content.event_id = entry.event_id
          AND content.session_id = entry.session_id
        WHERE entry.event_id = ? AND entry.schedule_version_id = ?
          AND content.session_id IS NULL`,
    )
      .bind(event.id, version.id)
      .first<{ missingContent: number }>();
    if (!snapshotIntegrity) {
      throw new Error(
        "Published schedule snapshot integrity query returned no result.",
      );
    }
    if (snapshotIntegrity.missingContent > 0) {
      throw new PublishedProgrammeSnapshotInvariantError(
        version.id,
        snapshotIntegrity.missingContent,
      );
    }
    const rows = await this.env.DB.prepare(
      `
      SELECT s.id, content.slug, content.title,
             COALESCE(content.description, '') AS description, content.format,
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
        JOIN schedule_versions current_version
          ON current_version.id = se.schedule_version_id
         AND current_version.event_id = se.event_id
         AND current_version.status = 'published'
        JOIN sessions s ON s.id = se.session_id AND s.event_id = se.event_id
        JOIN schedule_session_contents content
          ON content.schedule_version_id = se.schedule_version_id
         AND content.event_id = se.event_id AND content.session_id = s.id
        JOIN rooms r ON r.id = se.room_id AND r.event_id = se.event_id
        LEFT JOIN tracks t
          ON t.id = content.track_id AND t.event_id = content.event_id
         AND t.is_public = 1
       WHERE se.event_id = ? AND se.schedule_version_id = ?
         AND s.status = 'published' AND content.visibility = 'public'
       ORDER BY se.starts_at, r.position, content.title
    `,
    )
      .bind(event.id, version.id)
      .all<
        Omit<PublishedSession, "speakerIds" | "speakerNames"> & {
          speakerIds: string | null;
          speakerNames: string | null;
        }
      >();
    const speakers = await this.env.DB.prepare(
      `
      SELECT p.id, p.display_name AS displayName, p.biography, p.pronunciation,
             p.organisation_name AS organisationName, p.job_title AS jobTitle,
             GROUP_CONCAT(ss.session_id, '||') AS sessionIds
        FROM people p
        JOIN session_speakers ss ON ss.person_id = p.id
        JOIN sessions s ON s.id = ss.session_id AND s.event_id = ss.event_id
        JOIN schedule_entries se ON se.session_id = s.id AND se.event_id = s.event_id
        JOIN schedule_versions current_version
          ON current_version.id = se.schedule_version_id
         AND current_version.event_id = se.event_id
         AND current_version.status = 'published'
        JOIN schedule_session_contents content
          ON content.schedule_version_id = se.schedule_version_id
         AND content.event_id = se.event_id AND content.session_id = s.id
       WHERE s.event_id = ? AND se.schedule_version_id = ?
         AND s.status = 'published' AND content.visibility = 'public'
         AND ss.visibility = 'public' AND p.profile_status = 'published'
       GROUP BY p.id
       ORDER BY p.display_name COLLATE NOCASE, p.id
    `,
    )
      .bind(event.id, version.id)
      .all<
        Omit<PublishedSpeaker, "imageUrl" | "sessionIds"> & {
          sessionIds: string;
        }
      >();
    const publishedSpeakers = speakers.results.map((speaker) => ({
      ...speaker,
      imageUrl: null,
      sessionIds: speaker.sessionIds.split("||"),
    }));
    return withPublicContentRevision({
      event,
      version,
      sessions: rows.results.map((row) => ({
        ...row,
        speakerIds: row.speakerIds?.split("||") ?? [],
        speakerNames: row.speakerNames?.split("||") ?? [],
      })),
      speakers: await this.withPublishedHeadshotUrls(
        event,
        version,
        publishedSpeakers,
      ),
      freshness: {
        source: "d1",
        // D1 is the authoritative local source rather than a fetched cache.
        // Use the immutable publication timestamp so an unchanged response has
        // a stable strong validator across requests.
        fetchedAt: version.publishedAt,
        cacheExpiresAt: null,
        cached: false,
      },
    });
  }

  private itineraryService() {
    return new PublicItineraryService(this.env);
  }

  itinerary(programme: PublishedProgramme, identity: ItineraryIdentity) {
    return this.itineraryService().itinerary(programme, identity);
  }

  itineraryIsSynced(
    programme: PublishedProgramme,
    identity: ItineraryIdentity,
  ) {
    return this.itineraryService().itineraryIsSynced(programme, identity);
  }

  hasActiveAnonymousItinerary(
    programme: PublishedProgramme,
    visitorToken: string | null,
  ) {
    return this.itineraryService().hasActiveAnonymousItinerary(
      programme,
      visitorToken,
    );
  }

  sharedItinerary(programme: PublishedProgramme, shareToken: string) {
    return this.itineraryService().sharedItinerary(programme, shareToken);
  }

  syncItinerary(programme: PublishedProgramme, identity: ItineraryIdentity) {
    return this.itineraryService().syncItinerary(programme, identity);
  }

  updateItinerary(
    programme: PublishedProgramme,
    identity: ItineraryIdentity,
    sessionId: string,
    intent: "add" | "remove",
  ) {
    return this.itineraryService().updateItinerary(
      programme,
      identity,
      sessionId,
      intent,
    );
  }

  shareItinerary(programme: PublishedProgramme, identity: ItineraryIdentity) {
    return this.itineraryService().shareItinerary(programme, identity);
  }
}

export function readCookie(request: Request, name: string) {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) {
      try {
        return decodeURIComponent(value.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}
