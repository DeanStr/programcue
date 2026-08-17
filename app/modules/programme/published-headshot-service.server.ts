import { ensureDemoProgramme } from "~/platform/demo/seed.server";
import type {
  PublishedProgramme,
  PublishedSpeaker,
  PublishedSpeakerPreview,
} from "./public-programme-types";

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

const FIXTURE_EVENT_ID = "evt-foe-2025";
const BUNDLED_FIXTURE_HEADSHOTS: Record<string, string> = {
  "person-demo-speaker": "/images/demo-speakers/priya-shah.webp",
  "person-demo-submitter": "/images/demo-speakers/alex-morgan.webp",
  "person-sbek-speaker": "/images/demo-speakers/priya-raman.webp",
  "person-sbek-speaker2": "/images/demo-speakers/marcus-okafor.webp",
};

export function publishedHeadshotPath(eventSlug: string, personId: string) {
  return `/public/programme/${encodeURIComponent(eventSlug)}/speakers/${encodeURIComponent(personId)}/headshot`;
}

export class PublishedHeadshotService {
  constructor(private readonly env: CloudflareEnvironment) {}

  bundledFixtureHeadshotsEnabled(eventId: string) {
    return (
      eventId === FIXTURE_EVENT_ID &&
      (String(this.env.DEMO_MODE) === "true" ||
        String(this.env.EVALUATION_MODE) === "true")
    );
  }

  async publishedHeadshotPersonIds(eventId: string, versionId: string) {
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
         AND session.status = 'published' AND session.visibility = 'public'
         AND content.visibility = 'public'
         AND relation.visibility = 'public'
         AND relation.participation_status = 'confirmed'
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

  async currentPublicHeadshotPersonIds(
    eventId: string,
    versionId: string,
    personIds: readonly string[],
  ) {
    const bundledHeadshotPersonIds = this.bundledFixtureHeadshotsEnabled(
      eventId,
    )
      ? personIds.filter((personId) => BUNDLED_FIXTURE_HEADSHOTS[personId])
      : [];
    if (!bundledHeadshotPersonIds.length) return new Set<string>();
    const placeholders = bundledHeadshotPersonIds.map(() => "?").join(", ");
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
        JOIN people person ON person.id = relation.person_id
        JOIN file_assets asset
          ON asset.event_id = entry.event_id
         AND asset.target_type = 'person'
         AND asset.target_id = person.id
         AND asset.asset_kind = 'headshot'
         AND asset.status <> 'deleted'
       WHERE published_version.id = ? AND published_version.event_id = ?
         AND published_version.status = 'published'
         AND session.status = 'published' AND session.visibility = 'public'
         AND content.visibility = 'public'
         AND relation.visibility = 'public'
         AND relation.participation_status = 'confirmed'
         AND person.profile_status = 'published'
         AND person.id IN (${placeholders})
    `,
    )
      .bind(versionId, eventId, ...bundledHeadshotPersonIds)
      .all<{ personId: string }>();
    return new Set(rows.results.map((row) => row.personId));
  }

  bundledFixtureHeadshot(
    event: Pick<PublishedProgramme["event"], "id">,
    personId: string,
  ) {
    if (!this.bundledFixtureHeadshotsEnabled(event.id)) return null;
    return BUNDLED_FIXTURE_HEADSHOTS[personId] ?? null;
  }

  async withPublishedHeadshotUrls(
    event: Pick<PublishedProgramme["event"], "id" | "slug">,
    version: Pick<PublishedProgramme["version"], "id">,
    speakers: PublishedSpeaker[],
  ) {
    const [personIds, assetPersonIds] = await Promise.all([
      this.publishedHeadshotPersonIds(event.id, version.id),
      this.currentPublicHeadshotPersonIds(
        event.id,
        version.id,
        speakers.map((speaker) => speaker.id),
      ),
    ]);
    return speakers.map((speaker) => ({
      ...speaker,
      imageUrl: personIds.has(speaker.id)
        ? publishedHeadshotPath(event.slug, speaker.id)
        : assetPersonIds.has(speaker.id)
          ? null
          : this.bundledFixtureHeadshot(event, speaker.id),
    }));
  }

  async withPublishedPreviewHeadshotUrls(
    event: Pick<PublishedProgramme["event"], "id" | "slug">,
    version: Pick<PublishedProgramme["version"], "id">,
    speakers: PublishedSpeakerPreview[],
  ) {
    if (!speakers.length) return [];
    const placeholders = speakers.map(() => "?").join(", ");
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
        JOIN people person ON person.id = relation.person_id
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
         AND session.status = 'published' AND session.visibility = 'public'
         AND content.visibility = 'public'
         AND relation.visibility = 'public'
         AND relation.participation_status = 'confirmed'
         AND person.profile_status = 'published'
         AND version.upload_status = 'uploaded'
         AND version.signature_status = 'valid'
         AND version.scan_status = 'clean'
         AND version.released_at IS NOT NULL
         AND version.replaced_at IS NULL AND version.deleted_at IS NULL
         AND version.object_etag IS NOT NULL
         AND version.detected_content_type IN ('image/jpeg', 'image/png', 'image/webp')
         AND person.id IN (${placeholders})
    `,
    )
      .bind(version.id, event.id, ...speakers.map((speaker) => speaker.id))
      .all<{ personId: string }>();
    const personIds = new Set(rows.results.map((row) => row.personId));
    const assetPersonIds = await this.currentPublicHeadshotPersonIds(
      event.id,
      version.id,
      speakers.map((speaker) => speaker.id),
    );
    return speakers.map((speaker) => ({
      ...speaker,
      imageUrl: personIds.has(speaker.id)
        ? publishedHeadshotPath(event.slug, speaker.id)
        : assetPersonIds.has(speaker.id)
          ? null
          : this.bundledFixtureHeadshot(event, speaker.id),
    }));
  }

