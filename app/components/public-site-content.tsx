import {
  CalendarDays,
  ExternalLink,
  MapPin,
  Play,
  UsersRound,
} from "lucide-react";
import type { ReactNode } from "react";

import { RestrictedMarkdown } from "~/components/restricted-markdown";
import { publicSpeakerProfilePath } from "~/modules/programme/programme-presentation";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import type { PublishedPublicSiteSnapshot } from "~/modules/public-site/public-site";
import { PublishedPublicSiteInvariantError } from "~/modules/public-site/public-site-errors";
import { resolvePublicSitePresentation } from "~/modules/public-site/public-site-presentation";
import type { PublishedPublicSite } from "~/modules/public-site/public-site-service.server";

function dayCount(start: string, end: string) {
  return (
    Math.round(
      (Date.parse(`${end}T12:00:00Z`) - Date.parse(`${start}T12:00:00Z`)) /
        86_400_000,
    ) + 1
  );
}

function HomeSection({
  title,
  className = "",
  children,
}: {
  title: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`public-site-section ${className}`.trim()}>
      <div className="public-site-section-heading">
        <h2>{title}</h2>
      </div>
      {children}
    </section>
  );
}

function PreviewSafeLink({
  href,
  preview,
  className,
  children,
}: {
  href: string;
  preview: boolean;
  className?: string;
  children: ReactNode;
}) {
  return preview ? (
    <div className={className}>{children}</div>
  ) : (
    <a className={className} href={href} rel="noreferrer">
      {children}
    </a>
  );
}

