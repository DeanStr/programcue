import { describe, expect, it } from "vitest";

import {
  externalEmbedPresentation,
  externalGoogleMapFromQuery,
  externalVideoEmbedFromUrl,
  parseResourceEmbedProviders,
  ResourceEmbedConfigurationError,
  ResourceEmbedInputError,
  resourceEmbedConfiguration,
  resourceEmbedFrameOrigins,
} from "./resource-embed-policy";

describe("resource external embed policy", () => {
  it("accepts only explicit provider identifiers and derives exact frame origins", () => {
    expect(parseResourceEmbedProviders("none")).toEqual([]);
    expect(parseResourceEmbedProviders("youtube,vimeo,google_maps")).toEqual([
      "youtube",
      "vimeo",
      "google_maps",
    ]);
    expect(resourceEmbedFrameOrigins("youtube,vimeo,google_maps")).toEqual([
      "https://www.youtube-nocookie.com",
      "https://player.vimeo.com",
      "https://www.google.com",
    ]);
    expect(() => parseResourceEmbedProviders("youtube,youtube")).toThrow(
      ResourceEmbedConfigurationError,
    );
    expect(() => parseResourceEmbedProviders("youtube,docs")).toThrow(
      ResourceEmbedConfigurationError,
    );
  });

  it("requires a valid credential whenever Google Maps is enabled", () => {
    expect(() =>
      resourceEmbedConfiguration({
        RESOURCE_EMBED_PROVIDERS: "google_maps",
      }),
    ).toThrow("GOOGLE_MAPS_EMBED_API_KEY is unavailable or invalid");
    expect(
      resourceEmbedConfiguration({
        RESOURCE_EMBED_PROVIDERS: "youtube,vimeo",
      }),
    ).toEqual({
      enabledProviders: ["youtube", "vimeo"],
      googleMapsApiKey: null,
    });
  });

  it.each([
    "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    "https://youtu.be/dQw4w9WgXcQ?t=42",
    "https://www.youtube.com/shorts/dQw4w9WgXcQ",
    "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
  ])("normalises supported YouTube links: %s", (url) => {
    expect(externalVideoEmbedFromUrl(url, ["youtube"])).toEqual({
      provider: "youtube",
      videoId: "dQw4w9WgXcQ",
      sourceUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    });
  });

  it.each([
    "https://vimeo.com/123456789/AbC123xy",
    "https://player.vimeo.com/video/123456789?h=AbC123xy",
    "https://vimeo.com/channels/staffpicks/123456789?h=AbC123xy",
    "https://vimeo.com/groups/documentary/videos/123456789?h=AbC123xy",
    "https://vimeo.com/showcase/456/video/123456789?h=AbC123xy",
  ])("normalises supported Vimeo links: %s", (url) => {
    expect(externalVideoEmbedFromUrl(url, ["vimeo"])).toEqual({
      provider: "vimeo",
      videoId: "123456789",
      privacyHash: "AbC123xy",
      sourceUrl: "https://vimeo.com/123456789/AbC123xy",
    });
  });

  it("rejects lookalike, insecure, malformed and disabled video links", () => {
    for (const url of [
      "https://youtube.example/watch?v=dQw4w9WgXcQ",
      "http://youtu.be/dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ/extra",
      "https://www.youtube.com/embed/dQw4w9WgXcQ/extra",
      "https://vimeo.com/not-a-video",
      "https://player.vimeo.com/not-video/123456789",
      "https://vimeo.com/123456789/AbC123xy/extra",
    ]) {
      expect(() =>
        externalVideoEmbedFromUrl(url, ["youtube", "vimeo"]),
      ).toThrow(ResourceEmbedInputError);
    }
    expect(() =>
      externalVideoEmbedFromUrl("https://youtu.be/dQw4w9WgXcQ", ["vimeo"]),
    ).toThrow("not enabled");
    expect(
      externalVideoEmbedFromUrl("https://vimeo.com/channels/123/456", [
        "vimeo",
      ]),
    ).toEqual({
      provider: "vimeo",
      videoId: "456",
      sourceUrl: "https://vimeo.com/456",
    });
  });

  it("builds Google Maps place and search URLs from bounded text, never share URLs", () => {
    const map = externalGoogleMapFromQuery(
      { mode: "place", query: "Barbican Centre, London" },
      ["google_maps"],
    );
    const presentation = externalEmbedPresentation(map, {
      enabledProviders: ["google_maps"],
      googleMapsApiKey: "test-google-maps-embed-key-1234567890",
    });
    expect(presentation.embedUrl).toContain(
      "https://www.google.com/maps/embed/v1/place?",
    );
    expect(presentation.embedUrl).toContain("q=Barbican+Centre%2C+London");
    expect(presentation.sourceUrl).not.toContain("key=");
    expect(() =>
      externalGoogleMapFromQuery(
        { mode: "place", query: "https://maps.app.goo.gl/example" },
        ["google_maps"],
      ),
    ).toThrow("rather than a Google Maps URL");
    for (const query of [
      "maps.app.goo.gl/example",
      "www.google.com/maps/place/Barbican+Centre",
      "goo.gl/maps/example",
    ]) {
      expect(() =>
        externalGoogleMapFromQuery({ mode: "place", query }, ["google_maps"]),
      ).toThrow("rather than a Google Maps URL");
    }
  });
});
