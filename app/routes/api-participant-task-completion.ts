import { ZodError } from "zod";
import {
  TaskService,
  TaskStateError,
} from "~/modules/tasks/task-service.server";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  readJson,
  requireIdempotencyKey,
} from "~/platform/api/api.server";
import { apiParticipantTaskCompletionSchema } from "~/platform/api/api-command-contract";
import { ApiParticipantService } from "~/platform/api/api-participant-service.server";
import { ApiPersonIdempotencyService } from "~/platform/api/api-person-idempotency.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/api-participant-task-completion";

function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new ApiError(
      403,
      "SAME_ORIGIN_REQUIRED",
      "Participant task completion requires an exact same-origin request",
    );
  }
}

function participantTaskError(error: unknown) {
  if (error instanceof ZodError) {
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      "The task-completion command is invalid",
      error.issues,
    );
  }
  if (error instanceof TaskStateError) {
    return new ApiError(409, "TASK_STATE_CONFLICT", error.message);
  }
  if (error instanceof Response) {
    return new ApiError(
      error.status,
      error.status === 403 ? "AUTH_FORBIDDEN" : "TASK_REQUEST_FAILED",
      error.statusText || "The task-completion request failed",
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
        "Participant task completion requires POST",
      );
    }
    requireSameOrigin(request);
    if (!params.eventId || !params.taskId) {
      throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");
    }
    const viewer = await requireEventRole(
      request,
      env,
      params.eventId,
      ["speaker", "submitter"],
      "response",
    );
    const input = apiParticipantTaskCompletionSchema.parse(
      await readJson(request, 32_000),
    );
    if (input.taskId !== params.taskId) {
      throw new ApiError(
        422,
        "PATH_BODY_MISMATCH",
        "body.taskId must match the URL task identifier",
      );
    }
    const participantService = new ApiParticipantService(env);
    const loadResult = (operationId: string) =>
      participantService.recoverTaskCompletion(
        viewer,
        input.taskId,
        input.revision,
        operationId,
      );
    const response = await new ApiPersonIdempotencyService(env).run({
      viewer,
      scope: "api.participant-task.complete",
      idempotencyKey: requireIdempotencyKey(request),
      input,
      execute: async (commandId) => {
        await new TaskService(env).completeParticipant(
          viewer,
          input,
          commandId,
        );
        const result = await loadResult(commandId);
        if (!result)
          throw new Error("The completed task result is unavailable.");
        return result;
      },
      recover: loadResult,
    });
    return apiSuccess({
      result: { ...response.result, replayed: response.replayed },
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    return apiFailure(
      participantTaskError(error),
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
      "Participant task completion requires POST",
    ),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "POST");
  return response;
}
