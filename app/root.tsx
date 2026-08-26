import { useEffect } from "react";
import {
  isRouteErrorResponse,
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
import {
  EvaluationBanner,
  evaluationBannerHiddenFromCookieHeader,
} from "~/components/evaluation-banner";
import { RouteProgress } from "~/components/ui/route-progress";
import { PRODUCT_THEME_COLOUR } from "~/lib/product-colours";
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
  evaluationWorkspaceRecovery,
  readEvaluationSession,
} from "~/platform/evaluation/evaluation-session.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";
import type { Route } from "./+types/root";
import "./styles/index.css";
import { Button, ButtonLink } from "~/components/ui/button";

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
  { name: "theme-color", content: PRODUCT_THEME_COLOUR },
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
    evaluation: {
      name: identity.name,
      label,
      bannerHidden: evaluationBannerHiddenFromCookieHeader(
        request.headers.get("cookie"),
      ),
      workspace: evaluationWorkspaceRecovery(session.identityKey),
    },
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
    evaluationWorkspace: rootData?.evaluation?.workspace ?? null,
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
              <Button onClick={() => window.location.reload()} type="button">
                Try again
              </Button>
            ) : null}
            <ButtonLink variant="primary" to={recovery.href}>
              {recovery.label}
            </ButtonLink>
          </div>
        </section>
      </main>
    </>
  );
}
