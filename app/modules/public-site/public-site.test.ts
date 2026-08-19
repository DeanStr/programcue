import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PublicSiteHome } from "~/components/public-site-content";
import {
  RestrictedMarkdown,
  restrictedMarkdownPlainText,
} from "~/components/restricted-markdown";
import {
  restrictedMarkdownEditorDocument,
  restrictedMarkdownFromEditorDocument,
} from "~/components/restricted-markdown-editor";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import { submissionApplicationAvailability } from "~/modules/submissions/submission-availability";
import {
  defaultPublicSiteDraft,
  PUBLIC_SITE_CONFIGURATION_JSON_MAX_LENGTH,
  parsePublishedPublicSiteSnapshot,
  publicSiteDraftSchema,
  siteSaveInputSchema,
  sponsorInputSchema,
} from "./public-site";
import {
  publishedSocialCardRevision,
  resolvePublicSitePresentation,
} from "./public-site-presentation";

describe("public event site rules", () => {
  it("uses the canonical submission availability rule for public CTA state", () => {
    const base = {
      status: "published" as const,
      closesAt: null,
      submissionLimit: null,
      submittedCount: 0,
    };
    expect(submissionApplicationAvailability(base, 100).state).toBe(
      "accepting",
    );
    expect(
      submissionApplicationAvailability({ ...base, closesAt: 99 }, 100).state,
    ).toBe("closed");
    expect(
      submissionApplicationAvailability(
        { ...base, submissionLimit: 2, submittedCount: 2 },
        100,
      ).state,
    ).toBe("full");
  });

  it("keeps the homepage to exactly six unique fixed sections", () => {
    const draft = defaultPublicSiteDraft();
    expect(publicSiteDraftSchema.parse(draft).sectionOrder).toHaveLength(6);
    expect(() =>
      publicSiteDraftSchema.parse({
        ...draft,
        sectionOrder: [
          "introduction",
          "introduction",
          "featured_sessions",
          "statistics",
          "venue",
          "faq",
        ],
      }),
    ).toThrow(/exactly once/i);
  });

  it("requires enabled page navigation labels to be unambiguous", () => {
    const duplicate = defaultPublicSiteDraft();
    duplicate.pages.about.enabled = true;
    duplicate.pages.about.navigationLabel = "Event details";
    duplicate.pages.faq.enabled = true;
    duplicate.pages.faq.navigationLabel = "event DETAILS";
    expect(() => publicSiteDraftSchema.parse(duplicate)).toThrow(
      /navigation labels must be unique/i,
    );

    for (const label of ["sPeAkErS", "Timetable", "Day-by-day schedule"]) {
      const reserved = defaultPublicSiteDraft();
      reserved.pages.about.enabled = true;
      reserved.pages.about.navigationLabel = label;
      expect(() => publicSiteDraftSchema.parse(reserved)).toThrow(
        /cannot use an event navigation label/i,
      );
    }

    const reserved = defaultPublicSiteDraft();
    reserved.pages.about.navigationLabel = "Timetable";
    reserved.pages.about.enabled = false;
    expect(publicSiteDraftSchema.parse(reserved).pages.about.enabled).toBe(
      false,
    );
  });

  it("accepts a draft with every editorial field at its declared limit", () => {
    const escapedCharacter = "\u0000";
    const maximumId = (index: number) =>
      `${String(index).padStart(3, "0")}${escapedCharacter.repeat(157)}`;
    const draft = defaultPublicSiteDraft();
    draft.tagline = escapedCharacter.repeat(180);
    draft.introductionHeading = escapedCharacter.repeat(100);
    draft.featuredSpeakerIds = Array.from({ length: 12 }, (_, index) =>
      maximumId(index),
    );
    draft.featuredSessionIds = Array.from({ length: 12 }, (_, index) =>
      maximumId(index),
    );
    draft.faqItems = Array.from({ length: 12 }, (_, index) => ({
      id: maximumId(index),
      question: escapedCharacter.repeat(180),
      answer: escapedCharacter.repeat(2_000),
    }));
    for (const page of Object.values(draft.pages)) {
      page.title = escapedCharacter.repeat(100);
      page.navigationLabel = escapedCharacter.repeat(40);
      page.body = escapedCharacter.repeat(8_000);
    }
    draft.postEvent.heading = escapedCharacter.repeat(120);
    draft.postEvent.body = escapedCharacter.repeat(2_000);

    const configurationJson = JSON.stringify(draft);
    expect(configurationJson.length).toBeLessThanOrEqual(
      PUBLIC_SITE_CONFIGURATION_JSON_MAX_LENGTH,
    );
    expect(
      siteSaveInputSchema.parse({
        commandId: crypto.randomUUID(),
        revision: 0,
        configurationJson,
      }).configurationJson,
    ).toEqual(draft);
  });

  it("rejects credentialed or non-HTTPS sponsor addresses", () => {
    const input = {
      commandId: crypto.randomUUID(),
      id: "",
      revision: 0,
      name: "Main partner",
      tier: "Gold",
      websiteUrl: "http://example.test",
      logoUrl: "https://user:password@example.test/logo.png",
      description: "",
      position: 0,
    };
    expect(() => sponsorInputSchema.parse(input)).toThrow();
  });

  it("renders only credential-free HTTPS Markdown links", () => {
    const markup = renderToStaticMarkup(
      createElement(
        RestrictedMarkdown,
        null,
        "[Safe](https://example.test/help) [Secret](https://user:password@example.test/help) [Local](http://example.test/help)",
      ),
    );
    expect(markup).toContain('href="https://example.test/help"');
    expect(markup).not.toContain("user:password");
    expect(markup).not.toContain('href="http://');
    expect(markup).toContain("Secret");
  });

  it("derives clean metadata text from restricted Markdown", () => {
    expect(
      restrictedMarkdownPlainText(
        "## Why attend\n\n- Meet **practitioners**\n- Read [the guide](https://example.test/guide)",
      ),
    ).toBe("Why attend Meet practitioners Read the guide");
  });

  it("round-trips every visual editor format through restricted Markdown", () => {
    const markdown = [
      "## Practical details",
      "",
      "Read **the schedule** and [travel advice](https://example.test/travel).",
      "",
      "- Bring photo identification",
      "- Ask **the team** for help",
    ].join("\n");

    expect(
      restrictedMarkdownFromEditorDocument(
        restrictedMarkdownEditorDocument(markdown),
      ),
    ).toBe(markdown);
  });

  it("keeps adjacent visual-editor bullets in one Markdown list", () => {
    expect(
      restrictedMarkdownFromEditorDocument({
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "First" }],
                  },
                ],
              },
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Second" }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("- First\n- Second");
  });

  it("flattens pasted nested bullets without discarding their text", () => {
    expect(
      restrictedMarkdownFromEditorDocument({
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Parent" }],
                  },
                  {
                    type: "bulletList",
                    content: [
                      {
                        type: "listItem",
                        content: [
                          {
                            type: "paragraph",
                            content: [{ type: "text", text: "Child" }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("- Parent\n- Child");
  });

  it("flattens every pasted list-item paragraph without discarding text", () => {
    expect(
      restrictedMarkdownFromEditorDocument({
        type: "doc",
        content: [
          {
            type: "bulletList",
            content: [
              {
                type: "listItem",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "First paragraph" }],
                  },
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Second paragraph" }],
                  },
                ],
              },
            ],
          },
        ],
      }),
    ).toBe("- First paragraph\n- Second paragraph");
  });

  it("round-trips HTTPS links containing Markdown delimiters", () => {
    const markdown = restrictedMarkdownFromEditorDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Parenthesised link",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://example.test/a(b)" },
                },
              ],
            },
          ],
        },
      ],
    });

    expect(markdown).toBe("[Parenthesised link](<https://example.test/a(b)>)");
    expect(
      restrictedMarkdownEditorDocument(markdown).content?.[0]?.content?.[0]
        ?.marks?.[0]?.attrs?.href,
    ).toBe("https://example.test/a(b)");
    expect(
      publicSiteDraftSchema.parse({
        ...defaultPublicSiteDraft(),
        pages: {
          ...defaultPublicSiteDraft().pages,
          about: {
            ...defaultPublicSiteDraft().pages.about,
            body: markdown,
          },
        },
      }).pages.about.body,
    ).toBe(markdown);
    expect(
      renderToStaticMarkup(createElement(RestrictedMarkdown, null, markdown)),
    ).toContain('href="https://example.test/a(b)"');
  });

  it("escapes formatting delimiters in visual-editor text", () => {
    const markdown = restrictedMarkdownFromEditorDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "[New]",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://example.test/new" },
                },
              ],
            },
            { type: "text", text: " and " },
            {
              type: "text",
              text: "2 * 3",
              marks: [{ type: "bold" }],
            },
            { type: "text", text: " \\ **literal**" },
          ],
        },
      ],
    });

    expect(markdown).toBe(
      "[\\[New\\]](https://example.test/new) and **2 \\* 3** \\\\ \\*\\*literal\\*\\*",
    );
    expect(
      restrictedMarkdownFromEditorDocument(
        restrictedMarkdownEditorDocument(markdown),
      ),
    ).toBe(markdown);
    const markup = renderToStaticMarkup(
      createElement(RestrictedMarkdown, null, markdown),
    );
    expect(markup).toContain(
      '<a href="https://example.test/new" rel="noreferrer">[New]</a>',
    );
    expect(markup).toContain("<strong>2 * 3</strong> \\ **literal**");
  });

  it("escapes block markers typed as ordinary paragraph text", () => {
    const markdown = restrictedMarkdownFromEditorDocument({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "## Not a heading" }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "- Not a list item" }],
        },
      ],
    });

    expect(markdown).toBe("\\## Not a heading\n\n\\- Not a list item");
    expect(restrictedMarkdownEditorDocument(markdown)).toMatchObject({
      content: [
        { type: "paragraph", content: [{ text: "## Not a heading" }] },
        { type: "paragraph", content: [{ text: "- Not a list item" }] },
      ],
    });
  });

  it("renders bold text inside a safe link without permitting unsafe links", () => {
    const safeMarkup = renderToStaticMarkup(
      createElement(
        RestrictedMarkdown,
        null,
        "[**Read the guide**](https://example.test/guide)",
      ),
    );
    const unsafeMarkup = renderToStaticMarkup(
      createElement(
        RestrictedMarkdown,
        null,
        "[Private](https://user:password@example.test/guide)",
      ),
    );

    expect(safeMarkup).toContain(
      '<a href="https://example.test/guide" rel="noreferrer"><strong>Read the guide</strong></a>',
    );
    expect(unsafeMarkup).not.toContain("href=");
    expect(unsafeMarkup).not.toContain("user:password");
    expect(unsafeMarkup).toContain("Private");
  });

  it("does not introduce spaces around inline formatting in metadata", () => {
    const markup = renderToStaticMarkup(
      createElement(RestrictedMarkdown, null, "Meet **Sam**, then apply."),
    );

    expect(markup).toContain("Meet <strong>Sam</strong>, then apply.");
    expect(restrictedMarkdownPlainText("Meet **Sam**, then apply.")).toBe(
      "Meet Sam, then apply.",
    );
  });

  it("renders post-event Markdown and published accessibility resources", () => {
    const configuration = {
      ...defaultPublicSiteDraft(),
      sectionVisibility: {
        introduction: false,
        featured_speakers: false,
        featured_sessions: false,
        statistics: false,
        venue: false,
        faq: false,
      },
      postEvent: {
        enabled: true,
        heading: "Watch on demand",
        body: "Find **every talk** in the archive.",
      },
      sponsors: [],
    };
    const programme = {
      event: {
        slug: "example-event",
        startDate: "2027-01-01",
        endDate: "2027-01-01",
        description: null,
        venue: null,
        city: null,
        venueAddress: null,
      },
      sessions: [],
      speakers: [],
    } as unknown as PublishedProgramme;
    const markup = renderToStaticMarkup(
      createElement(PublicSiteHome, {
        event: programme.event,
        programme,
        site: {
          configuration,
          recordings: [
            {
              id: "recording-one",
              sessionId: "session-one",
              title: "Opening keynote",
              recordingUrl: "https://video.example.test/watch",
              captionsUrl: "https://video.example.test/captions.vtt",
              transcriptUrl: "https://video.example.test/transcript",
              sessionTitle: "Opening keynote",
              speakerNames: ["Example Speaker"],
            },
          ],
        },
      }),
    );
    expect(markup).toContain("<strong>every talk</strong>");
    expect(markup).toContain('href="https://video.example.test/captions.vtt"');
    expect(markup).toContain('href="https://video.example.test/transcript"');
  });

  it("keeps every public action inert in the editor preview", () => {
    const configuration = {
      ...defaultPublicSiteDraft(),
      sponsors: [],
    };
    const programme = {
      event: {
        slug: "example-event",
        startDate: "2027-01-01",
        endDate: "2027-01-01",
        description: "An example event.",
        venue: "Example Hall",
        city: "Example City",
        venueAddress: "1 Example Street",
        venueMapUrl: "https://maps.example.test/hall",
        application: {
          url: "https://forms.example.test/apply",
          state: "accepting",
        },
        supportUrl: "https://help.example.test/event",
      },
      sessions: [],
      speakers: [],
    } as unknown as PublishedProgramme;
    const markup = renderToStaticMarkup(
      createElement(PublicSiteHome, {
        event: programme.event,
        programme,
        site: { configuration, recordings: [] },
        preview: true,
      }),
    );
    expect(markup).toContain("Apply to speak");
    expect(markup).toContain("Explore the programme");
    expect(markup).toContain("Event help");
    expect(markup).toContain("Open map");
    expect(markup).not.toContain("href=");
  });

  it("uses honest wording for a published but closed call for speakers", () => {
    const configuration = {
      ...defaultPublicSiteDraft(),
      sponsors: [],
    };
    const programme = {
      event: {
        slug: "example-event",
        startDate: "2027-01-01",
        endDate: "2027-01-01",
        description: "An example event.",
        venue: "Example Hall",
        city: "Example City",
        venueAddress: "1 Example Street",
        venueMapUrl: null,
        application: {
          url: "/apply/example-event",
          state: "closed",
        },
        supportUrl: null,
      },
      sessions: [],
      speakers: [],
    } as unknown as PublishedProgramme;
    const markup = renderToStaticMarkup(
      createElement(PublicSiteHome, {
        event: programme.event,
        programme,
        site: { configuration, recordings: [] },
      }),
    );

    expect(markup).toContain("View call for speakers");
    expect(markup).not.toContain("Apply to speak");
    expect(markup).toContain('href="/apply/example-event"');
  });

  it("rejects unsafe restricted-Markdown links before publication", () => {
    const draft = defaultPublicSiteDraft();
    draft.pages.about.body =
      "[Secret](https://user:password@example.test/help)";
    expect(() => publicSiteDraftSchema.parse(draft)).toThrow(
      /credential-free HTTPS/i,
    );
  });

  it("strictly validates sponsor fields in persisted publication snapshots", () => {
    const snapshot = {
      ...defaultPublicSiteDraft(),
      sponsors: [
        {
          id: "sponsor-one",
          name: "Partner",
          tier: "Gold",
          websiteUrl: "https://user:password@example.test",
          logoUrl: null,
          description: null,
          position: 0,
        },
      ],
    };
    expect(() =>
      parsePublishedPublicSiteSnapshot(JSON.stringify(snapshot)),
    ).toThrow(/credentials/i);
  });

  it("fails when a visible featured record no longer resolves", () => {
    const draft = defaultPublicSiteDraft();
    draft.sectionVisibility.introduction = false;
    draft.sectionVisibility.venue = false;
    draft.sectionVisibility.featured_sessions = true;
    draft.featuredSessionIds = ["missing-session"];
    const programme = {
      event: {
        description: null,
        venue: null,
        city: null,
        venueAddress: null,
      },
      sessions: [],
      speakers: [],
    } as unknown as PublishedProgramme;
    expect(() =>
      resolvePublicSitePresentation(draft, programme.event, programme),
    ).toThrow(/missing-session.*current published programme/i);
  });

  it("requires programme-backed sections to be hidden before pre-programme publication", () => {
    const draft = defaultPublicSiteDraft();
    draft.sectionVisibility.introduction = false;
    draft.sectionVisibility.venue = false;
    const event = {
      description: null,
      venue: null,
      city: null,
      venueAddress: null,
    };
    expect(() => resolvePublicSitePresentation(draft, event, null)).toThrow(
      /require a published programme/i,
    );

    draft.sectionVisibility.statistics = false;
    expect(resolvePublicSitePresentation(draft, event, null)).toEqual({
      featuredSpeakers: [],
      featuredSessions: [],
      venueLabel: undefined,
    });
  });

  it("versions generic social cards from the site snapshot only", () => {
    expect(
      publishedSocialCardRevision({
        siteContentRevision: "site-hash",
        siteRevision: 3,
        programmeContentRevision: "programme-hash",
      }),
    ).toBe("site-hash-3");
    expect(
      publishedSocialCardRevision({
        siteContentRevision: "site-hash",
        siteRevision: 3,
        programmeContentRevision: "programme-hash",
        speakerId: "person-1",
      }),
    ).toBe("programme-hash-site-hash-3");
  });
});
