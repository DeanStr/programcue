import { BookOpen, CheckSquare, FileStack, Home, Mic2, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
import { Form, Link, NavLink, useLocation } from "react-router";

export function SpeakerShell({
  children,
  event,
  viewer,
}: {
  children: React.ReactNode;
  event: { name: string; dateLabel: string; locationLabel: string };
  viewer: { name: string; email: string; demo: boolean };
}) {
  const location = useLocation();
  const [activeHash, setActiveHash] = useState("");
  useEffect(() => setActiveHash(location.hash), [location.hash]);
  const name = viewer.name;
  const initials = name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("").toUpperCase();
  const dashboardSection = (hash: string) => location.pathname === "/speaker/dashboard" && activeHash === hash;
  return (
    <div className="speaker-shell">
      <header className="speaker-top">
        <NavLink className="brand" to="/speaker/dashboard" style={{ color: "var(--ink)", padding: 0 }}>
          <span className="brand-mark">P</span><span>Program Cue</span>
        </NavLink>
        <div><div className="event-title">{event.name}</div><div className="subtle tiny">{[event.dateLabel, event.locationLabel].filter(Boolean).join(" · ")}</div></div>
        <div className="right"><span className="avatar">{initials}</span><span><strong>{name}</strong><small className="subtle speaker-viewer-email">{viewer.email}</small></span>{!viewer.demo ? <Form method="post" action="/sign-out"><button className="btn small" type="submit">Sign out</button></Form> : null}</div>
      </header>
      <div className="speaker-layout">
        <nav className="speaker-nav" aria-label="Speaker portal">
          <Link to="/speaker/dashboard" className={dashboardSection("") ? "active" : undefined} aria-current={dashboardSection("") ? "page" : undefined}><Home aria-hidden size={17} /> <span>Dashboard</span></Link>
          <Link to="/speaker/dashboard#sessions" className={dashboardSection("#sessions") ? "active" : undefined} aria-current={dashboardSection("#sessions") ? "location" : undefined}><Mic2 aria-hidden size={17} /> <span>My sessions</span></Link>
          <Link to="/speaker/dashboard#tasks" className={dashboardSection("#tasks") ? "active" : undefined} aria-current={dashboardSection("#tasks") ? "location" : undefined}><CheckSquare aria-hidden size={17} /> <span>Tasks</span></Link>
          <Link to="/speaker/dashboard#files" className={dashboardSection("#files") ? "active" : undefined} aria-current={dashboardSection("#files") ? "location" : undefined}><FileStack aria-hidden size={17} /> <span>Files</span></Link>
          <NavLink to="/speaker/resources"><BookOpen aria-hidden size={17} /> <span>Resources</span></NavLink>
          <Link to="/speaker/dashboard#profile" className={dashboardSection("#profile") ? "active" : undefined} aria-current={dashboardSection("#profile") ? "location" : undefined}><UserRound aria-hidden size={17} /> <span>Profile</span></Link>
        </nav>
        <main id="main" className="speaker-main">{children}</main>
      </div>
    </div>
  );
}
