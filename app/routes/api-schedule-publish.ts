import { ZodError, z } from "zod";
import {
  ScheduleIdempotencyConflictError,
  ScheduleNotFoundError,
  SchedulePublicationBlockedError,
  ScheduleRevisionConflictError,
  ScheduleService,
} from "~/modules/schedule/schedule-service.server";
import {
  ApiError,
  apiFailure,
  apiRequestHash,
  apiSuccess,
  correlationId,
  readJson,
  requireApiKey,
  requireApiMethod,
  requireIdempotencyKey,
} from "~/platform/api/api.server";
import { notifyApiChange } from "~/platform/api/api-realtime.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/api-schedule-publish";

const apiSchedulePublishSchema = z
  .object({
    scheduleVersionId: z.string().trim().min(1).max(200),
    scheduleRevision: z.number().int().positive(),
  })
  .strict();

function routeError(error: unknown) {
  if (error instanceof ZodError) {
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      "The schedule publication request is invalid",
      error.issues,
    );
  }
  if (error instanceof ScheduleRevisionConflictError) {
    return new ApiError(409, "SCHEDULE_REVISION_CONFLICT", error.message);
  }
  if (error instanceof SchedulePublicationBlockedError) {
    return new ApiError(409, "SCHEDULE_NOT_PUBLISHABLE", error.message, {
      conflicts: error.conflicts,
    });
  }
  if (error instanceof ScheduleNotFoundError) {
    return new ApiError(404, "DRAFT_SCHEDULE_NOT_FOUND", error.message);
  }
  if (error instanceof ScheduleIdempotencyConflictError) {
    return new ApiError(409, error.code, error.message);
  }
  return error;
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
      "schedule:publish",
      params.eventId,
    );
    const principal = { ...authenticated, eventId: params.eventId };
    const idempotencyKey = requireIdempotencyKey(request);
    const input = apiSchedulePublishSchema.parse(
      await readJson(request, 32_000),
    );
    const actorId = `api_key:${principal.keyId}`;
    const publication = await new ScheduleService(env).publish(
      principal,
      input,
      {
        personId: null,
        actorId,
      },
      {
        actorId,
        idempotencyKey,
        requestHash: await apiRequestHash(input),
      },
    );
    const scheduleVersionId = input.scheduleVersionId;
    const realtime = await notifyApiChange(
      env,
      principal,
      publication.changeSequence,
      scheduleVersionId,
    );
    return apiSuccess(
      {
        published: true,
        scheduleVersionId,
        changeCursor: realtime.changeCursor,
        realtimeWarning: realtime.realtimeWarning,
        calendar: publication.calendar,
        correlationId: requestCorrelationId,
      },
      publication.calendar.dispatchError || realtime.realtimeWarning
        ? 207
        : 200,
    );
  } catch (error) {
    return apiFailure(
      routeError(error),
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
  }
}
