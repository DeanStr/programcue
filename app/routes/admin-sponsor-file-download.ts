import { SponsorAssetService } from "~/modules/sponsors/sponsor-assets.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-sponsor-file-download";
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return new SponsorAssetService(env).adminDownload(
    viewer,
    params.sponsorId,
    params.requestId,
    params.versionId,
    new URL(request.url).searchParams.get("inline") === "1",
  );
}
