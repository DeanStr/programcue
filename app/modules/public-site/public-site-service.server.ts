import { z } from "zod";
import { publicEventBrandAssetPath } from "~/modules/events/event-branding";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import { eventBoundaryCalendarDate } from "~/modules/schedule/schedule-time";
import { parsePublicApplicationProjection } from "~/modules/submissions/submission-availability";
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
  publicSiteUsesD1ProgrammeFeatures,
  publishedPublicSiteSnapshotSchema,
  publishedPublicSiteSponsorSchema,
  revisionInputSchema,
  sitePublishInputSchema,
  siteSaveInputSchema,
  sponsorInputSchema,
} from "./public-site";
import {
  parsePublicSiteCommandReplay,
  preparePublicSiteCommand,
  publicSiteCommandClaimStatements,
  publicSiteCommandCompletionStatement,
  publicSiteCommandGuard,
  resolvePublicSiteCommandRace,
} from "./public-site-command.server";
import {
  PUBLIC_SITE_D1_PROGRAMME_AUTHORITY_REQUIRED,
  PublicSiteNotFoundError,
  PublicSiteRevisionConflictError,
  PublicSiteValidationError,
  PublishedPublicSiteInvariantError,
} from "./public-site-errors";
import {
  publicSiteAtomicBatch,
  publicSiteAtomicMutationGuard,
  publicSiteChangeSequence,
  publicSiteMutationEvidence,
} from "./public-site-mutation-evidence.server";
import { resolvePublicSitePresentation } from "./public-site-presentation";

export {
  PublicSiteCommandConflictError,
  PublicSiteIntegrityError,
  PublicSiteNotFoundError,
  PublicSiteRevisionConflictError,
  PublicSiteValidationError,
} from "./public-site-errors";

const revisionCommandResponseSchema = z.object({
  revision: z.number().int().positive(),
});
const entityCommandResponseSchema = z.object({ id: z.string().min(1) });
const emptyCommandResponseSchema = z.object({});

async function publicSiteContentRevision(event: PublicSiteEvent) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(event)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

type SiteRow = {
  draftJson: string;
  draftRevision: number;
  publishedJson: string | null;
  publishedRevision: number | null;
  publishedAt: number | null;
};

const sponsorSnapshotRowSchema = publishedPublicSiteSponsorSchema.extend({
  revision: z.number().int().positive(),
});

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
  timezone: string;
  brandAccent: string;
  heroImageUrl: string | null;
  logoAssetId: string | null;
  bannerAssetId: string | null;
  legacyLogoUrl: string | null;
  supportUrl: string | null;
  applicationJson: string | null;
  brandDraftRevision: number;
  brandPublishedRevision: number;
  brandPublishedAt: number | null;
  programmePublishedAt: number | null;
  publicProjectionRevision: number;
  repositoryProvider: "d1" | "airtable";
};

export type PublicSiteEvent = PublishedProgramme["event"];

