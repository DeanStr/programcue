import { data } from "react-router";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import {
  decisionReopenFlash,
  type EvaluationAdminActionContext,
} from "./evaluation-admin-action-shared.server";
import { decisionActionOutcome } from "./evaluation-admin-outcomes";

export async function handleEvaluationAdminDecisionIntent(
  context: EvaluationAdminActionContext,
) {
  const { env, viewer, values, service } = context;
  if (values.get("intent") === "decide") {
    const released = values.get("release") === "true";
    const result = await service.decide(viewer, {
      submissionId: values.get("submissionId"),
      decision: values.get("decision"),
      rationale: values.get("rationale"),
      includeReviewerFeedback: values.get("includeReviewerFeedback") === "true",
      release: released,
      confirmedWithoutReview: values.get("confirmedWithoutReview") === "true",
      sessionTrackId: values.get("sessionTrackId") || null,
      sessionFormatKey: values.get("sessionFormatKey") || null,
      sessionDurationMinutes: values.get("sessionDurationMinutes") || null,
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "submission_decision",
      entityId: result.decisionId,
      changeType: released ? "published" : "updated",
    });
    const webhookDeliveries =
      "webhookDeliveries" in result ? (result.webhookDeliveries ?? []) : [];
    const webhookWarning = webhookDeliveries.some(
      (delivery) => delivery.status === "queue_failed",
    )
      ? "The change was committed, but one or more outbound webhooks need a queue retry."
      : null;
    const outcome = decisionActionOutcome(
      result.notificationStatus,
      released,
      realtimeFailure,
      webhookWarning,
      result.speakerInvitationStatus,
      result.speakerInvitationCount,
    );
    if (outcome.partial) {
      return data(
        {
          ok: false,
          committed: true,
          entityId: result.decisionId,
          message: outcome.message,
        },
        { status: 207 },
      );
    }
    return {
      ok: true,
      message: outcome.message,
    };
  }

  if (values.get("intent") === "reopen-decision") {
    const result = await service.reopenDecision(viewer, {
      submissionId: values.get("submissionId"),
      reason: values.get("reason"),
      confirmed: values.get("confirmed") === "true",
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "submission_decision",
      entityId: result.decisionId,
      changeType: "updated",
    });
    if (realtimeFailure) {
      return data(
        {
          ok: false,
          committed: true,
          message: `Decision reopened. ${realtimeFailure.message}`,
        },
        { status: 207 },
      );
    }
    return {
      ok: true,
      message: decisionReopenFlash(result),
    };
  }

  return null;
}
