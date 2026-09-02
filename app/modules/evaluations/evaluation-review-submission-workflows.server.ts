import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { EvaluationConflictDeclarationWorkflow } from "./evaluation-conflict-declaration-workflow.server";
import { EvaluationReviewAbstentionWorkflow } from "./evaluation-review-abstention-workflow.server";
import { EvaluationReviewSaveWorkflow } from "./evaluation-review-save-workflow.server";

/** Stable review-submission façade over save and conflict-declaration workflows. */
export class EvaluationReviewSubmissionWorkflows {
  private readonly saves: EvaluationReviewSaveWorkflow;
  private readonly conflicts: EvaluationConflictDeclarationWorkflow;
  private readonly abstentions: EvaluationReviewAbstentionWorkflow;

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    const airtable = dependencies.airtable ?? new AirtableProviderBoundary(env);
    const collaborators = { airtable };
    this.saves = new EvaluationReviewSaveWorkflow(env, collaborators);
    this.conflicts = new EvaluationConflictDeclarationWorkflow(
      env,
      collaborators,
    );
    this.abstentions = new EvaluationReviewAbstentionWorkflow(
      env,
      collaborators,
    );
  }

  saveReview(...args: Parameters<EvaluationReviewSaveWorkflow["saveReview"]>) {
    return this.saves.saveReview(...args);
  }

  declareConflict(
    ...args: Parameters<
      EvaluationConflictDeclarationWorkflow["declareConflict"]
    >
  ) {
    return this.conflicts.declareConflict(...args);
  }

  abstain(...args: Parameters<EvaluationReviewAbstentionWorkflow["abstain"]>) {
    return this.abstentions.abstain(...args);
  }
}
