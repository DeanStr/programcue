import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import { AirtableProgrammeRepository } from "~/modules/airtable/airtable-programme-repository.server";
import {
  eventBoundaryCalendarDate,
  eventLocalEndOfDayEpoch,
} from "~/modules/schedule/schedule-time";

const encoder = new TextEncoder();
const EXPIRED_ITINERARY_CLEANUP_LIMIT = 100;

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

export type ItineraryIdentity = {
  personId: string | null;
  visitorToken: string | null;
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

export class PublishedProgrammeItineraryNotFoundError extends Error {
  constructor(
    message = "Save at least one session before sharing an itinerary.",
  ) {
    super(message);
    this.name = "PublishedProgrammeItineraryNotFoundError";
  }
}

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

  async itinerary(programme: PublishedProgramme, identity: ItineraryIdentity) {
    if (!identity.personId && !identity.visitorToken) return [] as string[];
    const visitorHash = identity.visitorToken
      ? await sha256(identity.visitorToken)
      : null;
    const rows = await this.env.DB.prepare(
      `
      SELECT DISTINCT i.session_id AS sessionId
        FROM public_itineraries p JOIN public_itinerary_items i ON i.itinerary_id = p.id
        JOIN schedule_entries se ON se.session_id = i.session_id AND se.event_id = p.event_id
        JOIN sessions session
          ON session.id = se.session_id AND session.event_id = se.event_id
        JOIN schedule_session_contents content
          ON content.schedule_version_id = se.schedule_version_id
         AND content.event_id = se.event_id
         AND content.session_id = se.session_id
        JOIN schedule_versions current_version
          ON current_version.id = se.schedule_version_id
         AND current_version.event_id = se.event_id
         AND current_version.status = 'published'
       WHERE p.event_id = ?
         AND ((? IS NOT NULL AND p.person_id = ?)
           OR (? IS NOT NULL AND p.person_id IS NULL AND p.visitor_key_hash = ?))
         AND (p.expires_at IS NULL OR p.expires_at > unixepoch())
         AND se.schedule_version_id = ?
         AND session.status = 'published' AND content.visibility = 'public'
       ORDER BY se.starts_at, i.session_id
    `,
    )
      .bind(
        programme.event.id,
        identity.personId,
        identity.personId,
        visitorHash,
        visitorHash,
        programme.version.id,
      )
      .all<{ sessionId: string }>();
    return rows.results.map((row) => row.sessionId);
  }

  async itineraryIsSynced(
    programme: PublishedProgramme,
    identity: ItineraryIdentity,
  ) {
    if (!identity.personId) return false;
    if (!identity.visitorToken) return true;
    const visitorHash = await sha256(identity.visitorToken);
    const anonymous = await this.env.DB.prepare(
      `SELECT id FROM public_itineraries
        WHERE event_id = ? AND visitor_key_hash = ? AND person_id IS NULL
          AND (expires_at IS NULL OR expires_at > unixepoch())`,
    )
      .bind(programme.event.id, visitorHash)
      .first<{ id: string }>();
    return anonymous === null;
  }

  async hasActiveAnonymousItinerary(
    programme: PublishedProgramme,
    visitorToken: string | null,
  ) {
    if (!visitorToken) return false;
    const visitorHash = await sha256(visitorToken);
    return Boolean(
      await this.env.DB.prepare(
        `SELECT 1 FROM public_itineraries
          WHERE event_id = ? AND visitor_key_hash = ? AND person_id IS NULL
            AND (expires_at IS NULL OR expires_at > unixepoch())`,
      )
        .bind(programme.event.id, visitorHash)
        .first(),
    );
  }

  async sharedItinerary(programme: PublishedProgramme, shareToken: string) {
    if (!/^[0-9a-f-]{72}$/u.test(shareToken))
      throw new PublishedProgrammeItineraryNotFoundError(
        "This shared itinerary is unavailable or empty.",
      );
    const shareHash = await sha256(shareToken);
    const rows = await this.env.DB.prepare(
      `
      SELECT item.session_id AS sessionId
        FROM public_itineraries itinerary
        JOIN public_itinerary_items item ON item.itinerary_id = itinerary.id
        JOIN schedule_entries entry
          ON entry.session_id = item.session_id AND entry.event_id = itinerary.event_id
        JOIN sessions session
          ON session.id = entry.session_id AND session.event_id = entry.event_id
        JOIN schedule_session_contents content
          ON content.schedule_version_id = entry.schedule_version_id
         AND content.event_id = entry.event_id
         AND content.session_id = entry.session_id
        JOIN schedule_versions current_version
          ON current_version.id = entry.schedule_version_id
         AND current_version.event_id = entry.event_id
         AND current_version.status = 'published'
       WHERE itinerary.event_id = ? AND itinerary.share_token_hash = ?
         AND (itinerary.expires_at IS NULL OR itinerary.expires_at > unixepoch())
         AND entry.schedule_version_id = ?
         AND session.status = 'published' AND content.visibility = 'public'
       ORDER BY entry.starts_at
    `,
    )
      .bind(programme.event.id, shareHash, programme.version.id)
      .all<{ sessionId: string }>();
    if (!rows.results.length)
      throw new PublishedProgrammeItineraryNotFoundError(
        "This shared itinerary is unavailable or empty.",
      );
    return rows.results.map((row) => row.sessionId);
  }

  private itineraryExpiresAt(programme: PublishedProgramme) {
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
    return expiresAt;
  }

  async syncItinerary(
    programme: PublishedProgramme,
    identity: ItineraryIdentity,
  ) {
    if (!identity.personId)
      throw new Error("A signed-in person is required to sync an itinerary.");
    if (!identity.visitorToken) return;
    const visitorHash = await sha256(identity.visitorToken);
    const expiresAt = this.itineraryExpiresAt(programme);
    const [source, target] = await Promise.all([
      this.env.DB.prepare(
        `SELECT id FROM public_itineraries
          WHERE event_id = ? AND visitor_key_hash = ? AND person_id IS NULL
            AND (expires_at IS NULL OR expires_at > unixepoch())`,
      )
        .bind(programme.event.id, visitorHash)
        .first<{ id: string }>(),
      this.env.DB.prepare(
        `SELECT id FROM public_itineraries
          WHERE event_id = ? AND person_id = ?`,
      )
        .bind(programme.event.id, identity.personId)
        .first<{ id: string }>(),
    ]);
    if (!source) return;

    if (!target) {
      const converted = await this.env.DB.prepare(
        `UPDATE public_itineraries
            SET person_id = ?, visitor_key_hash = NULL, expires_at = ?,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND visitor_key_hash = ?
            AND person_id IS NULL
            AND (expires_at IS NULL OR expires_at > unixepoch())`,
      )
        .bind(
          identity.personId,
          expiresAt,
          source.id,
          programme.event.id,
          visitorHash,
        )
        .run();
      if ((converted.meta.changes ?? 0) !== 1)
        throw new Error(
          "The anonymous itinerary changed before it could be synced.",
        );
      return;
    }

    const [renewed, , removed] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE public_itineraries
            SET expires_at = ?,
                share_token_hash = COALESCE(
                  (
                    SELECT source.share_token_hash
                      FROM public_itineraries source
                     WHERE source.id = ? AND source.event_id = ?
                       AND source.visitor_key_hash = ?
                       AND source.person_id IS NULL
                       AND (source.expires_at IS NULL OR source.expires_at > unixepoch())
                  ),
                  share_token_hash
                ),
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND person_id = ?`,
      ).bind(
        expiresAt,
        source.id,
        programme.event.id,
        visitorHash,
        target.id,
        programme.event.id,
        identity.personId,
      ),
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO public_itinerary_items (
          itinerary_id, session_id, created_at
        )
        SELECT ?, item.session_id, unixepoch()
          FROM public_itineraries source
          JOIN public_itinerary_items item ON item.itinerary_id = source.id
          JOIN schedule_entries entry
            ON entry.event_id = source.event_id AND entry.session_id = item.session_id
          JOIN sessions session
            ON session.id = entry.session_id AND session.event_id = entry.event_id
          JOIN schedule_session_contents content
            ON content.schedule_version_id = entry.schedule_version_id
           AND content.event_id = entry.event_id
           AND content.session_id = entry.session_id
          JOIN schedule_versions current_version
            ON current_version.id = entry.schedule_version_id
           AND current_version.event_id = entry.event_id
           AND current_version.status = 'published'
         WHERE source.event_id = ? AND source.visitor_key_hash = ?
           AND source.person_id IS NULL
           AND (source.expires_at IS NULL OR source.expires_at > unixepoch())
           AND entry.schedule_version_id = ?
           AND session.status = 'published' AND content.visibility = 'public'
      `,
      ).bind(target.id, programme.event.id, visitorHash, programme.version.id),
      this.env.DB.prepare(
        `DELETE FROM public_itineraries
          WHERE id = ? AND event_id = ? AND visitor_key_hash = ?
            AND person_id IS NULL
            AND (expires_at IS NULL OR expires_at > unixepoch())
            AND EXISTS (
              SELECT 1 FROM public_itineraries target
               WHERE target.id = ? AND target.event_id = ? AND target.person_id = ?
                 AND (target.expires_at IS NULL OR target.expires_at > unixepoch())
            )`,
      ).bind(
        source.id,
        programme.event.id,
        visitorHash,
        target.id,
        programme.event.id,
        identity.personId,
      ),
    ]);
    if (
      (renewed.meta.changes ?? 0) !== 1 ||
      (removed.meta.changes ?? 0) !== 1
    ) {
      throw new Error("The itinerary changed before it could be synced.");
    }
  }

  async updateItinerary(
    programme: PublishedProgramme,
    identity: ItineraryIdentity,
    sessionId: string,
    intent: "add" | "remove",
  ) {
    const published = programme.sessions.some(
      (session) => session.id === sessionId,
    );
    if (!published) throw new PublishedProgrammeSessionNotFoundError();
    const expiresAt = this.itineraryExpiresAt(programme);
    if (identity.personId && identity.visitorToken) {
      await this.syncItinerary(programme, identity);
    }
    if (identity.personId) {
      const itineraryId = crypto.randomUUID();
      if (intent === "add") {
        await this.env.DB.batch([
          this.env.DB.prepare(
            `INSERT INTO public_itineraries (
               id, event_id, person_id, expires_at, created_at, updated_at
             ) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())
             ON CONFLICT(event_id, person_id) DO UPDATE SET
               expires_at = excluded.expires_at, updated_at = unixepoch()`,
          ).bind(itineraryId, programme.event.id, identity.personId, expiresAt),
          this.env.DB.prepare(
            `INSERT OR IGNORE INTO public_itinerary_items (
               itinerary_id, session_id, created_at
             )
             SELECT itinerary.id, session.id, unixepoch()
               FROM public_itineraries itinerary
               JOIN sessions session ON session.id = ? AND session.event_id = itinerary.event_id
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
              WHERE itinerary.event_id = ? AND itinerary.person_id = ?
                AND (itinerary.expires_at IS NULL OR itinerary.expires_at > unixepoch())
                AND entry.schedule_version_id = ?
                AND session.status = 'published' AND content.visibility = 'public'`,
          ).bind(
            sessionId,
            programme.event.id,
            identity.personId,
            programme.version.id,
          ),
        ]);
      } else {
        await this.env.DB.prepare(
          `DELETE FROM public_itinerary_items
            WHERE session_id = ? AND itinerary_id IN (
              SELECT id FROM public_itineraries
               WHERE event_id = ? AND person_id = ?
                 AND (expires_at IS NULL OR expires_at > unixepoch())
            )`,
        )
          .bind(sessionId, programme.event.id, identity.personId)
          .run();
      }
      return { token: null, expiresAt };
    }

    let token: string;
    let visitorHash: string;
    let existing: { id: string; expiresAt: number | null } | null = null;
    let expiredExistingId: string | null = null;
    if (identity.visitorToken) {
      const candidateHash = await sha256(identity.visitorToken);
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
      const recognizedInAnotherEvent = !existingIsActive
        ? Boolean(
            await this.env.DB.prepare(
              `SELECT 1 FROM public_itineraries
                  WHERE visitor_key_hash = ?
                    AND event_id <> ?
                    AND (expires_at IS NULL OR expires_at > unixepoch())
                  LIMIT 1`,
            )
              .bind(candidateHash, programme.event.id)
              .first(),
          )
        : false;
      if (existingIsActive || recognizedInAnotherEvent) {
        token = identity.visitorToken;
        visitorHash = candidateHash;
        if (!existingIsActive) {
          expiredExistingId = existing?.id ?? null;
          existing = null;
        }
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
          `DELETE FROM public_itineraries
            WHERE id IN (
              SELECT id FROM public_itineraries
               WHERE expires_at IS NOT NULL AND expires_at <= unixepoch()
               ORDER BY expires_at, id
               LIMIT ?
            )`,
        ).bind(EXPIRED_ITINERARY_CLEANUP_LIMIT),
        this.env.DB.prepare(
          `DELETE FROM public_itineraries
            WHERE id = ? AND event_id = ? AND visitor_key_hash = ?
              AND person_id IS NULL
              AND expires_at IS NOT NULL AND expires_at <= unixepoch()`,
        ).bind(expiredExistingId, programme.event.id, visitorHash),
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO public_itineraries (id, event_id, visitor_key_hash, expires_at, created_at, updated_at) VALUES (?, ?, ?, ?, unixepoch(), unixepoch())`,
        ).bind(itineraryId, programme.event.id, visitorHash, expiresAt),
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO public_itinerary_items (itinerary_id, session_id, created_at)
          SELECT p.id, s.id, unixepoch()
             FROM public_itineraries p
             JOIN sessions s ON s.id = ? AND s.event_id = p.event_id
             JOIN schedule_entries entry
               ON entry.session_id = s.id AND entry.event_id = s.event_id
             JOIN schedule_versions current_version
               ON current_version.id = entry.schedule_version_id
              AND current_version.event_id = entry.event_id
              AND current_version.status = 'published'
             JOIN schedule_session_contents content
               ON content.schedule_version_id = entry.schedule_version_id
              AND content.event_id = entry.event_id
              AND content.session_id = s.id
            WHERE p.event_id = ? AND p.visitor_key_hash = ?
              AND (p.expires_at IS NULL OR p.expires_at > unixepoch())
              AND entry.schedule_version_id = ?
              AND s.status = 'published' AND content.visibility = 'public'`,
        ).bind(
          sessionId,
          programme.event.id,
          visitorHash,
          programme.version.id,
        ),
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

  async shareItinerary(
    programme: PublishedProgramme,
    identity: ItineraryIdentity,
  ) {
    const visitorHash = identity.visitorToken
      ? await sha256(identity.visitorToken)
      : null;
    const itinerary = await this.env.DB.prepare(
      `
      SELECT itinerary.id
        FROM public_itineraries itinerary
       WHERE itinerary.event_id = ?
         AND ((? IS NOT NULL AND itinerary.person_id = ?)
           OR (? IS NULL AND ? IS NOT NULL AND itinerary.visitor_key_hash = ?))
         AND (itinerary.expires_at IS NULL OR itinerary.expires_at > unixepoch())
         AND EXISTS (
           SELECT 1 FROM public_itinerary_items item
           JOIN schedule_entries entry
             ON entry.session_id = item.session_id AND entry.event_id = itinerary.event_id
           JOIN sessions session
             ON session.id = entry.session_id AND session.event_id = entry.event_id
           JOIN schedule_session_contents content
             ON content.schedule_version_id = entry.schedule_version_id
            AND content.event_id = entry.event_id
            AND content.session_id = entry.session_id
           JOIN schedule_versions current_version
             ON current_version.id = entry.schedule_version_id
            AND current_version.event_id = entry.event_id
            AND current_version.status = 'published'
            WHERE item.itinerary_id = itinerary.id
              AND entry.schedule_version_id = ?
              AND session.status = 'published' AND content.visibility = 'public'
         )
       LIMIT 1
    `,
    )
      .bind(
        programme.event.id,
        identity.personId,
        identity.personId,
        identity.personId,
        visitorHash,
        visitorHash,
        programme.version.id,
      )
      .first<{ id: string }>();
    if (!itinerary) throw new PublishedProgrammeItineraryNotFoundError();
    const token = `${crypto.randomUUID()}${crypto.randomUUID()}`;
    const hash = await sha256(token);
    const updated = await this.env.DB.prepare(
      `UPDATE public_itineraries
          SET share_token_hash = ?, updated_at = unixepoch()
        WHERE id = ? AND event_id = ?
          AND (expires_at IS NULL OR expires_at > unixepoch())`,
    )
      .bind(hash, itinerary.id, programme.event.id)
      .run();
    if ((updated.meta.changes ?? 0) !== 1)
      throw new PublishedProgrammeItineraryNotFoundError();
    return token;
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
