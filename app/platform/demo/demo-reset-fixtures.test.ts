import { describe, expect, it } from "vitest";

import {
  DEMO_SHOWCASE_FEATURED_SESSION_IDS,
  DEMO_SHOWCASE_FEATURED_SPEAKER_IDS,
  DEMO_SHOWCASE_PUBLIC_SITE_TAGLINE,
  demoShowcasePublicSiteDraft,
  demoShowcasePublishedPublicSite,
  demoShowcasePublishedSponsors,
} from "./demo-reset-fixtures";

describe("demo public-site showcase fixture", () => {
  it("keeps draft and published snapshots valid and distinct", () => {
    const draft = demoShowcasePublicSiteDraft();
    const published = demoShowcasePublishedPublicSite();

    expect(draft.tagline).toBe(DEMO_SHOWCASE_PUBLIC_SITE_TAGLINE);
    expect(draft.theme).toBe("light");
    expect(draft.sectionOrder).toEqual([
      "introduction",
      "featured_speakers",
      "featured_sessions",
      "statistics",
      "venue",
      "faq",
    ]);
    expect(draft.sectionVisibility).toEqual({
      introduction: true,
      featured_speakers: true,
      featured_sessions: true,
      statistics: true,
      venue: true,
      faq: true,
    });
    expect(draft.featuredSessionIds).toEqual([
      ...DEMO_SHOWCASE_FEATURED_SESSION_IDS,
    ]);
    expect(draft.featuredSpeakerIds).toEqual([
      ...DEMO_SHOWCASE_FEATURED_SPEAKER_IDS,
    ]);
    expect(draft.faqItems).toHaveLength(2);
    expect(draft.pages.about.enabled).toBe(true);
    expect(draft.pages.sponsors.enabled).toBe(true);
    expect(draft.pages["code-of-conduct"].enabled).toBe(false);
    expect(draft.postEvent.enabled).toBe(false);
    expect(draft).not.toHaveProperty("sponsors");

    expect(published.tagline).toBe(draft.tagline);
    expect(published.theme).toBe(draft.theme);
    expect(published.featuredSessionIds).toEqual(draft.featuredSessionIds);
    expect(published.sponsors.map((sponsor) => sponsor.tier)).toEqual([
      "Community",
      "Partner",
    ]);
    expect(published.sponsors).toEqual(demoShowcasePublishedSponsors());
    expect(
      published.sponsors.every(
        (sponsor) => sponsor.logoUrl === null && sponsor.websiteUrl === null,
      ),
    ).toBe(true);
  });
});
