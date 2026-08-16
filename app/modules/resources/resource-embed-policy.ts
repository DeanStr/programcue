import { z } from "zod";

export const resourceEmbedProviderValues = [
  "youtube",
  "vimeo",
  "google_maps",
] as const;

export type ResourceEmbedProvider =
  (typeof resourceEmbedProviderValues)[number];

export type ExternalEmbed =
  | {
      provider: "youtube";
      videoId: string;
      sourceUrl: string;
    }
  | {
      provider: "vimeo";
      videoId: string;
      privacyHash?: string;
      sourceUrl: string;
    }
  | {
      provider: "google_maps";
      mode: "place" | "search";
      query: string;
    };

export type ResourceEmbedConfiguration = {
  enabledProviders: ResourceEmbedProvider[];
  googleMapsApiKey: string | null;
};

export type ResourceEmbedPresentation = {
  provider: ResourceEmbedProvider;
  providerLabel: string;
  contentLabel: string;
  loadLabel: string;
  unavailableLabel: string;
  sourceUrl: string;
  sourceLabel: string;
  embedUrl: string | null;
  aspectRatio: "16 / 9" | "4 / 3";
  sandbox: string;
  allow: string;
  referrerPolicy: "strict-origin-when-cross-origin";
  enabled: boolean;
};

const providerSet = new Set<string>(resourceEmbedProviderValues);
const youtubeVideoId = /^[A-Za-z0-9_-]{11}$/u;
const vimeoVideoId = /^\d{1,12}$/u;
const vimeoPrivacyHash = /^[A-Za-z0-9]{6,64}$/u;
const googleMapsApiKey = /^[A-Za-z0-9_-]{20,200}$/u;

const externalEmbedSchema = z.discriminatedUnion("provider", [
  z
    .object({
      provider: z.literal("youtube"),
      videoId: z.string().regex(youtubeVideoId),
      sourceUrl: z.string().url().max(500),
    })
    .strict(),
  z
    .object({
      provider: z.literal("vimeo"),
      videoId: z.string().regex(vimeoVideoId),
      privacyHash: z.string().regex(vimeoPrivacyHash).optional(),
      sourceUrl: z.string().url().max(500),
    })
    .strict(),
  z
    .object({
      provider: z.literal("google_maps"),
      mode: z.enum(["place", "search"]),
      query: z
        .string()
        .trim()
        .min(3, "Enter a venue, address or map search.")
        .max(300)
        .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
          message: "The map query contains unsupported control characters.",
        }),
    })
    .strict(),
]);

const frameOrigins: Record<ResourceEmbedProvider, string> = {
  youtube: "https://www.youtube-nocookie.com",
  vimeo: "https://player.vimeo.com",
  google_maps: "https://www.google.com",
};

export class ResourceEmbedConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceEmbedConfigurationError";
  }
}

export class ResourceEmbedInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResourceEmbedInputError";
  }
}

function configuredGoogleMapsKey(raw: unknown) {
  if (typeof raw !== "string" || !raw.trim()) return null;
  const value = raw.trim();
  return googleMapsApiKey.test(value) ? value : null;
}

export function parseResourceEmbedProviders(
  raw: unknown,
): ResourceEmbedProvider[] {
  if (typeof raw !== "string" || !raw.trim()) {
    throw new ResourceEmbedConfigurationError(
      "RESOURCE_EMBED_PROVIDERS must be configured explicitly.",
    );
  }
  const configured = raw.trim();
  if (configured === "none") return [];
  const requested = configured.split(",").map((value) => value.trim());
  if (
    requested.some((value) => !value || !providerSet.has(value)) ||
    requested.length > resourceEmbedProviderValues.length
  ) {
    throw new ResourceEmbedConfigurationError(
      'RESOURCE_EMBED_PROVIDERS must be "none" or a comma-separated selection of youtube, vimeo and google_maps.',
    );
  }
  if (new Set(requested).size !== requested.length) {
    throw new ResourceEmbedConfigurationError(
      "RESOURCE_EMBED_PROVIDERS cannot contain duplicate providers.",
    );
  }
  return requested as ResourceEmbedProvider[];
}

