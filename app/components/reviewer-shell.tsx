import { Form, Link, useLocation } from "react-router";

import { BrandMark } from "~/components/brand-mark";
import { Button, ButtonLink } from "~/components/ui/button";
import type { ViewerRole } from "~/platform/auth/authorize.server";
import { viewerRoleLabel } from "~/platform/auth/viewer-role-label";

export function ReviewerShell({
  viewer,
  eventName,
  children,
}: {
  viewer: { name: string; role: ViewerRole; demo: boolean };
  eventName: string;
  children: React.ReactNode;
}) {
  const location = useLocation();
  const eventSelectionHref = `/events/select?${new URLSearchParams({
    returnTo: `${location.pathname}${location.search}${location.hash}`,
  })}`;
  const initials = viewer.name
    .split(/\s+/)
    .map((part) => part[0])
    .slice(0, 2)
    .join("");
  /* Four clusters, and the grid declares four columns. It declared four while
     rendering five, so the chrome wrapped to a second row at its own design
     width and left identity under the logo with the event switcher 1,200px
     away. Session actions travel together; identity is its own cluster. */
  return (
    <div className="speaker-shell reviewer-shell">
      <header className="speaker-top review-top">
        <Link
          className="review-brand"
          to="/review/workbench"
          aria-label="Program Cue review workbench"
        >
          <BrandMark />
          <span>Program Cue</span>
        </Link>
        <div className="review-context">
          <strong>{eventName}</strong>
        </div>
        <div className="review-session-actions">
          <ButtonLink size="small" to={eventSelectionHref} reloadDocument>
            Switch event
          </ButtonLink>
          {viewer.demo ? (
            <form
              method="post"
              action="/demo/role"
              className="review-demo-return"
            >
              <input type="hidden" name="identity" value="administrator" />
              <Button type="submit" size="small">
                Return to organizer demo
              </Button>
            </form>
          ) : null}
        </div>
        <div className="review-account">
          <span className="review-account-role">
            {viewerRoleLabel(viewer.role)}
          </span>
          <span
            className="avatar"
            role="img"
            aria-label={`Signed in as ${viewer.name}`}
            title={viewer.name}
          >
            {initials}
          </span>
          <Form method="post" action="/sign-out">
            <Button size="small" type="submit">
              Sign out
            </Button>
          </Form>
        </div>
      </header>
      <main className="speaker-main" id="main" tabIndex={-1}>
        {children}
      </main>
    </div>
  );
}
