import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  requireApiKey,
} from "~/platform/api/api.server";
import {
  ADMIN_RESOURCE_SCOPES,
  ApiAdministrationService,
  parseAdminQuery,
  parseAdminResource,
} from "~/platform/api/api-administration-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/api-administration-resources";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    if (!params.eventId)
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    const resource = parseAdminResource(params.resource);
    const authenticated = await requireApiKey(
      request,
      env,
      ADMIN_RESOURCE_SCOPES[resource],
      params.eventId,
    );
    const input = parseAdminQuery(request, resource);
    const page = await new ApiAdministrationService(env).list(
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
      "This administration API collection is read-only",
    ),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "GET");
  return response;
}
