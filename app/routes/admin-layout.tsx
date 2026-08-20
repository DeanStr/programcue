import {
  isRouteErrorResponse,
  Link,
  Outlet,
  useLocation,
  useRevalidator,
  useRouteLoaderData,
} from "react-router";
import { AdminShell } from "~/components/admin-shell";
import { routeErrorCopy, routeErrorMessage } from "~/lib/route-error-copy";
import {
  routeErrorRecovery,
  sanitizeRouteErrorMessage,
  shouldOfferErrorRetry,
} from "~/lib/route-error-recovery";
import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import {
  loadCurrentEventAdminShellContext,
  requireCurrentEventRole,
} from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { CommandPaletteService } from "~/platform/operations/command-palette-service.server";
import { SavedViewService } from "~/platform/operations/saved-view-service.server";
import type { Route } from "./+types/admin-layout";

function formatEventDateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  const month = new Intl.DateTimeFormat("en", {
    month: "short",
    timeZone: "UTC",
  });
  const day = new Intl.DateTimeFormat("en", {
    day: "numeric",
    timeZone: "UTC",
  });
  const year = new Intl.DateTimeFormat("en", {
    year: "numeric",
    timeZone: "UTC",
  });
  if (startDate === endDate)
    return `${month.format(start)} ${day.format(start)}, ${year.format(start)}`;
  if (
    start.getUTCFullYear() === end.getUTCFullYear() &&
    start.getUTCMonth() === end.getUTCMonth()
  ) {
    return `${month.format(start)} ${day.format(start)}–${day.format(end)}, ${year.format(end)}`;
  }
  return `${month.format(start)} ${day.format(start)} – ${month.format(end)} ${day.format(end)}, ${year.format(end)}`;
}

export function adminLayoutAllowedRoles(pathname: string) {
  return /^\/admin\/review(?:\.data$|\/|$)/u.test(pathname)
    ? (["owner", "administrator", "committee_chair"] as const)
    : (["owner", "administrator"] as const);
}

export function adminErrorReturn(
  status: number | null,
  adminContextLoaded: boolean,
  options: { pathname?: string; evaluation?: boolean } = {},
) {
  return routeErrorRecovery({
    status,
    pathname: options.pathname ?? "/admin/command",
    evaluation: Boolean(options.evaluation),
    adminContextLoaded,
  });
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const pathname = new URL(request.url).pathname.replace(/\/$/, "");
  const allowedRoles = adminLayoutAllowedRoles(pathname);
  const viewer = await requireCurrentEventRole(request, env, allowedRoles);
  const commandPalette = new CommandPaletteService(env);
  const [shellContext, savedViews, recentRecords] = await Promise.all([
    loadCurrentEventAdminShellContext(env, viewer, allowedRoles),
    new SavedViewService(env).list(viewer),
    commandPalette.recent(viewer),
    new AirtableProviderBoundary(env).assertReadable(viewer),
  ]);
  const { event } = shellContext;

  return {
    event: {
      id: event.id,
      name: event.name,
      timezone: event.timezone,
      dates: formatEventDateRange(event.startDate, event.endDate),
      venue: event.venue,
      city: event.city,
    },
    eventOptions: shellContext.eventOptions,
    viewer: {
      name: viewer.name,
      email: viewer.email,
      role: viewer.role,
      demo: viewer.demo,
      canCreateEvents: shellContext.canCreateEvents,
    },
    commandPalette: {
      savedViews,
      recentRecords,
      organisationSearchAllowed: shellContext.canSearchOrganisation,
    },
    notifications:
      viewer.role === "committee_chair"
        ? []
        : [
            {
              label: "Overdue tasks",
              count: shellContext.notificationCounts.overdueTasks,
              href: "/admin/tasks?state=overdue",
              severity: "danger" as const,
              detail: "Past their due date and still open",
            },
            {
              label: "Blocking schedule conflicts",
              count: shellContext.notificationCounts.scheduleConflicts,
              href: "/admin/schedule?filter=conflicts",
              severity: "danger" as const,
              detail: "Revalidated at publication, and blocking until resolved",
            },
            {
              label: "Failed operations",
              count: shellContext.notificationCounts.failedOperations,
              href: "/admin/operations?status=failed",
              severity: "warning" as const,
              detail: "Inspect the error, then retry or archive the alert",
            },
          ].filter((notification) => notification.count > 0),
  };
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  return (
    <AdminShell
      event={loaderData.event}
      eventOptions={loaderData.eventOptions}
      viewer={loaderData.viewer}
      notifications={loaderData.notifications}
      commandPalette={loaderData.commandPalette}
    >
      <Outlet />
    </AdminShell>
  );
}

/**
 * A failure below this layout replaces the page, not the product. Without it
 * any loader throw fell through to the root boundary, which discards the whole
 * document — navigation, event context and all — for a recoverable error.
 */
export function ErrorBoundary({ error, loaderData }: Route.ErrorBoundaryProps) {
  const revalidator = useRevalidator();
  const location = useLocation();
  const rootData = useRouteLoaderData("root") as
    | { evaluation?: { name: string } | null }
    | undefined;

  const routeError = isRouteErrorResponse(error) ? error : null;
  const title = routeError
    ? routeErrorCopy(routeError.status).title
    : "This page could not load";
  const message = routeError
    ? sanitizeRouteErrorMessage(
        routeError.status,
        routeErrorMessage(routeError.status, routeError.data),
      )
    : "The page failed to load. Check your latest changes before trying again.";
  const errorReturn = adminErrorReturn(
    routeError?.status ?? null,
    Boolean(loaderData),
    {
      pathname: location.pathname,
      evaluation: Boolean(rootData?.evaluation),
    },
  );
  const showRetry = shouldOfferErrorRetry(routeError?.status ?? null);

  const errorContent = (
    <section className="card pad" style={{ maxWidth: 620 }}>
      <h1 style={{ fontSize: "var(--text-xl)", margin: 0 }}>{title}</h1>
      <p className="subtle">{message}</p>
      <div className="page-actions mt">
        {showRetry ? (
          <button
            className="btn"
            disabled={revalidator.state === "loading"}
            onClick={() => revalidator.revalidate()}
            type="button"
          >
            {revalidator.state === "loading" ? "Retrying…" : "Try again"}
          </button>
        ) : null}
        <Link className="btn primary" to={errorReturn.href}>
          {errorReturn.label}
        </Link>
      </div>
    </section>
  );

  if (!loaderData) return errorContent;

  return (
    <AdminShell
      event={loaderData.event}
      eventOptions={loaderData.eventOptions}
      viewer={loaderData.viewer}
      notifications={loaderData.notifications}
      commandPalette={loaderData.commandPalette}
    >
      {errorContent}
    </AdminShell>
  );
}
