import type { Route } from "./+types/public-headshot";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const unavailableHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export async function loader({ params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const slug = params.slug?.trim();
  const personId = params.personId?.trim();
  if (!slug || !personId) {
    throw new Response("Published headshot not found.", {
      status: 404,
      headers: unavailableHeaders,
    });
  }
  const response = await new PublicProgrammeService(env).getPublishedHeadshot(
    slug,
    personId,
  );
  if (!response) {
    throw new Response("Published headshot not found.", {
      status: 404,
      headers: unavailableHeaders,
    });
  }
  return response;
}
