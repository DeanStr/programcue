import { useEffect, useLayoutEffect, useRef } from "react";
import {
  Form,
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useLocation,
  useRouteLoaderData,
} from "react-router";
import { Toaster } from "sonner";
import { BrandMark } from "~/components/brand-mark";
import { RouteProgress } from "~/components/ui/route-progress";
import {
  routeErrorCopy,
  routeErrorMessage,
  UNKNOWN_ROUTE_ERROR_MESSAGE,
  UNKNOWN_ROUTE_ERROR_TITLE,
} from "~/lib/route-error-copy";
import {
  routeErrorRecovery,
  sanitizeRouteErrorMessage,
  shouldOfferErrorRetry,
} from "~/lib/route-error-recovery";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { installDraftRecoverySignOutCleanup } from "~/platform/drafts/draft-recovery";
import {
  evaluationApplicantGuideLabel,
  evaluationReviewerGuideLabel,
  readEvaluationScenarioGuideState,
} from "~/platform/evaluation/evaluation-guide-state.server";
import {
  EVALUATION_IDENTITIES,
  readEvaluationSession,
} from "~/platform/evaluation/evaluation-session.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";
import type { Route } from "./+types/root";
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
  { name: "theme-color", content: "#13201f" },
];

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!requireRuntimeMode(env).evaluation) return { evaluation: null };
  const session = await readEvaluationSession(request, env);
  if (!session?.identityKey) return { evaluation: null };
  const identity = EVALUATION_IDENTITIES[session.identityKey];
  let label: string = identity.label;
  if (
    session.identityKey === "sbek_applicant" ||
    session.identityKey === "sbek_reviewer"
  ) {
    const scenarioState = await readEvaluationScenarioGuideState(
      env,
      session.fixtureGeneration,
    );
    label =
      session.identityKey === "sbek_applicant"
        ? evaluationApplicantGuideLabel(scenarioState.applicant.phase)
        : evaluationReviewerGuideLabel(scenarioState.reviewer.phase);
  } else if (identity.group === "scenario") {
    throw new Error(
      `Evaluation identity ${session.identityKey} has no scenario banner mapping.`,
    );
  }
  return {
    evaluation: { name: identity.name, label },
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

function EvaluationBanner({
  evaluation,
}: {
  evaluation: { name: string; label: string } | null | undefined;
}) {
  const embedded = useLocation().pathname.startsWith("/embed/");
  const visible = Boolean(evaluation && !embedded);
  const bannerRef = useRef<HTMLElement>(null);
  useLayoutEffect(() => {
    if (!visible) {
      document.documentElement.style.removeProperty("--eval-banner-offset");
      return;
    }
    const node = bannerRef.current;
    if (!node) {
      document.documentElement.style.removeProperty("--eval-banner-offset");
      return;
    }
    const publish = () => {
      document.documentElement.style.setProperty(
        "--eval-banner-offset",
        `${Math.ceil(node.getBoundingClientRect().height)}px`,
      );
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(node);
    return () => {
      observer.disconnect();
      document.documentElement.style.removeProperty("--eval-banner-offset");
    };
  }, [visible]);
  if (!evaluation || !visible) return null;
  return (
    <aside
      ref={bannerRef}
      className="pc-status-notice is-warning pc-eval-banner"
      aria-label="Evaluation session"
    >
      <span className="pc-eval-banner-identity">
        <strong>Evaluation:</strong> {evaluation.label} · {evaluation.name}
      </span>
      <span className="pc-eval-banner-actions">
        <Link className="btn small" to="/evaluate">
          Evaluation guide
        </Link>
        <Form method="post" action="/sign-out">
          <button className="btn small" type="submit">
            Change persona
          </button>
        </Form>
      </span>
    </aside>
  );
}

export default function App({ loaderData }: Route.ComponentProps) {
  const embedded = useLocation().pathname.startsWith("/embed/");
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
      <EvaluationBanner evaluation={loaderData.evaluation} />
      <Outlet />
      {!embedded ? (
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
      ) : null}
    </>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  const location = useLocation();
  const rootData = useRouteLoaderData("root") as
    | Route.ComponentProps["loaderData"]
    | undefined;
  let title = UNKNOWN_ROUTE_ERROR_TITLE;
  let message = UNKNOWN_ROUTE_ERROR_MESSAGE;
  let status: number | null = null;

  if (isRouteErrorResponse(error)) {
    status = error.status;
    title = routeErrorCopy(error.status).title;
    message = sanitizeRouteErrorMessage(
      error.status,
      routeErrorMessage(error.status, error.data),
    );
  } else if (error instanceof Error && import.meta.env.DEV) {
    message = error.message;
  }

  const recovery = routeErrorRecovery({
    status,
    pathname: location.pathname,
    evaluation: Boolean(rootData?.evaluation),
  });
  const showRetry = shouldOfferErrorRetry(status);

  return (
    <>
      <EvaluationBanner evaluation={rootData?.evaluation} />
      <main className="design-board" id="main" tabIndex={-1}>
        <section
          className="card pad"
          style={{ maxWidth: 680, margin: "8vh auto" }}
        >
          <BrandMark />
          <h1>{title}</h1>
          <p className="subtle">{message}</p>
          <div className="page-actions mt">
            {showRetry ? (
              <button
                className="btn"
                onClick={() => window.location.reload()}
                type="button"
              >
                Try again
              </button>
            ) : null}
            <Link className="btn primary" to={recovery.href}>
              {recovery.label}
            </Link>
          </div>
        </section>
      </main>
    </>
  );
}
