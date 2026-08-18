import { describe, expect, it } from "vitest";

import { defaultPublicSiteDraft } from "./public-site";
import { publicationChangeSummary } from "./public-site-publication-summary";

function sponsor(name: string, id = name) {
  return {
    id,
    name,
    tier: "Community",
    websiteUrl: null,
    logoUrl: null,
    description: null,
    position: 0,
    revision: 1,
  };
}

describe("public-site publication change summary", () => {
  it("compares a first publication against an empty public baseline", () => {
    const draft = defaultPublicSiteDraft();
    draft.theme = "dark";
    draft.tagline = "A first public homepage.";
    draft.sectionVisibility.faq = true;
    draft.sectionVisibility.statistics = false;
    draft.pages.about.enabled = true;
    draft.pages.about.body = "About the event.";
    draft.pages.sponsors.enabled = true;
    draft.featuredSpeakerIds = ["speaker-1"];
    draft.featuredSessionIds = ["session-1"];

    expect(
      publicationChangeSummary({
        draft,
        sponsors: [sponsor("Civic Partner")],
        published: null,
        speakerNames: new Map([["speaker-1", "Priya Shah"]]),
        sessionNames: new Map([["session-1", "Opening keynote"]]),
      }),
    ).toEqual([
      "Sections added: Event introduction, Venue and map, Frequently asked questions",
      "Pages added: About, Sponsors",
      "Featured speakers added: Priya Shah",
      "Featured sessions added: Opening keynote",
      "Sponsors added: Civic Partner",
      "Theme: Dark",
      "Editorial homepage content will be published.",
    ]);
  });

  it("keeps later publications on the same comparison", () => {
    const published = {
      ...defaultPublicSiteDraft(),
      theme: "light" as const,
      featuredSpeakerIds: ["speaker-1"],
      featuredSessionIds: [],
      sponsors: [
        {
          id: "sponsor-1",
          name: "Civic Partner",
          tier: "Community",
          websiteUrl: null,
          logoUrl: null,
          description: null,
          position: 0,
        },
      ],
    };
    const draft = defaultPublicSiteDraft();
    draft.theme = "dark";
    draft.featuredSpeakerIds = ["speaker-1", "speaker-2"];
    draft.featuredSessionIds = ["session-1"];

    expect(
      publicationChangeSummary({
        draft,
        sponsors: [sponsor("Civic Partner", "sponsor-1")],
        published: { configuration: published },
        speakerNames: new Map([
          ["speaker-1", "Priya Shah"],
          ["speaker-2", "Alex Morgan"],
        ]),
        sessionNames: new Map([["session-1", "Opening keynote"]]),
      }),
    ).toEqual([
      "Featured speakers added: Alex Morgan",
      "Featured sessions added: Opening keynote",
      "Theme: Light → Dark",
    ]);
  });

  it("reports remaining editorial only when it is not already listed", () => {
    const published = {
      ...defaultPublicSiteDraft(),
      theme: "light" as const,
      sponsors: [],
    };
    const themeOnly = defaultPublicSiteDraft();
    themeOnly.theme = "dark";
    expect(
      publicationChangeSummary({
        draft: themeOnly,
        sponsors: [],
        published: { configuration: published },
        speakerNames: new Map(),
        sessionNames: new Map(),
      }),
    ).toEqual(["Theme: Light → Dark"]);

    const withCopy = defaultPublicSiteDraft();
    withCopy.theme = "dark";
    withCopy.tagline = "A revised public homepage.";
    expect(
      publicationChangeSummary({
        draft: withCopy,
        sponsors: [],
        published: { configuration: published },
        speakerNames: new Map(),
        sessionNames: new Map(),
      }),
    ).toEqual([
      "Theme: Light → Dark",
      "Homepage or fixed-page editorial content changed.",
    ]);
  });

  it("does not treat hidden first-publish editorial as public", () => {
    const draft = defaultPublicSiteDraft();
    draft.sectionVisibility.faq = false;
    draft.pages.faq.enabled = false;
    draft.pages.faq.body = "Only visible if the FAQ page is enabled.";
    draft.faqItems = [
      {
        id: "faq-1",
        question: "When does registration open?",
        answer: "The organiser will publish dates here.",
      },
    ];
    draft.postEvent.enabled = true;
    draft.pages.about.enabled = false;
    draft.pages.about.body = "Hidden about copy.";

    expect(
      publicationChangeSummary({
        draft,
        sponsors: [],
        published: null,
        speakerNames: new Map(),
        sessionNames: new Map(),
        hasRenderableRecordings: false,
      }),
    ).not.toContain("Editorial homepage content will be published.");
  });

  it("includes a changed introduction heading on first publication", () => {
    const draft = defaultPublicSiteDraft();
    draft.introductionHeading = "Welcome to the conference";

    expect(
      publicationChangeSummary({
        draft,
        sponsors: [],
        published: null,
        speakerNames: new Map(),
        sessionNames: new Map(),
      }),
    ).toContain("Editorial homepage content will be published.");
  });

  it("does not treat unpublished post-event copy as public while the event is still running", () => {
    const draft = defaultPublicSiteDraft();
    draft.postEvent.enabled = true;
    draft.postEvent.body = "Watch the talks on demand.";

    expect(
      publicationChangeSummary({
        draft,
        sponsors: [],
        published: null,
        speakerNames: new Map(),
        sessionNames: new Map(),
        hasRenderableRecordings: false,
      }),
    ).not.toContain("Editorial homepage content will be published.");
  });

  it("includes first-publish post-event copy only when recordings are publicly renderable", () => {
    const draft = defaultPublicSiteDraft();
    draft.postEvent.enabled = true;
    draft.postEvent.body = "Watch the talks on demand.";

    expect(
      publicationChangeSummary({
        draft,
        sponsors: [],
        published: null,
        speakerNames: new Map(),
        sessionNames: new Map(),
        hasRenderableRecordings: true,
      }),
    ).toContain("Editorial homepage content will be published.");
  });
});
