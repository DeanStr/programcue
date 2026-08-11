import type { Route } from "./+types/api-integration-resources";
import {
  ApiIntegrationService,
  parseIntegrationQuery,
  parseIntegrationResource,
} from "~/platform/api/api-integration-service.server";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  requireApiKey,
} from "~/platform/api/api.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    if (!params.eventId)
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    const resource = parseIntegrationResource(params.resource);
    const authenticated = await requireApiKey(
      request,
      env,
      "integrations:read",
      params.eventId,
    );
    const input = parseIntegrationQuery(request, resource);
    const page = await new ApiIntegrationService(env).list(
      { ...authenticated, eventId: params.eventId },
      resource,
      input,
    );
    return apiSuccess({ ...page, correlationId: requestCorrelationId });
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
      "This integration API collection is read-only",
    ),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "GET");
  return response;
}
