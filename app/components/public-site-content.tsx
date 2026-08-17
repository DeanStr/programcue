import {
  CalendarDays,
  ExternalLink,
  MapPin,
  Play,
  UsersRound,
} from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

import {
  PublicEventFooter,
  PublicEventHeader,
} from "~/components/public-event-chrome";
import { eventHeroImagePath } from "~/components/public-programme-model";
import { RestrictedMarkdown } from "~/components/restricted-markdown";
import {
  formatProgrammeEventDay,
  programmeAccentPalette,
  publicSessionDetailPath,
  publicSpeakerProfilePath,
} from "~/modules/programme/programme-presentation";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import type {
  PublicSitePageType,
  PublishedPublicSiteSnapshot,
} from "~/modules/public-site/public-site";
import { PublishedPublicSiteInvariantError } from "~/modules/public-site/public-site-errors";
import {
  publicVenueLabel,
  resolvePublicSitePresentation,
} from "~/modules/public-site/public-site-presentation";
import type {
  PublicSiteEvent,
  PublishedPublicSite,
} from "~/modules/public-site/public-site-service.server";

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
  event,
  programme,
  site,
  preview = false,
}: {
  event: PublicSiteEvent;
  programme: PublishedProgramme | null;
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
    presentation = resolvePublicSitePresentation(
      configuration,
      event,
      programme,
    );
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
    (programme?.sessions ?? []).flatMap((session) =>
      session.track ? [session.track] : [],
    ),
  );
  const statistics = [
    configuration.statisticVisibility.sessions
      ? { value: programme?.sessions.length ?? 0, label: "sessions" }
      : null,
    configuration.statisticVisibility.speakers
      ? { value: programme?.speakers.length ?? 0, label: "speakers" }
      : null,
    configuration.statisticVisibility.tracks
      ? { value: tracks.size, label: "tracks" }
      : null,
    configuration.statisticVisibility.days
      ? {
          value: dayCount(event.startDate, event.endDate),
          label: "event days",
        }
      : null,
  ].filter((item): item is { value: number; label: string } => item !== null);

  const sections: Record<
    (typeof configuration.sectionOrder)[number],
    React.ReactNode
  > = {
    introduction: (
      <HomeSection
        title={configuration.introductionHeading}
        className="public-site-introduction"
      >
        <p className="public-site-lede">{event.description}</p>
        <div className="public-site-actions">
          {event.application ? (
            <PreviewSafeLink
              className={`btn${event.application.state === "accepting" ? " primary" : ""}`}
              href={event.application.url}
              preview={preview}
            >
              {event.application.state === "accepting"
                ? "Apply to speak"
                : "View call for speakers"}
            </PreviewSafeLink>
          ) : null}
          {programme ? (
            <PreviewSafeLink
              className="btn"
              href={`/public/programme/${encodeURIComponent(event.slug)}/sessions`}
              preview={preview}
            >
              Explore the programme
            </PreviewSafeLink>
          ) : null}
          {event.supportUrl ? (
            <PreviewSafeLink
              className="btn"
              href={event.supportUrl}
              preview={preview}
            >
              Event help <ExternalLink aria-hidden size={13} />
            </PreviewSafeLink>
          ) : null}
        </div>
      </HomeSection>
    ),
    featured_speakers: (
      <HomeSection title="Featured speakers" className="public-site-speakers">
        <div className="public-site-feature-grid">
          {featuredSpeakers.map((speaker) => (
            <PreviewSafeLink
              className="public-site-feature-card"
              href={publicSpeakerProfilePath(event.slug, speaker.id)}
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
      <HomeSection title="Featured sessions" className="public-site-sessions">
        <div className="public-site-feature-grid sessions">
          {featuredSessions.map((session) => (
            <PreviewSafeLink
              className="public-site-feature-card"
              href={publicSessionDetailPath(event.slug, session.id)}
              key={session.id}
              preview={preview}
            >
              {/* No leading icon: every entry in this list is a session, so a
                  calendar mark on each one repeats what the heading said. The
                  time leads instead, because it is the first thing an attendee
                  needs from a session they are being offered. */}
              <span>
                <small className="public-site-feature-when">
                  {session.when}
                </small>
                <strong>{session.title}</strong>
                <small>
                  {[session.track, session.format, session.room]
                    .filter(Boolean)
                    .join(" · ")}
                </small>
              </span>
            </PreviewSafeLink>
          ))}
        </div>
      </HomeSection>
    ),
    statistics: (
      <HomeSection
        title="At a glance"
        className="public-site-statistics-section"
      >
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
      <HomeSection title="Venue" className="public-site-venue-section">
        <div className="public-site-venue">
          <MapPin aria-hidden />
          <div>
            {venueLabel !== event.venueAddress?.trim() ? (
              <strong>{venueLabel}</strong>
            ) : null}
            {event.venueAddress ? (
              <address>{event.venueAddress}</address>
            ) : null}
            {event.venueMapUrl ? (
              <PreviewSafeLink
                className="public-site-map-link"
                href={event.venueMapUrl}
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
      <HomeSection
        title="Frequently asked questions"
        className="public-site-faq-section"
      >
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
                  `/public/programme/${event.slug}/pages/sponsors`
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

export function PublicSitePageContent({
  event,
  configuration,
  page,
  preview = false,
}: {
  event: PublicSiteEvent;
  configuration: PublishedPublicSiteSnapshot;
  page: PublicSitePageType;
  preview?: boolean;
}) {
  const pageConfiguration = configuration.pages[page];
  if (page === "faq") {
    return (
      <>
        {pageConfiguration.body ? (
          <RestrictedMarkdown>{pageConfiguration.body}</RestrictedMarkdown>
        ) : null}
        <div className="public-site-faq">
          {configuration.faqItems.map((item) => (
            <details key={item.id}>
              <summary>{item.question}</summary>
              <RestrictedMarkdown>{item.answer}</RestrictedMarkdown>
            </details>
          ))}
        </div>
      </>
    );
  }
  if (page === "venue") {
    return (
      <>
        {pageConfiguration.body ? (
          <RestrictedMarkdown>{pageConfiguration.body}</RestrictedMarkdown>
        ) : null}
        <div className="public-site-venue">
          <MapPin aria-hidden />
          <div>
            {publicVenueLabel(event) !== event.venueAddress?.trim() ? (
              <strong>{publicVenueLabel(event)}</strong>
            ) : null}
            {event.venueAddress ? (
              <address>{event.venueAddress}</address>
            ) : null}
            {event.venueMapUrl ? (
              <PreviewSafeLink
                className="public-site-map-link"
                href={event.venueMapUrl}
                preview={preview}
              >
                Open map <ExternalLink aria-hidden size={13} />
              </PreviewSafeLink>
            ) : null}
          </div>
        </div>
      </>
    );
  }
  if (page === "sponsors") {
    const tiers = new Map<string, typeof configuration.sponsors>();
    for (const sponsor of configuration.sponsors) {
      tiers.set(sponsor.tier, [...(tiers.get(sponsor.tier) ?? []), sponsor]);
    }
    return (
      <>
        {pageConfiguration.body ? (
          <RestrictedMarkdown>{pageConfiguration.body}</RestrictedMarkdown>
        ) : null}
        {[...tiers.entries()].map(([tier, sponsors]) => (
          <section className="public-site-sponsor-tier" key={tier}>
            <h2>{tier}</h2>
            <div className="public-site-sponsor-grid">
              {sponsors.map((sponsor) => (
                <div className="public-site-sponsor-card" key={sponsor.id}>
                  {sponsor.logoUrl ? (
                    <img
                      src={sponsor.logoUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                    />
                  ) : null}
                  <strong>{sponsor.name}</strong>
                  {sponsor.description ? (
                    <small>{sponsor.description}</small>
                  ) : null}
                  {sponsor.websiteUrl ? (
                    <PreviewSafeLink
                      className="public-site-sponsor-link"
                      href={sponsor.websiteUrl}
                      preview={preview}
                    >
                      Visit sponsor <ExternalLink aria-hidden size={13} />
                    </PreviewSafeLink>
                  ) : null}
                </div>
              ))}
            </div>
          </section>
        ))}
      </>
    );
  }
  const body =
    pageConfiguration.body ||
    (page === "about" ? (event.description ?? "") : "");
  return <RestrictedMarkdown>{body}</RestrictedMarkdown>;
}

export function PublicEventSiteWorkspace({
  site,
}: {
  site: PublishedPublicSite;
}) {
  const { event, configuration } = site;
  const palette = programmeAccentPalette(event.brandAccent);
  const heroImage = eventHeroImagePath(event);
  const place = [event.venue, event.city].filter(Boolean).join(", ");
  return (
    <div
      className="public-shell event-branded"
      data-public-theme={configuration.theme}
      style={
        {
          "--event-accent": palette.accent,
          "--event-accent-light-ink": palette.ink,
          "--event-accent-on-solid": palette.onAccent,
        } as CSSProperties
      }
    >
      <PublicEventHeader event={event} programme={null} site={configuration} />
      <section
        className={`hero${heroImage ? " has-image" : ""}`}
        style={
          heroImage
            ? ({
                "--hero-image": `url(${JSON.stringify(heroImage)})`,
              } as CSSProperties)
            : undefined
        }
      >
        <div className="hero-body">
          <h1>{event.name}</h1>
          {configuration.tagline ? (
            <p className="public-site-tagline">{configuration.tagline}</p>
          ) : null}
          <p className="hero-meta">
            <span>
              <CalendarDays aria-hidden size={15} />
              <span>
                {formatProgrammeEventDay(event.startDate)}–
                {formatProgrammeEventDay(event.endDate)}
              </span>
            </span>
            {place ? (
              <span>
                <MapPin aria-hidden size={15} />
                <span>{place}</span>
              </span>
            ) : null}
          </p>
        </div>
      </section>
      <main id="main" className="public-main">
        <div className="public-content">
          <PublicSiteHome event={event} programme={null} site={site} />
        </div>
      </main>
      <PublicEventFooter event={event} programme={null} />
    </div>
  );
}
