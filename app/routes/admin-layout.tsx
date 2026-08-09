import { Outlet } from "react-router";

import type { Route } from "./+types/admin-layout";
import { AdminShell } from "~/components/admin-shell";
import { EventService } from "~/modules/events/event-service.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

function formatEventDateRange(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T12:00:00Z`);
  const end = new Date(`${endDate}T12:00:00Z`);
  const month = new Intl.DateTimeFormat("en", { month: "short", timeZone: "UTC" });
  const day = new Intl.DateTimeFormat("en", { day: "numeric", timeZone: "UTC" });
  const year = new Intl.DateTimeFormat("en", { year: "numeric", timeZone: "UTC" });
  if (startDate === endDate) return `${month.format(start)} ${day.format(start)}, ${year.format(start)}`;
  if (start.getUTCFullYear() === end.getUTCFullYear() && start.getUTCMonth() === end.getUTCMonth()) {
    return `${month.format(start)} ${day.format(start)}–${day.format(end)}, ${year.format(end)}`;
  }
  return `${month.format(start)} ${day.format(start)} – ${month.format(end)} ${day.format(end)}, ${year.format(end)}`;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const eventId = env.DEFAULT_EVENT_ID;
  if (!eventId) throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  const pathname = new URL(request.url).pathname.replace(/\/$/, "");
  const viewer = await requireEventRole(
    request,
    env,
    eventId,
    pathname === "/admin/review"
      ? ["owner", "administrator", "committee_chair"]
      : ["owner", "administrator"],
  );
  const [event, notificationCounts] = await Promise.all([
    new EventService(env).getSetup(viewer),
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM task_instances
          WHERE event_id = ? AND status NOT IN ('completed','waived')
            AND (status = 'overdue' OR (due_at IS NOT NULL AND due_at < unixepoch()))) AS overdueTasks,
        (SELECT COUNT(*) FROM schedule_conflicts
          WHERE event_id = ? AND resolved_at IS NULL AND severity = 'blocking') AS scheduleConflicts,
        (SELECT COUNT(*) FROM operation_jobs
          WHERE event_id = ? AND status IN ('queue_failed','failed','partially_failed')) AS failedOperations
    `).bind(eventId, eventId, eventId).first<{ overdueTasks: number; scheduleConflicts: number; failedOperations: number }>(),
  ]);

  return {
    event: {
      name: event.name,
      dates: formatEventDateRange(event.startDate, event.endDate),
      venue: event.venue,
      city: event.city,
    },
    viewer: {
      name: viewer.name,
      email: viewer.email,
      role: viewer.role,
      demo: viewer.demo,
    },
    notifications: viewer.role === "committee_chair" ? [] : [
      { label: "Overdue tasks", count: Number(notificationCounts?.overdueTasks ?? 0), href: "/admin/tasks?state=overdue", severity: "danger" as const },
      { label: "Blocking schedule conflicts", count: Number(notificationCounts?.scheduleConflicts ?? 0), href: "/admin/schedule?filter=conflicts", severity: "danger" as const },
      { label: "Failed operations", count: Number(notificationCounts?.failedOperations ?? 0), href: "/admin/operations?status=failed", severity: "warning" as const },
    ].filter((notification) => notification.count > 0),
  };
}

export default function AdminLayout({ loaderData }: Route.ComponentProps) {
  return <AdminShell event={loaderData.event} viewer={loaderData.viewer} notifications={loaderData.notifications}><Outlet /></AdminShell>;
}
