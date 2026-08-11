import { data } from "react-router";
import { ZodError } from "zod";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import {
  EvaluationDecisionAuthorityError,
  EvaluationDecisionFinalError,
  EvaluationInvitationDeliveryError,
  EvaluationRevisionConflictError,
  EvaluationService,
  EvaluationStateError,
  EvaluationValidationError,
} from "~/modules/evaluations/evaluation-service.server";
import { EventService } from "~/modules/events/event-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/evaluation-admin";
import {
  canReleaseEvaluationDecisions,
  decisionActionOutcome,
} from "./evaluation-admin-outcomes";

function readRubricCriteria(values: FormData) {
  const names = values.getAll("criterionName").map(String);
  const descriptions = values.getAll("criterionDescription").map(String);
  const inputTypes = values.getAll("criterionInputType").map(String);
  const weights = values.getAll("criterionWeight").map(String);
  const required = values.getAll("criterionRequired").map(String);
  return names
    .map((name, index) => ({
      id: crypto.randomUUID(),
      name,
      description: descriptions[index],
      inputType: inputTypes[index],
      weightPercent: weights[index],
      required:
        required[index] === "true"
          ? true
          : required[index] === "false"
            ? false
            : undefined,
      position: index,
    }))
    .filter((criterion) => criterion.name.trim())
    .map((criterion, position) => ({ ...criterion, position }));
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  await ensureDemoEvaluationData(env);
  const [workspace, event] = await Promise.all([
    new EvaluationService(env).getAdminWorkspace(viewer),
    new EventService(env).getSetup(viewer),
  ]);
  const search = new URL(request.url).searchParams;
  const unassignedOnly = search.get("filter") === "unassigned";
  const requestedRoundId = search.get("round")?.trim() ?? "";
  if (requestedRoundId.length > 200)
    throw new Response("Invalid evaluation round focus", { status: 400 });
  if (
    requestedRoundId &&
    !workspace.plan?.rounds.some((round) => round.id === requestedRoundId)
  )
    throw new Response("Evaluation round not found in this event", {
      status: 404,
    });
  return {
    ...workspace,
    canReleaseDecisions: canReleaseEvaluationDecisions(
      viewer.role,
      workspace.plan,
    ),
    canManageEvaluationAccess:
      viewer.role === "owner" || viewer.role === "administrator",
    submissions: unassignedOnly
      ? workspace.submissions.filter(
          (submission) => submission.assignmentCount === 0,
        )
      : workspace.submissions,
    unassignedOnly,
    focusedRoundId: requestedRoundId || null,
    totalSubmissionCount: workspace.submissions.length,
    eventTimezone: event.timezone,
    acceptedSpeakerInvitationResendEnabled: String(env.DEMO_MODE) !== "true",
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
    "committee_chair",
  ]);
  const values = await request.formData();
  const service = new EvaluationService(env);
  try {
    if (values.get("intent") === "resend-accepted-speaker") {
      const result = await service.resendAcceptedSpeakerInvitation(viewer, {
        decisionId: values.get("decisionId"),
        membershipId: values.get("membershipId"),
        expectedExpiresAt: values.get("expectedExpiresAt"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "membership",
        entityId: String(values.get("membershipId") ?? ""),
        changeType: "updated",
      });
      const message =
        result.status === "queue_failed"
          ? "The speaker invitation was renewed, but its saved delivery needs a queue retry."
          : result.status === "sent"
            ? "The renewed speaker invitation was already delivered."
            : result.replayed
              ? "The renewed speaker invitation is already queued."
              : "A new seven-day speaker sign-in invitation was queued; every earlier link is invalid.";
      if (result.status === "queue_failed" || realtimeFailure) {
        return data(
          {
            ok: false,
            committed: true,
            message: [message, realtimeFailure?.message]
              .filter(Boolean)
              .join(" "),
          },
          { status: 207 },
        );
      }
      return { ok: true, message };
    }
    if (values.get("intent") === "invite-evaluation-member") {
      const result = await service.inviteEvaluationMember(viewer, {
        name: values.get("name"),
        email: values.get("email"),
        role: values.get("role"),
        teamId: values.get("teamId") || null,
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "membership",
        entityId: result.membershipId,
        changeType: "created",
      });
      const roleLabel =
        values.get("role") === "committee_chair"
          ? "Committee-chair"
          : "Evaluator";
      const message =
        result.delivery === "sent"
          ? `${roleLabel} invitation created and a one-time sign-in link was sent.`
          : `Demo ${roleLabel.toLowerCase()} invitation created in D1. No email was sent in explicit demo mode.`;
      if (realtimeFailure) {
        return data(
          {
            ok: false,
            committed: true,
            message: `${message} ${realtimeFailure.message}`,
          },
          { status: 207 },
        );
      }
      return { ok: true, message };
    }
    if (values.get("intent") === "change-chair-access") {
      const result = await service.changeCommitteeChairAccess(viewer, {
        personId: values.get("personId"),
        operation: values.get("operation"),
        confirmed: values.get("confirmed") === "true",
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "membership",
        entityId: result.membershipId,
        changeType: "updated",
      });
      const message =
        result.operation === "promote"
          ? "Evaluator promoted to committee chair."
          : "Committee-chair access revoked; named team-chair positions were cleared.";
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
    if (values.get("intent") === "create-plan") {
      const criteria = readRubricCriteria(values);
      const planId = await service.savePlan(viewer, {
        revision: 0,
        name: values.get("planName"),
        status: "active",
        decisionRole: values.get("decisionRole"),
        rounds: [
          {
            id: crypto.randomUUID(),
            name: values.get("roundName"),
            anonymous: values.get("anonymous") === "true",
            criteria,
          },
        ],
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluation_plan",
        entityId: planId,
        changeType: "created",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return { ok: true, message: "Evaluation plan created." };
    }
    if (values.get("intent") === "save-team") {
      const teamId = await service.saveTeam(viewer, {
        teamId: values.get("teamId") || null,
        name: values.get("name"),
        description: values.get("description"),
        chairPersonId: values.get("chairPersonId") || null,
        status: values.get("status"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluation_team",
        entityId: teamId,
        changeType: values.get("teamId") ? "updated" : "created",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return { ok: true, message: "Evaluation team saved." };
    }
    if (values.get("intent") === "change-team-member") {
      await service.changeTeamMember(viewer, {
        teamId: values.get("teamId"),
        personId: values.get("personId"),
        role: values.get("memberRole"),
        operation: values.get("operation"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluation_team",
        entityId: String(values.get("teamId") ?? ""),
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return {
        ok: true,
        message:
          values.get("operation") === "remove"
            ? "Team member removed. Existing assignments were preserved."
            : "Team member saved.",
      };
    }
    if (values.get("intent") === "add-next-round") {
      const roundId = await service.addNextRound(viewer, {
        planId: values.get("planId"),
        planRevision: values.get("planRevision"),
        name: values.get("name"),
        dueAt: null,
        cloneRoundId: values.get("cloneRoundId"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluation_round",
        entityId: roundId,
        changeType: "created",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return { ok: true, message: "Next round created from the rubric." };
    }
    if (values.get("intent") === "update-draft-round") {
      await service.updateDraftRound(viewer, {
        roundId: values.get("roundId"),
        revision: values.get("roundRevision"),
        name: values.get("name"),
        dueAt: null,
        criteria: readRubricCriteria(values),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluation_round",
        entityId: String(values.get("roundId") ?? ""),
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return { ok: true, message: "Draft round and rubric saved." };
    }
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
      const moderationId = await service.moderate(viewer, {
        roundId: values.get("roundId"),
        submissionId: values.get("submissionId"),
        expectedModerationId: values.get("expectedModerationId") || null,
        recommendation: values.get("recommendation"),
        moderatedScore: values.get("moderatedScore") || null,
        notes: values.get("notes"),
        status,
        confirmed: values.get("confirmed") === "true",
      });
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
      const result = await service.reopenReview(viewer, {
        assignmentId: values.get("assignmentId"),
        reason: values.get("reason"),
        confirmed: values.get("confirmed") === "true",
      });
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
    if (values.get("intent") === "decide") {
      const released = values.get("release") === "true";
      const result = await service.decide(viewer, {
        submissionId: values.get("submissionId"),
        decision: values.get("decision"),
        rationale: values.get("rationale"),
        includeReviewerFeedback:
          values.get("includeReviewerFeedback") === "true",
        release: released,
        confirmedWithoutReview: values.get("confirmedWithoutReview") === "true",
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
    return data(
      { ok: false, error: "Unsupported evaluation action." },
      { status: 400 },
    );
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
    if (error instanceof Response) throw error;
    throw error;
  }
}
