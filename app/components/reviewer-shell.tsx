import { Form, Link, useLocation } from "react-router";

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
  return <div className="speaker-shell reviewer-shell">
    <header className="speaker-top review-top">
      <Link className="review-brand" to="/review/workbench" aria-label="Program Cue review workbench">
        <span className="brand-mark">P</span>
        <span>Program Cue</span>
      </Link>
      <div className="review-context">
        <strong>{eventName}</strong>
        <small>Evaluation workspace</small>
      </div>
      <Link className="btn small" to={eventSelectionHref}>Switch event</Link>
      {viewer.demo ? <form method="post" action="/demo/role" className="review-demo-return"><input type="hidden" name="role" value="administrator" /><button className="btn small">Return to administrator demo</button></form> : null}
      <div className="review-account">
        <span className="status info">{viewer.role.replaceAll("_", " ")}</span>
        <span className="avatar" role="img" aria-label={`Signed in as ${viewer.name}`} title={viewer.name}>{initials}</span>
        {!viewer.demo ? <Form method="post" action="/sign-out"><button className="btn small" type="submit">Sign out</button></Form> : null}
      </div>
    </header>
    <main className="speaker-main" id="main">{children}</main>
  </div>;
}
