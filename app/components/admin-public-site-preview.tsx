import { ClipboardCopy, Monitor, Smartphone } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";

import { publicSitePageLabels } from "~/components/admin-public-site-constants";
import {
  PublicSiteHome,
  PublicSitePageContent,
} from "~/components/public-site-content";
import {
  defaultProgrammeEmbedConfiguration,
  programmeEmbedUrl,
  programmeIframeSnippet,
} from "~/modules/programme/programme-embed-configuration";
import { programmeAccentPalette } from "~/modules/programme/programme-presentation";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import {
  PUBLIC_SITE_PAGE_TYPES,
  type PublicSiteDraft,
  type PublicSitePageType,
  type PublishedPublicSiteSnapshot,
} from "~/modules/public-site/public-site";
import type { PublicSiteEvent } from "~/modules/public-site/public-site-service.server";

function PromotionTools({
  origin,
  event,
  programme,
  configuration,
  siteContentRevision,
  siteRevision,
}: {
  origin: string;
  event: PublicSiteEvent;
  programme: PublishedProgramme | null;
  configuration: PublishedPublicSiteSnapshot;
  siteContentRevision: string;
  siteRevision: number;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const { slug, name } = event;
  const publicUrl = `${origin}/public/programme/${encodeURIComponent(slug)}`;
  const embed = programme
    ? programmeIframeSnippet(
        programmeEmbedUrl(origin, slug, defaultProgrammeEmbedConfiguration()),
        `${name} programme`,
        720,
      )
    : null;
  const announcement = `${name} is live. ${configuration.tagline || "Explore event details and updates."} ${publicUrl}`;
  const socialCardUrl = new URL(`${publicUrl}/social-card.webp`);
  socialCardUrl.searchParams.set(
    "v",
    programme
      ? `${programme.contentRevision}-${siteContentRevision}-${siteRevision}`
      : `${siteContentRevision}-${siteRevision}`,
  );

  async function copy(label: string, value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopyStatus(`${label} copied.`);
    } catch {
      setCopyStatus("Copy failed. Select the value and copy it manually.");
    }
  }

  return (
    <section className="card pad public-site-promotion">
      <div className="card-title">
        <div>
          <span className="pc-page-eyebrow">Promotion</span>
          <h2>Announcement handoff</h2>
        </div>
      </div>
      <label className="label">
        Public event URL
        <div className="public-site-copy-row">
          <input className="field" readOnly value={publicUrl} />
          <button
            type="button"
            className="btn small"
            onClick={() => void copy("URL", publicUrl)}
          >
            <ClipboardCopy aria-hidden size={14} /> Copy
          </button>
        </div>
      </label>
      <label className="label mt">
        Suggested announcement
        <textarea className="textarea" readOnly value={announcement} rows={3} />
        <button
          type="button"
          className="btn small mt"
          onClick={() => void copy("announcement", announcement)}
        >
          <ClipboardCopy aria-hidden size={14} /> Copy text
        </button>
      </label>
      {embed ? (
        <label className="label mt">
          Programme embed
          <textarea className="textarea code" readOnly value={embed} rows={5} />
          <button
            type="button"
            className="btn small mt"
            onClick={() => void copy("embed", embed)}
          >
            <ClipboardCopy aria-hidden size={14} /> Copy embed
          </button>
        </label>
      ) : null}
      {programme?.speakers.length ? (
        <details className="public-site-speaker-promotion mt">
          <summary>Speaker promotion links</summary>
          <div>
            {programme.speakers.map((speaker) => {
              const speakerUrl = new URL(publicUrl);
              speakerUrl.searchParams.set("speaker", speaker.id);
              const value = speakerUrl.toString();
              return (
                <div className="public-site-copy-row" key={speaker.id}>
                  <input
                    aria-label={`${speaker.displayName} promotion URL`}
                    className="field"
                    readOnly
                    value={value}
                  />
                  <button
                    type="button"
                    className="btn small"
                    onClick={() => void copy(speaker.displayName, value)}
                  >
                    <ClipboardCopy aria-hidden size={14} /> Copy
                  </button>
                </div>
              );
            })}
          </div>
        </details>
      ) : null}
      <div className="public-site-unfurl mt">
        <img
          src={socialCardUrl.toString()}
          alt="Generated social sharing preview"
        />
        <div>
          <strong>{name}</strong>
          <span>{configuration.tagline || "Published event programme"}</span>
          <small>{publicUrl}</small>
        </div>
      </div>
      {copyStatus ? (
        <p className="help" role="status">
          {copyStatus}
        </p>
      ) : null}
    </section>
  );
}

