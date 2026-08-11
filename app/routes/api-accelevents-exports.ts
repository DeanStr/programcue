import { z, ZodError } from "zod";

import type { Route } from "./+types/api-accelevents-exports";
import {
  IntegrationService,
  IntegrationStateError,
} from "~/modules/integrations/integration-service.server";
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
import { getCloudflareContext } from "~/platform/cloudflare-context";

const connectionIdSchema = z.string().trim().min(1).max(200);
const previewFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/);
const requestSchema = z.discriminatedUnion("dryRun", [
  z
    .object({
      connectionId: connectionIdSchema,
      dryRun: z.literal(true),
      previewFingerprint: previewFingerprintSchema.optional(),
    })
    .strict(),
  z
    .object({
      connectionId: connectionIdSchema,
      dryRun: z.literal(false),
      previewFingerprint: previewFingerprintSchema,
    })
    .strict(),
]);

function routeError(error: unknown) {
  if (error instanceof ZodError) {
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      "The Accelevents export request is invalid",
      error.issues,
    );
  }
  if (error instanceof IntegrationStateError) {
    if (/queue delivery failed/iu.test(error.message))
      return new ApiError(503, "INTEGRATION_QUEUE_FAILED", error.message);
    if (/not found/iu.test(error.message))
      return new ApiError(404, "INTEGRATION_NOT_FOUND", error.message);
    if (/idempotency key/iu.test(error.message))
      return new ApiError(409, "IDEMPOTENCY_KEY_REUSED", error.message);
    return new ApiError(409, "INTEGRATION_STATE_CONFLICT", error.message);
  }
  if (error instanceof Response) {
    return new ApiError(
      error.status,
      error.status === 403 ? "AUTH_FORBIDDEN" : "INTEGRATION_REQUEST_FAILED",
      error.statusText || "The integration request failed",
    );
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
      "integrations:write",
      params.eventId,
    );
    const idempotencyKey = requireIdempotencyKey(request);
    const input = requestSchema.parse(await readJson(request, 16_000));
    const result = await new IntegrationService(env).startRun(
      {
        kind: "api_key",
        organisationId: authenticated.organisationId,
        eventId: params.eventId,
        personId: null,
        actorId: `api_key:${authenticated.keyId}`,
      },
      { ...input, idempotencyKey },
    );
    return apiSuccess(
      { ...result, correlationId: requestCorrelationId },
      result.replayed ? 200 : result.queued ? 202 : 201,
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

export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const response = apiFailure(
    new ApiError(
      405,
      "METHOD_NOT_ALLOWED",
      "Accelevents exports must be started with POST",
    ),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "POST");
  return response;
}
