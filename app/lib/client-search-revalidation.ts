export function onlyClientSearchParametersChanged(
  currentUrl: URL,
  nextUrl: URL,
  clientOwnedParameters: readonly string[],
) {
  if (
    currentUrl.pathname !== nextUrl.pathname ||
    currentUrl.search === nextUrl.search
  ) {
    return false;
  }

  const serverOwnedSearch = (url: URL) => {
    const search = new URLSearchParams(url.search);
    for (const parameter of clientOwnedParameters) search.delete(parameter);
    search.sort();
    return search.toString();
  };

  return serverOwnedSearch(currentUrl) === serverOwnedSearch(nextUrl);
}

export const PUBLIC_PROGRAMME_CLIENT_SEARCH_PARAMETERS = [
  "query",
  "speakerQuery",
  "galleryQuery",
  "day",
  "track",
  "format",
  "room",
] as const;

export const SCHEDULE_SOURCE_CLIENT_SEARCH_PARAMETERS = ["sourceQuery"] as const;
