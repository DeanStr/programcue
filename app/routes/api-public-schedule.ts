import {
  apiFailure,
  apiSuccess,
  correlationId,
} from "~/platform/api/api.server";
import { parseStrictQuery } from "~/platform/api/api-pagination.server";
import {
  getPublicSessionPage,
  publicSessionQuerySchema,
  publishedProgrammeCacheHeaders,
  publishedProgrammeNotModified,
} from "~/platform/api/api-public-programme.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/api-public-schedule";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    const input = parseStrictQuery(request, publicSessionQuerySchema);
    const page = await getPublicSessionPage(
      env,
      params.slug ?? "",
      input,
      "schedule",
    );
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
