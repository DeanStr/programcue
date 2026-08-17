import { type ActionFunctionArgs, data, redirect } from "react-router";
import { ZodError } from "zod";
import { requireValue } from "~/lib/required-value";
import {
  AiReviewAssessmentConflictError,
  AiReviewAssessmentService,
  AiReviewAssessmentStateError,
} from "~/modules/ai/ai-review-assessment.server";
import {
  AiConfigurationError,
  AiProviderError,
} from "~/modules/ai/openai-responses-provider.server";
import {
  ReviewerAiSuggestionService,
  ReviewerAiSuggestionStateError,
} from "~/modules/ai/reviewer-ai-suggestion.server";
import { communicationScheduledEpoch } from "~/modules/communications/communication-time";
import {
  parseScorecardSelection,
  ScorecardSelectionError,
} from "~/modules/evaluations/evaluation-scorecard-selection";
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
import { EventService } from "~/modules/events/event-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { evaluatorEmailRoutingMessage } from "~/platform/evaluation/evaluator-email-alias.server";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import { decisionActionOutcome } from "./evaluation-admin-outcomes";

function readRubricCriteria(values: FormData) {
  const ids = values.getAll("criterionId").map(String);
  const names = values.getAll("criterionName").map(String);
  const descriptions = values.getAll("criterionDescription").map(String);
  const inputTypes = values.getAll("criterionInputType").map(String);
  const options = values.getAll("criterionOptions").map(String);
  const weights = values.getAll("criterionWeight").map(String);
  const required = values.getAll("criterionRequired").map(String);
  return names
    .map((name, index) => ({
      id: ids[index]?.trim() || crypto.randomUUID(),
      name,
      description: descriptions[index],
      inputType: inputTypes[index],
      options: (options[index] ?? "")
        .split(/[\n,]/u)
        .map((option) => option.trim())
        .filter(Boolean),
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

function readRoundDateTime(
  values: FormData,
  field: string,
  eventTimezone: string,
) {
  const value = String(values.get(field) ?? "").trim();
  if (!value) return null;
  try {
    return new Date(
      communicationScheduledEpoch(value, eventTimezone) * 1_000,
    ).toISOString();
  } catch (error) {
    throw new EvaluationValidationError(
      error instanceof Error
        ? error.message
        : "Enter a valid round date and time.",
    );
  }
}

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
  try {
    if (values.get("intent") === "update-reviewer-ai-setting") {
      const setting = await new ReviewerAiSuggestionService(env).updateSetting(
        viewer,
        {
          enabled: values.get("enabled") === "true",
          revision: values.get("revision"),
        },
      );
      return {
        ok: true,
        message: setting.enabled
          ? "Reviewer AI suggestions enabled for this event."
          : "Reviewer AI suggestions disabled for this event.",
      };
    }
    if (values.get("intent") === "add-discussion-message") {
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
    if (values.get("intent") === "reconcile-ai-review-assessment") {
      const result = await new AiReviewAssessmentService(
        env,
      ).reconcileGenerationAttempt(viewer, {
        operationId: values.get("operationId"),
      });
      return result.status === "completed"
        ? {
            ok: true,
            message: `Recovered AI first-pass assessment saved at ${result.assessment.score.toFixed(1)} / 5.`,
          }
        : {
            ok: true,
            message:
              "The expired AI attempt was reconciled as failed. Review its failure before explicitly retrying.",
          };
    }
    if (values.get("intent") === "generate-ai-review-assessment") {
      const assessment = await new AiReviewAssessmentService(env).generate(
        viewer,
        {
          generationIntentId: values.get("generationIntentId"),
          roundId: values.get("roundId"),
          submissionId: values.get("submissionId"),
          confirmed: values.get("confirmed") === "true" ? true : undefined,
        },
      );
      return {
        ok: true,
        message: `AI first-pass assessment saved at ${assessment.score.toFixed(1)} / 5.`,
      };
    }
    if (values.get("intent") === "retry-ai-review-assessment") {
      const assessment = await new AiReviewAssessmentService(env).generate(
        viewer,
        {
          generationIntentId: values.get("generationIntentId"),
          roundId: values.get("roundId"),
          submissionId: values.get("submissionId"),
          retryFailedOperationId: values.get("failedOperationId"),
          duplicateRiskAcknowledged:
            values.get("duplicateRiskAcknowledged") === "true"
              ? true
              : undefined,
          confirmed: values.get("confirmed") === "true" ? true : undefined,
        },
      );
      return {
        ok: true,
        message: `Retried AI first-pass assessment saved at ${assessment.score.toFixed(1)} / 5.`,
      };
    }
    if (values.get("intent") === "override-ai-review-assessment") {
      const assessment = await new AiReviewAssessmentService(env).override(
        viewer,
        {
          assessmentId: values.get("assessmentId"),
          expectedRevision: values.get("expectedRevision"),
          score: values.get("score"),
          rationale: values.get("rationale"),
          confirmed: values.get("confirmed") === "true" ? true : undefined,
        },
      );
      return {
        ok: true,
        message: `Human assessment of the AI advisory saved at ${requireValue(
          assessment.overrideScore,
          "A saved human assessment must include its score.",
        ).toFixed(1)} / 5.`,
      };
    }
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
      const invitationMessage =
        result.delivery === "sent"
          ? `${roleLabel} invitation created and a one-time sign-in link was sent.`
          : result.demoAccessActivation === "activated" ||
              result.demoAccessActivation === "already_active"
            ? `Demo ${roleLabel.toLowerCase()} invitation created, and the fixed demo identity was activated locally. No email was sent.`
            : `Demo ${roleLabel.toLowerCase()} invitation created. No email was sent, because this is demo mode.`;
      const routingDisclosure = evaluatorEmailRoutingMessage(
        "routing" in result ? (result.routing ?? null) : null,
      );
      const message = `${invitationMessage}${routingDisclosure ? ` ${routingDisclosure}` : ""}`;
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
      const event = await new EventService(env).getSetup(viewer);
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
            opensAt: readRoundDateTime(values, "roundOpensAt", event.timezone),
            closesAt: readRoundDateTime(
              values,
              "roundClosesAt",
              event.timezone,
            ),
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
    if (values.get("intent") === "start-review-cycle") {
      const event = await new EventService(env).getSetup(viewer);
      const criteria = readRubricCriteria(values).map((criterion) => ({
        name: criterion.name,
        description: criterion.description,
        inputType: criterion.inputType,
        options: criterion.options,
        weightPercent: criterion.weightPercent,
        required: criterion.required,
      }));
      const result = await service.startReviewCycle(viewer, {
        currentPlanId: values.get("currentPlanId"),
        currentPlanRevision: values.get("currentPlanRevision"),
        expectedRunningAssessmentOperationCount: values.get(
          "expectedRunningAssessmentOperationCount",
        ),
        expectedUnfinishedAssignmentCount: values.get(
          "expectedUnfinishedAssignmentCount",
        ),
        expectedUnfinishedReviewCount: values.get(
          "expectedUnfinishedReviewCount",
        ),
        planName: values.get("planName"),
        round: {
          name: values.get("roundName"),
          opensAt: readRoundDateTime(values, "roundOpensAt", event.timezone),
          closesAt: readRoundDateTime(values, "roundClosesAt", event.timezone),
          anonymous: values.get("anonymous") === "true",
          criteria,
        },
        confirmed: values.get("confirmed") === "true",
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluation_plan",
        entityId: result.planId,
        changeType: "created",
      });
      const message = `New review cycle started. The prior plan remains in immutable history with ${result.unfinishedAssignmentCount} unfinished assignment${result.unfinishedAssignmentCount === 1 ? "" : "s"} and ${result.unfinishedReviewCount} saved unfinished review${result.unfinishedReviewCount === 1 ? "" : "s"}.`;
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
      const event = await new EventService(env).getSetup(viewer);
      let scorecardSelection: ReturnType<typeof parseScorecardSelection>;
      try {
        scorecardSelection = parseScorecardSelection(
          values.get("scorecardSelection"),
        );
      } catch (error) {
        if (error instanceof ScorecardSelectionError) {
          throw new EvaluationValidationError(error.message);
        }
        throw error;
      }
      const roundId = await service.addNextRound(viewer, {
        planId: values.get("planId"),
        planRevision: values.get("planRevision"),
        name: values.get("name"),
        opensAt: readRoundDateTime(values, "roundOpensAt", event.timezone),
        closesAt: readRoundDateTime(values, "roundClosesAt", event.timezone),
        anonymous: values.get("anonymous") === "true",
        dueAt: null,
        cloneRoundId: values.get("cloneRoundId"),
        scorecardId: scorecardSelection.scorecardId,
        scorecardVersion: scorecardSelection.scorecardVersion,
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
      const event = await new EventService(env).getSetup(viewer);
      await service.updateDraftRound(viewer, {
        roundId: values.get("roundId"),
        revision: values.get("roundRevision"),
        name: values.get("name"),
        opensAt: readRoundDateTime(values, "roundOpensAt", event.timezone),
        closesAt: readRoundDateTime(values, "roundClosesAt", event.timezone),
        anonymous: values.get("anonymous") === "true",
        scorecardId: values.get("scorecardId") || null,
        scorecardVersion: values.get("scorecardVersion") || undefined,
        dueAt: null,
        criteria: readRubricCriteria(values),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluation_round",
        entityId: String(values.get("roundId") ?? ""),
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return { ok: true, message: "Round and scorecard saved." };
    }
    if (values.get("intent") === "delete-draft-round") {
      const result = await service.deleteDraftRound(viewer, {
        roundId: values.get("roundId"),
        roundRevision: values.get("roundRevision"),
        planRevision: values.get("planRevision"),
        expectedReviewerPersonIds: values.getAll("expectedReviewerPersonIds"),
        confirmed: values.get("confirmed") === "true",
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluation_round",
        entityId: result.roundId,
        changeType: "deleted",
      });
      const message = "Unused final draft round deleted.";
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
    if (values.get("intent") === "change-round-reviewer") {
      const result = await service.changeRoundReviewerPool(viewer, {
        roundId: values.get("roundId"),
        personId: values.get("personId"),
        operation: values.get("operation"),
        confirmed: values.get("confirmed") === "true" ? true : undefined,
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "evaluation_round",
        entityId: String(values.get("roundId") ?? ""),
        changeType: "updated",
      });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return {
        ok: true,
        message:
          values.get("operation") === "remove"
            ? result.cancelledAssignmentCount > 0
              ? `Reviewer removed from this round pool. ${result.cancelledAssignmentCount} unfinished assignment${result.cancelledAssignmentCount === 1 ? "" : "s"} cancelled and available for reassignment.`
              : "Reviewer removed from this round pool. No unfinished assignments were cancelled."
            : "Reviewer added to this round pool.",
      };
    }
    if (values.get("intent") === "prepare-reviewer-reminder") {
      const draft = await service.prepareReviewerReminder(viewer, {
        roundId: values.get("roundId"),
        reviewerPersonIds: values.getAll("reviewerPersonId"),
        templateVersionId: values.get("templateVersionId"),
      });
      return redirect(`/admin/communications/compose/${draft.id}`);
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
        message: result.notificationCancelled
          ? "Decision reopened for correction and its pending notification was cancelled. Messages already sent cannot be recalled; record and release the corrected outcome explicitly."
          : "Decision reopened for correction. Messages already sent cannot be recalled; record and release the corrected outcome explicitly.",
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
