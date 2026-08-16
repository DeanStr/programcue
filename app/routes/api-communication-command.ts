import { ZodError, z } from "zod";
import { CommunicationDeliveryService } from "~/modules/communications/communication-delivery-service.server";
import {
  confirmCommunicationSchema,
  previewCommunicationSchema,
  scheduleCommunicationSchema,
  testCommunicationSchema,
} from "~/modules/communications/communication-schema";
import {
  CommunicationNotFoundError,
  CommunicationQueueUnavailableError,
  CommunicationStateError,
} from "~/modules/communications/communication-service-shared";
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
import type { Route } from "./+types/api-communication-command";

const commandSchemas = {
  preview: previewCommunicationSchema
    .extend({ kind: z.enum(["transactional", "optional"]) })
    .strict(),
  send: confirmCommunicationSchema
    .extend({ kind: z.enum(["transactional", "optional"]) })
    .strict(),
  schedule: scheduleCommunicationSchema
    .extend({ kind: z.enum(["transactional", "optional"]) })
    .strict(),
  test: testCommunicationSchema.strict(),
};

function command(value: string | undefined): keyof typeof commandSchemas {
  if (value && Object.hasOwn(commandSchemas, value)) {
    return value as keyof typeof commandSchemas;
  }
  throw new ApiError(
    404,
    "COMMUNICATION_COMMAND_NOT_FOUND",
    "Communication command not found",
  );
}

function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new ApiError(
      403,
      "SAME_ORIGIN_REQUIRED",
      "Communication commands require an exact same-origin request",
    );
  }
}

function communicationApiError(error: unknown) {
  if (error instanceof ZodError) {
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      "The communication command is invalid",
      error.issues,
    );
  }
  if (error instanceof CommunicationNotFoundError) {
    return new ApiError(404, "COMMUNICATION_NOT_FOUND", error.message);
  }
  if (error instanceof CommunicationStateError) {
    return new ApiError(409, "COMMUNICATION_STATE_CONFLICT", error.message);
  }
  if (error instanceof CommunicationQueueUnavailableError) {
    return new ApiError(503, "COMMUNICATION_QUEUE_UNAVAILABLE", error.message, {
      committed: true,
      operationId: error.operationId,
    });
  }
  if (error instanceof Response) {
    return new ApiError(
      error.status,
      error.status === 403 ? "EVENT_FORBIDDEN" : "COMMUNICATION_REQUEST_FAILED",
      error.statusText || "The communication request failed",
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
        "Communication commands require POST",
      );
    }
    requireSameOrigin(request);
    if (!params.eventId) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    }
    const selected = command(params.command);
    const viewer = await requireEventRole(
      request,
      env,
      params.eventId,
      ["owner", "administrator"],
      "response",
    );
    const raw = await readJson(
      request,
      selected === "preview" ? 64_000 : 32_000,
    );
    const service = new CommunicationDeliveryService(env);
    if (selected === "preview") {
      const input = commandSchemas.preview.parse(raw);
      return apiSuccess({
        result: await service.preview(viewer, input),
        correlationId: requestCorrelationId,
      });
    }
    const headerKey = requireIdempotencyKey(request);
    if (selected === "send") {
      const input = commandSchemas.send.parse(raw);
      if (input.idempotencyKey !== headerKey) {
        throw new ApiError(
          422,
          "IDEMPOTENCY_KEY_MISMATCH",
          "The Idempotency-Key header must match body.idempotencyKey",
        );
      }
      return apiSuccess({
        result: await service.confirm(viewer, input),
        correlationId: requestCorrelationId,
      });
    }
    if (selected === "schedule") {
      const input = commandSchemas.schedule.parse(raw);
      if (input.idempotencyKey !== headerKey) {
        throw new ApiError(
          422,
          "IDEMPOTENCY_KEY_MISMATCH",
          "The Idempotency-Key header must match body.idempotencyKey",
        );
      }
      return apiSuccess({
        result: await service.schedule(viewer, input),
        correlationId: requestCorrelationId,
      });
    }
    const input = commandSchemas.test.parse(raw);
    if (input.idempotencyKey !== headerKey) {
      throw new ApiError(
        422,
        "IDEMPOTENCY_KEY_MISMATCH",
        "The Idempotency-Key header must match body.idempotencyKey",
      );
    }
    return apiSuccess({
      result: await service.testSend(viewer, input),
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    return apiFailure(
      communicationApiError(error),
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
      "Communication commands require POST",
    ),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "POST");
  return response;
}
