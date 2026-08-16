import { z } from "zod";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  requireApiKey,
} from "~/platform/api/api.server";
import { ApiAdministrationService } from "~/platform/api/api-administration-service.server";
import { parseStrictQuery } from "~/platform/api/api-pagination.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/api-event";

const querySchema = z.object({}).strict();

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    if (!params.eventId)
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    parseStrictQuery(request, querySchema);
    const authenticated = await requireApiKey(
      request,
      env,
      "events:read",
      params.eventId,
    );
    const event = await new ApiAdministrationService(env).getEvent({
      ...authenticated,
      eventId: params.eventId,
    });
    return apiSuccess({ event, correlationId: requestCorrelationId });
  } catch (error) {
    return apiFailure(
      error,
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
  }
}

export function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const response = apiFailure(
    new ApiError(
      405,
      "METHOD_NOT_ALLOWED",
      "The event API resource is read-only",
    ),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "GET");
  return response;
}
