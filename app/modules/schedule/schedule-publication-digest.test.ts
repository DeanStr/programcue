import { describe, expect, it } from "vitest";
import {
  buildSchedulePublicationDigest,
  SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT,
} from "./schedule-publication-digest.server";

describe("schedule publication digest", () => {
  it("keeps exact counts while bounding stored highlights", () => {
    const added = Array.from(
      { length: SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT + 7 },
      (_, index) => ({
        sessionId: `session-${index}`,
        title: `Session ${index}`,
      }),
    );
    const digest = buildSchedulePublicationDigest({
      added,
      removed: [{ sessionId: "removed", title: "Removed session" }],
      moved: [],
      visibility: [],
      content: [],
    });
    expect(digest.counts).toEqual({
      added: SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT + 7,
      removed: 1,
      moved: 0,
      visibility: 0,
      content: 0,
      total: SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT + 8,
    });
    expect(digest.highlights.added).toHaveLength(
      SCHEDULE_PUBLICATION_DIGEST_HIGHLIGHT_LIMIT,
    );
  });

  it("stores only public content field names, not before and after bodies", () => {
    const digest = buildSchedulePublicationDigest({
      added: [],
      removed: [],
      moved: [],
      visibility: [],
      content: [
        {
          sessionId: "session-one",
          title: "One",
          fields: [
            {
              field: "description",
              before: "private old body",
              after: "private new body",
            },
          ],
        },
      ],
    });
    expect(digest.highlights.content).toEqual([
      {
        sessionId: "session-one",
        title: "One",
        fields: ["description"],
      },
    ]);
    expect(JSON.stringify(digest)).not.toContain("private old body");
    expect(JSON.stringify(digest)).not.toContain("private new body");
  });
});
