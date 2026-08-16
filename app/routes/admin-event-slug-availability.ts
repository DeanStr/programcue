import { data } from "react-router";

import type { Route } from "./+types/admin-event-slug-availability";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await requireCurrentEventRole(request, env, ["owner", "administrator"]);
  const slug = new URL(request.url).searchParams.get("slug")?.trim() ?? "";
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(slug) || slug.length > 120) {
    return data(
      {
        slug,
        available: false,
        message: "Use lowercase letters, numbers and single hyphens.",
      },
      { status: 400 },
    );
  }
  const existing = await env.DB.prepare(
    "SELECT 1 FROM events WHERE slug = ? LIMIT 1",
  )
    .bind(slug)
    .first();
  return {
    slug,
    available: !existing,
    message: existing
      ? "That public slug is already in use."
      : "Public slug is available.",
  };
}
