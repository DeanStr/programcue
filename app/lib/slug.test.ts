import { describe, expect, it } from "vitest";

import { canonicalSlugOnBlur, sanitizeSlugInput, slugify } from "~/lib/slug";

describe("slugify", () => {
  it("normalises names into lowercase single-hyphen slugs", () => {
    expect(slugify("  Future of Events: 2027!  ")).toBe(
      "future-of-events-2027",
    );
  });

  it("transliterates decomposable accented characters", () => {
    expect(slugify("Café Montréal")).toBe("cafe-montreal");
  });

  it("trims at a complete slug boundary", () => {
    expect(slugify("A useful event name", { maximumLength: 10 })).toBe(
      "a-useful-e",
    );
    expect(slugify("Event---", { maximumLength: 6 })).toBe("event");
  });

  it("leaves the value empty when no compatible characters remain", () => {
    expect(slugify("会議")).toBe("");
    expect(slugify("🎤🎉")).toBe("");
  });
});

describe("sanitizeSlugInput", () => {
  it("preserves a trailing separator while the person is still typing", () => {
    expect(sanitizeSlugInput("My event-")).toBe("my-event-");
    expect(sanitizeSlugInput("My event-n")).toBe("my-event-n");
  });

  it("still removes leading and repeated separators", () => {
    expect(sanitizeSlugInput("---My---event---")).toBe("my-event-");
    expect(slugify("---My---event---")).toBe("my-event");
  });

  it("can preserve a valid custom identifier without imposing a suggestion limit", () => {
    const customSlug = `custom-${"segment-".repeat(20)}link`;
    expect(sanitizeSlugInput(customSlug, { maximumLength: null })).toBe(
      customSlug,
    );
    expect(canonicalSlugOnBlur(customSlug, false, { maximumLength: 80 })).toBe(
      customSlug,
    );
    expect(canonicalSlugOnBlur("conference-", false)).toBe("conference");
    expect(canonicalSlugOnBlur("Derived slug-", true)).toBe("derived-slug");
  });
});
