import type { Route } from "./+types/api-public-event";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import {
  emptyPublicQuerySchema,
  publishedProgrammeCacheHeaders,
  publishedProgrammeNotModified,
  publicEventResponse,
  requirePublishedProgramme,
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
    parseStrictQuery(request, emptyPublicQuerySchema);
    const programme = requirePublishedProgramme(
      await new PublicProgrammeService(env).getPublished(params.slug ?? ""),
    );
    const headers = {
      ...(await publishedProgrammeCacheHeaders(request, programme)),
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
