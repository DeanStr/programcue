import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import {
  EvaluationResultsExportIdempotencyConflictError,
  EvaluationResultsExportRoundNotFoundError,
  EvaluationResultsExportService,
  EvaluationResultsExportTooLargeError,
} from "~/modules/evaluations/evaluation-results-export.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";

export function loader() {
  return new Response("Abstract results exports require POST.", {
    status: 405,
    headers: {
      allow: "POST",
      "cache-control": "private, no-store",
    },
  });
}

export async function action({ request, context }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") return loader();
  const rejectedOrigin = rejectCrossOriginBrowserMutation(request);
  if (rejectedOrigin) return rejectedOrigin;

  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  const form = await request.formData();
  const intentKey = z.uuid().safeParse(form.get("idempotencyKey"));
  if (!intentKey.success) {
    throw new Response("A valid export intent key is required.", {
      status: 422,
      headers: { "cache-control": "private, no-store" },
    });
  }
  const roundId = z
    .string()
    .trim()
    .min(1)
    .max(128)
    .safeParse(new URL(request.url).searchParams.get("round"));
  if (!roundId.success) {
    throw new Response("Choose an evaluation round to export.", {
      status: 422,
      headers: { "cache-control": "private, no-store" },
    });
  }
  try {
    const result = await new EvaluationResultsExportService(env).create(
      viewer,
      roundId.data,
      intentKey.data,
    );
    return new Response(result.body, {
      headers: {
        "content-type": "text/csv; charset=utf-8",
        "content-disposition": `attachment; filename="${result.filename}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
        "x-program-cue-operation": result.operationId,
      },
    });
  } catch (error) {
    if (error instanceof EvaluationResultsExportRoundNotFoundError) {
      throw new Response(error.message, {
        status: 404,
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (error instanceof EvaluationResultsExportTooLargeError) {
      throw new Response(error.message, {
        status: 413,
        headers: { "cache-control": "private, no-store" },
      });
    }
    if (error instanceof EvaluationResultsExportIdempotencyConflictError) {
      throw new Response(error.message, {
        status: 409,
        headers: { "cache-control": "private, no-store" },
      });
    }
    throw error;
  }
}
