import type { Viewer } from "~/platform/auth/authorize.server";
import { resendAcceptedSpeakerInvitation } from "./accepted-speaker-invitation.server";
import { EvaluationDecisionService } from "./evaluation-decision-service.server";
import { EvaluationReviewerWorkflows } from "./evaluation-reviewer-workflows.server";
import { type EvaluationApiCommand } from "./evaluation-service-foundation.server";
export {
  EvaluationDemoActivationError,
  EvaluationDecisionAuthorityError,
  EvaluationDecisionFinalError,
  EvaluationInvitationDeliveryError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
export {
  sessionReviewSnapshotSchema,
  type EvaluationAdminActor,
  type EvaluationAdvancementExecutionResult,
  type EvaluationAdvancementResult,
  type EvaluationApiActor,
  type EvaluationApiCommand,
  type EvaluationAssignmentResult,
  type EvaluationReviewCycleResult,
  type EvaluationRoundReviewerResult,
} from "./evaluation-service-foundation.server";

export class EvaluationService extends EvaluationReviewerWorkflows {
  async decide(
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

  async resendAcceptedSpeakerInvitation(viewer: Viewer, input: unknown) {
    return resendAcceptedSpeakerInvitation({
      env: this.env,
      viewer,
      value: input,
    });
  }
}
