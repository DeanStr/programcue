import { redirect } from "react-router";

import type { Route } from "./+types/home";
import type { ViewerRole } from "~/platform/auth/authorize.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const landingPage: Record<ViewerRole, string> = {
  owner: "/admin/event",
  administrator: "/admin/event",
  committee_chair: "/admin/review",
  evaluator: "/review/workbench",
  speaker: "/participant/dashboard",
  submitter: "/participant/dashboard",
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
  return redirect(landingPage[viewer.role]);
}

export default function Home() {
  return null;
}
