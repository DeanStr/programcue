import { describe, expect, it } from "vitest";
import { PublishedPublicSiteInvariantError } from "./public-site-errors";
import {
  publishedSocialCardAccent,
  socialCardSvg,
  wrapSocialCardText,
} from "./social-card-image";

describe("social card markup", () => {
  it("wraps words onto at most three lines", () => {
    expect(wrapSocialCardText("Future of Events 2027", 10)).toEqual([
      "Future of",
      "Events",
      "2027",
    ]);
    expect(
      wrapSocialCardText("x".repeat(80), 30).every((line) => line.length <= 30),
    ).toBe(true);
    expect(
      wrapSocialCardText("未来のイベント国際会議2027", 4).join(""),
    ).toContain("…");
    const emojiLines = wrapSocialCardText("👨‍👩‍👧‍👦".repeat(8), 2);
    expect(emojiLines.every((line) => !line.includes("\uFFFD"))).toBe(true);
    expect(emojiLines.join("")).toContain("…");
  });

  it("rejects an invalid published accent", () => {
    expect(() => publishedSocialCardAccent("copper")).toThrow(
      PublishedPublicSiteInvariantError,
    );
  });

  it("escapes event copy in the authored SVG", () => {
    const svg = socialCardSvg({
      title: `Talks & "ideas" <here>`,
      subtitle: "Venue > Hall",
      eyebrow: "Future & Co",
      footer: "PUBLIC EVENT",
      accent: "#4f46e5",
    });
    expect(svg).toContain("Talks &amp; &quot;ideas&quot; &lt;here&gt;");
    expect(svg).toContain("Venue &gt; Hall");
    expect(svg).toContain("Future &amp; Co");
    expect(svg).toContain('fill="#4f46e5"');
    expect(svg).not.toContain("<here>");
  });
});
