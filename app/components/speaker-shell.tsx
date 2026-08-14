import {
  BookOpen,
  CheckSquare,
  ClipboardList,
  FileStack,
  Home,
  Mic2,
  UserRound,
} from "lucide-react";
import { Form, Link, NavLink, useLocation } from "react-router";

import { BrandMark } from "~/components/brand-mark";

export function SpeakerShell({
  children,
  event,
  viewer,
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
  viewer: { name: string; email: string; demo: boolean };
}) {
  const location = useLocation();
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
  return (
    <div
      className="speaker-shell event-branded"
      style={{ "--event-accent": event.brandAccent } as React.CSSProperties}
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
          <Link className="btn small" to={eventSelectionHref}>
            Switch event
          </Link>
          {event.participantSupportUrl ? (
            <a
              className="btn small"
              href={event.participantSupportUrl}
              target="_blank"
              rel="noreferrer"
            >
              Support
            </a>
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
            <button className="btn small" type="submit">
              Sign out
            </button>
          </Form>
        </div>
      </header>
      <div className="speaker-layout">
        {/* The label spans are display:none at and below 1024px, which leaves
            these links with no accessible name. */}
        <nav className="speaker-nav" aria-label="Participant workspace">
          <NavLink to="/participant/dashboard" aria-label="Overview">
            <Home aria-hidden size={17} /> <span>Overview</span>
          </NavLink>
          <NavLink to="/participant/applications" aria-label="Applications">
            <ClipboardList aria-hidden size={17} /> <span>Applications</span>
          </NavLink>
          <NavLink to="/participant/sessions" aria-label="My sessions">
            <Mic2 aria-hidden size={17} /> <span>My sessions</span>
          </NavLink>
          <NavLink to="/participant/tasks" aria-label="Tasks">
            <CheckSquare aria-hidden size={17} /> <span>Tasks</span>
          </NavLink>
          <NavLink to="/participant/files" aria-label="Files">
            <FileStack aria-hidden size={17} /> <span>Files</span>
          </NavLink>
          <NavLink to="/participant/resources" aria-label="Resources">
            <BookOpen aria-hidden size={17} /> <span>Resources</span>
          </NavLink>
          <NavLink to="/participant/profile" aria-label="Profile">
            <UserRound aria-hidden size={17} /> <span>Profile</span>
          </NavLink>
        </nav>
        <main id="main" className="speaker-main">
          {children}
        </main>
      </div>
    </div>
  );
}
