import { chromium } from "playwright";

// This is a cache-equivalence bound, never an image-quality score.
export const paintNoiseBound = { pixelLimit: 64, channelDeltaLimit: 4 };

export async function paintDifference(beforeBytes, afterBytes) {
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    return await page.evaluate(
      async ({ images, bound }) => {
        const decoded = await Promise.all(
          images.map(async (data) => {
            const response = await fetch(`data:image/png;base64,${data}`);
            const image = await createImageBitmap(await response.blob());
            const canvas = new OffscreenCanvas(image.width, image.height);
            const context = canvas.getContext("2d");
            context.drawImage(image, 0, 0);
            return {
              width: image.width,
              height: image.height,
              pixels: context.getImageData(0, 0, image.width, image.height).data,
            };
          }),
        );
        const [before, after] = decoded;
        if (before.width !== after.width || before.height !== after.height) return null;
        let changedPixels = 0;
        let maximumChannelDelta = 0;
        for (let index = 0; index < before.pixels.length; index += 4) {
          let delta = 0;
          for (let channel = 0; channel < 4; channel++)
            delta = Math.max(
              delta,
              Math.abs(before.pixels[index + channel] - after.pixels[index + channel]),
            );
          if (delta) changedPixels++;
          maximumChannelDelta = Math.max(maximumChannelDelta, delta);
          if (changedPixels > bound.pixelLimit || maximumChannelDelta > bound.channelDeltaLimit)
            return null;
        }
        return { changedPixels, maximumChannelDelta, ...bound };
      },
      {
        images: [beforeBytes.toString("base64"), afterBytes.toString("base64")],
        bound: paintNoiseBound,
      },
    );
  } finally {
    await browser.close();
  }
}
