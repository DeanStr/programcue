export const PUBLIC_PROGRAMME_FACET_PARAMETERS = [
  "day",
  "track",
  "format",
  "room",
] as const;

export type PublicProgrammeFacetParameter =
  (typeof PUBLIC_PROGRAMME_FACET_PARAMETERS)[number];

export function clearUnavailablePublicProgrammeFacets(
  search: URLSearchParams,
  available: Record<PublicProgrammeFacetParameter, readonly string[]>,
) {
  const next = new URLSearchParams(search);
  const cleared: PublicProgrammeFacetParameter[] = [];
  for (const parameter of PUBLIC_PROGRAMME_FACET_PARAMETERS) {
    const requested = next.get(parameter);
    if (requested && !available[parameter].includes(requested)) {
      next.delete(parameter);
      cleared.push(parameter);
    }
  }
  return { search: next, cleared };
}

export function clearedPublicProgrammeFacetMessage(
  cleared: readonly PublicProgrammeFacetParameter[],
) {
  if (!cleared.length) return "";
  const names = cleared.join(", ");
  return `Saved ${names} filter${cleared.length === 1 ? " is" : "s are"} no longer available and ${cleared.length === 1 ? "was" : "were"} cleared.`;
}
