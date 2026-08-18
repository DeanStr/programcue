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
  programmeAccentCssVars,
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
  kicker,
  className = "",
  children,
}: {
  title: string;
  kicker?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={`public-site-section ${className}`.trim()}>
      <div className="public-site-section-heading">
        {kicker ? <p className="public-site-section-kicker">{kicker}</p> : null}
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

function PublicVenueDetails({
  venueLabel,
  venueAddress,
  venueMapUrl,
  preview,
}: {
  venueLabel: string | undefined;
  venueAddress: string | null | undefined;
  venueMapUrl: string | null | undefined;
  preview: boolean;
}) {
  return (
    <div className="public-site-venue">
      <div className="public-site-venue-place">
        <MapPin aria-hidden />
        <div>
          {venueLabel && venueLabel !== venueAddress?.trim() ? (
            <strong>{venueLabel}</strong>
          ) : null}
          {venueAddress ? <address>{venueAddress}</address> : null}
        </div>
      </div>
      {venueMapUrl ? (
        <PreviewSafeLink
          className="btn primary public-site-map-link"
          href={venueMapUrl}
          preview={preview}
        >
          Open map <ExternalLink aria-hidden size={13} />
        </PreviewSafeLink>
      ) : null}
    </div>
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
  const glanceQuiet = statistics.some(
    (item) =>
      (item.label === "speakers" && item.value <= 3) ||
      (item.label === "sessions" && item.value <= 8),
  );

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
      <HomeSection
        title="Featured speakers"
        kicker="The people on stage"
        className="public-site-speakers"
      >
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
                <span className="public-site-speaker-profile-cue">
                  View profile
                </span>
              </span>
            </PreviewSafeLink>
          ))}
        </div>
      </HomeSection>
    ),
    featured_sessions: (
      <HomeSection
        title="Featured sessions"
        kicker="Start here"
        className={`public-site-sessions${
          featuredSessions.length <= 2 ? " is-pair" : ""
        }`}
      >
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
                {session.speakerNames.length ? (
                  <small className="public-site-feature-who">
                    {session.speakerNames.join(" · ")}
                  </small>
                ) : null}
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
        className={`public-site-statistics-section${
          glanceQuiet ? " is-quiet" : ""
        }`}
      >
        {glanceQuiet ? (
          <p className="public-site-glance-line">
            {statistics
              .map((statistic) => `${statistic.value} ${statistic.label}`)
              .join(" · ")}
          </p>
        ) : (
          <dl className="public-site-statistics">
            {statistics.map((statistic) => (
              <div key={statistic.label}>
                <dt>{statistic.label}</dt>
                <dd>{statistic.value}</dd>
              </div>
            ))}
          </dl>
        )}
      </HomeSection>
    ),
    venue: (
      <HomeSection title="Venue" className="public-site-venue-section">
        <PublicVenueDetails
          preview={preview}
          venueAddress={event.venueAddress}
          venueLabel={venueLabel}
          venueMapUrl={event.venueMapUrl}
        />
      </HomeSection>
    ),
    faq: (
      <HomeSection
        title="Frequently asked questions"
        kicker="Before you arrive"
        className={`public-site-faq-section${
          configuration.faqItems.length <= 3 ? " is-interview" : ""
        }`}
      >
        <div className="public-site-faq">
          {configuration.faqItems.map((item, index) => (
            <details
              key={item.id}
              open={
                configuration.faqItems.length <= 3 && index === 1
                  ? true
                  : undefined
              }
            >
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
        <HomeSection
          title="Supported by"
          className={`public-site-sponsor-strip${
            configuration.sponsors.some((sponsor) => sponsor.logoUrl)
              ? ""
              : " is-credits"
          }`}
        >
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
                {sponsor.tier ? <small>{sponsor.tier}</small> : null}
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
        <PublicVenueDetails
          preview={preview}
          venueAddress={event.venueAddress}
          venueLabel={publicVenueLabel(event)}
          venueMapUrl={event.venueMapUrl}
        />
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
      style={programmeAccentCssVars(palette) as CSSProperties}
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
