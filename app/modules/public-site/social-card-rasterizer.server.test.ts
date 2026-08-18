import { describe, expect, it } from "vitest";
import { socialCardFontBuffers } from "./social-card-fonts";
import { socialCardSvg } from "./social-card-image";
import {
  inspectSocialCardSvg,
  rasterizeSocialCardSvg,
} from "./social-card-rasterizer.server";

function pixelAt(
  pixels: Uint8Array,
  width: number,
  x: number,
  y: number,
): [number, number, number] {
  const index = (y * width + x) * 4;
  return [pixels[index] ?? 0, pixels[index + 1] ?? 0, pixels[index + 2] ?? 0];
}

function isNear(
  actual: [number, number, number],
  expected: [number, number, number],
  tolerance = 24,
) {
  return actual.every(
    (channel, index) => Math.abs(channel - (expected[index] ?? 0)) <= tolerance,
  );
}

function countNear(
  pixels: Uint8Array,
  width: number,
  expected: [number, number, number],
  x0: number,
  y0: number,
  x1: number,
  y1: number,
) {
  let count = 0;
  for (let y = y0; y <= y1; y += 1) {
    for (let x = x0; x <= x1; x += 1) {
      if (isNear(pixelAt(pixels, width, x, y), expected, 40)) count += 1;
    }
  }
  return count;
}

describe("social card fonts", () => {
  it("decodes the Inter Regular and ExtraBold TTF buffers", () => {
    const fonts = socialCardFontBuffers();
    expect(fonts).toHaveLength(2);
    expect(fonts[0]?.byteLength).toBe(411640);
    expect(fonts[1]?.byteLength).toBe(421796);
    expect(
      fonts.every((font) => [...font.slice(0, 4)].join() === "0,1,0,0"),
    ).toBe(true);
  });
});

describe("social card rasterizer", () => {
  it("rasterizes authored SVG to a 1200x630 PNG with text and accent", async () => {
    const svg = socialCardSvg({
      title: "HHHHHHHHHH",
      subtitle: "A published public event",
      eyebrow: "12 May 2027",
      footer: "PUBLIC EVENT",
      accent: "#4f46e5",
    });
    const image = await inspectSocialCardSvg(svg);
    expect(image.width).toBe(1200);
    expect(image.height).toBe(630);
    const png = new Uint8Array(image.png);
    expect(png[0]).toBe(0x89);
    expect(String.fromCharCode(png[1] ?? 0, png[2] ?? 0, png[3] ?? 0)).toBe(
      "PNG",
    );
    expect(
      isNear(pixelAt(image.pixels, image.width, 20, 20), [17, 28, 27]),
    ).toBe(true);
    expect(
      isNear(pixelAt(image.pixels, image.width, 79, 300), [79, 70, 229]),
    ).toBe(true);
    expect(
      countNear(image.pixels, image.width, [255, 255, 255], 122, 180, 500, 235),
    ).toBeGreaterThan(200);
    expect(
      countNear(image.pixels, image.width, [201, 212, 210], 122, 100, 400, 130),
    ).toBeGreaterThan(20);
    const served = await rasterizeSocialCardSvg(svg);
    expect(served.png.byteLength).toBe(image.png.byteLength);
    expect("pixels" in served).toBe(false);
  });

  it("paints a heavier title at weight 800 than at 400", async () => {
    const title = (weight: number) =>
      `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
        <rect width="1200" height="630" fill="#111c1b"/>
        <text x="122" y="235" fill="#ffffff" font-family="Inter" font-size="64" font-weight="${weight}">HHHHHHHHHH</text>
      </svg>`;
    const [regular, extraBold] = await Promise.all([
      inspectSocialCardSvg(title(400)),
      inspectSocialCardSvg(title(800)),
    ]);
    const regularCoverage = countNear(
      regular.pixels,
      regular.width,
      [255, 255, 255],
      122,
      180,
      700,
      235,
    );
    const extraBoldCoverage = countNear(
      extraBold.pixels,
      extraBold.width,
      [255, 255, 255],
      122,
      180,
      700,
      235,
    );
    expect(regularCoverage).toBeGreaterThan(200);
    expect(extraBoldCoverage).toBeGreaterThan(regularCoverage * 1.15);
  });
});
