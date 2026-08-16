import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
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
import {
  apiAssignmentSchema,
  apiEvaluationPlanSchema,
  apiNextRoundSchema,
  apiRoundReviewerSchema,
  evaluationApiError,
} from "~/platform/api/api-evaluation-commands.server";
import {
  ApiEvaluationService,
  parseEvaluationQuery,
  parseEvaluationResource,
} from "~/platform/api/api-evaluation-service.server";
import { isoTimestamp } from "~/platform/api/api-pagination.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/api-evaluation-resources";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    if (!params.eventId)
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    const resource = parseEvaluationResource(params.resource);
    const authenticated = await requireApiKey(
      request,
      env,
      "evaluation:read",
      params.eventId,
    );
    const input = parseEvaluationQuery(request, resource);
    const page = await new ApiEvaluationService(env).list(
      { ...authenticated, eventId: params.eventId },
      resource,
      input,
    );
    return apiSuccess({ ...page, correlationId: requestCorrelationId });
  } catch (error) {
    return apiFailure(
      error,
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
    const resource = parseEvaluationResource(params.resource);
    if (
      !(
        resource === "plans" ||
        resource === "rounds" ||
        resource === "round-reviewers" ||
        resource === "assignments"
      )
    ) {
      throw new ApiError(
        405,
        "METHOD_NOT_ALLOWED",
        "This evaluation API collection is read-only",
      );
    }
    const authenticated = await requireApiKey(
      request,
      env,
      "evaluation:write",
      params.eventId,
    );
    const idempotencyKey = requireIdempotencyKey(request);
    const raw = await readJson(request, 256_000);
    const service = new EvaluationService(env);
    const actor = {
      kind: "api_key" as const,
      organisationId: authenticated.organisationId,
      eventId: params.eventId,
      personId: null,
      actorId: `api_key:${authenticated.keyId}`,
    };
    if (resource === "plans") {
      const input = apiEvaluationPlanSchema.parse(raw);
      const planId = await service.savePlan(actor, input, {
        idempotencyKey,
        requestHash: await apiRequestHash(input),
      });
      return apiSuccess({ planId, correlationId: requestCorrelationId });
    }
    if (resource === "rounds") {
      const input = apiNextRoundSchema.parse(raw);
      const roundId = await service.addNextRound(actor, input, {
        idempotencyKey,
        requestHash: await apiRequestHash(input),
      });
      return apiSuccess({ roundId, correlationId: requestCorrelationId });
    }
    if (resource === "round-reviewers") {
      const input = apiRoundReviewerSchema.parse(raw);
      const result = await service.changeRoundReviewerPool(actor, input, {
        idempotencyKey,
        requestHash: await apiRequestHash(input),
      });
      return apiSuccess({ ...result, correlationId: requestCorrelationId });
    }
    const input = apiAssignmentSchema.parse(raw);
    const result = await service.assign(actor, input, {
      idempotencyKey,
      requestHash: await apiRequestHash(input),
    });
    return apiSuccess({
      ...result,
      undoExpiresAt: isoTimestamp(result.undoExpiresAt),
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    const response = apiFailure(
      evaluationApiError(error),
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
    if (response.status === 405) response.headers.set("allow", "GET, POST");
    return response;
  }
}
