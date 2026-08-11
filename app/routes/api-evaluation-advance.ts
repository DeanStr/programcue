import type { Route } from "./+types/api-evaluation-advance";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import {
  apiRoundAdvancementSchema,
  evaluationApiError,
} from "~/platform/api/api-evaluation-commands.server";
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
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { WebhookService } from "~/platform/operations/webhook-service.server";

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
      "evaluation:write",
      params.eventId,
    );
    const idempotencyKey = requireIdempotencyKey(request);
    const input = apiRoundAdvancementSchema.parse(
      await readJson(request, 256_000),
    );
    const actor = {
      kind: "api_key" as const,
      organisationId: authenticated.organisationId,
      eventId: params.eventId,
      personId: null,
      actorId: `api_key:${authenticated.keyId}`,
    };
    const result = await new EvaluationService(env).advanceRound(actor, input, {
      idempotencyKey,
      requestHash: await apiRequestHash(input),
    });
    let webhookDeliveries = result.webhookDeliveries ?? [];
    let webhookWarning: string | null = null;
    // Durable API command responses intentionally omit transient delivery
    // metadata. Replaying the stable webhook key both reports current status
    // and redispatches a committed delivery that was never handed to Queue.
    if (!result.webhookDeliveries) {
      try {
        webhookDeliveries = await new WebhookService(env).queueEvent(actor, {
          eventType: "round.advanced",
          entityType: "evaluation_round",
          entityId: input.toRoundId,
          idempotencyKey: `round.advanced:${input.toRoundId}:${input.toRoundRevision + 1}`,
          correlationId: requestCorrelationId,
          data: {
            fromRoundId: input.fromRoundId,
            toRoundId: input.toRoundId,
            advancedSubmissionCount: result.advancedSubmissionCount,
            assignmentCount: result.assignmentCount,
          },
        });
      } catch (error) {
        console.error("Failed to recover API round advancement webhook", {
          errorName: error instanceof Error ? error.name : "UnknownError",
        });
        webhookWarning =
          "The round advanced, but its durable outbound webhook could not be recovered.";
      }
    }
    if (
      !webhookWarning &&
      webhookDeliveries.some((delivery) => delivery.status === "queue_failed")
    ) {
      webhookWarning =
        "The round advanced, but one or more outbound webhook deliveries require retry.";
    }
    return apiSuccess({
      advancedSubmissionCount: result.advancedSubmissionCount,
      assignmentCount: result.assignmentCount,
      webhookDeliveries: webhookDeliveries.map(
        ({ duplicate: _duplicate, ...delivery }) => delivery,
      ),
      webhookWarning,
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    return apiFailure(
      evaluationApiError(error),
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
      "Round advancement must be confirmed with POST",
    ),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "POST");
  return response;
}
