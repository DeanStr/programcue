import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import { useEffect } from "react";
import { Toaster } from "sonner";

import type { Route } from "./+types/root";
import { BrandMark } from "~/components/brand-mark";
import { installDraftRecoverySignOutCleanup } from "~/platform/drafts/draft-recovery";
import { RouteProgress } from "~/components/ui/route-progress";
import "./styles/index.css";

export const links: Route.LinksFunction = () => [
  {
    rel: "preload",
    as: "font",
    type: "font/woff2",
    href: "/fonts/inter-latin-var.woff2",
    crossOrigin: "anonymous",
  },
  {
    rel: "icon",
    type: "image/svg+xml",
    href: "/brand-mark.svg",
  },
];

export const meta: Route.MetaFunction = () => [
  { title: "Program Cue" },
  {
    name: "description",
    content:
      "Conference programme operations, submissions, reviews, speaker readiness, communications and scheduling.",
  },
  { name: "theme-color", content: "#0b1428" },
];

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        {/* viewport-fit=cover is what makes env(safe-area-inset-*) resolve to
            anything other than 0, which three rules already depend on. */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, viewport-fit=cover"
        />
        <Meta />
        <Links />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  useEffect(() => {
    document.body.dataset.hydrated = "true";
    const removeDraftCleanup = installDraftRecoverySignOutCleanup();
    return () => {
      delete document.body.dataset.hydrated;
      removeDraftCleanup();
    };
  }, []);
  return (
    <>
      <RouteProgress />
      <Outlet />
      <Toaster
        closeButton
        containerAriaLabel="Action status notifications"
        position="bottom-right"
        toastOptions={{
          closeButtonAriaLabel: "Dismiss notification",
          classNames: { toast: "pc-toast" },
        }}
        visibleToasts={3}
      />
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "The request could not be completed.";
  // Home, not Event Setup: an arbitrary failure is not evidence the user was
  // setting up an event.
  let returnHref = "/admin/command";
  let returnLabel = "Go to Command Centre";

  if (isRouteErrorResponse(error)) {
    title =
      error.status === 404
        ? "Page not found"
        : `${error.status} ${error.statusText}`;
    if (error.status === 404) {
      message = "That page does not exist, or the link has changed.";
    }
    if (error.status < 500 && typeof error.data === "string")
      message = error.data;
    if ([400, 403, 428].includes(error.status)) {
      returnHref = "/events/select";
      returnLabel = "Choose an event";
    }
  } else if (error instanceof Error && import.meta.env.DEV) {
    message = error.message;
  }

  return (
    <main className="design-board" id="main" tabIndex={-1}>
      <section
        className="card pad"
        style={{ maxWidth: 680, margin: "8vh auto" }}
      >
        <BrandMark />
        <h1>{title}</h1>
        <p className="subtle">{message}</p>
        <div className="page-actions mt">
          <button
            className="btn"
            onClick={() => window.location.reload()}
            type="button"
          >
            Try again
          </button>
          <Link className="btn primary" to={returnHref}>
            {returnLabel}
          </Link>
        </div>
      </section>
    </main>
  );
}
