import { Heart } from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router";

import {
  type PublicProgrammeSurface,
  publicProgrammeSurfacePath,
} from "~/modules/programme/programme-presentation";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import {
  PUBLIC_EVENT_NAVIGATION_LABELS,
  PUBLIC_SITE_PAGE_TYPES,
  type PublicSitePageType,
  type PublishedPublicSiteSnapshot,
} from "~/modules/public-site/public-site";

type EventNavigationLink = {
  key: string;
  label: string;
  href: string;
  active: boolean;
  routed: boolean;
};

export function PublicEventHeader({
  event,
  programme,
  site,
  activeSurface,
  activePage,
  itinerary,
}: {
  event: PublishedProgramme["event"];
  programme: PublishedProgramme | null;
  site: PublishedPublicSiteSnapshot | null;
  activeSurface?: PublicProgrammeSurface;
  activePage?: PublicSitePageType;
  itinerary?: { shared: boolean; savedCount: number };
}) {
  const mobileNavigationRef = useRef<HTMLDetailsElement>(null);
  const overflowNavigationRef = useRef<HTMLDetailsElement>(null);
  const slug = event.slug;
  const overviewSurface =
    activeSurface === "overview" || activeSurface === "sessions";
  const programmeHref = `/public/programme/${slug}`;
  const homeLink: EventNavigationLink = {
    key: "home",
    label: PUBLIC_EVENT_NAVIGATION_LABELS.home,
    href: programmeHref,
    active: programme
      ? activeSurface === "overview" && !activePage
      : !activePage,
    routed: true,
  };
  const programmePrimaryLinks: EventNavigationLink[] = programme
    ? [
        ...(site ? [homeLink] : []),
        {
          key: "sessions",
          label: PUBLIC_EVENT_NAVIGATION_LABELS.sessions,
          href: site
            ? publicProgrammeSurfacePath(slug, "sessions")
            : overviewSurface
              ? "#programme"
              : `${programmeHref}#programme`,
          active: site
            ? activeSurface === "sessions"
            : Boolean(overviewSurface && !activePage),
          routed: Boolean(site),
        },
        {
          key: "speakers",
          label: PUBLIC_EVENT_NAVIGATION_LABELS.speakers,
          href:
            site || !overviewSurface
              ? publicProgrammeSurfacePath(slug, "speakers")
              : "#speakers",
          active: activeSurface === "speakers",
          routed: Boolean(site || !overviewSurface),
        },
      ]
    : [homeLink];
  const programmeOverflowLinks: EventNavigationLink[] = programme
    ? (["agenda", "schedule", "gallery"] as const).map((surface) => ({
        key: surface,
        label: PUBLIC_EVENT_NAVIGATION_LABELS[surface],
        href: publicProgrammeSurfacePath(slug, surface),
        active: activeSurface === surface,
        routed: true,
      }))
    : [];
  const pageLinks: EventNavigationLink[] = PUBLIC_SITE_PAGE_TYPES.flatMap(
    (page) => {
      const configuration = site?.pages[page];
      return configuration?.enabled
        ? [
            {
              key: `page-${page}`,
              label: configuration.navigationLabel,
              href: `/public/programme/${encodeURIComponent(slug)}/pages/${encodeURIComponent(page)}`,
              active: activePage === page,
              routed: true,
            },
          ]
        : [];
    },
  );
  const overflowLinks = [...programmeOverflowLinks, ...pageLinks];
  const links = [...programmePrimaryLinks, ...overflowLinks];
  const activeOverflowLink = overflowLinks.find((link) => link.active);
  const itineraryHref = overviewSurface
    ? "#itinerary"
    : `${programmeHref}#itinerary`;

  function navigationLink(link: EventNavigationLink, onActivate?: () => void) {
    return link.routed ? (
      <Link
        key={link.key}
        to={link.href}
        className={link.active ? "active" : undefined}
        aria-current={link.active ? "page" : undefined}
        onClick={onActivate}
      >
        {link.label}
      </Link>
    ) : (
      <a
        key={link.key}
        href={link.href}
        className={link.active ? "active" : undefined}
        aria-current={link.active ? "page" : undefined}
        onClick={onActivate}
      >
        {link.label}
      </a>
    );
  }

  return (
    <header className="public-top">
      <Link
        aria-label={`${event.name} event home`}
        className="brand"
        to={programmeHref}
      >
        {event.logoUrl ? (
          <img className="public-event-logo" src={event.logoUrl} alt="" />
        ) : (
          <span className="public-brand-mark" aria-hidden="true" />
        )}
        <span className="public-brand-name">{event.name}</span>
      </Link>
      <nav
        className="public-nav"
        aria-label={site ? "Event navigation" : "Programme"}
      >
        {programmePrimaryLinks.map((link) => navigationLink(link))}
        {overflowLinks.length ? (
          <details className="public-nav-overflow" ref={overflowNavigationRef}>
            <summary
              className={activeOverflowLink ? "active" : undefined}
              aria-label={
                activeOverflowLink
                  ? `Browse, current page ${activeOverflowLink.label}`
                  : "Browse programme and event pages"
              }
            >
              Browse
            </summary>
            <div className="public-nav-overflow-panel">
              {overflowLinks.map((link) =>
                navigationLink(link, () =>
                  overflowNavigationRef.current?.removeAttribute("open"),
                ),
              )}
            </div>
          </details>
        ) : null}
      </nav>
      <details className="public-mobile-nav" ref={mobileNavigationRef}>
        <summary className="btn small">Browse</summary>
        <nav aria-label={site ? "Event navigation" : "Programme sections"}>
          {links.map((link) =>
            navigationLink(link, () =>
              mobileNavigationRef.current?.removeAttribute("open"),
            ),
          )}
        </nav>
      </details>
      {itinerary ? (
        <a className="btn public-itinerary-link" href={itineraryHref}>
          <Heart aria-hidden="true" size={15} />
          <span>
            {itinerary.shared
              ? PUBLIC_EVENT_NAVIGATION_LABELS.sharedItinerary
              : PUBLIC_EVENT_NAVIGATION_LABELS.itinerary}
          </span>
          <span className="status info">{itinerary.savedCount}</span>
        </a>
      ) : null}
    </header>
  );
}

export function PublicEventFooter({
  event,
  programme,
}: {
  event: PublishedProgramme["event"];
  programme: PublishedProgramme | null;
}) {
  const published = programme
    ? new Intl.DateTimeFormat("en", {
        dateStyle: "long",
        timeZone: event.timezone,
      }).format(new Date(programme.version.publishedAt * 1_000))
    : null;
  return (
    <footer className="public-footer">
      <div>
        <p className="public-footer-primary">
          Event dates and times use {event.timezone}.
        </p>
        <p className="public-footer-secondary">
          {programme
            ? `Programme version ${programme.version.versionNumber} · published ${published}`
            : `${event.startDate}${event.startDate === event.endDate ? "" : ` – ${event.endDate}`}`}
        </p>
      </div>
      <div className="public-footer-actions">
        {programme ? (
          <a
            className="btn small"
            href={`/api/v1/public/events/${encodeURIComponent(event.slug)}/calendar.ics`}
          >
            Add to calendar (.ics)
          </a>
        ) : null}
        <p className="public-footer-secondary">Powered by Program Cue</p>
      </div>
    </footer>
  );
}