export type PublishedPublicSite = {
  event: PublicSiteEvent;
  contentRevision: string;
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
              timezone, brand_accent AS brandAccent,
              programme_hero_image_url AS heroImageUrl,
              brand_logo_asset_id AS logoAssetId,
              brand_banner_asset_id AS bannerAssetId,
              participant_logo_url AS legacyLogoUrl,
              participant_support_url AS supportUrl,
              (
                SELECT json_object(
                         'url', '/apply/' || form.public_slug,
                         'closesAt', form.closes_at,
                         'submissionLimit', form.submission_limit,
                         'submittedCount', (
                           SELECT COUNT(*)
                             FROM submissions submission
                             JOIN form_versions submission_version
                               ON submission_version.id = submission.form_version_id
                              AND submission_version.event_id = submission.event_id
                            WHERE submission_version.form_id = form.id
                              AND submission.status <> 'draft'
                         )
                       )
                  FROM form_definitions form
                 WHERE form.event_id = events.id
                   AND form.kind = 'submission' AND form.status = 'published'
                   AND EXISTS (
                     SELECT 1 FROM form_versions version
                      WHERE version.form_id = form.id
                        AND version.event_id = form.event_id
                        AND version.status = 'published'
                   )
                 ORDER BY form.updated_at DESC, form.id
                 LIMIT 1
              ) AS applicationJson,
              brand_draft_revision AS brandDraftRevision,
              brand_published_revision AS brandPublishedRevision,
              brand_published_at AS brandPublishedAt,
              programme_published_at AS programmePublishedAt,
              public_projection_revision AS publicProjectionRevision,
              repository_provider AS repositoryProvider
         FROM events
        WHERE id = ? AND organisation_id = ? AND activation_status = 'active'`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<EventRow>();
    if (!row) throw new PublicSiteNotFoundError();
    return row;
  }

  private publicEvent(
    row: EventRow,
    now = Math.floor(Date.now() / 1_000),
  ): PublicSiteEvent {
    const application = parsePublicApplicationProjection(
      row.applicationJson,
      now,
    );
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      timezone: row.timezone,
      startDate: eventBoundaryCalendarDate(row.startsAt),
      endDate: eventBoundaryCalendarDate(row.endsAt),
      venue: row.venue,
      venueAddress: row.venueAddress,
      venueMapUrl: row.venueMapUrl,
      city: row.city,
      description: row.description,
      brandAccent: row.brandAccent,
      heroImageUrl: row.heroImageUrl,
      logoUrl: row.logoAssetId
        ? publicEventBrandAssetPath(row.slug, "logo")
        : row.legacyLogoUrl,
      bannerUrl: row.bannerAssetId
        ? publicEventBrandAssetPath(row.slug, "banner")
        : null,
      supportUrl: row.supportUrl,
      application,
    };
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

  private async siteAndSponsors(
    viewer: Pick<Viewer, "eventId" | "organisationId">,
  ) {
    const row = await this.env.DB.prepare(
      `SELECT site.draft_json AS draftJson,
              site.draft_revision AS draftRevision,
              site.published_json AS publishedJson,
              site.published_revision AS publishedRevision,
              site.published_at AS publishedAt,
              COALESCE((
                SELECT json_group_array(json_object(
                         'id', sponsor.id,
                         'name', sponsor.name,
                         'tier', sponsor.tier,
                         'websiteUrl', sponsor.website_url,
                         'logoUrl', sponsor.logo_url,
                         'description', sponsor.description,
                         'position', sponsor.position,
                         'revision', sponsor.revision
                       ))
                  FROM (
                    SELECT * FROM event_site_sponsors
                     WHERE event_id = site.event_id
                       AND organisation_id = site.organisation_id
                     ORDER BY tier COLLATE NOCASE, position,
                              name COLLATE NOCASE, id
                  ) sponsor
              ), '[]') AS sponsorsJson
         FROM event_public_sites site
        WHERE site.event_id = ? AND site.organisation_id = ?`,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<SiteRow & { sponsorsJson: string }>();
    if (!row) return null;
    return {
      site: row,
      sponsors: z
        .array(sponsorSnapshotRowSchema)
        .parse(JSON.parse(row.sponsorsJson)) satisfies PublicSiteSponsor[],
    };
  }

  async getWorkspace(viewer: Viewer) {
    const event = await this.event(viewer);
    const [site, sponsors, recordings, programme] = await Promise.all([
      this.site(viewer),
      this.sponsors(viewer),
      new PublicRecordingService(this.env).list(viewer),
      new PublicProgrammeService(this.env).getPublished(event.slug),
    ]);
    const publicEvent = this.publicEvent(event);
    const draft = site
      ? parsePublicSiteDraft(site.draftJson)
      : defaultPublicSiteDraft();
    let published = null;
    if (site?.publishedJson) {
      if (site.publishedRevision === null || site.publishedAt === null) {
        throw new PublishedPublicSiteInvariantError(
          "The published event site is missing required publication metadata.",
        );
      }
      published = {
        configuration: parsePublishedPublicSiteSnapshot(site.publishedJson),
        revision: site.publishedRevision,
        publishedAt: site.publishedAt,
      };
    }
    return {
      event,
      publicEvent,
      publicEventContentRevision: await publicSiteContentRevision(publicEvent),
      draft: { configuration: draft, revision: site?.draftRevision ?? 0 },
      published,
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
    const nextRevision = parsed.revision + 1;
    const prepared = await preparePublicSiteCommand(
      this.env,
      viewer,
      "public_site.draft.save",
      parsed.commandId,
      { revision: parsed.revision, configuration },
    );
    if (prepared.replay)
      return parsePublicSiteCommandReplay(
        prepared.replay,
        revisionCommandResponseSchema,
      );
    const command = prepared.command;
    const requiresD1ProgrammeAuthority =
      publicSiteUsesD1ProgrammeFeatures(configuration);
    const event = await this.event(viewer);
    if (requiresD1ProgrammeAuthority && event.repositoryProvider !== "d1") {
      throw new PublicSiteValidationError(
        PUBLIC_SITE_D1_PROGRAMME_AUTHORITY_REQUIRED,
      );
    }
    const operationId = command.id;
    const commandGuard = publicSiteCommandGuard(viewer, command);
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
                     AND (? = 0 OR repository_provider = 'd1')
                )
                  AND NOT EXISTS (
                    SELECT 1 FROM event_public_sites WHERE event_id = ?
                  )
                  AND EXISTS (${commandGuard.sql})`,
          ).bind(
            viewer.eventId,
            viewer.organisationId,
            JSON.stringify(configuration),
            viewer.personId,
            operationId,
            viewer.eventId,
            viewer.organisationId,
            requiresD1ProgrammeAuthority ? 1 : 0,
            viewer.eventId,
            ...commandGuard.bindings,
          )
        : this.env.DB.prepare(
            `UPDATE event_public_sites
                SET draft_json = ?, draft_revision = draft_revision + 1,
                    last_updated_by_person_id = ?, last_operation_id = ?,
                    updated_at = unixepoch()
              WHERE event_id = ? AND organisation_id = ? AND draft_revision = ?
                AND (
                  ? = 0 OR EXISTS (
                    SELECT 1 FROM events event
                     WHERE event.id = event_public_sites.event_id
                       AND event.organisation_id = event_public_sites.organisation_id
                       AND event.repository_provider = 'd1'
                  )
                )
                AND EXISTS (${commandGuard.sql})`,
          ).bind(
            JSON.stringify(configuration),
            viewer.personId,
            operationId,
            viewer.eventId,
            viewer.organisationId,
            parsed.revision,
            requiresD1ProgrammeAuthority ? 1 : 0,
            ...commandGuard.bindings,
          );
    const mutationDescriptor = {
      action: "public_site.draft_saved",
      entityType: "public_site",
      entityId: viewer.eventId,
      changeType:
        parsed.revision === 0 ? ("created" as const) : ("updated" as const),
      metadata: { revision: nextRevision },
    };
    const mutationResult = { revision: nextRevision };
    const mutationState = {
      sql: `SELECT 1 FROM event_public_sites
             WHERE event_id = ? AND organisation_id = ?
               AND draft_revision = ? AND draft_json = ?
               AND last_operation_id = ?`,
      bindings: [
        viewer.eventId,
        viewer.organisationId,
        nextRevision,
        JSON.stringify(configuration),
        operationId,
      ],
    };
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      mutationDescriptor,
      mutationState,
    );
    const results = await publicSiteAtomicBatch(this.env, [
      ...publicSiteCommandClaimStatements(this.env, viewer, command),
      mutation,
      ...evidence,
      publicSiteCommandCompletionStatement(
        this.env,
        viewer,
        command,
        mutationResult,
      ),
      publicSiteAtomicMutationGuard(
        this.env,
        viewer,
        command,
        mutationDescriptor,
        mutationResult,
        mutationState,
        mutationState,
      ),
    ]);
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      const replay = await resolvePublicSiteCommandRace(
        this.env,
        viewer,
        command,
      );
      if (replay)
        return parsePublicSiteCommandReplay(
          replay,
          revisionCommandResponseSchema,
        );
      throw new PublicSiteRevisionConflictError();
    }
    return {
      revision: nextRevision,
      changeSequence: publicSiteChangeSequence(results[4]),
    };
  }

  private validateConfiguration(
    configuration: PublicSiteDraft,
    event: Pick<
      PublicSiteEvent,
      "description" | "venue" | "city" | "venueAddress"
    >,
    programme: PublishedProgramme | null,
  ) {
    try {
      resolvePublicSitePresentation(configuration, event, programme);
    } catch (error) {
      if (error instanceof PublishedPublicSiteInvariantError)
        throw new PublicSiteValidationError(error.message);
      throw error;
    }
  }

  async publish(viewer: Viewer, input: unknown) {
    const parsed = sitePublishInputSchema.parse(input);
    const prepared = await preparePublicSiteCommand(
      this.env,
      viewer,
      "public_site.publish",
      parsed.commandId,
      { revision: parsed.revision, confirmed: parsed.confirmed },
    );
    if (prepared.replay)
      return parsePublicSiteCommandReplay(
        prepared.replay,
        revisionCommandResponseSchema,
      );
    const command = prepared.command;
    const event = await this.event(viewer);
    const siteSnapshot = await this.siteAndSponsors(viewer);
    const site = siteSnapshot?.site ?? null;
    const sponsors = siteSnapshot?.sponsors ?? [];
    if (!site || site.draftRevision !== parsed.revision)
      throw new PublicSiteRevisionConflictError();
    const configuration = parsePublicSiteDraft(site.draftJson);
    const requiresD1ProgrammeAuthority =
      publicSiteUsesD1ProgrammeFeatures(configuration);
    if (requiresD1ProgrammeAuthority && event.repositoryProvider !== "d1") {
      throw new PublicSiteValidationError(
        PUBLIC_SITE_D1_PROGRAMME_AUTHORITY_REQUIRED,
      );
    }
    const programme = await new PublicProgrammeService(this.env).getPublished(
      event.slug,
    );
    this.validateConfiguration(configuration, event, programme);
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
    const operationId = command.id;
    const commandGuard = publicSiteCommandGuard(viewer, command);
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
                    AND session.status = 'published'
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
                    AND session.status = 'published'
                    AND session.visibility = 'public'
                    AND content.visibility = 'public'
                    AND content.content_status = 'approved'
                    AND relation.visibility = 'public'
                    AND relation.participation_status = 'confirmed'
                    AND person.profile_status = 'published'
               )
            )
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = event_public_sites.event_id
                 AND event.organisation_id = event_public_sites.organisation_id
                 AND event.public_projection_revision = ?
                 AND (? = 0 OR event.repository_provider = 'd1')
            )
            AND EXISTS (${commandGuard.sql})`,
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
        event.publicProjectionRevision,
        requiresD1ProgrammeAuthority ? 1 : 0,
        ...commandGuard.bindings,
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
            AND public_projection_revision = ?
            AND EXISTS (
              SELECT 1 FROM event_public_sites
               WHERE event_id = ? AND published_revision = ? AND last_operation_id = ?
            )`,
      ).bind(
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        event.publicProjectionRevision,
        viewer.eventId,
        parsed.revision,
        operationId,
      ),
    ];
    const mutationDescriptor = {
      action: "public_site.published",
      entityType: "public_site",
      entityId: viewer.eventId,
      changeType: "published" as const,
      metadata: {
        revision: parsed.revision,
        sections: configuration.sectionOrder.filter(
          (section) => configuration.sectionVisibility[section],
        ),
        pages: Object.entries(configuration.pages)
          .filter(([, page]) => page.enabled)
          .map(([page]) => page),
        sponsorCount: sponsors.length,
      },
    };
    const mutationResult = { revision: parsed.revision };
    const mutationActivation = {
      sql: `SELECT 1 FROM event_public_sites
             WHERE event_id = ? AND organisation_id = ?
               AND published_revision = ? AND last_operation_id = ?`,
      bindings: [
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
        operationId,
      ],
    };
    const referencesJson = JSON.stringify(references);
    const publicationState = {
      sql: `SELECT 1 FROM event_public_sites site
             WHERE site.event_id = ? AND site.organisation_id = ?
               AND site.published_revision = ? AND site.published_json = ?
               AND site.last_operation_id = ?
               AND EXISTS (
                 SELECT 1 FROM events event
                  WHERE event.id = site.event_id
                    AND event.organisation_id = site.organisation_id
                    AND event.public_projection_revision = ?
                    AND event.last_operation_id = ?
               )
               AND NOT EXISTS (
                 SELECT reference.kind, reference.record_id, reference.site_revision
                   FROM event_public_site_references reference
                  WHERE reference.event_id = site.event_id
                    AND reference.organisation_id = site.organisation_id
                 EXCEPT
                 SELECT json_extract(expected.value, '$.kind'),
                        json_extract(expected.value, '$.recordId'), ?
                   FROM json_each(?) expected
               )
               AND NOT EXISTS (
                 SELECT json_extract(expected.value, '$.kind'),
                        json_extract(expected.value, '$.recordId'), ?
                   FROM json_each(?) expected
                 EXCEPT
                 SELECT reference.kind, reference.record_id, reference.site_revision
                   FROM event_public_site_references reference
                  WHERE reference.event_id = site.event_id
                    AND reference.organisation_id = site.organisation_id
               )`,
      bindings: [
        viewer.eventId,
        viewer.organisationId,
        parsed.revision,
        JSON.stringify(snapshot),
        operationId,
        event.publicProjectionRevision + 1,
        operationId,
        parsed.revision,
        referencesJson,
        parsed.revision,
        referencesJson,
      ],
    };
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      mutationDescriptor,
      mutationActivation,
    );
    const results = await publicSiteAtomicBatch(this.env, [
      ...publicSiteCommandClaimStatements(this.env, viewer, command),
      ...statements,
      ...evidence,
      publicSiteCommandCompletionStatement(
        this.env,
        viewer,
        command,
        mutationResult,
      ),
      publicSiteAtomicMutationGuard(
        this.env,
        viewer,
        command,
        mutationDescriptor,
        mutationResult,
        mutationActivation,
        publicationState,
      ),
    ]);
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      const replay = await resolvePublicSiteCommandRace(
        this.env,
        viewer,
        command,
      );
      if (replay)
        return parsePublicSiteCommandReplay(
          replay,
          revisionCommandResponseSchema,
        );
      throw new PublicSiteRevisionConflictError();
    }
    return {
      revision: parsed.revision,
      changeSequence: publicSiteChangeSequence(results.at(-3)),
    };
  }

  async saveSponsor(viewer: Viewer, input: unknown) {
    const parsed = sponsorInputSchema.parse(input);
    const prepared = await preparePublicSiteCommand(
      this.env,
      viewer,
      "public_site.sponsor.save",
      parsed.commandId,
      {
        id: parsed.id,
        revision: parsed.revision,
        name: parsed.name,
        tier: parsed.tier,
        websiteUrl: parsed.websiteUrl,
        logoUrl: parsed.logoUrl,
        description: parsed.description,
        position: parsed.position,
      },
    );
    if (prepared.replay)
      return parsePublicSiteCommandReplay(
        prepared.replay,
        entityCommandResponseSchema,
      );
    const command = prepared.command;
    const site = await this.site(viewer);
    if (!site)
      throw new PublicSiteValidationError(
        "Save the public-site draft before adding sponsors.",
      );
    const id = parsed.id ?? crypto.randomUUID();
    const operationId = command.id;
    const commandGuard = publicSiteCommandGuard(viewer, command);
    const mutation = parsed.id
      ? this.env.DB.prepare(
          `UPDATE event_site_sponsors
              SET name = ?, tier = ?, website_url = ?, logo_url = ?,
                  description = ?, position = ?, revision = revision + 1,
                  last_updated_by_person_id = ?, last_operation_id = ?,
                  updated_at = unixepoch()
            WHERE id = ? AND event_id = ? AND organisation_id = ? AND revision = ?
              AND EXISTS (
                SELECT 1 FROM event_public_sites site
                 WHERE site.event_id = event_site_sponsors.event_id
                   AND site.organisation_id = event_site_sponsors.organisation_id
                   AND site.draft_revision = ?
              )
              AND EXISTS (${commandGuard.sql})`,
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
          site.draftRevision,
          ...commandGuard.bindings,
        )
      : this.env.DB.prepare(
          `INSERT INTO event_site_sponsors (
             id, organisation_id, event_id, name, tier, website_url, logo_url,
             description, position, revision, last_updated_by_person_id,
             last_operation_id, created_at, updated_at
           ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, unixepoch(), unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM event_public_sites site
                 WHERE site.event_id = ? AND site.organisation_id = ?
                   AND site.draft_revision = ?
              )
                AND EXISTS (${commandGuard.sql})`,
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
          viewer.eventId,
          viewer.organisationId,
          site.draftRevision,
          ...commandGuard.bindings,
        );
    const mutationDescriptor = {
      action: parsed.id
        ? "public_site.sponsor_updated"
        : "public_site.sponsor_created",
      entityType: "event_sponsor",
      entityId: id,
      changeType: parsed.id ? ("updated" as const) : ("created" as const),
      metadata: { name: parsed.name, tier: parsed.tier },
    };
    const mutationResult = { id };
    const mutationActivation = {
      sql: `SELECT 1 FROM event_site_sponsors
             WHERE id = ? AND event_id = ? AND organisation_id = ?
               AND last_operation_id = ?`,
      bindings: [id, viewer.eventId, viewer.organisationId, operationId],
    };
    const sponsorState = {
      sql: `SELECT 1 FROM event_site_sponsors sponsor
             WHERE sponsor.id = ? AND sponsor.event_id = ?
               AND sponsor.organisation_id = ? AND sponsor.name = ?
               AND sponsor.tier = ? AND sponsor.website_url IS ?
               AND sponsor.logo_url IS ? AND sponsor.description IS ?
               AND sponsor.position = ? AND sponsor.revision = ?
               AND sponsor.last_operation_id = ?
               AND EXISTS (
                 SELECT 1 FROM event_public_sites site
                  WHERE site.event_id = sponsor.event_id
                    AND site.organisation_id = sponsor.organisation_id
                    AND site.draft_revision = ?
                    AND site.last_operation_id = ?
               )`,
      bindings: [
        id,
        viewer.eventId,
        viewer.organisationId,
        parsed.name,
        parsed.tier,
        parsed.websiteUrl,
        parsed.logoUrl,
        parsed.description,
        parsed.position,
        parsed.id ? parsed.revision + 1 : 1,
        operationId,
        site.draftRevision + 1,
        operationId,
      ],
    };
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      mutationDescriptor,
      mutationActivation,
    );
    const results = await publicSiteAtomicBatch(this.env, [
      ...publicSiteCommandClaimStatements(this.env, viewer, command),
      mutation,
      this.env.DB.prepare(
        `UPDATE event_public_sites
            SET draft_revision = draft_revision + 1,
                last_updated_by_person_id = ?, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE event_id = ? AND organisation_id = ?
            AND draft_revision = ?
            AND EXISTS (
              SELECT 1 FROM event_site_sponsors
               WHERE id = ? AND event_id = ? AND last_operation_id = ?
            )`,
      ).bind(
        viewer.personId,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        site.draftRevision,
        id,
        viewer.eventId,
        operationId,
      ),
      ...evidence,
      publicSiteCommandCompletionStatement(
        this.env,
        viewer,
        command,
        mutationResult,
      ),
      publicSiteAtomicMutationGuard(
        this.env,
        viewer,
        command,
        mutationDescriptor,
        mutationResult,
        mutationActivation,
        sponsorState,
      ),
    ]);
    if ((results[2]?.meta.changes ?? 0) !== 1) {
      const replay = await resolvePublicSiteCommandRace(
        this.env,
        viewer,
        command,
      );
      if (replay)
        return parsePublicSiteCommandReplay(
          replay,
          entityCommandResponseSchema,
        );
      throw new PublicSiteRevisionConflictError();
    }
    return { id, changeSequence: publicSiteChangeSequence(results[5]) };
  }

  async deleteSponsor(viewer: Viewer, input: unknown) {
    const parsed = revisionInputSchema.parse(input);
    const prepared = await preparePublicSiteCommand(
      this.env,
      viewer,
      "public_site.sponsor.delete",
      parsed.commandId,
      { id: parsed.id, revision: parsed.revision, confirmed: parsed.confirmed },
    );
    if (prepared.replay)
      return parsePublicSiteCommandReplay(
        prepared.replay,
        emptyCommandResponseSchema,
      );
    const command = prepared.command;
    const site = await this.site(viewer);
    if (!site)
      throw new PublicSiteValidationError(
        "Save the public-site draft before removing sponsors.",
      );
    const operationId = command.id;
    const commandGuard = publicSiteCommandGuard(viewer, command);
    const mutationDescriptor = {
      action: "public_site.sponsor_deleted",
      entityType: "event_sponsor",
      entityId: parsed.id,
      changeType: "deleted" as const,
      metadata: { revision: parsed.revision },
    };
    const mutationResult = {};
    const mutationActivation = {
      sql: `SELECT 1 FROM event_public_sites
             WHERE event_id = ? AND organisation_id = ?
               AND last_operation_id = ?`,
      bindings: [viewer.eventId, viewer.organisationId, operationId],
    };
    const sponsorDeletionState = {
      sql: `SELECT 1 FROM event_public_sites site
             WHERE site.event_id = ? AND site.organisation_id = ?
               AND site.draft_revision = ?
               AND site.last_operation_id = ?
               AND NOT EXISTS (
                 SELECT 1 FROM event_site_sponsors sponsor
                  WHERE sponsor.id = ? AND sponsor.event_id = site.event_id
                    AND sponsor.organisation_id = site.organisation_id
               )`,
      bindings: [
        viewer.eventId,
        viewer.organisationId,
        site.draftRevision + 1,
        operationId,
        parsed.id,
      ],
    };
    const evidence = publicSiteMutationEvidence(
      this.env,
      viewer,
      operationId,
      mutationDescriptor,
      mutationActivation,
    );
    const results = await publicSiteAtomicBatch(this.env, [
      ...publicSiteCommandClaimStatements(this.env, viewer, command),
      this.env.DB.prepare(
        `UPDATE event_public_sites
            SET draft_revision = draft_revision + 1,
                last_updated_by_person_id = ?, last_operation_id = ?,
                updated_at = unixepoch()
          WHERE event_id = ? AND organisation_id = ?
            AND draft_revision = ?
            AND EXISTS (${commandGuard.sql})
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
        site.draftRevision,
        ...commandGuard.bindings,
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
      publicSiteCommandCompletionStatement(
        this.env,
        viewer,
        command,
        mutationResult,
      ),
      publicSiteAtomicMutationGuard(
        this.env,
        viewer,
        command,
        mutationDescriptor,
        mutationResult,
        mutationActivation,
        sponsorDeletionState,
      ),
    ]);
    if (
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    ) {
      const replay = await resolvePublicSiteCommandRace(
        this.env,
        viewer,
        command,
      );
      if (replay)
        return parsePublicSiteCommandReplay(replay, emptyCommandResponseSchema);
      throw new PublicSiteRevisionConflictError();
    }
    return { changeSequence: publicSiteChangeSequence(results[5]) };
  }

  async getPublished(slug: string, now = Math.floor(Date.now() / 1_000)) {
    const row = await this.env.DB.prepare(
      `SELECT site.published_json AS publishedJson,
              site.published_revision AS publishedRevision,
              site.published_at AS publishedAt,
              event.id, event.name, event.slug, event.description,
              event.venue_name AS venue,
              event.venue_address AS venueAddress,
              event.venue_map_url AS venueMapUrl, event.city,
              event.starts_at AS startsAt, event.ends_at AS endsAt,
              event.timezone, event.brand_accent AS brandAccent,
              event.programme_hero_image_url AS heroImageUrl,
              event.brand_logo_asset_id AS logoAssetId,
              event.brand_banner_asset_id AS bannerAssetId,
              event.participant_logo_url AS legacyLogoUrl,
              event.participant_support_url AS supportUrl,
              event.brand_draft_revision AS brandDraftRevision,
              event.brand_published_revision AS brandPublishedRevision,
              event.brand_published_at AS brandPublishedAt,
              event.programme_published_at AS programmePublishedAt,
              event.public_projection_revision AS publicProjectionRevision,
              event.repository_provider AS repositoryProvider,
              event.organisation_id AS organisationId,
              (
                SELECT json_object(
                         'url', '/apply/' || form.public_slug,
                         'closesAt', form.closes_at,
                         'submissionLimit', form.submission_limit,
                         'submittedCount', (
                           SELECT COUNT(*)
                             FROM submissions submission
                             JOIN form_versions submission_version
                               ON submission_version.id = submission.form_version_id
                              AND submission_version.event_id = submission.event_id
                            WHERE submission_version.form_id = form.id
                              AND submission.status <> 'draft'
                         )
                       )
                  FROM form_definitions form
                 WHERE form.event_id = event.id
                   AND form.kind = 'submission' AND form.status = 'published'
                   AND EXISTS (
                     SELECT 1 FROM form_versions version
                      WHERE version.form_id = form.id
                        AND version.event_id = form.event_id
                        AND version.status = 'published'
                   )
                 ORDER BY form.updated_at DESC, form.id
                 LIMIT 1
              ) AS applicationJson
         FROM event_public_sites site
         JOIN events event
           ON event.id = site.event_id AND event.organisation_id = site.organisation_id
        WHERE event.slug = ? AND event.activation_status = 'active'
          AND site.published_json IS NOT NULL`,
    )
      .bind(slug)
      .first<
        EventRow & {
          publishedJson: string;
          publishedRevision: number;
          publishedAt: number;
          organisationId: string;
        }
      >();
    if (!row) return null;
    const configuration = parsePublishedPublicSiteSnapshot(row.publishedJson);
    if (
      row.repositoryProvider !== "d1" &&
      publicSiteUsesD1ProgrammeFeatures(configuration)
    ) {
      throw new PublishedPublicSiteInvariantError(
        "The published event site contains D1-bound programme content for a non-D1 programme source.",
      );
    }
    const event = this.publicEvent(row, now);
    const recordings = configuration.postEvent.enabled
      ? await new PublicRecordingService(this.env).getRenderableForEvent(
          row.id,
          row.organisationId,
          row.endsAt,
          row.timezone,
          now,
        )
      : [];
    return {
      event,
      contentRevision: await publicSiteContentRevision(event),
      configuration,
      revision: row.publishedRevision,
      publishedAt: row.publishedAt,
      recordings,
    } satisfies PublishedPublicSite;
  }
}
