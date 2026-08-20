import { type LoaderFunctionArgs, redirect } from "react-router";

import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import type { EvaluationDiscussionPage } from "~/modules/evaluations/evaluation-discussion-workflows.server";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { isHtmlDocumentRequest } from "~/platform/http/html-navigation";

export async function loader({
  request,
  context,
}: LoaderFunctionArgs): Promise<EvaluationDiscussionPage> {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
    "evaluator",
  ]);
  if (isHtmlDocumentRequest(request)) throw redirect("/review/workbench");
  await ensureDemoEvaluationData(env);
  const search = new URL(request.url).searchParams;
  return new EvaluationService(env).listDiscussion(viewer, {
    roundId: search.get("roundId"),
    targetType: search.get("targetType"),
    targetId: search.get("targetId"),
    cursor: search.get("cursor") ?? undefined,
  });
}
