import { ZodError } from "zod";

import type { Route } from "./+types/api-participant-resources";
import {
  ApiParticipantService,
  parseParticipantQuery,
  parseParticipantResource,
  participantProfilePatchSchema,
} from "~/platform/api/api-participant-service.server";
import {
  ApiError,
  apiFailure,
  apiRequestHash,
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
      "Participant mutations require an exact same-origin request",
    );
  }
}

function participantApiError(error: unknown) {
  if (error instanceof ZodError) {
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      "The participant API request is invalid",
      error.issues,
    );
  }
  if (error instanceof Response) {
    if (error.status === 401) {
      return new ApiError(401, "AUTH_REQUIRED", "Authentication is required");
    }
    if (error.status === 403) {
      return new ApiError(
        403,
        "EVENT_FORBIDDEN",
        "The authenticated participant cannot access this event",
      );
    }
    if (error.status === 404) {
      return new ApiError(404, "NOT_FOUND", "Participant record not found");
    }
  }
  return error;
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    if (!params.eventId) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    }
    const resource = parseParticipantResource(params.resource);
    const viewer = await requireEventRole(
      request,
      env,
      params.eventId,
      ["speaker", "submitter"],
      "response",
    );
    const input = parseParticipantQuery(request, resource);
    const service = new ApiParticipantService(env);
    if (resource === "profile") {
      return apiSuccess({
        profile: await service.profile(viewer),
        correlationId: requestCorrelationId,
      });
    }
    if (!input.limit) {
      throw new Error("The participant page limit was not defaulted.");
    }
    return apiSuccess({
      ...(await service.list(viewer, resource, {
        ...input,
        limit: input.limit,
      })),
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    return apiFailure(
      participantApiError(error),
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    if (request.method.toUpperCase() !== "PATCH") {
      throw new ApiError(
        405,
        "METHOD_NOT_ALLOWED",
        "Participant profiles are updated with PATCH",
      );
    }
    requireSameOrigin(request);
    if (!params.eventId) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    }
    const resource = parseParticipantResource(params.resource);
    if (resource !== "profile") {
      throw new ApiError(
        405,
        "METHOD_NOT_ALLOWED",
        "This participant API resource is read-only",
      );
    }
    const viewer = await requireEventRole(
      request,
      env,
      params.eventId,
      ["speaker", "submitter"],
      "response",
    );
    const idempotencyKey = requireIdempotencyKey(request);
    const input = participantProfilePatchSchema.parse(
      await readJson(request, 16_000),
    );
    const service = new ApiParticipantService(env);
    const result = await service.runCommand(
      viewer,
      "participant.profile.update",
      idempotencyKey,
      await apiRequestHash(input),
      (operationId) =>
        service.updateProfile(viewer, input, requestCorrelationId, operationId),
      (operationId) => service.recoverProfileUpdate(viewer, input, operationId),
    );
    return apiSuccess({
      ...result.response,
      replayed: result.replayed,
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    const response = apiFailure(
      participantApiError(error),
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
    if (error instanceof ApiError && error.status === 405) {
      response.headers.set("allow", "PATCH");
    }
    return response;
  }
}