export function resourceEmbedConfiguration(environment: {
  RESOURCE_EMBED_PROVIDERS?: unknown;
  GOOGLE_MAPS_EMBED_API_KEY?: unknown;
}): ResourceEmbedConfiguration {
  const enabledProviders = parseResourceEmbedProviders(
    environment.RESOURCE_EMBED_PROVIDERS,
  );
  const googleMapsApiKey = configuredGoogleMapsKey(
    environment.GOOGLE_MAPS_EMBED_API_KEY,
  );
  if (enabledProviders.includes("google_maps") && !googleMapsApiKey) {
    throw new ResourceEmbedConfigurationError(
      "Google Maps embeds are enabled, but GOOGLE_MAPS_EMBED_API_KEY is unavailable or invalid.",
    );
  }
  return { enabledProviders, googleMapsApiKey };
}

export function resourceEmbedFrameOrigins(rawProviders: unknown) {
  return parseResourceEmbedProviders(rawProviders).map(
    (provider) => frameOrigins[provider],
  );
}

function canonicalYoutubeSourceUrl(videoId: string) {
  return `https://www.youtube.com/watch?v=${videoId}`;
}

function canonicalVimeoSourceUrl(videoId: string, privacyHash?: string) {
  return `https://vimeo.com/${videoId}${privacyHash ? `/${privacyHash}` : ""}`;
}

export function parseExternalEmbed(raw: unknown): ExternalEmbed {
  const result = externalEmbedSchema.safeParse(raw);
  if (!result.success) {
    throw new ResourceEmbedInputError(
      result.error.issues[0]?.message ??
        "The external video or map block is invalid.",
    );
  }
  const embed = result.data;
  if (
    embed.provider === "youtube" &&
    embed.sourceUrl !== canonicalYoutubeSourceUrl(embed.videoId)
  ) {
    throw new ResourceEmbedInputError(
      "The saved YouTube link does not match its video identifier.",
    );
  }
  if (
    embed.provider === "vimeo" &&
    embed.sourceUrl !==
      canonicalVimeoSourceUrl(embed.videoId, embed.privacyHash)
  ) {
    throw new ResourceEmbedInputError(
      "The saved Vimeo link does not match its video identifier.",
    );
  }
  return embed;
}

