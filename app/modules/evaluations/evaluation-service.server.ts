import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { resendAcceptedSpeakerInvitation } from "./accepted-speaker-invitation.server";
import { EvaluationAccessWorkflows } from "./evaluation-access-workflows.server";
import { EvaluationAssignmentWorkflows } from "./evaluation-assignment-workflows.server";
import { EvaluationConfigurationWorkflows } from "./evaluation-configuration-workflows.server";
import { EvaluationDecisionService } from "./evaluation-decision-service.server";
import { EvaluationDiscussionWorkflows } from "./evaluation-discussion-workflows.server";
import { EvaluationPlanWorkflows } from "./evaluation-plan-workflows.server";
import { EvaluationReviewSubmissionWorkflows } from "./evaluation-review-submission-workflows.server";
import { EvaluationReviewerWorkflows } from "./evaluation-reviewer-workflows.server";
import { EvaluationReviewerWorkspaceWorkflows } from "./evaluation-reviewer-workspace-workflows.server";
import { EvaluationRoundWorkflows } from "./evaluation-round-workflows.server";
import {
  type EvaluationApiCommand,
  EvaluationServiceFoundation,
} from "./evaluation-service-foundation.server";

export {
  EvaluationDecisionAuthorityError,
  EvaluationDecisionFinalError,
  EvaluationDemoActivationError,
  EvaluationInvitationDeliveryError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
export {
  type EvaluationAdminActor,
  type EvaluationAdvancementExecutionResult,
  type EvaluationAdvancementResult,
  type EvaluationApiActor,
  type EvaluationApiCommand,
  type EvaluationAssignmentResult,
  type EvaluationReviewCycleResult,
  type EvaluationRoundReviewerResult,
  sessionReviewSnapshotSchema,
} from "./evaluation-service-foundation.server";

class EvaluationDecisionWorkflow extends EvaluationServiceFoundation {
  decide(
    viewer: Viewer,
    input: unknown,
    command?: EvaluationApiCommand & { commandId: string },
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.decision.save",
      input,
      command,
      () =>
        new EvaluationDecisionService(this.env).decide(
          viewer,
          input,
          command?.commandId,
        ),
    );
  }

  reopen(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.decision.reopen",
      input,
      undefined,
      () => new EvaluationDecisionService(this.env).reopen(viewer, input),
    );
  }
}

