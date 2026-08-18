import { describe, expect, it } from "vitest";

import {
  formatSpeakerXHandleInput,
  speakerLinkedinUrlSchema,
  speakerXHandleSchema,
} from "./speaker-schema";

describe("speaker social profile normalization", () => {
  it("canonicalizes supported LinkedIn inputs to HTTPS", () => {
    expect(
      speakerLinkedinUrlSchema.parse("http://www.linkedin.com/in/priya-shah"),
    ).toBe("https://www.linkedin.com/in/priya-shah");
    expect(speakerLinkedinUrlSchema.parse("linkedin.com/in/priya-shah")).toBe(
      "https://linkedin.com/in/priya-shah",
    );
  });

  it("rejects unsupported LinkedIn hosts instead of rewriting them", () => {
    expect(() =>
      speakerLinkedinUrlSchema.parse("https://example.com/linkedin-profile"),
    ).toThrow("Enter a full https://www.linkedin.com profile URL.");
  });

  it("accepts handles and complete X or Twitter profile URLs", () => {
    expect(speakerXHandleSchema.parse("@priya_shah")).toBe("priya_shah");
    expect(speakerXHandleSchema.parse("https://x.com/priya_shah")).toBe(
      "priya_shah",
    );
    expect(
      speakerXHandleSchema.parse("http://www.twitter.com/priya_shah/"),
    ).toBe("priya_shah");
    expect(formatSpeakerXHandleInput("https://x.com/priya_shah")).toBe(
      "@priya_shah",
    );
  });

  it("rejects unsupported X URLs and malformed handles", () => {
    expect(() =>
      speakerXHandleSchema.parse("https://x.com/priya_shah/status/123"),
    ).toThrow(
      "Enter an X handle or a complete x.com or twitter.com profile URL.",
    );
    expect(() => speakerXHandleSchema.parse("invalid handle")).toThrow(
      "Enter an X handle or a complete x.com or twitter.com profile URL.",
    );
    expect(() => speakerXHandleSchema.parse("https://x.com/home")).toThrow(
      "Enter an X handle or a complete x.com or twitter.com profile URL.",
    );
    expect(() => speakerXHandleSchema.parse("https://x.com/intent")).toThrow(
      "Enter an X handle or a complete x.com or twitter.com profile URL.",
    );
    expect(() => speakerXHandleSchema.parse("@settings")).toThrow(
      "Enter an X handle or a complete x.com or twitter.com profile URL.",
    );
  });
});
