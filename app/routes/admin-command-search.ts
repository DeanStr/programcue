import { type LoaderFunctionArgs, redirect } from "react-router";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { isHtmlDocumentRequest } from "~/platform/http/html-navigation";
import { CommandPaletteService } from "~/platform/operations/command-palette-service.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  if (isHtmlDocumentRequest(request)) {
    throw redirect(
      viewer.role === "committee_chair" ? "/admin/review" : "/admin/command",
    );
  }
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
