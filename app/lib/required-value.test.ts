import { describe, expect, it } from "vitest";

import { requireValue } from "./required-value";

describe("requireValue", () => {
  it("preserves defined falsy values", () => {
    expect(requireValue(0, "missing number")).toBe(0);
    expect(requireValue(false, "missing boolean")).toBe(false);
    expect(requireValue("", "missing string")).toBe("");
  });

  it.each([null, undefined])("rejects an absent value", (value) => {
    expect(() => requireValue(value, "required value is unavailable")).toThrow(
      "required value is unavailable",
    );
  });
});
