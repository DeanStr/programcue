import { ClipboardCopy, Monitor, Smartphone } from "lucide-react";
import type { CSSProperties } from "react";
import { useState } from "react";

import { PublicSiteHome } from "~/components/public-site-content";
import {
  defaultProgrammeEmbedConfiguration,
  programmeEmbedUrl,
  programmeIframeSnippet,
} from "~/modules/programme/programme-embed-configuration";
import { programmeAccentPalette } from "~/modules/programme/programme-presentation";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import type {
  PublicSiteDraft,
  PublishedPublicSiteSnapshot,
} from "~/modules/public-site/public-site";

function PromotionTools({
  origin,
  programme,
  configuration,
  siteRevision,
}: {
  origin: string;
  programme: PublishedProgramme;
  configuration: PublishedPublicSiteSnapshot;
  siteRevision: number;
}) {
  const [copyStatus, setCopyStatus] = useState("");
  const { slug, name } = programme.event;
  const publicUrl = `${origin}/public/programme/${encodeURIComponent(slug)}`;
  const embed = programmeIframeSnippet(
    programmeEmbedUrl(origin, slug, defaultProgrammeEmbedConfiguration()),
    `${name} programme`,
    720,
  );
  const announcement = `${name} is live. ${configuration.tagline || "Explore the published programme, speakers and schedule."} ${publicUrl}`;
  const socialCardUrl = new URL(`${publicUrl}/social-card.webp`);
  socialCardUrl.searchParams.set(
    "v",
    `${programme.contentRevision}-${siteRevision}`,
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
      {programme.speakers.length ? (
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
  eventName,
  publicOrigin,
  published,
  canPublish,
  onPublish,
}: {
  configuration: PublicSiteDraft;
  draftSponsors: PublishedPublicSiteSnapshot["sponsors"];
  programme: PublishedProgramme | null;
  eventName: string;
  publicOrigin: string;
  published: {
    configuration: PublishedPublicSiteSnapshot;
    revision: number;
  } | null;
  canPublish: boolean;
  onPublish: () => void;
}) {
  const [mobilePreview, setMobilePreview] = useState(false);
  const draftPreview = programme
    ? {
        configuration: { ...configuration, sponsors: draftSponsors },
        recordings: [],
      }
    : null;
  const palette = programme
    ? programmeAccentPalette(programme.event.brandAccent)
    : null;

  return (
    <div className="public-site-preview-stack">
      <div
        className="branding-preview-toolbar"
        role="toolbar"
        aria-label="Preview viewport"
      >
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
        data-public-theme={configuration.theme}
        style={
          palette
            ? ({
                "--event-accent": palette.accent,
                "--event-accent-light-ink": palette.ink,
                "--event-accent-on-solid": palette.onAccent,
              } as CSSProperties)
            : undefined
        }
      >
        {programme && draftPreview ? (
          <>
            <header>
              <strong>{eventName}</strong>
              <small>{configuration.tagline}</small>
            </header>
            <PublicSiteHome programme={programme} site={draftPreview} preview />
          </>
        ) : (
          <div className="empty-state">
            <strong>Programme required</strong>
            <p>
              Publish a programme to preview referenced speakers, sessions and
              statistics.
            </p>
          </div>
        )}
      </section>
      <section className="card pad">
        <div>
          <h2>Publish saved site draft</h2>
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
          Publish public site
        </button>
      </section>
      {published && programme ? (
        <PromotionTools
          origin={publicOrigin}
          programme={programme}
          configuration={published.configuration}
          siteRevision={published.revision}
        />
      ) : null}
    </div>
  );
}
