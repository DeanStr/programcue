import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  PublicRecordingService,
  type PublishedPublicRecording,
} from "./public-recording-service.server";
import {
  defaultPublicSiteDraft,
  type PublicSiteDraft,
  type PublicSiteSponsor,
  type PublishedPublicSiteSnapshot,
  parsePublicSiteDraft,
  parsePublishedPublicSiteSnapshot,
  publishedPublicSiteSnapshotSchema,
  revisionInputSchema,
  sitePublishInputSchema,
  siteSaveInputSchema,
  sponsorInputSchema,
} from "./public-site";
import {
  PublicSiteNotFoundError,
  PublicSiteRevisionConflictError,
  PublicSiteValidationError,
  PublishedPublicSiteInvariantError,
} from "./public-site-errors";
import {
  publicSiteChangeSequence,
  publicSiteMutationEvidence,
} from "./public-site-mutation-evidence.server";
import { resolvePublicSitePresentation } from "./public-site-presentation";

export {
  PublicSiteNotFoundError,
  PublicSiteRevisionConflictError,
  PublicSiteValidationError,
} from "./public-site-errors";

type SiteRow = {
  draftJson: string;
  draftRevision: number;
  publishedJson: string | null;
  publishedRevision: number | null;
  publishedAt: number | null;
};

type EventRow = {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  venue: string | null;
  venueAddress: string | null;
  venueMapUrl: string | null;
  city: string | null;
  startsAt: number;
  endsAt: number;
  brandDraftRevision: number;
  brandPublishedRevision: number;
  brandPublishedAt: number | null;
  programmePublishedAt: number | null;
};

export type PublishedPublicSite = {
  configuration: PublishedPublicSiteSnapshot;
  revision: number;
  publishedAt: number;
  recordings: PublishedPublicRecording[];
};

export class PublicSiteService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async event(viewer: Pick<Viewer, "eventId" | "organisationId">) {
    const row = await this.env.DB.prepare(
      `SELECT id, name, slug, description, venue_name AS venue,
              venue_address AS venueAddress, venue_map_url AS venueMapUrl, city,
              starts_at AS startsAt, ends_at AS endsAt,
              brand_draft_revision AS brandDraftRevision,
              brand_published_revision AS brandPublishedRevision,
              brand_published_at AS brandPublishedAt,
              programme_published_at AS programmePublishedAt
         FROM events
        WHERE id = ? AND organisation_id = ? AND activation_status = 'active'`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<EventRow>();
    if (!row) throw new PublicSiteNotFoundError();
    return row;
  }