export function AdminPublicSitePreview({
  configuration,
  draftSponsors,
  programme,
  event,
  eventContentRevision,
  publicOrigin,
  published,
  canPublish,
  onPublish,
}: {
  configuration: PublicSiteDraft;
  draftSponsors: PublishedPublicSiteSnapshot["sponsors"];
  programme: PublishedProgramme | null;
  event: PublicSiteEvent;
  eventContentRevision: string;
  publicOrigin: string;
  published: {
    configuration: PublishedPublicSiteSnapshot;
    revision: number;
  } | null;
  canPublish: boolean;
  onPublish: () => void;
}) {
  const [mobilePreview, setMobilePreview] = useState(false);
  const [previewContent, setPreviewContent] = useState<
    "home" | PublicSitePageType
  >("home");
  const draftPreview = {
    configuration: { ...configuration, sponsors: draftSponsors },
    recordings: [],
  };
  const palette = programmeAccentPalette(event.brandAccent);

  return (
    <div className="public-site-preview-stack">
      <div
        className="branding-preview-toolbar"
        role="toolbar"
        aria-label="Event website preview controls"
      >
        <label className="public-site-preview-content-control">
          <span>Preview</span>
          <select
            className="field"
            aria-label="Preview content"
            value={previewContent}
            onChange={(event) =>
              setPreviewContent(
                event.target.value as "home" | PublicSitePageType,
              )
            }
          >
            <option value="home">Homepage</option>
            {PUBLIC_SITE_PAGE_TYPES.map((page) => (
              <option key={page} value={page}>
                {publicSitePageLabels[page]} page
                {configuration.pages[page].enabled ? "" : " (disabled)"}
              </option>
            ))}
          </select>
        </label>
        <button
          className={!mobilePreview ? "btn small active" : "btn small"}
          type="button"
          aria-pressed={!mobilePreview}
          onClick={() => setMobilePreview(false)}
        >
          <Monitor aria-hidden size={14} /> Desktop
        </button>
        <button
          className={mobilePreview ? "btn small active" : "btn small"}
          type="button"
          aria-pressed={mobilePreview}
          onClick={() => setMobilePreview(true)}
        >
          <Smartphone aria-hidden size={14} /> Mobile
        </button>
      </div>
      <section
        className={`public-site-preview-frame${mobilePreview ? " is-mobile" : ""}`}
        aria-label="Event website preview"
        data-public-theme={configuration.theme}
        // biome-ignore lint/a11y/noNoninteractiveTabindex: This scrollable preview must be keyboard-focusable so users can reach overflow content.
        tabIndex={0}
        style={
          {
            "--event-accent": palette.accent,
            "--event-accent-light-ink": palette.ink,
            "--event-accent-on-solid": palette.onAccent,
          } as CSSProperties
        }
      >
        <header>
          <strong>{event.name}</strong>
          <small>
            {previewContent === "home"
              ? configuration.tagline
              : configuration.pages[previewContent].enabled
                ? `${publicSitePageLabels[previewContent]} page`
                : `${publicSitePageLabels[previewContent]} page · Not enabled for publication`}
          </small>
        </header>
        {previewContent === "home" ? (
          <PublicSiteHome
            event={event}
            programme={programme}
            site={draftPreview}
            preview
          />
        ) : (
          <div className="public-site-page public-site-page-preview">
            <p className="pc-page-eyebrow">{event.name}</p>
            <h1>{configuration.pages[previewContent].title}</h1>
            <PublicSitePageContent
              event={event}
              configuration={draftPreview.configuration}
              page={previewContent}
              preview
            />
          </div>
        )}
      </section>
      <section className="card pad">
        <div>
          <h2>Publish saved website draft</h2>
          <p className="help">
            Publishing snapshots editorial configuration and sponsors. Programme
            data remains canonical.
          </p>
        </div>
        <button
          className="btn primary mt"
          type="button"
          disabled={!canPublish}
          onClick={onPublish}
        >
          Publish event website
        </button>
      </section>
      {published ? (
        <PromotionTools
          origin={publicOrigin}
          event={event}
          programme={programme}
          configuration={published.configuration}
          siteContentRevision={eventContentRevision}
          siteRevision={published.revision}
        />
      ) : null}
    </div>
  );
}
