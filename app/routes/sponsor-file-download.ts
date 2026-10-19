import { SponsorAssetService } from "~/modules/sponsors/sponsor-assets.server";
import { requireAuthenticatedPerson } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/sponsor-file-download";
export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  return new SponsorAssetService(env).portalDownload(
    await requireAuthenticatedPerson(request, env),
    params.eventId,
    params.sponsorId,
    params.requestId,
    params.versionId,
  );
}
