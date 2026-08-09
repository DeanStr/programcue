import { redirect } from "react-router";

import type { Route } from "./+types/home";
import { requireEventRole, type ViewerRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const landingPage: Partial<Record<ViewerRole, string>> = {
  owner: "/admin/event",
  administrator: "/admin/event",
  committee_chair: "/admin/review",
  evaluator: "/review/workbench",
  speaker: "/speaker/dashboard",
};

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID) {
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  }

  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
    "committee_chair",
    "evaluator",
    "speaker",
    "submitter",
  ]);
  const destination = landingPage[viewer.role];
  if (destination) return redirect(destination);

  const form = await env.DB.prepare(`
    SELECT public_slug AS publicSlug
      FROM form_definitions
     WHERE event_id = ? AND status = 'published'
     ORDER BY updated_at DESC
     LIMIT 1
  `).bind(viewer.eventId).first<{ publicSlug: string }>();
  if (!form) throw new Response("No application form is currently published", { status: 404 });
  return redirect(`/apply/${encodeURIComponent(form.publicSlug)}`);
}

export default function Home() {
  return null;
}
