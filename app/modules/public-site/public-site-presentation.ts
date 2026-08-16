import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import type { PublicSiteDraft } from "./public-site";
import { PublishedPublicSiteInvariantError } from "./public-site-errors";

type CanonicalPublicEvent = Pick<
  PublishedProgramme["event"],
  "description" | "venue" | "city" | "venueAddress"
>;

export function publicVenueLabel(event: CanonicalPublicEvent) {
  return (
    event.venue?.trim() || event.city?.trim() || event.venueAddress?.trim()
  );
}

export function validatePublicSiteCanonicalEvent(
  configuration: PublicSiteDraft,
  event: CanonicalPublicEvent,
) {
  if (
    configuration.sectionVisibility.introduction &&
    !event.description?.trim()
  ) {
    throw new PublishedPublicSiteInvariantError(
      "The introduction section requires an event description in Event Setup.",
    );
  }
  if (
    configuration.pages.about.enabled &&
    !configuration.pages.about.body &&
    !event.description?.trim()
  ) {
    throw new PublishedPublicSiteInvariantError(
      "The enabled About page requires content.",
    );
  }

  const venueRequired =
    configuration.sectionVisibility.venue || configuration.pages.venue.enabled;
  const venueLabel = publicVenueLabel(event);
  if (venueRequired && !venueLabel) {
    throw new PublishedPublicSiteInvariantError(
      "The venue section or page requires a venue, city, or address in Event Setup.",
    );
  }
  return venueLabel;
}

export function resolvePublicSitePresentation(
  configuration: PublicSiteDraft,
  programme: PublishedProgramme,
) {
  const venueLabel = validatePublicSiteCanonicalEvent(
    configuration,
    programme.event,
  );

  if (
    configuration.sectionVisibility.faq &&
    configuration.faqItems.length === 0
  ) {
    throw new PublishedPublicSiteInvariantError(
      "Hide the FAQ section or add at least one question before publishing.",
    );
  }
  if (
    configuration.sectionVisibility.statistics &&
    !Object.values(configuration.statisticVisibility).some(Boolean)
  ) {
    throw new PublishedPublicSiteInvariantError(
      "Hide the statistics section or select at least one statistic before publishing.",
    );
  }
  if (
    configuration.sectionVisibility.featured_speakers &&
    configuration.featuredSpeakerIds.length === 0
  ) {
    throw new PublishedPublicSiteInvariantError(
      "Hide the featured speakers section or select at least one published speaker.",
    );
  }
  if (
    configuration.sectionVisibility.featured_sessions &&
    configuration.featuredSessionIds.length === 0
  ) {
    throw new PublishedPublicSiteInvariantError(
      "Hide the featured sessions section or select at least one published session.",
    );
  }

  const pages = configuration.pages;
  if (pages["code-of-conduct"].enabled && !pages["code-of-conduct"].body) {
    throw new PublishedPublicSiteInvariantError(
      "The enabled Code of conduct page requires content.",
    );
  }
  if (
    pages.faq.enabled &&
    !pages.faq.body &&
    configuration.faqItems.length === 0
  ) {
    throw new PublishedPublicSiteInvariantError(
      "The enabled FAQ page requires content.",
    );
  }
  if (configuration.postEvent.enabled && !configuration.postEvent.heading) {
    throw new PublishedPublicSiteInvariantError(
      "Post-event mode requires a heading.",
    );
  }

  const speakerById = new Map(
    programme.speakers.map((speaker) => [speaker.id, speaker]),
  );
  const sessionById = new Map(
    programme.sessions.map((session) => [session.id, session]),
  );
  const featuredSpeakers = configuration.sectionVisibility.featured_speakers
    ? configuration.featuredSpeakerIds.map((id) => {
        const speaker = speakerById.get(id);
        if (!speaker)
          throw new PublishedPublicSiteInvariantError(
            `Featured speaker ${id} is not part of the current published programme.`,
          );
        return speaker;
      })
    : [];
  const featuredSessions = configuration.sectionVisibility.featured_sessions
    ? configuration.featuredSessionIds.map((id) => {
        const session = sessionById.get(id);
        if (!session)
          throw new PublishedPublicSiteInvariantError(
            `Featured session ${id} is not part of the current published programme.`,
          );
        return session;
      })
    : [];

  return { featuredSpeakers, featuredSessions, venueLabel };
}

export function publishedPublicSiteInvariantResponse() {
  return new Response("The published public event site is inconsistent.", {
    status: 500,
    headers: { "cache-control": "no-store" },
  });
}