function httpsUrl(raw: unknown) {
  if (typeof raw !== "string") return null;
  try {
    const url = new URL(raw.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    return url;
  } catch {
    return null;
  }
}

function youtubeEmbed(url: URL): ExternalEmbed | null {
  const hostname = url.hostname.toLowerCase();
  let videoId = "";
  if (hostname === "youtu.be" || hostname === "www.youtu.be") {
    const path = url.pathname.split("/").filter(Boolean);
    if (path.length !== 1) return null;
    videoId = path[0] ?? "";
  } else if (
    [
      "youtube.com",
      "www.youtube.com",
      "m.youtube.com",
      "music.youtube.com",
      "youtube-nocookie.com",
      "www.youtube-nocookie.com",
    ].includes(hostname)
  ) {
    const path = url.pathname.split("/").filter(Boolean);
    if (
      path.length === 2 &&
      (path[0] === "embed" || path[0] === "shorts" || path[0] === "live")
    )
      videoId = path[1] ?? "";
    else if (url.pathname === "/watch") videoId = url.searchParams.get("v") ?? "";
  }
  if (!youtubeVideoId.test(videoId)) return null;
  return {
    provider: "youtube",
    videoId,
    sourceUrl: canonicalYoutubeSourceUrl(videoId),
  };
}

function vimeoEmbed(url: URL): ExternalEmbed | null {
  const hostname = url.hostname.toLowerCase();
  if (
    !["vimeo.com", "www.vimeo.com", "player.vimeo.com"].includes(hostname)
  )
    return null;
  const path = url.pathname.split("/").filter(Boolean);
  let videoId: string | undefined;
  let pathHash: string | undefined;
  if (hostname === "player.vimeo.com") {
    if (path[0] !== "video" || !vimeoVideoId.test(path[1] ?? "")) return null;
    if (path.length > 2) return null;
    videoId = path[1];
  } else if (vimeoVideoId.test(path[0] ?? "") && path.length <= 2) {
    videoId = path[0];
    pathHash = path[1];
  } else if (
    path[0] === "channels" &&
    path.length === 3 &&
    path[1] &&
    vimeoVideoId.test(path[2] ?? "")
  ) {
    videoId = path[2];
  } else if (
    path[0] === "groups" &&
    path[1] &&
    path[2] === "videos" &&
    path.length === 4 &&
    vimeoVideoId.test(path[3] ?? "")
  ) {
    videoId = path[3];
  } else if (
    ["album", "showcase"].includes(path[0] ?? "") &&
    path[1] &&
    path[2] === "video" &&
    path.length === 4 &&
    vimeoVideoId.test(path[3] ?? "")
  ) {
    videoId = path[3];
  } else {
    return null;
  }
  if (!videoId) return null;
  const queryHash = url.searchParams.get("h") ?? undefined;
  if (pathHash && queryHash && pathHash !== queryHash) return null;
  const requestedHash = queryHash ?? pathHash;
  const privacyHash = requestedHash
    ? vimeoPrivacyHash.test(requestedHash)
      ? requestedHash
      : null
    : undefined;
  if (requestedHash && !privacyHash) return null;
  return {
    provider: "vimeo",
    videoId,
    ...(privacyHash ? { privacyHash } : {}),
    sourceUrl: canonicalVimeoSourceUrl(videoId, privacyHash ?? undefined),
  };
}

function looksLikeMapUrl(value: string) {
  const query = value.trim();
  if (/^[a-z][a-z\d+.-]*:\/\//iu.test(query)) return true;
  return /^(?:(?:www\.)?google\.[a-z.]+\/maps(?:[/?#]|$)|maps\.google\.[a-z.]+(?:[/?#]|$)|maps\.app\.goo\.gl(?:[/?#]|$)|goo\.gl\/maps(?:[/?#]|$))/iu.test(
    query,
  );
}

export function externalVideoEmbedFromUrl(
  raw: unknown,
  enabledProviders: readonly ResourceEmbedProvider[],
) {
  const url = httpsUrl(raw);
  if (!url) {
    throw new ResourceEmbedInputError(
      "Paste a complete HTTPS YouTube or Vimeo link.",
    );
  }
  const embed = youtubeEmbed(url) ?? vimeoEmbed(url);
  if (!embed) {
    throw new ResourceEmbedInputError(
      "That link is not a supported YouTube or Vimeo video. Add it as a normal link instead.",
    );
  }
  if (!enabledProviders.includes(embed.provider)) {
    throw new ResourceEmbedInputError(
      `${embed.provider === "youtube" ? "YouTube" : "Vimeo"} video embeds are not enabled for this deployment. Add the video as a normal link instead.`,
    );
  }
  return embed;
}

export function externalGoogleMapFromQuery(
  raw: { mode?: unknown; query?: unknown },
  enabledProviders: readonly ResourceEmbedProvider[],
): ExternalEmbed {
  if (!enabledProviders.includes("google_maps")) {
    throw new ResourceEmbedInputError(
      "Google Maps embeds are not enabled for this deployment. Add the map as a normal link instead.",
    );
  }
  if (typeof raw.query === "string" && looksLikeMapUrl(raw.query)) {
    throw new ResourceEmbedInputError(
      "Enter a venue, address or search rather than a Google Maps URL.",
    );
  }
  return parseExternalEmbed({
    provider: "google_maps",
    mode: raw.mode,
    query: raw.query,
  });
}

export function assertExternalEmbedEnabled(
  embed: ExternalEmbed,
  configuration: ResourceEmbedConfiguration,
) {
  if (!configuration.enabledProviders.includes(embed.provider)) {
    throw new ResourceEmbedInputError(
      `${providerLabel(embed.provider)} embeds are no longer enabled. Remove this block or add the content as a normal link.`,
    );
  }
  if (
    embed.provider === "google_maps" &&
    !configuration.googleMapsApiKey
  ) {
    throw new ResourceEmbedConfigurationError(
      "Google Maps embeds are enabled, but GOOGLE_MAPS_EMBED_API_KEY is unavailable or invalid.",
    );
  }
}

export function providerLabel(provider: ResourceEmbedProvider) {
  if (provider === "youtube") return "YouTube";
  if (provider === "vimeo") return "Vimeo";
  return "Google Maps";
}

export function externalEmbedPresentation(
  embed: ExternalEmbed,
  configuration: ResourceEmbedConfiguration,
): ResourceEmbedPresentation {
  const enabled = configuration.enabledProviders.includes(embed.provider);
  if (embed.provider === "youtube") {
    return {
      provider: embed.provider,
      providerLabel: "YouTube",
      contentLabel: "YouTube video",
      loadLabel: "Load video from YouTube",
      unavailableLabel: "This YouTube video is currently disabled.",
      sourceUrl: canonicalYoutubeSourceUrl(embed.videoId),
      sourceLabel: "Open on YouTube",
      embedUrl: enabled
        ? `https://www.youtube-nocookie.com/embed/${embed.videoId}`
        : null,
      aspectRatio: "16 / 9",
      sandbox: "allow-scripts allow-same-origin",
      allow:
        "accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen",
      referrerPolicy: "strict-origin-when-cross-origin",
      enabled,
    };
  }
  if (embed.provider === "vimeo") {
    const hash = embed.privacyHash
      ? `?h=${encodeURIComponent(embed.privacyHash)}`
      : "";
    return {
      provider: embed.provider,
      providerLabel: "Vimeo",
      contentLabel: "Vimeo video",
      loadLabel: "Load video from Vimeo",
      unavailableLabel: "This Vimeo video is currently disabled.",
      sourceUrl: canonicalVimeoSourceUrl(embed.videoId, embed.privacyHash),
      sourceLabel: "Open on Vimeo",
      embedUrl: enabled
        ? `https://player.vimeo.com/video/${embed.videoId}${hash}`
        : null,
      aspectRatio: "16 / 9",
      sandbox: "allow-scripts allow-same-origin",
      allow: "autoplay; fullscreen; picture-in-picture",
      referrerPolicy: "strict-origin-when-cross-origin",
      enabled,
    };
  }
  const sourceUrl = new URL("https://www.google.com/maps/search/");
  sourceUrl.searchParams.set("api", "1");
  sourceUrl.searchParams.set("query", embed.query);
  if (enabled && !configuration.googleMapsApiKey) {
    throw new ResourceEmbedConfigurationError(
      "Google Maps embeds are enabled, but GOOGLE_MAPS_EMBED_API_KEY is unavailable or invalid.",
    );
  }
  const embedUrl = enabled
    ? new URL(`https://www.google.com/maps/embed/v1/${embed.mode}`)
    : null;
  if (embedUrl) {
    embedUrl.searchParams.set("key", configuration.googleMapsApiKey!);
    embedUrl.searchParams.set("q", embed.query);
  }
  return {
    provider: embed.provider,
    providerLabel: "Google Maps",
    contentLabel: `Map of ${embed.query}`,
    loadLabel: "Load map from Google Maps",
    unavailableLabel: "This Google map is currently disabled.",
    sourceUrl: sourceUrl.toString(),
    sourceLabel: "Open in Google Maps",
    embedUrl: embedUrl?.toString() ?? null,
    aspectRatio: "4 / 3",
    sandbox: "allow-scripts allow-same-origin allow-popups",
    allow: "fullscreen",
    referrerPolicy: "strict-origin-when-cross-origin",
    enabled,
  };
}
