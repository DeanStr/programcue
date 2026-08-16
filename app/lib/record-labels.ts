/**
 * Readable renderings for stored record shapes that surface in operator views.
 *
 * Diff tables, operation metadata and audit rows are read by event operators,
 * not by whoever wrote the schema. Column keys arrive as `snake_case` or
 * `camelCase` identifiers and values arrive as raw JSON, both of which force
 * the reader to decode storage conventions before they can read the change.
 */
export function fieldLabel(key: string) {
  const spaced = key
    .replaceAll("_", " ")
    .replace(/([a-z\d])([A-Z])/gu, "$1 $2")
    .toLowerCase()
    .trim();
  return spaced.replace(/^./u, (letter) => letter.toUpperCase());
}

/** A stored value as a short phrase, with "Empty" standing in for no value. */
export function fieldValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "Empty";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number")
    return new Intl.NumberFormat("en").format(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value))
    return value.length ? value.map(fieldValue).join(", ") : "Empty";
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${fieldLabel(key)}: ${fieldValue(item)}`)
      .join(" · ");
  return String(value);
}
