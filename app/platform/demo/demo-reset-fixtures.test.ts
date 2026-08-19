import { describe, expect, it } from "vitest";

import { PUBLIC_SITE_PAGE_TYPES } from "~/modules/public-site/public-site";
import {
  DEMO_SHOWCASE_ENABLED_PAGES,
  DEMO_SHOWCASE_FAQ_ITEMS,
  DEMO_SHOWCASE_FEATURED_SESSION_IDS,
  DEMO_SHOWCASE_FEATURED_SPEAKER_IDS,
  DEMO_SHOWCASE_PUBLIC_SITE_TAGLINE,
  DEMO_SHOWCASE_SITE_SPONSORS,
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
      faq: false,
    });
    expect(draft.featuredSessionIds).toEqual([
      ...DEMO_SHOWCASE_FEATURED_SESSION_IDS,
    ]);
    expect(draft.featuredSpeakerIds).toEqual([
      ...DEMO_SHOWCASE_FEATURED_SPEAKER_IDS,
    ]);
    expect(draft.faqItems).toEqual(
      DEMO_SHOWCASE_FAQ_ITEMS.map((item) => ({ ...item })),
    );
    expect(draft.postEvent.enabled).toBe(false);
    expect(draft).not.toHaveProperty("sponsors");

    // Every optional page ships enabled with content, so an evaluator sees
    // what each one renders instead of an empty navigation.
    expect(DEMO_SHOWCASE_ENABLED_PAGES).toEqual([...PUBLIC_SITE_PAGE_TYPES]);
    for (const page of PUBLIC_SITE_PAGE_TYPES) {
      expect(draft.pages[page].enabled).toBe(true);
      expect(draft.pages[page].body.length).toBeGreaterThan(120);
    }

    expect(published.tagline).toBe(draft.tagline);
    expect(published.theme).toBe(draft.theme);
    expect(published.featuredSessionIds).toEqual(draft.featuredSessionIds);
    /* The service groups sponsors by tier name alphabetically, so the fixture's
       tiers are named to fall in their own hierarchy under that sort. This is
       the assertion that fails if someone adds a tier that does not. */
    expect(published.sponsors.map((sponsor) => sponsor.tier)).toEqual([
      "Headline partner",
      "Major partner",
      "Major partner",
      "Supporting partner",
      "Supporting partner",
      "Supporting partner",
      "Supporting partner",
    ]);
    expect(published.sponsors).toEqual(demoShowcasePublishedSponsors());
    expect(published.sponsors).toHaveLength(DEMO_SHOWCASE_SITE_SPONSORS.length);
    // Fictional organisations carry no website or logo, so the homepage strip
    // sends a reader to this event's sponsors page rather than to a dead host.
    expect(
      published.sponsors.every(
        (sponsor) =>
          sponsor.logoUrl === null &&
          sponsor.websiteUrl === null &&
          Boolean(sponsor.description),
      ),
    ).toBe(true);
  });
});
