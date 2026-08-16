import type {
  PublicSitePageType,
  PublicSiteSectionType,
} from "~/modules/public-site/public-site";

export const publicSiteSectionLabels: Record<PublicSiteSectionType, string> = {
  introduction: "Event introduction",
  featured_speakers: "Featured speakers",
  featured_sessions: "Featured sessions",
  statistics: "Programme statistics",
  venue: "Venue and map",
  faq: "Frequently asked questions",
};

export const publicSitePageDescriptions: Record<PublicSitePageType, string> = {
  about: "Editorial context beyond the event introduction.",
  faq: "An optional introduction followed by the canonical FAQ entries.",
  venue: "Arrival or accessibility notes followed by canonical venue details.",
  "code-of-conduct": "The attendee-facing behavior and reporting policy.",
  sponsors: "An optional introduction followed by structured sponsor records.",
};
