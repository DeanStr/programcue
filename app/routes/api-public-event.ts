import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import {
  apiFailure,
  apiSuccess,
  correlationId,
} from "~/platform/api/api.server";
import { parseStrictQuery } from "~/platform/api/api-pagination.server";
import {
  emptyPublicQuerySchema,
  publicEventResponse,
  publishedProgrammeCacheHeaders,
  publishedProgrammeNotModified,
  requirePublishedProgramme,
} from "~/platform/api/api-public-programme.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/api-public-event";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    parseStrictQuery(request, emptyPublicQuerySchema);
    const programme = requirePublishedProgramme(
      await new PublicProgrammeService(env).getPublished(params.slug ?? ""),
    );
    const headers = {
      ...(await publishedProgrammeCacheHeaders(request, programme, "", "live")),
      "access-control-allow-origin": "*",
    };
    if (publishedProgrammeNotModified(request, headers.etag)) {
      return new Response(null, { status: 304, headers });
    }
    return apiSuccess(publicEventResponse(programme), 200, {
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
