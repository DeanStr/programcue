import { redirect } from "react-router";

import type { Route } from "./+types/home";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import type { ViewerRole } from "~/platform/auth/authorize.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
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
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
    "evaluator",
    "speaker",
    "submitter",
  ]);
  const destination = landingPage[viewer.role];
  if (destination) return redirect(destination);

  const publicSlug = await new SubmissionService(
    env,
  ).getLatestPublishedFormSlug(viewer);
  if (!publicSlug)
    throw new Response("No application form is currently published", {
      status: 404,
    });
  return redirect(`/apply/${encodeURIComponent(publicSlug)}`);
}

export default function Home() {
  return null;
}