  async withPublishedPageHeadshotUrls(
    event: Pick<PublishedProgramme["event"], "id" | "slug">,
    version: Pick<PublishedProgramme["version"], "id">,
    speakers: PublishedSpeaker[],
  ) {
    if (!speakers.length) return [];
    const placeholders = speakers.map(() => "?").join(", ");
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
        JOIN people person ON person.id = relation.person_id
        JOIN file_assets asset
          ON asset.event_id = entry.event_id
         AND asset.target_type = 'person'
         AND asset.target_id = person.id
         AND asset.asset_kind = 'headshot'
         AND asset.status = 'active'
        JOIN file_versions file_version
          ON file_version.id = asset.current_version_id
         AND file_version.asset_id = asset.id
         AND file_version.event_id = asset.event_id
       WHERE published_version.id = ? AND published_version.event_id = ?
         AND published_version.status = 'published'
         AND session.status = 'published' AND session.visibility = 'public'
         AND content.visibility = 'public'
         AND relation.visibility = 'public'
         AND relation.participation_status = 'confirmed'
         AND person.profile_status = 'published'
         AND file_version.upload_status = 'uploaded'
         AND file_version.signature_status = 'valid'
         AND file_version.scan_status = 'clean'
         AND file_version.released_at IS NOT NULL
         AND file_version.replaced_at IS NULL
         AND file_version.deleted_at IS NULL
         AND file_version.object_etag IS NOT NULL
         AND file_version.detected_content_type IN ('image/jpeg', 'image/png', 'image/webp')
         AND person.id IN (${placeholders})
    `,
    )
      .bind(version.id, event.id, ...speakers.map((speaker) => speaker.id))
      .all<{ personId: string }>();
    const personIds = new Set(rows.results.map((row) => row.personId));
    const assetPersonIds = await this.currentPublicHeadshotPersonIds(
      event.id,
      version.id,
      speakers.map((speaker) => speaker.id),
    );
    return speakers.map((speaker) => ({
      ...speaker,
      imageUrl: personIds.has(speaker.id)
        ? publishedHeadshotPath(event.slug, speaker.id)
        : assetPersonIds.has(speaker.id)
          ? null
          : this.bundledFixtureHeadshot(event, speaker.id),
    }));
  }

  async findPublishedHeadshot(
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
       WHERE event.slug = ? AND event.activation_status = 'active'
         AND event.programme_published_at IS NOT NULL
         AND person.id = ? AND person.profile_status = 'published'
         AND session.status = 'published' AND session.visibility = 'public'
         AND content.visibility = 'public'
         AND relation.visibility = 'public'
         AND relation.participation_status = 'confirmed'
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
      throw new Error("The published public headshot file is missing.");
    }
    if (object.httpEtag !== headshot.objectEtag) {
      throw new Error(
        "The published public headshot file no longer matches the version that was scanned.",
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
}
