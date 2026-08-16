import { Heart } from "lucide-react";
import { useRef } from "react";
import { Link } from "react-router";

import {
  type PublicProgrammeSurface,
  publicProgrammeSurfacePath,
} from "~/modules/programme/programme-presentation";
import type { PublishedProgramme } from "~/modules/programme/public-programme-types";
import {
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
  programme,
  site,
  activeSurface,
  activePage,
  itinerary,
}: {
  programme: PublishedProgramme;
  site: PublishedPublicSiteSnapshot | null;
  activeSurface?: PublicProgrammeSurface;
  activePage?: PublicSitePageType;
  itinerary?: { shared: boolean; savedCount: number };
}) {
  const mobileNavigationRef = useRef<HTMLDetailsElement>(null);
  const slug = programme.event.slug;
  const overviewSurface =
    activeSurface === "overview" || activeSurface === "sessions";
  const programmeHref = `/public/programme/${slug}`;
  const links: EventNavigationLink[] = [
    {
      key: "sessions",
      label: "All sessions",
      href: overviewSurface ? "#programme" : `${programmeHref}#programme`,
      active: Boolean(overviewSurface && !activePage),
      routed: false,
    },
    {
      key: "speakers",
      label: "Speakers",
      href: overviewSurface
        ? "#speakers"
        : publicProgrammeSurfacePath(slug, "speakers"),
      active: activeSurface === "speakers",
      routed: false,
    },
    ...(["agenda", "schedule", "gallery"] as const).map((surface) => ({
      key: surface,
      label:
        surface === "agenda"
          ? "Day agenda"
          : surface === "schedule"
            ? "Full schedule"
            : "Speaker Gallery",
      href: publicProgrammeSurfacePath(slug, surface),
      active: activeSurface === surface,
      routed: true,
    })),
    ...PUBLIC_SITE_PAGE_TYPES.flatMap((page) => {
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
    }),
  ];
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
        aria-label={`${programme.event.name} programme`}
        className="brand"
        to={programmeHref}
      >
        {programme.event.logoUrl ? (
          <img
            className="public-event-logo"
            src={programme.event.logoUrl}
            alt=""
          />
        ) : (
          <span className="public-brand-mark" aria-hidden="true" />
        )}
        <span className="public-brand-name">{programme.event.name}</span>
      </Link>
      <nav className="public-nav" aria-label="Programme">
        {links.map((link) => navigationLink(link))}
      </nav>
      <details className="public-mobile-nav" ref={mobileNavigationRef}>
        <summary className="btn small">Browse</summary>
        <nav aria-label="Programme sections">
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
          <span>{itinerary.shared ? "Shared itinerary" : "My itinerary"}</span>
          <span className="status info">{itinerary.savedCount}</span>
        </a>
      ) : null}
    </header>
  );
}

export function PublicEventFooter({
  programme,
}: {
  programme: PublishedProgramme;
}) {
  const published = new Intl.DateTimeFormat("en", {
    dateStyle: "long",
    timeZone: programme.event.timezone,
  }).format(new Date(programme.version.publishedAt * 1_000));
  return (
    <footer className="public-footer">
      <div>
        <p className="public-footer-primary">
          All times shown in {programme.event.timezone}.
        </p>
        <p className="public-footer-secondary">
          Programme version {programme.version.versionNumber} · published{" "}
          {published}
        </p>
      </div>
      <div className="public-footer-actions">
        <a
          className="btn small"
          href={`/api/v1/public/events/${encodeURIComponent(programme.event.slug)}/calendar.ics`}
        >
          Add to calendar (.ics)
        </a>
        <p className="public-footer-secondary">Powered by Program Cue</p>
      </div>
    </footer>
  );
}
