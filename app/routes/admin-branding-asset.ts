import { EventBrandingService } from "~/modules/events/event-branding-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-branding-asset";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const asset = await new EventBrandingService(env).getAdminAsset(
    viewer,
    params.assetId,
  );
  if (!asset) throw new Response("Branding asset not found.", { status: 404 });
  return new EventBrandingService(env).assetResponse(asset, "private");
}
