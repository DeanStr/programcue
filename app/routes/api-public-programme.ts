import type { Route } from "./+types/api-public-programme";
import { PublicProgrammeService } from "~/modules/programme/public-programme-service.server";
import { apiSuccess, correlationId } from "~/platform/api/api.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const programme = await new PublicProgrammeService(env).getPublished(
    params.slug ?? "",
  );
  if (!programme)
    return apiSuccess(
      {
        error: {
          code: "EVENT_NOT_FOUND",
          message: "Published event programme not found",
        },
        correlationId: correlationId(request),
      },
      404,
      { "access-control-allow-origin": "*" },
    );
  return apiSuccess(programme, 200, {
    "cache-control": "public, max-age=60, stale-while-revalidate=300",
    "access-control-allow-origin": "*",
  });
}
