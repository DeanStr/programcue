import { ZodError } from "zod";

import type { Route } from "./+types/api-tasks";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  readJson,
  requireApiKey,
  requireIdempotencyKey,
  requireApiMethod,
} from "~/platform/api/api.server";
import { notifyApiChange } from "~/platform/api/api-realtime.server";
import {
  ApiTaskService,
  apiTaskListQuerySchema,
} from "~/platform/api/api-task-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

function validationError(error: ZodError) {
  return new ApiError(
    422,
    "VALIDATION_ERROR",
    "The task request is invalid",
    error.issues,
  );
}

function parseTaskListQuery(url: URL) {
  const keys = [...new Set(url.searchParams.keys())];
  const values = Object.fromEntries(
    keys.map((key) => [key, url.searchParams.get(key)]),
  );
  const repeated = ["limit", "cursor"].find(
    (key) => url.searchParams.getAll(key).length > 1,
  );
  if (repeated) {
    throw new ApiError(
      422,
      "VALIDATION_ERROR",
      `${repeated} may only be supplied once`,
    );
  }
  return apiTaskListQuerySchema.parse(values);
}

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    if (!params.eventId)
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    const authenticated = await requireApiKey(
      request,
      env,
      "tasks:read",
      params.eventId,
    );
    const principal = { ...authenticated, eventId: params.eventId };
    const query = parseTaskListQuery(new URL(request.url));
    const page = await new ApiTaskService(env).list(principal, query);
    return apiSuccess({ ...page, correlationId: requestCorrelationId });
  } catch (error) {
    return apiFailure(
      error instanceof ZodError ? validationError(error) : error,
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
    requireApiMethod(request, "POST");
    if (!params.eventId)
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    const authenticated = await requireApiKey(
      request,
      env,
      "tasks:write",
      params.eventId,
    );
    const principal = { ...authenticated, eventId: params.eventId };
    const idempotencyKey = requireIdempotencyKey(request);
    const result = await new ApiTaskService(env).create(
      principal,
      await readJson(request, 64_000),
      requestCorrelationId,
      idempotencyKey,
    );
    const realtime = await notifyApiChange(
      env,
      principal,
      result.changeSequence,
      result.task.id,
    );
    const webhookWarning = result.webhookDeliveries.some(
      (delivery) => delivery.status === "queue_failed",
    )
      ? "The task was created, but one or more outbound webhook deliveries require retry."
      : null;
    return apiSuccess(
      {
        task: result.task,
        changeCursor: realtime.changeCursor,
        realtimeWarning: realtime.realtimeWarning,
        webhookDeliveries: result.webhookDeliveries.map(
          ({ duplicate: _duplicate, ...delivery }) => delivery,
        ),
        webhookWarning,
        correlationId: requestCorrelationId,
      },
      201,
    );
  } catch (error) {
    return apiFailure(
      error instanceof ZodError ? validationError(error) : error,
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
  }
}
