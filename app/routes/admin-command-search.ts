import type { LoaderFunctionArgs } from "react-router";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { CommandPaletteService } from "~/platform/operations/command-palette-service.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  const search = new URL(request.url).searchParams;
  const query = search.get("q") ?? "";
  if (query.trim().length < 2) return { records: [] };
  return {
    records: await new CommandPaletteService(env).search(viewer, {
      query,
      scope: search.get("scope") ?? "event",
    }),
  };
}
