const maximumResourceEmbedOrigins = 16;

export class ResourceEmbedConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceEmbedConfigurationError";
  }
}

export class ResourceEmbedUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceEmbedUrlError";
  }
}

function exactHttpsOrigin(raw: string) {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResourceEmbedConfigurationError(
      "Resource embed origins must be absolute HTTPS origins.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new ResourceEmbedConfigurationError(
      "Resource embed origins must be exact HTTPS origins without credentials, paths, queries or fragments.",
    );
  }
  return url.origin;
}

export function parseResourceEmbedOrigins(raw: unknown): string[] {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ResourceEmbedConfigurationError(
      "RESOURCE_EMBED_ORIGINS must be configured explicitly.",
    );
  }
  if (raw.trim().toLocaleLowerCase() === "none") return [];
  const requested = raw
    .split(",")
    .map((value) => value.trim());
  if (
    !requested.length ||
    requested.some((value) => !value) ||
    requested.length > maximumResourceEmbedOrigins
  ) {
    throw new ResourceEmbedConfigurationError(
      `RESOURCE_EMBED_ORIGINS must contain between 1 and ${maximumResourceEmbedOrigins} exact origins, or "none".`,
    );
  }
  const origins = requested.map(exactHttpsOrigin);
  if (new Set(origins).size !== origins.length) {
    throw new ResourceEmbedConfigurationError(
      "RESOURCE_EMBED_ORIGINS cannot contain duplicate origins.",
    );
  }
  return origins;
}

export function allowedResourceEmbedUrl(
  raw: unknown,
  allowedOrigins: readonly string[],
) {
  if (typeof raw !== "string") {
    throw new ResourceEmbedUrlError(
      "Embedded references must use a supported HTTPS URL.",
    );
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ResourceEmbedUrlError(
      "Embedded references must use a supported HTTPS URL.",
    );
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    !allowedOrigins.includes(url.origin)
  ) {
    throw new ResourceEmbedUrlError(
      `Embedded references from ${url.hostname || "that origin"} are not supported. Use an explicitly approved resource embed origin.`,
    );
  }
  return url.toString();
}
