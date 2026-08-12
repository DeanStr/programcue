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
            <span className="brand-mark">P</span>
          )}
          <span>Program Cue</span>
        </NavLink>
        <div>
          <div className="event-title">{event.name}</div>
          <div className="subtle tiny">
            {[event.dateLabel, event.locationLabel].filter(Boolean).join(" · ")}
          </div>
          <Link className="tiny" to={eventSelectionHref}>
            Switch event
          </Link>
          {event.participantSupportUrl ? (
            <a
              className="tiny participant-support-link"
              href={event.participantSupportUrl}
              target="_blank"
              rel="noreferrer"
            >
              Participant support
            </a>
          ) : null}
        </div>
        <div className="right">
          <span className="avatar">{initials}</span>
          <span>
            <strong>{name}</strong>
            <small className="subtle speaker-viewer-email">
              {viewer.email}
            </small>
          </span>
          <Form method="post" action="/sign-out">
            <button className="btn small" type="submit">
              Sign out
            </button>
          </Form>
        </div>
      </header>
      <div className="speaker-layout">
        <nav className="speaker-nav" aria-label="Participant workspace">
          <NavLink to="/participant/dashboard">
            <Home aria-hidden size={17} /> <span>Overview</span>
          </NavLink>
          <NavLink to="/participant/applications">
            <ClipboardList aria-hidden size={17} /> <span>Applications</span>
          </NavLink>
          <NavLink to="/participant/sessions">
            <Mic2 aria-hidden size={17} /> <span>My sessions</span>
          </NavLink>
          <NavLink to="/participant/tasks">
            <CheckSquare aria-hidden size={17} /> <span>Tasks</span>
          </NavLink>
          <NavLink to="/participant/files">
            <FileStack aria-hidden size={17} /> <span>Files</span>
          </NavLink>
          <NavLink to="/participant/resources">
            <BookOpen aria-hidden size={17} /> <span>Resources</span>
          </NavLink>
          <NavLink to="/participant/profile">
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