export function PublicSiteHome({
  programme,
  site,
  preview = false,
}: {
  programme: PublishedProgramme;
  site:
    | PublishedPublicSite
    | {
        configuration: PublishedPublicSiteSnapshot;
        recordings: PublishedPublicSite["recordings"];
      };
  preview?: boolean;
}) {
  const { configuration } = site;
  let presentation: ReturnType<typeof resolvePublicSitePresentation>;
  try {
    presentation = resolvePublicSitePresentation(configuration, programme);
  } catch (error) {
    if (preview && error instanceof PublishedPublicSiteInvariantError) {
      return (
        <div className="validation-item warn" role="status">
          {error.message}
        </div>
      );
    }
    throw error;
  }
  const { featuredSpeakers, featuredSessions, venueLabel } = presentation;
  const tracks = new Set(
    programme.sessions.flatMap((session) =>
      session.track ? [session.track] : [],
    ),
  );
  const statistics = [
    configuration.statisticVisibility.sessions
      ? { value: programme.sessions.length, label: "sessions" }
      : null,
    configuration.statisticVisibility.speakers
      ? { value: programme.speakers.length, label: "speakers" }
      : null,
    configuration.statisticVisibility.tracks
      ? { value: tracks.size, label: "tracks" }
      : null,
    configuration.statisticVisibility.days
      ? {
          value: dayCount(programme.event.startDate, programme.event.endDate),
          label: "event days",
        }
      : null,
  ].filter((item): item is { value: number; label: string } => item !== null);

  const sections: Record<
    (typeof configuration.sectionOrder)[number],
    React.ReactNode
  > = {
    introduction: (
      <HomeSection title={configuration.introductionHeading}>
        <p className="public-site-lede">{programme.event.description}</p>
        <div className="public-site-actions">
          {programme.event.applicationUrl ? (
            <PreviewSafeLink
              className="btn primary"
              href={programme.event.applicationUrl}
              preview={preview}
            >
              Apply to speak
            </PreviewSafeLink>
          ) : null}
          <PreviewSafeLink
            className="btn"
            href={`/public/programme/${encodeURIComponent(programme.event.slug)}/sessions`}
            preview={preview}
          >
            Explore the programme
          </PreviewSafeLink>
          {programme.event.supportUrl ? (
            <PreviewSafeLink
              className="btn"
              href={programme.event.supportUrl}
              preview={preview}
            >
              Event help <ExternalLink aria-hidden size={13} />
            </PreviewSafeLink>
          ) : null}
        </div>
      </HomeSection>
    ),
    featured_speakers: (
      <HomeSection title="Featured speakers">
        <div className="public-site-feature-grid">
          {featuredSpeakers.map((speaker) => (
            <PreviewSafeLink
              className="public-site-feature-card"
              href={publicSpeakerProfilePath(programme.event.slug, speaker.id)}
              key={speaker.id}
              preview={preview}
            >
              {speaker.imageUrl ? (
                <img src={speaker.imageUrl} alt="" />
              ) : (
                <UsersRound aria-hidden />
              )}
              <span>
                <strong>{speaker.displayName}</strong>
                <small>
                  {[speaker.jobTitle, speaker.organisationName]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
            </PreviewSafeLink>
          ))}
        </div>
      </HomeSection>
    ),
    featured_sessions: (
      <HomeSection title="Featured sessions">
        <div className="public-site-feature-grid sessions">
          {featuredSessions.map((session) => (
            <article className="public-site-feature-card" key={session.id}>
              <CalendarDays aria-hidden />
              <span>
                <strong>{session.title}</strong>
                <small>
                  {[session.track, session.format, session.room]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
            </article>
          ))}
        </div>
      </HomeSection>
    ),
    statistics: (
      <HomeSection title="At a glance">
        <dl className="public-site-statistics">
          {statistics.map((statistic) => (
            <div key={statistic.label}>
              <dt>{statistic.label}</dt>
              <dd>{statistic.value}</dd>
            </div>
          ))}
        </dl>
      </HomeSection>
    ),
    venue: (
      <HomeSection title="Venue">
        <div className="public-site-venue">
          <MapPin aria-hidden />
          <div>
            {venueLabel !== programme.event.venueAddress?.trim() ? (
              <strong>{venueLabel}</strong>
            ) : null}
            {programme.event.venueAddress ? (
              <address>{programme.event.venueAddress}</address>
            ) : null}
            {programme.event.venueMapUrl ? (
              <PreviewSafeLink
                href={programme.event.venueMapUrl}
                preview={preview}
              >
                Open map <ExternalLink aria-hidden size={13} />
              </PreviewSafeLink>
            ) : null}
          </div>
        </div>
      </HomeSection>
    ),
    faq: (
      <HomeSection title="Frequently asked questions">
        <div className="public-site-faq">
          {configuration.faqItems.map((item) => (
            <details key={item.id}>
              <summary>{item.question}</summary>
              <RestrictedMarkdown>{item.answer}</RestrictedMarkdown>
            </details>
          ))}
        </div>
      </HomeSection>
    ),
  };

  return (
    <div className="public-site-home">
      {configuration.sectionOrder.map((section) =>
        configuration.sectionVisibility[section] ? (
          <div key={section}>{sections[section]}</div>
        ) : null,
      )}
      {configuration.pages.sponsors.enabled && configuration.sponsors.length ? (
        <HomeSection title="Supported by" className="public-site-sponsor-strip">
          <div className="public-site-sponsor-grid">
            {configuration.sponsors.slice(0, 8).map((sponsor) => (
              <PreviewSafeLink
                href={
                  sponsor.websiteUrl ??
                  `/public/programme/${programme.event.slug}/pages/sponsors`
                }
                key={sponsor.id}
                preview={preview}
              >
                {sponsor.logoUrl ? (
                  <img
                    src={sponsor.logoUrl}
                    alt=""
                    referrerPolicy="no-referrer"
                  />
                ) : null}
                <strong>{sponsor.name}</strong>
                <small>{sponsor.tier}</small>
              </PreviewSafeLink>
            ))}
          </div>
        </HomeSection>
      ) : null}
      {configuration.postEvent.enabled && site.recordings.length ? (
        <HomeSection
          title={configuration.postEvent.heading}
          className="public-site-recordings"
        >
          <RestrictedMarkdown>
            {configuration.postEvent.body}
          </RestrictedMarkdown>
          <div className="public-site-feature-grid sessions">
            {site.recordings.map((recording) => (
              <article
                className="public-site-recording-card"
                key={recording.id}
              >
                <a href={recording.recordingUrl} rel="noreferrer">
                  <Play aria-hidden />
                  <span>
                    <strong>{recording.title}</strong>
                    <small>{recording.sessionTitle}</small>
                  </span>
                </a>
                {recording.captionsUrl || recording.transcriptUrl ? (
                  <div className="public-site-recording-resources">
                    {recording.captionsUrl ? (
                      <a href={recording.captionsUrl} rel="noreferrer">
                        Captions
                      </a>
                    ) : null}
                    {recording.transcriptUrl ? (
                      <a href={recording.transcriptUrl} rel="noreferrer">
                        Transcript
                      </a>
                    ) : null}
                  </div>
                ) : null}
              </article>
            ))}
          </div>
        </HomeSection>
      ) : null}
    </div>
  );
}
