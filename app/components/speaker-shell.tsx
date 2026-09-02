import {
  BookOpen,
  CalendarClock,
  CheckSquare,
  ClipboardList,
  FileStack,
  Home,
  type LucideIcon,
  Mic2,
  MoreHorizontal,
  UserRound,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Form, NavLink, useLocation } from "react-router";

import { BrandMark } from "~/components/brand-mark";
import { Button, ButtonAnchor, ButtonLink } from "~/components/ui/button";
import { PRODUCT_GUIDE_URL } from "~/lib/product-guide";
import { programmeAccentPalette } from "~/modules/programme/programme-presentation";

type ParticipantDestination = {
  id:
    | "overview"
    | "applications"
    | "sessions"
    | "availability"
    | "tasks"
    | "files"
    | "resources"
    | "profile";
  to: string;
  label: string;
  mobileLabel?: string;
  icon: LucideIcon;
};

const participantDestinations = [
  {
    id: "overview",
    to: "/participant/dashboard",
    label: "Overview",
    icon: Home,
  },
  {
    id: "applications",
    to: "/participant/applications",
    label: "Applications",
    mobileLabel: "Apps",
    icon: ClipboardList,
  },
  {
    id: "sessions",
    to: "/participant/sessions",
    label: "My sessions",
    mobileLabel: "Sessions",
    icon: Mic2,
  },
  {
    id: "availability",
    to: "/participant/availability",
    label: "Availability",
    icon: CalendarClock,
  },
  {
    id: "tasks",
    to: "/participant/tasks",
    label: "Tasks",
    icon: CheckSquare,
  },
  {
    id: "files",
    to: "/participant/files",
    label: "Files",
    icon: FileStack,
  },
  {
    id: "resources",
    to: "/participant/resources",
    label: "Resources",
    icon: BookOpen,
  },
  {
    id: "profile",
    to: "/participant/profile",
    label: "Profile",
    icon: UserRound,
  },
] as const satisfies ReadonlyArray<ParticipantDestination>;

function ParticipantDestinationLink({
  destination,
  compact = false,
  onNavigate,
}: {
  destination: ParticipantDestination;
  compact?: boolean;
  onNavigate?: () => void;
}) {
  const Icon = destination.icon;
  const visibleLabel = compact
    ? (destination.mobileLabel ?? destination.label)
    : destination.label;
  const accessibleLabel =
    visibleLabel === destination.label
      ? destination.label
      : `${visibleLabel}: ${destination.label}`;
  return (
    <NavLink
      to={destination.to}
      aria-label={accessibleLabel}
      onClick={onNavigate}
    >
      <Icon aria-hidden size={17} />
      <span>{visibleLabel}</span>
    </NavLink>
  );
}

export function primaryParticipantDestinationIds({
  role,
  hasParticipantApplications,
  hasParticipantSessions,
}: {
  role: string;
  hasParticipantApplications: boolean;
  hasParticipantSessions: boolean;
}): ReadonlyArray<ParticipantDestination["id"]> {
  const hasApplicationWork = role === "submitter" || hasParticipantApplications;
  if (hasApplicationWork && hasParticipantSessions) {
    return ["overview", "applications", "sessions", "tasks"];
  }
  return hasApplicationWork
    ? ["overview", "applications", "tasks", "files"]
    : ["overview", "sessions", "tasks", "files"];
}

