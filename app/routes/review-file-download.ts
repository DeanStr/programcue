import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/review-file-download";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!params.assetId) {
    throw new Response("Review attachment not found.", { status: 404 });
  }
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
    "evaluator",
  ]);
  return new EvaluationService(env).downloadReviewerAttachment(
    viewer,
    params.assetId,
  );
}
