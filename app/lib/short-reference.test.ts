import { describe, expect, it } from "vitest";

import { shortReference } from "./short-reference";

describe("shortReference", () => {
  it("uses the entire composite identifier", () => {
    const first = shortReference(
      "evt-foe-2025.session-opening.person-speaker@calendar.programcue.app",
    );
    const second = shortReference(
      "evt-foe-2025.session-closing.person-speaker@calendar.programcue.app",
    );

    expect(first).toMatch(/^[A-F0-9]{10}$/u);
    expect(second).toMatch(/^[A-F0-9]{10}$/u);
    expect(first).not.toBe(second);
  });

  it("is stable for prefixed operation identifiers", () => {
    const identifier =
      "ai-review-assessment:0f1f937d-bc55-4501-b4df-1a8fccab229d";

    expect(shortReference(identifier)).toBe(shortReference(identifier));
  });

  it("returns null when no usable identifier is provided", () => {
    expect(shortReference(null)).toBeNull();
    expect(shortReference("   ")).toBeNull();
  });
});
