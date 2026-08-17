import { describe, expect, it } from "vitest";

import { cssColourContrastRatio, parseCssColourChannels } from "./css-contrast";

describe("css colour contrast", () => {
  it("reads color(srgb) as 0–1 channels, not 0–255", () => {
    expect(
      parseCssColourChannels("color(srgb 0.350275 0.196078 0.143216)"),
    ).toEqual([0.350275, 0.196078, 0.143216]);
    expect(parseCssColourChannels("rgb(89, 50, 37)")[0]).toBeCloseTo(
      89 / 255,
      5,
    );
    expect(
      cssColourContrastRatio(
        "color(srgb 0.350275 0.196078 0.143216)",
        "rgb(242, 245, 244)",
      ),
    ).toBeGreaterThan(8);
    expect(
      cssColourContrastRatio(
        "color(srgb 0.350275 0.196078 0.143216)",
        "rgb(242, 245, 244)",
      ),
    ).toBeLessThan(12);
  });

  it("rejects an unparsed colour instead of treating it as black", () => {
    expect(() => parseCssColourChannels("lab(50% 0 0)")).toThrow(
      /unsupported css colour/i,
    );
  });
});
