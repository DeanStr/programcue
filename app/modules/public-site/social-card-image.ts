import { PublishedPublicSiteInvariantError } from "./public-site-errors";

export const SOCIAL_CARD_WIDTH = 1200;
export const SOCIAL_CARD_HEIGHT = 630;

export function publishedSocialCardAccent(value: string) {
  if (!/^#[0-9a-f]{6}$/iu.test(value))
    throw new PublishedPublicSiteInvariantError(
      "The published event brand accent is invalid.",
    );
  return value;
}

function graphemes(value: string) {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [
      ...new Intl.Segmenter("en", { granularity: "grapheme" }).segment(value),
    ].map((part) => part.segment);
  }
  return [...value];
}

function graphemeLength(value: string) {
  return graphemes(value).length;
}

function breakLongToken(token: string, maximum: number) {
  const units = graphemes(token);
  if (units.length <= maximum) return [token];
  const pieces: string[] = [];
  for (let index = 0; index < units.length; index += maximum) {
    pieces.push(units.slice(index, index + maximum).join(""));
  }
  return pieces;
}

export function wrapSocialCardText(value: string, maximum = 34) {
  const tokens = value
    .trim()
    .split(/\s+/u)
    .flatMap((word) => breakLongToken(word, maximum));
  const lines: string[] = [];
  let line = "";
  for (const token of tokens) {
    if (line && graphemeLength(`${line} ${token}`) > maximum) {
      lines.push(line);
      line = token;
    } else {
      line = line ? `${line} ${token}` : token;
    }
  }
  if (line) lines.push(line);
  if (lines.length <= 3) return lines;
  const kept = lines.slice(0, 3);
  const last = kept[2] ?? "";
  const lastUnits = graphemes(last);
  kept[2] =
    lastUnits.length >= maximum
      ? `${lastUnits.slice(0, Math.max(1, maximum - 1)).join("")}…`
      : `${last}…`;
  return kept;
}

function xml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

export function socialCardSvg(input: {
  title: string;
  subtitle: string;
  eyebrow: string;
  footer: string;
  accent: string;
}) {
  const titleLines = wrapSocialCardText(input.title, 30);
  const subtitleLines = wrapSocialCardText(input.subtitle, 58);
  const accent = xml(publishedSocialCardAccent(input.accent));
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SOCIAL_CARD_WIDTH}" height="${SOCIAL_CARD_HEIGHT}" viewBox="0 0 ${SOCIAL_CARD_WIDTH} ${SOCIAL_CARD_HEIGHT}">
    <rect width="${SOCIAL_CARD_WIDTH}" height="${SOCIAL_CARD_HEIGHT}" fill="#111c1b"/>
    <circle cx="1080" cy="-20" r="320" fill="${accent}" opacity="0.28"/>
    <rect x="72" y="68" width="14" height="494" rx="7" fill="${accent}"/>
    <text x="122" y="126" fill="#c9d4d2" font-family="Inter" font-size="30" font-weight="650">${xml(input.eyebrow)}</text>
    ${titleLines.map((line, index) => `<text x="122" y="${235 + index * 76}" fill="#ffffff" font-family="Inter" font-size="64" font-weight="800">${xml(line)}</text>`).join("")}
    ${subtitleLines.map((line, index) => `<text x="122" y="${445 + index * 42}" fill="#c9d4d2" font-family="Inter" font-size="30">${xml(line)}</text>`).join("")}
    <text x="122" y="570" fill="${accent}" font-family="Inter" font-size="24" font-weight="700">${xml(input.footer)}</text>
  </svg>`;
}
