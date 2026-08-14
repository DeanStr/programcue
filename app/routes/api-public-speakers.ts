import type { Route } from "./+types/api-public-speakers";
import {
  getPublicSpeakerPage,
  publishedProgrammeCacheHeaders,
  publishedProgrammeNotModified,
  publicSpeakerQuerySchema,
} from "~/platform/api/api-public-programme.server";
import { parseStrictQuery } from "~/platform/api/api-pagination.server";
import {
  apiFailure,
  apiSuccess,
  correlationId,
} from "~/platform/api/api.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    const input = parseStrictQuery(request, publicSpeakerQuerySchema);
    const page = await getPublicSpeakerPage(env, params.slug ?? "", input);
    const headers = {
      ...(await publishedProgrammeCacheHeaders(request, page)),
      "access-control-allow-origin": "*",
    };
    if (publishedProgrammeNotModified(request, headers.etag)) {
      return new Response(null, { status: 304, headers });
    }
    return apiSuccess(page.body, 200, {
      ...headers,
    });
  } catch (error) {
    return apiFailure(
      error,
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
  }
}
