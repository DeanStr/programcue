import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { EvaluationPlanSaveWorkflow } from "./evaluation-plan-save-workflow.server";
import { EvaluationPlanWorkspaceWorkflow } from "./evaluation-plan-workspace-workflow.server";
import { EvaluationReviewCycleStartWorkflow } from "./evaluation-review-cycle-start-workflow.server";
import { EvaluationReviewerReminderWorkflow } from "./evaluation-reviewer-reminder-workflow.server";

/** Stable plan façade over query and command-specific workflows. */
export class EvaluationPlanWorkflows {
  private readonly workspace: EvaluationPlanWorkspaceWorkflow;
  private readonly reminders: EvaluationReviewerReminderWorkflow;
  private readonly cycleStart: EvaluationReviewCycleStartWorkflow;
  private readonly saving: EvaluationPlanSaveWorkflow;

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    const airtable = dependencies.airtable ?? new AirtableProviderBoundary(env);
    const collaborators = { airtable };
    this.workspace = new EvaluationPlanWorkspaceWorkflow(env, collaborators);
    this.reminders = new EvaluationReviewerReminderWorkflow(env, collaborators);
    this.cycleStart = new EvaluationReviewCycleStartWorkflow(
      env,
      collaborators,
    );
    this.saving = new EvaluationPlanSaveWorkflow(env, collaborators);
  }

  getAdminWorkspace(
    ...args: Parameters<EvaluationPlanWorkspaceWorkflow["getAdminWorkspace"]>
  ) {
    return this.workspace.getAdminWorkspace(...args);
  }
  prepareReviewerReminder(
    ...args: Parameters<
      EvaluationReviewerReminderWorkflow["prepareReviewerReminder"]
    >
  ) {
    return this.reminders.prepareReviewerReminder(...args);
  }
  startReviewCycle(
    ...args: Parameters<EvaluationReviewCycleStartWorkflow["startReviewCycle"]>
  ) {
    return this.cycleStart.startReviewCycle(...args);
  }
  savePlan(...args: Parameters<EvaluationPlanSaveWorkflow["savePlan"]>) {
    return this.saving.savePlan(...args);
  }
}
