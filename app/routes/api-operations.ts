import type { Route } from "./+types/api-operations";
import { ApiError, apiFailure, apiSuccess, correlationId, requireApiKey } from "~/platform/api/api.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  try {
    if (!params.eventId) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    const principal = await requireApiKey(request, env, "operations:read", params.eventId);
    const rawLimit = new URL(request.url).searchParams.get("limit") ?? "100";
    const limit = Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
      throw new ApiError(422, "VALIDATION_ERROR", "limit must be a whole number from 1 to 200");
    }
    const result = await env.DB.prepare(`
      SELECT o.id, o.type, o.status, o.idempotency_key AS idempotencyKey,
             o.correlation_id AS operationCorrelationId,
             o.progress_total AS progressTotal, o.progress_completed AS progressCompleted,
             o.progress_failed AS progressFailed, o.attempt_count AS attemptCount,
             o.last_error AS lastError, o.created_at AS createdAt,
             o.updated_at AS updatedAt, o.completed_at AS completedAt
        FROM operation_jobs o
        JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
       WHERE o.event_id = ?
       ORDER BY o.created_at DESC LIMIT ?
    `).bind(principal.organisationId, params.eventId, limit).all();
    return apiSuccess({ operations: result.results, correlationId: correlationId(request) });
  } catch (error) {
    return apiFailure(error, request, env.APP_ENV);
  }
}

export function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const response = apiFailure(
    new ApiError(405, "METHOD_NOT_ALLOWED", "The operations collection is read-only; domain workflows create background work."),
    request,
    env.APP_ENV,
  );
  response.headers.set("allow", "GET");
  return response;
}
