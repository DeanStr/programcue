import { handleMultipart } from "~/modules/files/multipart-request.server";
import { SponsorAssetService } from "~/modules/sponsors/sponsor-assets.server";
import { requireAuthenticatedPerson } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/sponsor-file-multipart";
export async function action({ request, context, params }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  return handleMultipart(request, env, params.operation, async () =>
    new SponsorAssetService(env).actor(
      await requireAuthenticatedPerson(request, env),
      params.eventId,
      params.sponsorId,
    ),
  );
}
export function loader() {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: "POST" },
  });
}
