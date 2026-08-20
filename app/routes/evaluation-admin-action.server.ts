import { type ActionFunctionArgs, data } from "react-router";
import { ZodError } from "zod";
import {
  AiReviewAssessmentConflictError,
  AiReviewAssessmentStateError,
} from "~/modules/ai/ai-review-assessment.server";
import {
  AiConfigurationError,
  AiProviderError,
} from "~/modules/ai/openai-responses-provider.server";
import { ReviewerAiSuggestionStateError } from "~/modules/ai/reviewer-ai-suggestion.server";
import {
  EvaluationDecisionAuthorityError,
  EvaluationDecisionFinalError,
  EvaluationDemoActivationError,
  EvaluationInvitationDeliveryError,
  EvaluationRevisionConflictError,
  EvaluationService,
  EvaluationStateError,
  EvaluationValidationError,
} from "~/modules/evaluations/evaluation-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import { handleEvaluationAdminAccessIntent } from "./evaluation-admin-access-actions.server";
import { handleEvaluationAdminAiIntent } from "./evaluation-admin-ai-actions.server";
import { handleEvaluationAdminAssignmentIntent } from "./evaluation-admin-assignment-actions.server";
import { handleEvaluationAdminDecisionIntent } from "./evaluation-admin-decision-actions.server";
import { handleEvaluationAdminPlanIntent } from "./evaluation-admin-plan-actions.server";

export async function action({ request, context }: ActionFunctionArgs) {
  const rejectedOrigin = rejectCrossOriginBrowserMutation(request);
  if (rejectedOrigin) return rejectedOrigin;
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  const values = await request.formData();
  const service = new EvaluationService(env);
  const actionContext = { env, viewer, values, service };
  try {
    const result =
      (await handleEvaluationAdminAiIntent(actionContext)) ??
      (await handleEvaluationAdminAccessIntent(actionContext)) ??
      (await handleEvaluationAdminPlanIntent(actionContext)) ??
      (await handleEvaluationAdminAssignmentIntent(actionContext)) ??
      (await handleEvaluationAdminDecisionIntent(actionContext));
    if (result == null) {
      return data(
        { ok: false, error: "Unsupported evaluation action." },
        { status: 400 },
      );
    }
    return result;
  } catch (error) {
    if (error instanceof ZodError)
      return data(
        {
          ok: false,
          error: error.issues[0]?.message ?? "Invalid evaluation input.",
        },
        { status: 422 },
      );
    if (error instanceof EvaluationInvitationDeliveryError) {
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "membership",
        entityId: error.membershipId,
        changeType: "created",
      });
      return data(
        {
          ok: false,
          committed: true,
          message: realtimeFailure
            ? `${error.message} ${realtimeFailure.message}`
            : error.message,
        },
        { status: 207 },
      );
    }
    if (error instanceof EvaluationDemoActivationError) {
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "membership",
        entityId: error.membershipId,
        changeType: "created",
      });
      return data(
        {
          ok: false,
          committed: true,
          message: realtimeFailure
            ? `${error.message} ${realtimeFailure.message}`
            : error.message,
        },
        { status: 207 },
      );
    }
    if (error instanceof EvaluationRevisionConflictError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof EvaluationStateError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof EvaluationValidationError)
      return data({ ok: false, error: error.message }, { status: 422 });
    if (error instanceof EvaluationDecisionFinalError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof EvaluationDecisionAuthorityError)
      return data({ ok: false, error: error.message }, { status: 403 });
    if (error instanceof AiReviewAssessmentConflictError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof AiReviewAssessmentStateError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof ReviewerAiSuggestionStateError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof AiConfigurationError)
      return data({ ok: false, error: error.message }, { status: 503 });
    if (error instanceof AiProviderError)
      return data({ ok: false, error: error.message }, { status: 502 });
    if (error instanceof Response) throw error;
    throw error;
  }
}