  private async site(viewer: Pick<Viewer, "eventId" | "organisationId">) {
    return this.env.DB.prepare(
      `SELECT draft_json AS draftJson, draft_revision AS draftRevision,
              published_json AS publishedJson,
              published_revision AS publishedRevision,
              published_at AS publishedAt
         FROM event_public_sites
        WHERE event_id = ? AND organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<SiteRow>();
  }

  private async sponsors(
    viewer: Pick<Viewer, "eventId" | "organisationId">,
  ): Promise<PublicSiteSponsor[]> {
    const rows = await this.env.DB.prepare(
      `SELECT id, name, tier, website_url AS websiteUrl, logo_url AS logoUrl,
              description, position, revision
         FROM event_site_sponsors
        WHERE event_id = ? AND organisation_id = ?
        ORDER BY tier COLLATE NOCASE, position, name COLLATE NOCASE, id`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .all<PublicSiteSponsor>();
    return rows.results;
  }

  async getWorkspace(viewer: Viewer) {
    const event = await this.event(viewer);
    const [site, sponsors, recordings, programme] = await Promise.all([
      this.site(viewer),
      this.sponsors(viewer),
      new PublicRecordingService(this.env).list(viewer),
      new PublicProgrammeService(this.env).getPublished(event.slug),
    ]);
    const draft = site
      ? parsePublicSiteDraft(site.draftJson)
      : defaultPublicSiteDraft();
    return {
      event,
      draft: { configuration: draft, revision: site?.draftRevision ?? 0 },
      published: site?.publishedJson
        ? {
            configuration: parsePublishedPublicSiteSnapshot(site.publishedJson),
            revision: site.publishedRevision!,
            publishedAt: site.publishedAt!,
          }
        : null,
      hasUnpublishedChanges:
        site !== null &&
        (site.publishedRevision === null ||
          site.draftRevision !== site.publishedRevision),
      sponsors,
      recordings,
      programme,
      publicationStatus: {
        branding: {
          draftRevision: event.brandDraftRevision,
          publishedRevision: event.brandPublishedRevision,
          publishedAt: event.brandPublishedAt,
          current:
            event.brandPublishedAt !== null &&
            event.brandDraftRevision === event.brandPublishedRevision,
        },
        site: {
          draftRevision: site?.draftRevision ?? 0,
          publishedRevision: site?.publishedRevision ?? null,
          publishedAt: site?.publishedAt ?? null,
          current:
            site !== null &&
            site.publishedRevision !== null &&
            site.draftRevision === site.publishedRevision,
        },
        programme: {
          publishedAt: event.programmePublishedAt,
          version: programme?.version.versionNumber ?? null,
        },
      },
    };
  }

  async saveDraft(viewer: Viewer, input: unknown) {
    const parsed = siteSaveInputSchema.parse(input);
    const configuration = parsed.configurationJson;
    const operationId = crypto.randomUUID();
    const nextRevision = parsed.revision + 1;
    const mutation =
      parsed.revision === 0
        ? this.env.DB.prepare(
            `INSERT INTO event_public_sites (
               event_id, organisation_id, draft_json, draft_revision,
               last_updated_by_person_id, last_operation_id, created_at, updated_at
             ) SELECT ?, ?, ?, 1, ?, ?, unixepoch(), unixepoch()
                WHERE EXISTS (
                  SELECT 1 FROM events
                   WHERE id = ? AND organisation_id = ? AND activation_status = 'active'
                )
                  AND NOT EXISTS (
                    SELECT 1 FROM event_public_sites WHERE event_id = ?
                  )`,
          ).bind(
            viewer.eventId,
            viewer.organisationId,
            JSON.stringify(configuration),
            viewer.personId,
            operationId,
            viewer.eventId,
            viewer.organisationId,
            viewer.eventId,
          )
        : this.env.DB.prepare(
            `UPDATE event_public_sites
                SET draft_json = ?, draft_revision = draft_revision + 1,
                    last_updated_by_person_id = ?, last_operation_id = ?,
                    updated_at = unixepoch()
              WHERE event_id = ? AND organisation_id = ? AND draft_revision = ?`,
          ).bind(
            JSON.stringify(configuration),
            viewer.personId,
            operationId,
            viewer.eventId,
            viewer.organisationId,
            parsed.revision,
          );
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      "public_site.draft_saved",
      "public_site",
      viewer.eventId,
      parsed.revision === 0 ? "created" : "updated",
      { revision: nextRevision },
      {
        sql: `SELECT 1 FROM event_public_sites
               WHERE event_id = ? AND organisation_id = ?
                 AND draft_revision = ? AND last_operation_id = ?`,
        bindings: [
          viewer.eventId,
          viewer.organisationId,
          nextRevision,
          operationId,
        ],
      },
    );
    const results = await this.env.DB.batch([mutation, ...evidence]);
    if ((results[0]?.meta.changes ?? 0) !== 1)
      throw new PublicSiteRevisionConflictError();
    return {
      revision: nextRevision,
      changeSequence: publicSiteChangeSequence(results[2]),
    };
  }

  private validateConfiguration(
    configuration: PublicSiteDraft,
    programme: PublishedProgramme,
  ) {
    try {
      resolvePublicSitePresentation(configuration, programme);
    } catch (error) {
      if (error instanceof PublishedPublicSiteInvariantError)
        throw new PublicSiteValidationError(error.message);
      throw error;
    }
  }

  async publish(viewer: Viewer, input: unknown) {
    const parsed = sitePublishInputSchema.parse(input);
    const event = await this.event(viewer);
    const [site, sponsors, programme] = await Promise.all([
      this.site(viewer),
      this.sponsors(viewer),
      new PublicProgrammeService(this.env).getPublished(event.slug),
    ]);
    if (!site || site.draftRevision !== parsed.revision)
      throw new PublicSiteRevisionConflictError();
    if (!programme)
      throw new PublicSiteValidationError(
        "Publish the programme before publishing the public event site.",
      );
    const configuration = parsePublicSiteDraft(site.draftJson);
    this.validateConfiguration(configuration, programme);
    if (configuration.pages.sponsors.enabled && sponsors.length === 0)
      throw new PublicSiteValidationError(
        "The enabled Sponsors page requires at least one sponsor record.",
      );
    const snapshot: PublishedPublicSiteSnapshot =
      publishedPublicSiteSnapshotSchema.parse({
        ...configuration,
        sponsors: sponsors.map(
          ({ revision: _revision, ...sponsor }) => sponsor,
        ),
      });
    const featuredSessionIds = configuration.sectionVisibility.featured_sessions
      ? configuration.featuredSessionIds
      : [];
    const featuredSpeakerIds = configuration.sectionVisibility.featured_speakers
      ? configuration.featuredSpeakerIds
      : [];
    const references = [
      ...featuredSessionIds.map((recordId) => ({
        kind: "session" as const,
        recordId,
      })),
      ...featuredSpeakerIds.map((recordId) => ({
        kind: "speaker" as const,
        recordId,
      })),
    ];
    const operationId = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `UPDATE event_public_sites
            SET published_json = ?,
                published_revision = draft_revision,
                published_at = unixepoch(), last_updated_by_person_id = ?,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE event_id = ? AND organisation_id = ? AND draft_revision = ?
            AND (
              ? = 0 OR EXISTS (
                SELECT 1 FROM events event
                 WHERE event.id = event_public_sites.event_id
                   AND event.organisation_id = event_public_sites.organisation_id
                   AND length(trim(event.description)) > 0
              )
            )
            AND (
              ? = 0 OR EXISTS (
                SELECT 1 FROM events event
                 WHERE event.id = event_public_sites.event_id
                   AND event.organisation_id = event_public_sites.organisation_id
                   AND (
                     length(trim(event.venue_name)) > 0
                     OR length(trim(event.city)) > 0
                     OR length(trim(event.venue_address)) > 0
                   )
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM json_each(?) selected
               WHERE NOT EXISTS (
                 SELECT 1
                   FROM schedule_versions version
                   JOIN schedule_entries entry
                     ON entry.event_id = version.event_id
                    AND entry.schedule_version_id = version.id
                   JOIN sessions session
                     ON session.id = entry.session_id
                    AND session.event_id = entry.event_id
                   JOIN schedule_session_contents content
                     ON content.event_id = entry.event_id
                    AND content.schedule_version_id = entry.schedule_version_id
                    AND content.session_id = entry.session_id
                  WHERE version.event_id = event_public_sites.event_id
                    AND version.status = 'published'
                    AND entry.session_id = selected.value
                    AND session.visibility = 'public'
                    AND content.visibility = 'public'
                    AND content.content_status = 'approved'
               )
            )
            AND NOT EXISTS (
              SELECT 1 FROM json_each(?) selected
               WHERE NOT EXISTS (
                 SELECT 1
                   FROM schedule_versions version
                   JOIN schedule_entries entry
                     ON entry.event_id = version.event_id
                    AND entry.schedule_version_id = version.id
                   JOIN sessions session
                     ON session.id = entry.session_id
                    AND session.event_id = entry.event_id
                   JOIN schedule_session_contents content
                     ON content.event_id = entry.event_id
                    AND content.schedule_version_id = entry.schedule_version_id
                    AND content.session_id = entry.session_id
                   JOIN session_speakers relation
                     ON relation.event_id = entry.event_id
                    AND relation.session_id = entry.session_id
                   JOIN people person ON person.id = relation.person_id
                  WHERE version.event_id = event_public_sites.event_id
                    AND version.status = 'published'
                    AND relation.person_id = selected.value
                    AND session.visibility = 'public'
                    AND content.visibility = 'public'
                    AND content.content_status = 'approved'
                    AND relation.visibility = 'public'
                    AND relation.participation_status = 'confirmed'
                    AND person.profile_status = 'published'
               )
            )`,
      ).bind(
        JSON.stringify(snapshot),
        viewer.personId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
        configuration.sectionVisibility.introduction ||
          (configuration.pages.about.enabled && !configuration.pages.about.body)
          ? 1
          : 0,
        configuration.sectionVisibility.venue ||
          configuration.pages.venue.enabled
          ? 1
          : 0,
        JSON.stringify(featuredSessionIds),
        JSON.stringify(featuredSpeakerIds),
      ),
      this.env.DB.prepare(
        `DELETE FROM event_public_site_references
          WHERE event_id = ? AND organisation_id = ?
            AND EXISTS (
              SELECT 1 FROM event_public_sites
               WHERE event_id = ? AND published_revision = ? AND last_operation_id = ?
            )`,
      ).bind(
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        parsed.revision,
        operationId,
      ),
      ...references.map((reference) =>
        this.env.DB.prepare(
          `INSERT INTO event_public_site_references (
             event_id, organisation_id, kind, record_id, site_revision
           ) SELECT ?, ?, ?, ?, ?
              WHERE EXISTS (
                SELECT 1 FROM event_public_sites
                 WHERE event_id = ? AND organisation_id = ?
                   AND published_revision = ? AND last_operation_id = ?
              )`,
        ).bind(
          viewer.eventId,
          viewer.organisationId,
          reference.kind,
          reference.recordId,
          parsed.revision,
          viewer.eventId,
          viewer.organisationId,
          parsed.revision,
          operationId,
        ),
      ),
      this.env.DB.prepare(
        `UPDATE events
            SET revision = revision + 1,
                public_projection_revision = public_projection_revision + 1,
                last_operation_id = ?, last_updated_by_person_id = ?,
                updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND EXISTS (
              SELECT 1 FROM event_public_sites
               WHERE event_id = ? AND published_revision = ? AND last_operation_id = ?
            )`,
      ).bind(
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        parsed.revision,
        operationId,
      ),
    ];
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      "public_site.published",
      "public_site",
      viewer.eventId,
      "published",
      {
        revision: parsed.revision,
        sections: configuration.sectionOrder.filter(
          (section) => configuration.sectionVisibility[section],
        ),
        pages: Object.entries(configuration.pages)
          .filter(([, page]) => page.enabled)
          .map(([page]) => page),
        sponsorCount: sponsors.length,
      },
      {
        sql: `SELECT 1 FROM event_public_sites
               WHERE event_id = ? AND organisation_id = ?
                 AND published_revision = ? AND last_operation_id = ?`,
        bindings: [
          viewer.eventId,
          viewer.organisationId,
          parsed.revision,
          operationId,
        ],
      },
    );
    const results = await this.env.DB.batch([...statements, ...evidence]);
    if ((results[0]?.meta.changes ?? 0) !== 1)
      throw new PublicSiteRevisionConflictError();
    const changeResult = results.at(-1);
    return {
      revision: parsed.revision,
      changeSequence: publicSiteChangeSequence(changeResult),
    };
  }

  async saveSponsor(viewer: Viewer, input: unknown) {
    const parsed = sponsorInputSchema.parse(input);
    const site = await this.site(viewer);
    if (!site)
      throw new PublicSiteValidationError(
        "Save the public-site draft before adding sponsors.",
      );
    const id = parsed.id ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const mutation = parsed.id
      ? this.env.DB.prepare(
          `UPDATE event_site_sponsors
              SET name = ?, tier = ?, website_url = ?, logo_url = ?,
                  description = ?, position = ?, revision = revision + 1,
                  last_updated_by_person_id = ?, last_operation_id = ?,
                  updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND organisation_id = ? AND revision = ?`,
        ).bind(
          parsed.name,
          parsed.tier,
          parsed.websiteUrl,
          parsed.logoUrl,
          parsed.description,
          parsed.position,
          viewer.personId,
          operationId,
          id,
          viewer.eventId,
          viewer.organisationId,
          parsed.revision,
        )
      : this.env.DB.prepare(
          `INSERT INTO event_site_sponsors (
             id, organisation_id, event_id, name, tier, website_url, logo_url,
             description, position, revision, last_updated_by_person_id,
             last_operation_id, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, unixepoch(), unixepoch())`,
        ).bind(
          id,
          viewer.organisationId,
          viewer.eventId,
          parsed.name,
          parsed.tier,
          parsed.websiteUrl,
          parsed.logoUrl,
          parsed.description,
          parsed.position,
          viewer.personId,
          operationId,
        );
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      parsed.id ? "public_site.sponsor_updated" : "public_site.sponsor_created",
      "event_sponsor",
      id,
      parsed.id ? "updated" : "created",
      { name: parsed.name, tier: parsed.tier },
      {
        sql: `SELECT 1 FROM event_site_sponsors
               WHERE id = ? AND event_id = ? AND organisation_id = ?
                 AND last_operation_id = ?`,
        bindings: [id, viewer.eventId, viewer.organisationId, operationId],
      },
    );
    const results = await this.env.DB.batch([
      mutation,
      this.env.DB.prepare(
        `UPDATE event_public_sites
            SET draft_revision = draft_revision + 1,
                last_updated_by_person_id = ?, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE event_id = ? AND organisation_id = ?
            AND EXISTS (
              SELECT 1 FROM event_site_sponsors
               WHERE id = ? AND event_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        viewer.personId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        id,
        viewer.eventId,
        operationId,
      ),
      ...evidence,
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1)
      throw new PublicSiteRevisionConflictError();
    return { id, changeSequence: publicSiteChangeSequence(results[3]) };
  }

  async deleteSponsor(viewer: Viewer, input: unknown) {
    const parsed = revisionInputSchema.parse(input);
    const operationId = crypto.randomUUID();
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      "public_site.sponsor_deleted",
      "event_sponsor",
      parsed.id,
      "deleted",
      { revision: parsed.revision },
      {
        sql: `SELECT 1 FROM event_public_sites
               WHERE event_id = ? AND organisation_id = ?
                 AND last_operation_id = ?`,
        bindings: [viewer.eventId, viewer.organisationId, operationId],
      },
    );
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE event_public_sites
            SET draft_revision = draft_revision + 1,
                last_updated_by_person_id = ?, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE event_id = ? AND organisation_id = ?
            AND EXISTS (
              SELECT 1 FROM event_site_sponsors
               WHERE id = ? AND event_id = ? AND organisation_id = ?
                 AND revision = ?
            )`,
      ).bind(
        viewer.personId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.id,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
      ),
      this.env.DB.prepare(
        `DELETE FROM event_site_sponsors
          WHERE id = ? AND event_id = ? AND organisation_id = ? AND revision = ?
            AND EXISTS (
              SELECT 1 FROM event_public_sites
               WHERE event_id = ? AND organisation_id = ?
                 AND last_operation_id = ?
            )`,
      ).bind(
        parsed.id,
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      ...evidence,
    ]);
    if (
      (results[0]?.meta.changes ?? 0) !== 1 ||
      (results[1]?.meta.changes ?? 0) !== 1
    )
      throw new PublicSiteRevisionConflictError();
    return { changeSequence: publicSiteChangeSequence(results[3]) };
  }

  async getPublished(slug: string, now = Math.floor(Date.now() / 1_000)) {
    const row = await this.env.DB.prepare(
      `SELECT site.published_json AS publishedJson,
              site.published_revision AS publishedRevision,
              site.published_at AS publishedAt,
              event.id AS eventId, event.organisation_id AS organisationId,
              event.ends_at AS eventEndsAt
         FROM event_public_sites site
         JOIN events event
           ON event.id = site.event_id AND event.organisation_id = site.organisation_id
        WHERE event.slug = ? AND event.activation_status = 'active'
          AND event.programme_published_at IS NOT NULL
          AND site.published_json IS NOT NULL`,
    )
      .bind(slug)
      .first<{
        publishedJson: string;
        publishedRevision: number;
        publishedAt: number;
        eventId: string;
        organisationId: string;
        eventEndsAt: number;
      }>();
    if (!row) return null;
    const configuration = parsePublishedPublicSiteSnapshot(row.publishedJson);
    let recordings: PublishedPublicRecording[] = [];
    if (configuration.postEvent.enabled && now >= row.eventEndsAt) {
      recordings = await new PublicRecordingService(
        this.env,
      ).getPublishedForEvent(row.eventId, row.organisationId, now);
    }
    return {
      configuration,
      revision: row.publishedRevision,
      publishedAt: row.publishedAt,
      recordings,
    } satisfies PublishedPublicSite;
  }
}
