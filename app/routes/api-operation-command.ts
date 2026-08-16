import { ZodError, z } from "zod";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  readJson,
} from "~/platform/api/api.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  OperationNotFoundError,
  OperationQueueUnavailableError,
  OperationService,
  OperationStateError,
} from "~/platform/operations/operation-service.server";
import type { Route } from "./+types/api-operation-command";

const commandSchema = z.enum(["retry", "retry-item", "cancel"]);
const confirmedSchema = z.object({ confirmed: z.literal(true) }).strict();
const retryItemSchema = z
  .object({
    confirmed: z.literal(true),
    itemId: z.string().trim().min(1).max(200),
  })
  .strict();
const operationIdSchema = z.string().trim().min(1).max(200);

function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new ApiError(
      403,
      "SAME_ORIGIN_REQUIRED",
      "Operation commands require an exact same-origin request",
    );
  }
}

function operationApiError(error: unknown) {
  if (error instanceof ZodError) {
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      "The operation command is invalid",
      error.issues,
    );
  }
  if (error instanceof OperationNotFoundError) {
    return new ApiError(404, "OPERATION_NOT_FOUND", error.message);
  }
  if (error instanceof OperationStateError) {
    return new ApiError(409, "OPERATION_STATE_CONFLICT", error.message);
  }
  if (error instanceof OperationQueueUnavailableError) {
    return new ApiError(503, "OPERATION_QUEUE_UNAVAILABLE", error.message, {
      committed: true,
      operationId: error.operationId,
    });
  }
  if (error instanceof Response) {
    return new ApiError(
      error.status,
      error.status === 403 ? "EVENT_FORBIDDEN" : "OPERATION_REQUEST_FAILED",
      error.statusText || "The operation request failed",
    );
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
        "Operation commands require POST",
      );
    }
    requireSameOrigin(request);
    if (!params.eventId) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    }
    const command = commandSchema.parse(params.command);
    const operationId = operationIdSchema.parse(params.operationId);
    const viewer = await requireEventRole(
      request,
      env,
      params.eventId,
      ["owner", "administrator"],
      "response",
    );
    const raw = await readJson(request, 8_000);
    const service = new OperationService(env);
    if (command === "retry-item") {
      const input = retryItemSchema.parse(raw);
      await service.retryItem(viewer, operationId, input.itemId);
      return apiSuccess({
        operationId,
        itemId: input.itemId,
        status: "queued",
        correlationId: requestCorrelationId,
      });
    }
    confirmedSchema.parse(raw);
    if (command === "retry") {
      await service.retry(viewer, operationId);
      return apiSuccess({
        operationId,
        status: "queued",
        correlationId: requestCorrelationId,
      });
    }
    await service.cancel(viewer, operationId);
    return apiSuccess({
      operationId,
      status: "cancelled",
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    return apiFailure(
      operationApiError(error),
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
  }
}

export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const response = apiFailure(
    new ApiError(405, "METHOD_NOT_ALLOWED", "Operation commands require POST"),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "POST");
  return response;
}
