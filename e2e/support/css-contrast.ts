/* WCAG 2 contrast for colours read off a rendered page. Chromium serialises
   `color-mix()` as `color(srgb …)` with 0–1 channels; `getComputedStyle`
   colour and `rgb()` stay 0–255. Treating every number as 0–255 made mixed
   stops look near-black and blessed any light text. */

function srgbChannel(value: number) {
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
}

function relativeLuminance(red: number, green: number, blue: number) {
  return (
    srgbChannel(red) * 0.2126 +
    srgbChannel(green) * 0.7152 +
    srgbChannel(blue) * 0.0722
  );
}

export function parseCssColourChannels(
  value: string,
): [number, number, number] {
  const trimmed = value.trim();
  const srgb = trimmed.match(
    /^color\(\s*srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*[\d.]+)?\s*\)$/iu,
  );
  if (srgb) {
    return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3])];
  }
  const rgb = trimmed.match(
    /^rgba?\(\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)\s*[, ]\s*([\d.]+)(%?)(?:\s*[,/]\s*[\d.]+\s*%?)?\s*\)$/iu,
  );
  if (rgb) {
    const channel = (index: number, percentFlag: number) => {
      const amount = Number(rgb[index]);
      return rgb[percentFlag] === "%" ? amount / 100 : amount / 255;
    };
    return [channel(1, 2), channel(3, 4), channel(5, 6)];
  }
  const hex = trimmed.match(/^#([0-9a-f]{6})$/iu);
  if (hex) {
    const digits = hex[1];
    return [1, 3, 5].map(
      (start) => Number.parseInt(digits.slice(start - 1, start + 1), 16) / 255,
    ) as [number, number, number];
  }
  throw new Error(`Unsupported CSS colour: ${value}`);
}

export function cssColourContrastRatio(left: string, right: string) {
  const [leftRed, leftGreen, leftBlue] = parseCssColourChannels(left);
  const [rightRed, rightGreen, rightBlue] = parseCssColourChannels(right);
  const lighter = Math.max(
    relativeLuminance(leftRed, leftGreen, leftBlue),
    relativeLuminance(rightRed, rightGreen, rightBlue),
  );
  const darker = Math.min(
    relativeLuminance(leftRed, leftGreen, leftBlue),
    relativeLuminance(rightRed, rightGreen, rightBlue),
  );
  return (lighter + 0.05) / (darker + 0.05);
}
