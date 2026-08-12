import { describe, expect, it } from "vitest";

import type { PublishedProgramme } from "~/modules/programme/public-programme-service.server";
import { staticProgrammeHtml } from "./api-public-programme";

describe("static programme HTML", () => {
  it("omits an affiliation paragraph when no public affiliation exists", () => {
    const programme: PublishedProgramme = {
      event: {
        id: "event-1",
        slug: "test-event",
        name: "Test event",
        timezone: "UTC",
        startDate: "2026-08-12",
        endDate: "2026-08-12",
        venue: null,
        city: null,
        description: null,
        brandAccent: "#4f46e5",
      },
      version: { id: "version-1", versionNumber: 1, publishedAt: 1 },
      sessions: [],
      speakers: [
        {
          id: "speaker-1",
          displayName: "Speaker One",
          imageUrl: null,
          biography: "A biography.",
          pronunciation: null,
          jobTitle: " ",
          organisationName: null,
          sessionIds: [],
        },
      ],
      freshness: {
        source: "d1",
        fetchedAt: 1,
        cacheExpiresAt: null,
        cached: false,
      },
      contentRevision: "test-revision",
    };

    const html = staticProgrammeHtml(programme);

    expect(html).toContain('<article id="speaker-speaker-1">');
    expect(html).toContain("<p>A biography.</p>");
    expect(html).not.toContain("<p></p>");
    expect(html).not.toContain("not provided");
  });
});
