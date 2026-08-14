import { Form, Link, useLocation } from "react-router";

import { BrandMark } from "~/components/brand-mark";

export function ReviewerShell({ viewer, eventName, children }: {
  viewer: { name: string; role: string; demo: boolean };
  eventName: string;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const eventSelectionHref = `/events/select?${new URLSearchParams({
    returnTo: `${location.pathname}${location.search}${location.hash}`,
  })}`;
  const initials = viewer.name.split(/\s+/).map((part) => part[0]).slice(0, 2).join("");
  /* Four clusters, and the grid declares four columns. It declared four while
     rendering five, so the chrome wrapped to a second row at its own design
     width and left identity under the logo with the event switcher 1,200px
     away. Session actions travel together; identity is its own cluster. */
  return <div className="speaker-shell reviewer-shell">
    <header className="speaker-top review-top">
      <Link className="review-brand" to="/review/workbench" aria-label="Program Cue review workbench">
        <BrandMark />
        <span>Program Cue</span>
      </Link>
      <div className="review-context">
        <strong>{eventName}</strong>
        <small>Evaluation workspace</small>
      </div>
      <div className="review-session-actions">
        <Link className="btn small" to={eventSelectionHref}>Switch event</Link>
        {viewer.demo ? <form method="post" action="/demo/role" className="review-demo-return"><input type="hidden" name="identity" value="administrator" /><button className="btn small">Return to organizer demo</button></form> : null}
      </div>
      <div className="review-account">
        <span className="status info">{viewer.role.replaceAll("_", " ")}</span>
        <span className="avatar" role="img" aria-label={`Signed in as ${viewer.name}`} title={viewer.name}>{initials}</span>
        <Form method="post" action="/sign-out"><button className="btn small" type="submit">Sign out</button></Form>
      </div>
    </header>
    <main className="speaker-main" id="main">{children}</main>
  </div>;
}
