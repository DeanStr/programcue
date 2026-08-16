import { ZodError } from "zod";
import {
  EventBrandingAssetChangedError,
  EventBrandingService,
} from "~/modules/events/event-branding-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/public-branding-asset";

const unavailableHeaders = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
};

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const service = new EventBrandingService(env);
  try {
    const response = await service.publishedAssetResponse(
      params.slug,
      params.kind,
      request,
    );
    if (!response)
      throw new Response("Published branding asset not found.", {
        status: 404,
        headers: unavailableHeaders,
      });
    return response;
  } catch (error) {
    if (error instanceof EventBrandingAssetChangedError)
      throw new Response(error.message, {
        status: 503,
        headers: { ...unavailableHeaders, "retry-after": "0" },
      });
    if (error instanceof ZodError)
      throw new Response("Published branding asset not found.", {
        status: 404,
        headers: unavailableHeaders,
      });
    throw error;
  }
}
