import { data, redirect } from "react-router";
import {
  parseScorecardSelection,
  ScorecardSelectionError,
} from "~/modules/evaluations/evaluation-scorecard-selection";
import { EvaluationValidationError } from "~/modules/evaluations/evaluation-service.server";
import { EventService } from "~/modules/events/event-service.server";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import {
  type EvaluationAdminActionContext,
  readRecommendationChoices,
  readRoundDateTime,
  readRubricCriteria,
} from "./evaluation-admin-action-shared.server";

export async function handleEvaluationAdminPlanIntent(
  context: EvaluationAdminActionContext,
) {
  const { env, viewer, values, service } = context;
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
          closesAt: readRoundDateTime(values, "roundClosesAt", event.timezone),
          recommendationChoices: readRecommendationChoices(values),
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
        recommendationChoices: readRecommendationChoices(values),
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
      recommendationChoices: readRecommendationChoices(values),
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

  return null;
}
