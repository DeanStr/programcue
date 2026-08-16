import { ArrowDown, ArrowUp, MapPin, Play, Trash2 } from "lucide-react";
import { useState } from "react";

import {
  replaceResourceDocumentEmbeds,
  resourceDocumentEmbeds,
  type TiptapNode,
} from "~/modules/resources/resource-content";
import {
  externalGoogleMapFromQuery,
  externalVideoEmbedFromUrl,
  providerLabel,
  type ExternalEmbed,
  type ResourceEmbedConfiguration,
} from "~/modules/resources/resource-embed-policy";
import type { ResourceExternalEmbedDraft } from "~/modules/resources/resource-recovery";

function description(embed: ExternalEmbed) {
  if (embed.provider === "youtube" || embed.provider === "vimeo")
    return embed.sourceUrl;
  return `${embed.mode === "place" ? "Place" : "Search"}: ${embed.query}`;
}

export function ResourceExternalEmbedEditor({
  document,
  configuration,
  draft,
  onChange,
  onDraftChange,
}: {
  document: TiptapNode;
  configuration: ResourceEmbedConfiguration;
  draft: ResourceExternalEmbedDraft;
  onChange(document: TiptapNode): void;
  onDraftChange(draft: ResourceExternalEmbedDraft): void;
}) {
  const [error, setError] = useState<string | null>(null);
  const { kind, videoUrl, mapMode, mapQuery } = draft;
  let embeds: ExternalEmbed[] = [];
  let documentError: string | null = null;
  try {
    embeds = resourceDocumentEmbeds(document);
  } catch (caught) {
    documentError =
      caught instanceof Error
        ? caught.message
        : "This draft contains invalid external content.";
  }
  const videosConfigured = configuration.enabledProviders.some((provider) =>
    ["youtube", "vimeo"].includes(provider),
  );
  const mapsConfigured =
    configuration.enabledProviders.includes("google_maps") &&
    Boolean(configuration.googleMapsApiKey);

  function commit(next: readonly ExternalEmbed[]) {
    onChange(replaceResourceDocumentEmbeds(document, next));
    setError(null);
  }

  function addEmbed() {
    try {
      if (embeds.length >= 8)
        throw new Error(
          "A resource can contain at most eight external video or map blocks.",
        );
      if (kind === "video") {
        commit([
          ...embeds,
          externalVideoEmbedFromUrl(videoUrl, configuration.enabledProviders),
        ]);
        onDraftChange({ ...draft, videoUrl: "" });
      } else {
        if (!mapsConfigured)
          throw new Error(
            "Google Maps needs an enabled provider and a configured Embed API key.",
          );
        commit([
          ...embeds,
          externalGoogleMapFromQuery(
            { mode: mapMode, query: mapQuery },
            configuration.enabledProviders,
          ),
        ]);
        onDraftChange({ ...draft, mapQuery: "" });
      }
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "This external content could not be added.",
      );
    }
  }

  function move(index: number, direction: -1 | 1) {
    const next = [...embeds];
    const destination = index + direction;
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    commit(next);
  }

  if (documentError) {
    return (
      <aside className="resource-embed-editor">
        <span className="label">Video or map</span>
        <div className="validation-item error" role="alert">
          <strong>External content needs attention</strong>
          <span>{documentError}</span>
        </div>
        <button
          className="btn danger small"
          type="button"
          onClick={() => commit([])}
        >
          Remove invalid external blocks
        </button>
      </aside>
    );
  }

  return (
    <aside className="resource-embed-editor">
      <input
        type="hidden"
        name="externalEmbedDraft"
        value={kind === "video" ? videoUrl.trim() : mapQuery.trim()}
      />
      <div>
        <span className="label">Video or map</span>
        <div
          className="resource-embed-kind"
          role="group"
          aria-label="External content type"
        >
          <button
            className="btn small"
            type="button"
            aria-pressed={kind === "video"}
            onClick={() => {
              onDraftChange({
                ...draft,
                kind: "video",
                mapQuery: "",
              });
              setError(null);
            }}
          >
            <Play aria-hidden size={15} /> Video
          </button>
          <button
            className="btn small"
            type="button"
            aria-pressed={kind === "map"}
            onClick={() => {
              onDraftChange({
                ...draft,
                kind: "map",
                videoUrl: "",
              });
              setError(null);
            }}
          >
            <MapPin aria-hidden size={15} /> Map
          </button>
        </div>
      </div>

      {kind === "video" ? (
        <label className="label">
          YouTube or Vimeo link
          <input
            className="field"
            type="url"
            value={videoUrl}
            onChange={(event) => {
              onDraftChange({ ...draft, videoUrl: event.target.value });
            }}
            placeholder="https://www.youtube.com/watch?v=…"
            disabled={!videosConfigured}
          />
          {!videosConfigured ? (
            <span className="help">
              YouTube and Vimeo are disabled for this deployment. Add a normal
              link for now.
            </span>
          ) : null}
        </label>
      ) : (
        <>
          <label className="label">
            Map type
            <select
              className="select"
              value={mapMode}
              onChange={(event) =>
                onDraftChange({
                  ...draft,
                  mapMode: event.target.value === "search" ? "search" : "place",
                })
              }
            >
              <option value="place">Venue or address</option>
              <option value="search">Search results</option>
            </select>
          </label>
          <label className="label">
            {mapMode === "place" ? "Venue or address" : "Map search"}
            <input
              className="field"
              value={mapQuery}
              onChange={(event) => {
                onDraftChange({ ...draft, mapQuery: event.target.value });
              }}
              placeholder={
                mapMode === "place"
                  ? "Barbican Centre, London"
                  : "accessible parking near Barbican Centre"
              }
              disabled={!mapsConfigured}
            />
          </label>
          {!mapsConfigured ? (
            <p className="help">
              Google Maps is unavailable until its Embed API key is configured.
              Add a normal link for now.
            </p>
          ) : null}
        </>
      )}

      <button
        className="btn primary small"
        type="button"
        onClick={addEmbed}
        disabled={
          embeds.length >= 8 ||
          (kind === "video"
            ? !videoUrl.trim() || !videosConfigured
            : !mapQuery.trim() || !mapsConfigured)
        }
      >
        Add {kind}
      </button>
      {error ? (
        <div className="validation-item error" role="alert">
          {error}
        </div>
      ) : null}

      {embeds.length ? (
        <ol
          className="resource-embed-list"
          aria-label="External content blocks"
        >
          {embeds.map((embed, index) => (
            <li key={`${embed.provider}:${description(embed)}:${index}`}>
              <span>
                <strong>{providerLabel(embed.provider)}</strong>
                <small>{description(embed)}</small>
              </span>
              <span className="resource-embed-row-actions">
                <button
                  className="btn icon small"
                  type="button"
                  aria-label={`Move ${providerLabel(embed.provider)} block up`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  <ArrowUp aria-hidden size={14} />
                </button>
                <button
                  className="btn icon small"
                  type="button"
                  aria-label={`Move ${providerLabel(embed.provider)} block down`}
                  disabled={index === embeds.length - 1}
                  onClick={() => move(index, 1)}
                >
                  <ArrowDown aria-hidden size={14} />
                </button>
                <button
                  className="btn icon small"
                  type="button"
                  aria-label={`Remove ${providerLabel(embed.provider)} block`}
                  onClick={() =>
                    commit(embeds.filter((_, item) => item !== index))
                  }
                >
                  <Trash2 aria-hidden size={14} />
                </button>
              </span>
            </li>
          ))}
        </ol>
      ) : (
        <p className="help">No external video or map blocks yet.</p>
      )}
      <p className="help">
        Blocks appear after the page content. Speakers choose when to load a
        provider; its ordinary external link always remains available.
      </p>
    </aside>
  );
}
