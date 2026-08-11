import { z, ZodError } from "zod";

import type { Route } from "./+types/api-direct-sessions";
import { sessionFormatInputSchema } from "~/modules/events/event-schema";
import {
  SubmissionService,
  type SubmissionApiActor,
} from "~/modules/submissions/submission-service.server";
import { SubmissionStateError } from "~/modules/submissions/submission-repository.server";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  readJson,
  requireApiKey,
  requireApiMethod,
  requireIdempotencyKey,
} from "~/platform/api/api.server";
import { recordIdempotentApiChange } from "~/platform/api/api-realtime.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { WebhookService } from "~/platform/operations/webhook-service.server";

const speakerSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
    biography: z.string().trim().max(5_000).default(""),
  })
  .strict();
const directSessionApiSchema = z
  .object({
    title: z.string().trim().min(3).max(180),
    description: z.string().trim().max(3_000).default(""),
    trackId: z.string().trim().min(1).max(100),
    format: sessionFormatInputSchema.shape.key,
    durationMinutes: z.number().int().min(5).max(480).optional(),
    speakers: z
      .array(speakerSchema)
      .min(1)
      .max(20)
      .superRefine((speakers, context) => {
        const emails = speakers.map((speaker) => speaker.email);
        if (new Set(emails).size !== emails.length) {
          context.addIssue({
            code: "custom",
            path: [],
            message: "Each speaker must use a different email address",
          });
        }
      }),
  })
  .strict();

function directSessionApiError(error: unknown) {
  if (error instanceof ZodError) {
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      "The direct-session command is invalid",
      error.issues,
    );
  }
  if (error instanceof SubmissionStateError) {
    return new ApiError(409, "SESSION_STATE_CONFLICT", error.message);
  }
  if (error instanceof Response && error.status === 404) {
    return new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
  }
  return error;
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    requireApiMethod(request, "POST");
    if (!params.eventId) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    }
    const authenticated = await requireApiKey(
      request,
      env,
      "sessions:write",
      params.eventId,
    );
    const idempotencyKey = requireIdempotencyKey(request);
    const input = directSessionApiSchema.parse(
      await readJson(request, 128_000),
    );
    const actor: SubmissionApiActor = {
      kind: "api_key",
      organisationId: authenticated.organisationId,
      eventId: params.eventId,
      personId: null,
      actorId: `api_key:${authenticated.keyId}`,
    };
    const created = await new SubmissionService(env).createDirectSessionForApi(
      actor,
      { ...input, idempotencyKey },
    );
    const sessionId = created.sessionId;
    const realtime = await recordIdempotentApiChange(
      env,
      { ...authenticated, eventId: params.eventId },
      {
        entityType: "session",
        entityId: sessionId,
        changeType: "created",
        correlationId: `api-direct-session:${sessionId}`,
      },
    );
    let webhookDeliveries: Awaited<ReturnType<WebhookService["queueEvent"]>> =
      [];
    let webhookWarning: string | null = null;
    try {
      webhookDeliveries = await new WebhookService(env).queueEvent(actor, {
        eventType: "session.created",
        entityType: "session",
        entityId: sessionId,
        idempotencyKey: `session.created:${sessionId}`,
        correlationId: requestCorrelationId,
        data: { source: "api_direct_entry" },
      });
      if (
        webhookDeliveries.some((delivery) => delivery.status === "queue_failed")
      ) {
        webhookWarning =
          "The session was created, but one or more outbound webhook deliveries require retry.";
      }
    } catch (error) {
      console.error("Failed to record direct-session API webhook", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      webhookWarning =
        "The session was created, but its outbound webhook event could not be recorded.";
    }
    return apiSuccess(
      {
        session: { id: sessionId, status: "unscheduled" },
        replayed: created.replayed,
        changeCursor: realtime.changeCursor,
        realtimeWarning: realtime.realtimeWarning,
        webhookDeliveries: webhookDeliveries.map(
          ({ duplicate: _duplicate, ...delivery }) => delivery,
        ),
        webhookWarning,
        correlationId: requestCorrelationId,
      },
      201,
    );
  } catch (error) {
    return apiFailure(
      directSessionApiError(error),
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
      "Direct sessions are created with POST",
    ),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "POST");
  return response;
}
