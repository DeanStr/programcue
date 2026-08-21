import { describe, expect, it } from "vitest";

import { composeScheduleReviewPreviewHeaders } from "./schedule-review-preview-http";

describe("schedule review preview headers", () => {
  it("keeps error-specific headers while overlaying the confidential preview policy", () => {
    const headers = composeScheduleReviewPreviewHeaders(
      new Headers({
        "retry-after": "12",
        allow: "GET, HEAD, POST",
        "cache-control": "public, max-age=60",
      }),
    );
    expect(headers.get("retry-after")).toBe("12");
    expect(headers.get("allow")).toBe("GET, HEAD, POST");
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
  });
});
