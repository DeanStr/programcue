import { AiOperationsProposalWorkflows } from "./ai-operations-proposal-workflows.server";
import { adminRoles } from "./ai-tool-contracts.server";
import {
  AiToolPermissionError,
  type AiToolExecution,
} from "./ai-tool-execution";
export { prepareReminderSendProposal } from "./ai-proposal-executor-foundation.server";

export class AiProposalToolExecutor extends AiOperationsProposalWorkflows {
  execute(name: string, encodedArguments: string): Promise<AiToolExecution> {
    if (!adminRoles.has(this.viewer.role)) throw new AiToolPermissionError();
    switch (name) {
      case "propose_reminder_send":
        return this.executeProposeReminderSend(encodedArguments);
      case "propose_form_draft":
        return this.executeProposeFormDraft(encodedArguments);
      case "propose_rubric_update":
        return this.executeProposeRubricUpdate(encodedArguments);
      case "propose_reviewer_assignment":
        return this.executeProposeReviewerAssignment(encodedArguments);
      case "propose_email_template_draft":
        return this.executeProposeEmailTemplateDraft(encodedArguments);
      case "propose_schedule_placement":
        return this.executeProposeSchedulePlacement(encodedArguments);
      case "propose_form_publication":
        return this.executeProposeFormPublication(encodedArguments);
      case "propose_schedule_publication":
        return this.executeProposeSchedulePublication(encodedArguments);
      case "propose_accelevents_run":
        return this.executeProposeAcceleventsRun(encodedArguments);
      case "propose_task":
        return this.executeProposeTask(encodedArguments);
      default:
        throw new AiToolPermissionError(`Tool ${name} is not a proposal tool.`);
    }
  }
}
