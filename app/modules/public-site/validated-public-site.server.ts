import { ZodError } from "zod";

import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import type {
  PublishedProgramme,
  PublishedProgrammeVersion,
} from "~/modules/programme/public-programme-types";
import type { PublicSiteDraft } from "./public-site";
import { PublishedPublicSiteInvariantError } from "./public-site-errors";
import {
  publicSiteRequiresPublishedProgramme,
  publishedPublicSiteInvariantResponse,
  resolvePublicSitePresentation,
  validatePublicSiteCanonicalEvent,
  validatePublicSiteConfiguration,
} from "./public-site-presentation";
import {
  PublicSiteService,
  type PublishedPublicSite,
} from "./public-site-service.server";

async function missingPublishedProgrammeFeaturedIds(
  env: CloudflareEnvironment,
  eventId: string,
  configuration: PublicSiteDraft,
) {
  const sessionIds = configuration.sectionVisibility.featured_sessions
    ? configuration.featuredSessionIds
    : [];
  const speakerIds = configuration.sectionVisibility.featured_speakers
    ? configuration.featuredSpeakerIds
    : [];
  if (sessionIds.length === 0 && speakerIds.length === 0) return [];

  const missing = await env.DB.prepare(
    `SELECT selected.kind, selected.recordId
       FROM (
         SELECT 'session' AS kind, value AS recordId
           FROM json_each(?)
         UNION ALL
         SELECT 'speaker' AS kind, value AS recordId
           FROM json_each(?)
       ) selected
      WHERE (
        selected.kind = 'session' AND NOT EXISTS (
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
           WHERE version.event_id = ?
             AND version.status = 'published'
             AND entry.session_id = selected.recordId
             AND session.status = 'published'
             AND session.visibility = 'public'
             AND content.visibility = 'public'
        )
      ) OR (
        selected.kind = 'speaker' AND NOT EXISTS (
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
           WHERE version.event_id = ?
             AND version.status = 'published'
             AND relation.person_id = selected.recordId
             AND session.status = 'published'
             AND session.visibility = 'public'
             AND content.visibility = 'public'
             AND relation.visibility = 'public'
             AND relation.participation_status = 'confirmed'
             AND person.profile_status = 'published'
        )
      )
      ORDER BY selected.kind, selected.recordId
      LIMIT 1`,
  )
    .bind(
      JSON.stringify(sessionIds),
      JSON.stringify(speakerIds),
      eventId,
      eventId,
    )
    .first<{ kind: "session" | "speaker"; recordId: string }>();
  return missing ? [missing] : [];
}

async function validatePublishedPublicSiteWithoutProgrammeSnapshot(
  env: CloudflareEnvironment,
  site: PublishedPublicSite,
  hasPublishedProgramme: boolean,
) {
  validatePublicSiteCanonicalEvent(site.configuration, site.event);
  validatePublicSiteConfiguration(site.configuration);
  if (
    !hasPublishedProgramme &&
    publicSiteRequiresPublishedProgramme(site.configuration)
  ) {
    throw new PublishedPublicSiteInvariantError(
      "Featured speakers, featured sessions, statistics and post-event recordings require a published programme.",
    );
  }
  const missing = await missingPublishedProgrammeFeaturedIds(
    env,
    site.event.id,
    site.configuration,
  );
  const first = missing[0];
  if (first) {
    throw new PublishedPublicSiteInvariantError(
      `Featured ${first.kind} ${first.recordId} is not part of the current published programme.`,
    );
  }
}

export async function getValidatedPublishedPublicSite(
  env: CloudflareEnvironment,
  slug: string,
  programme?: PublishedProgramme | null,
  now?: number,
  publishedVersion?: PublishedProgrammeVersion | null,
) {
  try {
    const site = await new PublicSiteService(env).getPublished(slug, now);
    if (!site) return null;
    if (programme) {
      resolvePublicSitePresentation(site.configuration, site.event, programme);
    } else {
      const version =
        publishedVersion === undefined
          ? await new PublicProgrammeService(env).findPublishedVersion(slug)
          : publishedVersion;
      await validatePublishedPublicSiteWithoutProgrammeSnapshot(
        env,
        site,
        version !== null,
      );
    }
    return site;
  } catch (error) {
    if (
      error instanceof PublishedPublicSiteInvariantError ||
      error instanceof ZodError ||
      error instanceof SyntaxError
    ) {
      throw publishedPublicSiteInvariantResponse();
    }
    throw error;
  }
}
