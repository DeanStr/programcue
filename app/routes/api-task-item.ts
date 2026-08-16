import { ZodError, z } from "zod";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  requireApiKey,
} from "~/platform/api/api.server";
import { ApiTaskService } from "~/platform/api/api-task-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/api-task-item";

const taskIdSchema = z.string().trim().min(1).max(200);

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    if (!params.eventId) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    }
    const taskId = taskIdSchema.parse(params.taskId);
    const authenticated = await requireApiKey(
      request,
      env,
      "tasks:read",
      params.eventId,
    );
    const task = await new ApiTaskService(env).get(
      { ...authenticated, eventId: params.eventId },
      taskId,
    );
    if (!task) throw new ApiError(404, "TASK_NOT_FOUND", "Task not found");
    return apiSuccess({ task, correlationId: requestCorrelationId });
  } catch (error) {
    return apiFailure(
      error instanceof ZodError
        ? new ApiError(
            422,
            "VALIDATION_ERROR",
            "The task identifier is invalid",
            error.issues,
          )
        : error,
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
  }
}
