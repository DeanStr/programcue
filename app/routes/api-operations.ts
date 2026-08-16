import { z } from "zod";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  requireApiKey,
} from "~/platform/api/api.server";
import {
  decodePrivateCursor,
  encodePrivateCursor,
  isoTimestamp,
  parseStrictQuery,
} from "~/platform/api/api-pagination.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { OperationService } from "~/platform/operations/operation-service.server";
import type { Route } from "./+types/api-operations";

const querySchema = z
  .object({
    limit: z
      .string()
      .regex(/^\d+$/u, "limit must be a whole number from 1 to 200")
      .transform(Number)
      .pipe(z.number().int().min(1).max(200))
      .default(100),
    cursor: z.string().trim().min(1).max(512).optional(),
  })
  .strict();

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  try {
    if (!params.eventId)
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    const principal = await requireApiKey(
      request,
      env,
      "operations:read",
      params.eventId,
    );
    const input = parseStrictQuery(request, querySchema);
    const cursor = input.cursor ? decodePrivateCursor(input.cursor) : null;
    const result = await new OperationService(env).listApi(
      { organisationId: principal.organisationId, eventId: params.eventId },
      { limit: input.limit, cursor },
    );
    const page = result.items;
    return apiSuccess({
      operations: page.map((operation) => ({
        ...operation,
        createdAt: isoTimestamp(operation.createdAt),
        updatedAt: isoTimestamp(operation.updatedAt),
        completedAt: isoTimestamp(operation.completedAt),
      })),
      nextCursor:
        result.hasMore && page.length
          ? encodePrivateCursor(page.at(-1)!.createdAt, page.at(-1)!.id)
          : null,
      correlationId: correlationId(request),
    });
  } catch (error) {
    return apiFailure(error, request, env.APP_ENV);
  }
}

export function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const response = apiFailure(
    new ApiError(
      405,
      "METHOD_NOT_ALLOWED",
      "The operations collection is read-only; domain workflows create background work.",
    ),
    request,
    env.APP_ENV,
  );
  response.headers.set("allow", "GET");
  return response;
}
