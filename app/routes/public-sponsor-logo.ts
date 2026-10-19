import { SponsorAssetService } from "~/modules/sponsors/sponsor-assets.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/public-sponsor-logo";
export async function loader({ context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  return new SponsorAssetService(env).publicLogo(
    params.eventId,
    params.requestId,
    params.versionId,
  );
}
