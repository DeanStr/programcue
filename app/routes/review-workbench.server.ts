import {
  data,
  redirect,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";
import { ZodError } from "zod";

import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import {
  EvaluationRevisionConflictError,
  EvaluationService,
  EvaluationStateError,
  EvaluationValidationError,
} from "~/modules/evaluations/evaluation-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export async function loader({ request, context }: LoaderFunctionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
    "evaluator",
  ]);
  await ensureDemoEvaluationData(env);
  const selected = new URL(request.url).searchParams.get("assignment");
  const service = new EvaluationService(env);
  const result = await service.getReviewerWorkbench(
    viewer,
    selected ?? undefined,
  );
  if (result.kind === "selection_recused") throw redirect("/review/workbench");
  const selectedAssignment = result.workspace.selected;
  const manager =
    viewer.role === "owner" ||
    viewer.role === "administrator" ||
    viewer.role === "committee_chair";
  const discussion = selectedAssignment
    ? manager || selectedAssignment.status === "submitted"
      ? {
          available: true as const,
          ...(await service.listDiscussion(viewer, {
            roundId: selectedAssignment.roundId,
            targetType: selectedAssignment.targetType,
            targetId: selectedAssignment.targetId,
          })),
        }
      : {
          available: false as const,
          target: {
            roundId: selectedAssignment.roundId,
            targetType: selectedAssignment.targetType,
            targetId: selectedAssignment.targetId,
          },
          writable: false,
          messages: [],
          postIntentId: crypto.randomUUID(),
        }
    : null;
  return {
    viewer,
    eventName: result.eventName,
    eventTimezone: result.eventTimezone,
    workspace: { ...result.workspace, discussion },
  };
}

export async function action({ request, context }: ActionFunctionArgs) {
  const rejectedOrigin = rejectCrossOriginBrowserMutation(request);
  if (rejectedOrigin) return rejectedOrigin;
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
    "evaluator",
  ]);
  const values = await request.formData();
  const service = new EvaluationService(env);
  const intent = String(values.get("intent") ?? "");
  if (
    intent !== "conflict" &&
    intent !== "save" &&
    intent !== "submit" &&
    intent !== "add-discussion-message"
  ) {
    return data(
      { ok: false, error: "Unsupported review action." },
      { status: 400 },
    );
  }
  try {
    if (intent === "add-discussion-message") {
      const result = await service.addDiscussionMessage(viewer, {
        roundId: values.get("roundId"),
        targetType: values.get("targetType"),
        targetId: values.get("targetId"),
        body: values.get("body"),
        idempotencyKey: values.get("idempotencyKey"),
      });
      return {
        ok: true,
        message: result.replayed
          ? "Discussion message was already added."
          : "Discussion message added.",
      };
    }
    if (intent === "conflict") {
      await service.declareConflict(viewer, {
        assignmentId: values.get("assignmentId"),
        reason: values.get("reason"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluator_assignment",
        entityId: String(values.get("assignmentId") ?? ""),
        changeType: "updated",
      });
      if (realtimeFailure)
        return data(
          {
            ...realtimeFailure,
            clearedAssignmentId: String(values.get("assignmentId") ?? ""),
          },
          { status: 207 },
        );
      return {
        ok: true,
        message:
          "Conflict declared. The assignment was returned for reassignment.",
        clearedAssignmentId: String(values.get("assignmentId") ?? ""),
      };
    }
    const scores: Record<string, FormDataEntryValue> = {};
    for (const [name, value] of values)
      if (name.startsWith("score:")) scores[name.slice(6)] = value;
    const result = await service.saveReview(viewer, {
      assignmentId: values.get("assignmentId"),
      revision: values.get("revision"),
      scores,
      recommendation: values.get("recommendation") || null,
      confidence: values.get("confidence") || null,
      submitterFeedback: values.get("submitterFeedback"),
      privateNotes: values.get("privateNotes"),
      intent,
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "review",
      entityId: result.reviewId,
      changeType: intent === "submit" ? "published" : "updated",
    });
    const webhookWarning = result.webhookDeliveries.some(
      (delivery) => delivery.status === "queue_failed",
    )
      ? "Review submitted, but one or more outbound webhooks need a queue retry."
      : null;
    if (realtimeFailure || webhookWarning)
      return data(
        {
          ok: false,
          committed: true,
          message: [realtimeFailure?.message, webhookWarning]
            .filter(Boolean)
            .join(" "),
          revision: result.revision,
          submittedAssignmentId:
            intent === "submit"
              ? String(values.get("assignmentId") ?? "")
              : null,
          nextAssignmentId:
            intent === "submit" && values.get("openNext") === "true"
              ? result.nextAssignmentId
              : null,
        },
        { status: 207 },
      );
    return {
      ok: true,
      message:
        intent === "submit"
          ? `Review submitted with a weighted score of ${result.weightedScore}.${
              values.get("openNext") === "true" && !result.nextAssignmentId
                ? " Your active review queue is complete."
                : ""
            }`
          : "Review saved.",
      revision: result.revision,
      submittedAssignmentId:
        intent === "submit" ? String(values.get("assignmentId") ?? "") : null,
      nextAssignmentId:
        intent === "submit" && values.get("openNext") === "true"
          ? result.nextAssignmentId
          : null,
    };
  } catch (error) {
    if (error instanceof ZodError)
      return data(
        { ok: false, error: error.issues[0]?.message ?? "Invalid review." },
        { status: 422 },
      );
    if (error instanceof EvaluationRevisionConflictError)
      return data(
        { ok: false, error: error.message, conflict: true },
        { status: 409 },
      );
    if (error instanceof EvaluationStateError)
      return data({ ok: false, error: error.message }, { status: 409 });
    if (error instanceof EvaluationValidationError)
      return data({ ok: false, error: error.message }, { status: 422 });
    if (error instanceof Response) throw error;
    throw error;
  }
}
