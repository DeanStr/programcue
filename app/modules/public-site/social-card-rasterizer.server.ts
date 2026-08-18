import { Resvg } from "@cf-wasm/resvg/workerd";

import { socialCardFontBuffers } from "./social-card-fonts";
import { SOCIAL_CARD_HEIGHT, SOCIAL_CARD_WIDTH } from "./social-card-image";

export class SocialCardRasterizeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SocialCardRasterizeError";
  }
}

export type RasterizedSocialCard = {
  png: ArrayBuffer;
  width: number;
  height: number;
};

export type InspectedSocialCard = RasterizedSocialCard & {
  pixels: Uint8Array;
};

async function renderSocialCardSvg(svg: string, includePixels: boolean) {
  const resvg = await Resvg.async(svg, {
    fitTo: { mode: "original" },
    font: {
      fontBuffers: socialCardFontBuffers(),
      defaultFontFamily: "Inter",
      sansSerifFamily: "Inter",
    },
  });
  if (resvg.width !== SOCIAL_CARD_WIDTH || resvg.height !== SOCIAL_CARD_HEIGHT)
    throw new SocialCardRasterizeError(
      "Social card rasterizer returned unexpected dimensions.",
    );
  const image = resvg.render();
  try {
    if (
      image.width !== SOCIAL_CARD_WIDTH ||
      image.height !== SOCIAL_CARD_HEIGHT
    )
      throw new SocialCardRasterizeError(
        "Social card rasterizer returned unexpected dimensions.",
      );
    const png = image.asPng();
    if (png.byteLength < 1)
      throw new SocialCardRasterizeError(
        "Social card rasterizer returned an empty image.",
      );
    const pngBytes = new ArrayBuffer(png.byteLength);
    new Uint8Array(pngBytes).set(png);
    return includePixels
      ? {
          png: pngBytes,
          width: image.width,
          height: image.height,
          pixels: new Uint8Array(image.pixels),
        }
      : {
          png: pngBytes,
          width: image.width,
          height: image.height,
        };
  } finally {
    image.free();
    resvg.free();
  }
}

async function rasterize(svg: string, includePixels: boolean) {
  try {
    return await renderSocialCardSvg(svg, includePixels);
  } catch (error) {
    if (error instanceof SocialCardRasterizeError) throw error;
    throw new SocialCardRasterizeError(
      "The social card SVG could not be rasterized.",
      { cause: error },
    );
  }
}

export async function rasterizeSocialCardSvg(
  svg: string,
): Promise<RasterizedSocialCard> {
  const rendered = await rasterize(svg, false);
  return {
    png: rendered.png,
    width: rendered.width,
    height: rendered.height,
  };
}

export async function inspectSocialCardSvg(
  svg: string,
): Promise<InspectedSocialCard> {
  const rendered = await rasterize(svg, true);
  if (!rendered.pixels)
    throw new SocialCardRasterizeError(
      "Social card rasterizer returned no pixel buffer.",
    );
  return {
    png: rendered.png,
    width: rendered.width,
    height: rendered.height,
    pixels: rendered.pixels,
  };
}
