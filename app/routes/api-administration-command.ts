import { ZodError } from "zod";

import type { Route } from "./+types/api-administration-command";
import { ResourceContentError } from "~/modules/resources/resource-content";
import { ResourceEmbedUrlError } from "~/modules/resources/resource-embed-policy";
import { apiAdministrationFamilySchema } from "~/platform/api/api-command-contract";
import { ApiAdministrationCommandService } from "~/platform/api/api-administration-command-service.server";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  readJson,
  requireIdempotencyKey,
} from "~/platform/api/api.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new ApiError(
      403,
      "SAME_ORIGIN_REQUIRED",
      "Authenticated administration commands require an exact same-origin request",
    );
  }
}

function commandError(error: unknown) {
  if (error instanceof ZodError) {
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      "The administration command is invalid",
      error.issues,
    );
  }
  if (
    error instanceof ResourceContentError ||
    error instanceof ResourceEmbedUrlError
  ) {
    return new ApiError(422, "VALIDATION_ERROR", error.message);
  }
  if (error instanceof Response) {
    return new ApiError(
      error.status,
      error.status === 403
        ? "AUTH_FORBIDDEN"
        : error.status === 404
          ? "RESOURCE_NOT_FOUND"
          : "ADMINISTRATION_COMMAND_FAILED",
      error.statusText || "The administration command failed",
    );
  }
  if (
    error instanceof Error &&
    (error.name.includes("RevisionConflict") ||
      error.name.includes("StateError") ||
      error.name.includes("FinalError") ||
      error.name.includes("AlreadyActive") ||
      error.name.includes("NotFound"))
  ) {
    return new ApiError(
      error.name.includes("NotFound") ? 404 : 409,
      error.name.replace(/([a-z])([A-Z])/g, "$1_$2").toUpperCase(),
      error.message,
    );
  }
  if (
    error instanceof Error &&
    (error.name.includes("Permission") || error.name.includes("Authority"))
  ) {
    return new ApiError(403, "AUTH_FORBIDDEN", error.message);
  }
  if (
    error instanceof Error &&
    (error.name.includes("Configuration") ||
      error.name.includes("QueueUnavailable") ||
      error.name.includes("DeliveryError"))
  ) {
    return new ApiError(503, "DEPENDENCY_UNAVAILABLE", error.message, {
      committed:
        "committed" in error && (error as { committed?: unknown }).committed,
    });
  }
  return error;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    if (request.method.toUpperCase() !== "POST") {
      throw new ApiError(
        405,
        "METHOD_NOT_ALLOWED",
        "Administration commands require POST",
      );
    }
    requireSameOrigin(request);
    if (!params.eventId) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    }
    const family = apiAdministrationFamilySchema.parse(params.family);
    const roles =
      family === "decisions"
        ? (["owner", "administrator", "committee_chair"] as const)
        : (["owner", "administrator"] as const);
    const viewer = await requireEventRole(
      request,
      env,
      params.eventId,
      [...roles],
      "response",
    );
    const result = await new ApiAdministrationCommandService(env).execute(
      viewer,
      family,
      params.itemId,
      params.command,
      await readJson(request, 512_000),
      requireIdempotencyKey(request),
    );
    return apiSuccess({ result, correlationId: requestCorrelationId });
  } catch (error) {
    return apiFailure(
      commandError(error),
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
  }
}

export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const response = apiFailure(
    new ApiError(
      405,
      "METHOD_NOT_ALLOWED",
      "Administration commands require POST",
    ),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "POST");
  return response;
}
