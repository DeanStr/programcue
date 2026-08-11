import type { Route } from "./+types/api-public-sessions";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import {
  publishedProgrammeCacheHeaders,
  publishedProgrammeNotModified,
  publicSessionPage,
  publicSessionQuerySchema,
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
    const input = parseStrictQuery(request, publicSessionQuerySchema);
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
    return apiSuccess(await publicSessionPage(programme, input), 200, {
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
