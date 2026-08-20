import { data } from "react-router";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import type { EvaluationAdminActionContext } from "./evaluation-admin-action-shared.server";

export async function handleEvaluationAdminAssignmentIntent(
  context: EvaluationAdminActionContext,
) {
  const { env, viewer, values, service } = context;
  if (values.get("intent") === "assign") {
    const assignmentTarget = String(values.get("assignmentTarget") ?? "");
    const [targetType, targetId] = assignmentTarget.split(":", 2);
    if (!targetId || (targetType !== "team" && targetType !== "person")) {
      return data(
        { ok: false, error: "Choose an evaluator or evaluation team." },
        { status: 422 },
      );
    }
    const result = await service.assign(viewer, {
      roundId: values.get("roundId"),
      targetType: values.get("targetType"),
      targetIds: values.getAll("targetId"),
      evaluatorPersonIds: targetType === "person" ? [targetId] : [],
      teamId: targetType === "team" ? targetId : null,
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "evaluator_assignment",
      entityId: result.undoOperationId ?? undefined,
      changeType: "created",
    });
    if (realtimeFailure)
      return data(
        {
          ...realtimeFailure,
          undoOperationId: result.undoOperationId,
          undoExpiresAt: result.undoExpiresAt,
        },
        { status: 207 },
      );
    return {
      ok: true,
      message:
        result.createdAssignmentCount === 0
          ? "The requested assignment already existed; no assignment was added."
          : result.createdAssignmentCount === result.requestedAssignmentCount
            ? `${result.createdAssignmentCount} evaluator assignment${result.createdAssignmentCount === 1 ? "" : "s"} created.`
            : `${result.createdAssignmentCount} new evaluator assignment${result.createdAssignmentCount === 1 ? "" : "s"} created; existing assignments were preserved.`,
      undoOperationId: result.undoOperationId,
      undoExpiresAt: result.undoExpiresAt,
    };
  }

  if (values.get("intent") === "undo-assignments") {
    const result = await service.undoAssignments(viewer, {
      operationId: values.get("operationId"),
      confirmed: values.get("confirmed") === "true",
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "evaluator_assignment",
      entityId: String(values.get("operationId") ?? ""),
      changeType: "deleted",
    });
    const message = `${result.undoneAssignmentCount} evaluator assignment${result.undoneAssignmentCount === 1 ? "" : "s"} undone before review work started.`;
    if (realtimeFailure)
      return data(
        {
          ok: false,
          committed: true,
          message: `${message} ${realtimeFailure.message}`,
        },
        { status: 207 },
      );
    return { ok: true, message };
  }

  if (values.get("intent") === "moderate") {
    const status = values.get("moderationStatus");
    const moderationId = await service.moderate(
      viewer,
      {
        roundId: values.get("roundId"),
        submissionId: values.get("submissionId"),
        expectedModerationId: values.get("expectedModerationId") || null,
        recommendation: values.get("recommendation"),
        moderatedScore: values.get("moderatedScore") || null,
        notes: values.get("notes"),
        status,
        confirmed: values.get("confirmed") === "true",
      },
      "admin_ui",
    );
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "review_moderation",
      entityId: moderationId,
      changeType: status === "confirmed" ? "published" : "updated",
    });
    if (realtimeFailure) return data(realtimeFailure, { status: 207 });
    return {
      ok: true,
      message:
        status === "confirmed"
          ? "Moderation confirmed. The submission is ready for a final decision."
          : "Moderation draft saved.",
    };
  }

  if (values.get("intent") === "reopen-review") {
    const result = await service.reopenReview(
      viewer,
      {
        assignmentId: values.get("assignmentId"),
        reason: values.get("reason"),
        confirmed: values.get("confirmed") === "true",
      },
      "admin_ui",
    );
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "review",
      entityId: result.reviewId,
      changeType: "updated",
    });
    const webhookWarning = result.webhookDeliveries.some(
      (delivery) => delivery.status === "queue_failed",
    )
      ? "The change was committed, but one or more outbound webhooks need a queue retry."
      : null;
    if (realtimeFailure || webhookWarning) {
      return data(
        {
          ok: false,
          committed: true,
          message: [realtimeFailure?.message, webhookWarning]
            .filter(Boolean)
            .join(" "),
        },
        { status: 207 },
      );
    }
    return {
      ok: true,
      message:
        "Review reopened. Its submitted revision remains in the audit history.",
    };
  }

  if (values.get("intent") === "advance-round") {
    const assignmentTarget = String(values.get("assignmentTarget") ?? "");
    const [targetType, targetId] = assignmentTarget.split(":", 2);
    if (!targetId || (targetType !== "team" && targetType !== "person")) {
      return data(
        {
          ok: false,
          error: "Choose the evaluators for the next round.",
        },
        { status: 422 },
      );
    }
    const result = await service.advanceRound(viewer, {
      fromRoundId: values.get("fromRoundId"),
      fromRoundRevision: values.get("fromRoundRevision"),
      toRoundId: values.get("toRoundId"),
      toRoundRevision: values.get("toRoundRevision"),
      submissionIds: values.getAll("submissionId"),
      evaluatorPersonIds: targetType === "person" ? [targetId] : [],
      teamId: targetType === "team" ? targetId : null,
      confirmed: values.get("confirmed") === "true",
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "evaluation_round",
      entityId: String(values.get("toRoundId") ?? ""),
      changeType: "updated",
    });
    const webhookWarning = result.webhookDeliveries?.some(
      (delivery) => delivery.status === "queue_failed",
    )
      ? "The change was committed, but one or more outbound webhooks need a queue retry."
      : null;
    if (realtimeFailure || webhookWarning) {
      return data(
        {
          ok: false,
          committed: true,
          message: [realtimeFailure?.message, webhookWarning]
            .filter(Boolean)
            .join(" "),
        },
        { status: 207 },
      );
    }
    return {
      ok: true,
      message: `${result.advancedSubmissionCount} submission${result.advancedSubmissionCount === 1 ? "" : "s"} advanced with ${result.assignmentCount} new assignment${result.assignmentCount === 1 ? "" : "s"}.`,
    };
  }

  return null;
}
