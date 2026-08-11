import { z, ZodError } from "zod";

import type { Route } from "./+types/api-administration-item";
import {
  ADMIN_RESOURCE_SCOPES,
  parseAdminResource,
} from "~/platform/api/api-administration-service.server";
import { ApiAdministrationItemService } from "~/platform/api/api-administration-item-service.server";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  requireApiKey,
} from "~/platform/api/api.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const itemIdSchema = z.string().trim().min(1).max(200);

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    if (request.method.toUpperCase() !== "GET") {
      throw new ApiError(405, "METHOD_NOT_ALLOWED", "Items are read with GET");
    }
    if (!params.eventId) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    }
    const resource = parseAdminResource(params.resource);
    const itemId = itemIdSchema.parse(params.itemId);
    const authenticated = await requireApiKey(
      request,
      env,
      ADMIN_RESOURCE_SCOPES[resource],
      params.eventId,
    );
    return apiSuccess({
      ...(await new ApiAdministrationItemService(env).get(
        { ...authenticated, eventId: params.eventId },
        resource,
        itemId,
      )),
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    return apiFailure(
      error instanceof ZodError
        ? new ApiError(
            422,
            "VALIDATION_ERROR",
            "The administration item identifier is invalid",
            error.issues,
          )
        : error,
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
  }
}