/** Stable evaluation façade composed from independent use-case services. */
export class EvaluationService {
  private readonly plans: EvaluationPlanWorkflows;
  private readonly access: EvaluationAccessWorkflows;
  private readonly configuration: EvaluationConfigurationWorkflows;
  private readonly rounds: EvaluationRoundWorkflows;
  private readonly assignments: EvaluationAssignmentWorkflows;
  private readonly reviewerWorkspace: EvaluationReviewerWorkspaceWorkflows;
  private readonly reviewSubmission: EvaluationReviewSubmissionWorkflows;
  private readonly reviews: EvaluationReviewerWorkflows;
  private readonly decisions: EvaluationDecisionWorkflow;
  private readonly discussion: EvaluationDiscussionWorkflows;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    const airtable = dependencies.airtable ?? new AirtableProviderBoundary(env);
    const collaborators = { airtable };
    this.plans = new EvaluationPlanWorkflows(env, collaborators);
    this.access = new EvaluationAccessWorkflows(env, collaborators);
    this.configuration = new EvaluationConfigurationWorkflows(
      env,
      collaborators,
    );
    this.rounds = new EvaluationRoundWorkflows(env, collaborators);
    this.assignments = new EvaluationAssignmentWorkflows(env, collaborators);
    this.reviewerWorkspace = new EvaluationReviewerWorkspaceWorkflows(
      env,
      collaborators,
    );
    this.reviewSubmission = new EvaluationReviewSubmissionWorkflows(
      env,
      collaborators,
    );
    this.reviews = new EvaluationReviewerWorkflows(env, collaborators);
    this.decisions = new EvaluationDecisionWorkflow(env, collaborators);
    this.discussion = new EvaluationDiscussionWorkflows(env, collaborators);
  }

  getAdminWorkspace(
    ...args: Parameters<EvaluationPlanWorkflows["getAdminWorkspace"]>
  ) {
    return this.plans.getAdminWorkspace(...args);
  }
  prepareReviewerReminder(
    ...args: Parameters<EvaluationPlanWorkflows["prepareReviewerReminder"]>
  ) {
    return this.plans.prepareReviewerReminder(...args);
  }
  startReviewCycle(
    ...args: Parameters<EvaluationPlanWorkflows["startReviewCycle"]>
  ) {
    return this.plans.startReviewCycle(...args);
  }
  savePlan(...args: Parameters<EvaluationPlanWorkflows["savePlan"]>) {
    return this.plans.savePlan(...args);
  }
  inviteEvaluationMember(
    ...args: Parameters<EvaluationAccessWorkflows["inviteEvaluationMember"]>
  ) {
    return this.access.inviteEvaluationMember(...args);
  }
  changeCommitteeChairAccess(
    ...args: Parameters<EvaluationAccessWorkflows["changeCommitteeChairAccess"]>
  ) {
    return this.access.changeCommitteeChairAccess(...args);
  }
  saveTeam(...args: Parameters<EvaluationConfigurationWorkflows["saveTeam"]>) {
    return this.configuration.saveTeam(...args);
  }
  changeTeamMember(
    ...args: Parameters<EvaluationConfigurationWorkflows["changeTeamMember"]>
  ) {
    return this.configuration.changeTeamMember(...args);
  }
  changeRoundReviewerPool(
    ...args: Parameters<
      EvaluationConfigurationWorkflows["changeRoundReviewerPool"]
    >
  ) {
    return this.configuration.changeRoundReviewerPool(...args);
  }
  addNextRound(...args: Parameters<EvaluationRoundWorkflows["addNextRound"]>) {
    return this.rounds.addNextRound(...args);
  }
  updateDraftRound(
    ...args: Parameters<EvaluationRoundWorkflows["updateDraftRound"]>
  ) {
    return this.rounds.updateDraftRound(...args);
  }
  deleteDraftRound(
    ...args: Parameters<EvaluationRoundWorkflows["deleteDraftRound"]>
  ) {
    return this.rounds.deleteDraftRound(...args);
  }
  advanceRound(...args: Parameters<EvaluationRoundWorkflows["advanceRound"]>) {
    return this.rounds.advanceRound(...args);
  }
  assign(...args: Parameters<EvaluationAssignmentWorkflows["assign"]>) {
    return this.assignments.assign(...args);
  }
  undoAssignments(
    ...args: Parameters<EvaluationAssignmentWorkflows["undoAssignments"]>
  ) {
    return this.assignments.undoAssignments(...args);
  }
  getReviewerWorkspace(
    ...args: Parameters<
      EvaluationReviewerWorkspaceWorkflows["getReviewerWorkspace"]
    >
  ) {
    return this.reviewerWorkspace.getReviewerWorkspace(...args);
  }
  getReviewerWorkbench(
    ...args: Parameters<
      EvaluationReviewerWorkspaceWorkflows["getReviewerWorkbench"]
    >
  ) {
    return this.reviewerWorkspace.getReviewerWorkbench(...args);
  }
  downloadReviewerAttachment(
    ...args: Parameters<
      EvaluationReviewerWorkspaceWorkflows["downloadReviewerAttachment"]
    >
  ) {
    return this.reviewerWorkspace.downloadReviewerAttachment(...args);
  }
  saveReview(
    ...args: Parameters<EvaluationReviewSubmissionWorkflows["saveReview"]>
  ) {
    return this.reviewSubmission.saveReview(...args);
  }
  declareConflict(
    ...args: Parameters<EvaluationReviewSubmissionWorkflows["declareConflict"]>
  ) {
    return this.reviewSubmission.declareConflict(...args);
  }

  abstain(...args: Parameters<EvaluationReviewSubmissionWorkflows["abstain"]>) {
    return this.reviewSubmission.abstain(...args);
  }
  moderate(...args: Parameters<EvaluationReviewerWorkflows["moderate"]>) {
    return this.reviews.moderate(...args);
  }
  reopenReview(
    ...args: Parameters<EvaluationReviewerWorkflows["reopenReview"]>
  ) {
    return this.reviews.reopenReview(...args);
  }
  decide(...args: Parameters<EvaluationDecisionWorkflow["decide"]>) {
    return this.decisions.decide(...args);
  }
  reopenDecision(...args: Parameters<EvaluationDecisionService["reopen"]>) {
    return this.decisions.reopen(...args);
  }
  listDiscussion(
    ...args: Parameters<EvaluationDiscussionWorkflows["listDiscussion"]>
  ) {
    return this.discussion.listDiscussion(...args);
  }
  addDiscussionMessage(
    ...args: Parameters<EvaluationDiscussionWorkflows["addDiscussionMessage"]>
  ) {
    return this.discussion.addDiscussionMessage(...args);
  }
  resendAcceptedSpeakerInvitation(viewer: Viewer, input: unknown) {
    return resendAcceptedSpeakerInvitation({
      env: this.env,
      viewer,
      value: input,
    });
  }
}