export function SpeakerShell({
  children,
  event,
  viewer,
  canManageAvailability = false,
  hasParticipantApplications = false,
  hasParticipantSessions = false,
}: {
  children: React.ReactNode;
  event: {
    name: string;
    dateLabel: string;
    locationLabel: string;
    brandAccent: string;
    participantLogoUrl: string | null;
    participantSupportUrl: string | null;
  };
  viewer: {
    name: string;
    email: string;
    demo: boolean;
    role: string;
  };
  canManageAvailability?: boolean;
  hasParticipantApplications?: boolean;
  hasParticipantSessions?: boolean;
}) {
  const location = useLocation();
  const [moreOpen, setMoreOpen] = useState(false);
  const moreContainerRef = useRef<HTMLDivElement>(null);
  const moreButtonRef = useRef<HTMLButtonElement>(null);
  const name = viewer.name;
  const initials = name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();
  const eventSelectionHref = `/events/select?${new URLSearchParams({
    returnTo: `${location.pathname}${location.search}${location.hash}`,
  })}`;
  const accentPalette = programmeAccentPalette(event.brandAccent);
  const visibleDestinations = participantDestinations.filter(
    (destination) => destination.id !== "availability" || canManageAvailability,
  );
  const primaryDestinationIds = new Set<ParticipantDestination["id"]>(
    primaryParticipantDestinationIds({
      role: viewer.role,
      hasParticipantApplications,
      hasParticipantSessions,
    }),
  );
  const primaryDestinations = visibleDestinations.filter((destination) =>
    primaryDestinationIds.has(destination.id),
  );
  const secondaryDestinations = visibleDestinations.filter(
    (destination) => !primaryDestinationIds.has(destination.id),
  );
  const secondaryRouteActive = secondaryDestinations.some(
    (destination) => location.pathname === destination.to,
  );

  useEffect(() => {
    if (!moreOpen) return;
    const closeForPointerOutside = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !moreContainerRef.current?.contains(event.target)
      ) {
        setMoreOpen(false);
      }
    };
    const closeForEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMoreOpen(false);
      moreButtonRef.current?.focus();
    };
    document.addEventListener("pointerdown", closeForPointerOutside);
    document.addEventListener("keydown", closeForEscape);
    return () => {
      document.removeEventListener("pointerdown", closeForPointerOutside);
      document.removeEventListener("keydown", closeForEscape);
    };
  }, [moreOpen]);

  return (
    <div
      className="speaker-shell event-branded"
      style={
        {
          "--event-accent": accentPalette.accent,
          "--accent-ink": accentPalette.ink,
          "--accent-on-solid": accentPalette.onAccent,
        } as React.CSSProperties
      }
    >
      <header className="speaker-top">
        <NavLink
          aria-label={`${event.name} participant workspace`}
          className="brand"
          to="/participant/dashboard"
          style={{ color: "var(--ink)", padding: 0 }}
        >
          {event.participantLogoUrl ? (
            <img
              className="participant-logo"
              src={event.participantLogoUrl}
              alt={`${event.name} logo`}
              referrerPolicy="no-referrer"
            />
          ) : (
            <BrandMark />
          )}
          <span>Program Cue</span>
        </NavLink>
        {/* Event identity is context, not controls: "Switch event" and support
            are actions, so they sit with the other actions on the right. The
            class name is main's, which its responsive rules already target. */}
        <div className="speaker-event-context">
          <div className="event-title">{event.name}</div>
          <div className="subtle tiny">
            {[event.dateLabel, event.locationLabel].filter(Boolean).join(" · ")}
          </div>
        </div>
        <div className="right">
          <ButtonLink size="small" to={eventSelectionHref} reloadDocument>
            Switch event
          </ButtonLink>
          <ButtonAnchor
            size="small"
            href={PRODUCT_GUIDE_URL}
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Product guide"
          >
            Guide
          </ButtonAnchor>
          {event.participantSupportUrl ? (
            <ButtonAnchor
              size="small"
              href={event.participantSupportUrl}
              target="_blank"
              rel="noreferrer"
            >
              Support
            </ButtonAnchor>
          ) : null}
          <span className="speaker-identity">
            <span className="avatar">{initials}</span>
            <span className="speaker-viewer-identity">
              <strong>{name}</strong>
              <small className="subtle speaker-viewer-email">
                {viewer.email}
              </small>
            </span>
          </span>
          <Form method="post" action="/sign-out">
            <Button size="small" type="submit">
              Sign out
            </Button>
          </Form>
        </div>
      </header>
      <div className="speaker-layout">
        <nav className="speaker-nav" aria-label="Participant workspace">
          <div className="speaker-nav-desktop">
            {visibleDestinations.map((destination) => (
              <ParticipantDestinationLink
                key={destination.id}
                destination={destination}
              />
            ))}
          </div>
          <div className="speaker-nav-mobile">
            {primaryDestinations.map((destination) => (
              <ParticipantDestinationLink
                key={destination.id}
                destination={destination}
                compact
                onNavigate={() => setMoreOpen(false)}
              />
            ))}
            <div className="speaker-nav-more" ref={moreContainerRef}>
              <button
                ref={moreButtonRef}
                type="button"
                className={secondaryRouteActive ? "active" : undefined}
                data-route-active={secondaryRouteActive ? "" : undefined}
                aria-expanded={moreOpen}
                aria-controls="participant-more-destinations"
                onClick={() => setMoreOpen((open) => !open)}
              >
                <MoreHorizontal aria-hidden size={18} />
                <span>More</span>
                {secondaryRouteActive ? (
                  <span className="sr-only">, contains current page</span>
                ) : null}
              </button>
              <div
                id="participant-more-destinations"
                className="speaker-nav-more-menu"
                hidden={!moreOpen}
              >
                {secondaryDestinations.map((destination) => (
                  <ParticipantDestinationLink
                    key={destination.id}
                    destination={destination}
                    onNavigate={() => setMoreOpen(false)}
                  />
                ))}
              </div>
            </div>
          </div>
        </nav>
        <main id="main" className="speaker-main" tabIndex={-1}>
          {children}
        </main>
      </div>
    </div>
  );
}
