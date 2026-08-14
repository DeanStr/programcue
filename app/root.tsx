import {
  isRouteErrorResponse,
  Form,
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
import {
  routeErrorCopy,
  routeErrorMessage,
  UNKNOWN_ROUTE_ERROR_MESSAGE,
  UNKNOWN_ROUTE_ERROR_TITLE,
} from "~/lib/route-error-copy";
import { installDraftRecoverySignOutCleanup } from "~/platform/drafts/draft-recovery";
import { RouteProgress } from "~/components/ui/route-progress";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  EVALUATION_IDENTITIES,
  readEvaluationSession,
} from "~/platform/evaluation/evaluation-session.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";
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

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!requireRuntimeMode(env).evaluation) return { evaluation: null };
  const session = await readEvaluationSession(request, env);
  const identity = session?.identityKey
    ? EVALUATION_IDENTITIES[session.identityKey]
    : null;
  return {
    evaluation: identity
      ? { name: identity.name, label: identity.label }
      : null,
  };
}

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

export default function App({ loaderData }: Route.ComponentProps) {
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
      {loaderData.evaluation ? (
        <aside
          className="pc-status-notice is-warning"
          aria-label="Evaluation session"
          style={{ borderRadius: 0, margin: 0, justifyContent: "center" }}
        >
          <strong>Evaluation:</strong> {loaderData.evaluation.label} ·{" "}
          {loaderData.evaluation.name}
          <Link className="btn small" to="/evaluate">
            Evaluation guide
          </Link>
          <Form method="post" action="/sign-out">
            <button className="btn small" type="submit">
              Change persona
            </button>
          </Form>
        </aside>
      ) : null}
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
  let title = UNKNOWN_ROUTE_ERROR_TITLE;
  let message = UNKNOWN_ROUTE_ERROR_MESSAGE;
  // Home, not Event Setup: an arbitrary failure is not evidence the user was
  // setting up an event.
  let returnHref = "/admin/command";
  let returnLabel = "Go to Command Centre";

  if (isRouteErrorResponse(error)) {
    title = routeErrorCopy(error.status).title;
    message = routeErrorMessage(error.status, error.data);
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
