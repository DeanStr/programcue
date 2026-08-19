export function sanitizeSlugInput(
  value: string,
  options: { maximumLength?: number | null } = {},
) {
  const sanitized = value
    .toLocaleLowerCase("en")
    .replaceAll("ß", "ss")
    .replaceAll("æ", "ae")
    .replaceAll("œ", "oe")
    .replaceAll("ø", "o")
    .replaceAll("ł", "l")
    .replaceAll("đ", "d")
    .replaceAll("þ", "th")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-/gu, "");
  return options.maximumLength === null
    ? sanitized
    : sanitized.slice(0, options.maximumLength ?? 80);
}

export function slugify(
  value: string,
  options: { maximumLength?: number } = {},
) {
  return sanitizeSlugInput(value, options).replace(/-$/gu, "");
}

export function canonicalSlugOnBlur(
  value: string,
  derived: boolean,
  options: { maximumLength?: number } = {},
) {
  return derived ? slugify(value, options) : value.replace(/-+$/gu, "");
}
