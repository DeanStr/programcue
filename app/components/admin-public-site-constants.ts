import type {
  PublicSiteDraft,
  PublicSitePageType,
  PublicSiteSectionType,
} from "~/modules/public-site/public-site";

export type PublicSiteStatisticType =
  keyof PublicSiteDraft["statisticVisibility"];

export const publicSiteSectionLabels: Record<PublicSiteSectionType, string> = {
  introduction: "Event introduction",
  featured_speakers: "Featured speakers",
  featured_sessions: "Featured sessions",
  statistics: "Programme statistics",
  venue: "Venue and map",
  faq: "Frequently asked questions",
};

/* What the section puts on the homepage, in the organiser's terms. The list is
   the homepage's outline, so each row has to say what publishing it produces
   rather than repeat its own name. */
export const publicSiteSectionDescriptions: Record<
  PublicSiteSectionType,
  string
> = {
  introduction: "A heading and the event description from Event settings.",
  featured_speakers: "A chosen, ordered strip of published speakers.",
  featured_sessions: "A chosen, ordered strip of published sessions.",
  statistics: "Counts drawn from the published programme.",
  venue: "The venue, address and map from Event settings.",
  faq: "The questions and answers kept below.",
};

/* A complete record, so a statistic added to the draft schema fails the build
   here rather than disappearing from the editor that switches it on. */
export const publicSiteStatisticLabels: Record<
  PublicSiteStatisticType,
  string
> = {
  sessions: "Sessions",
  speakers: "Speakers",
  tracks: "Tracks",
  days: "Days",
};

export const publicSitePageDescriptions: Record<PublicSitePageType, string> = {
  about: "Editorial context beyond the event introduction.",
  faq: "An optional introduction followed by the canonical FAQ entries.",
  venue: "Arrival or accessibility notes followed by canonical venue details.",
  "code-of-conduct": "The attendee-facing behavior and reporting policy.",
  sponsors: "An optional introduction followed by structured sponsor records.",
};

export const publicSitePageLabels: Record<PublicSitePageType, string> = {
  about: "About",
  faq: "FAQ",
  venue: "Venue",
  "code-of-conduct": "Code of Conduct",
  sponsors: "Sponsors",
};
