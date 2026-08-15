import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { EvaluationRoundAddWorkflow } from "./evaluation-round-add-workflow.server";
import { EvaluationRoundAdvanceWorkflow } from "./evaluation-round-advance-workflow.server";
import { EvaluationRoundDeleteWorkflow } from "./evaluation-round-delete-workflow.server";
import { EvaluationRoundUpdateWorkflow } from "./evaluation-round-update-workflow.server";

/** Stable round façade over command-specific transactional workflows. */
export class EvaluationRoundWorkflows {
  private readonly additions: EvaluationRoundAddWorkflow;
  private readonly updates: EvaluationRoundUpdateWorkflow;
  private readonly deletions: EvaluationRoundDeleteWorkflow;
  private readonly advancement: EvaluationRoundAdvanceWorkflow;

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    const airtable = dependencies.airtable ?? new AirtableProviderBoundary(env);
    const collaborators = { airtable };
    this.additions = new EvaluationRoundAddWorkflow(env, collaborators);
    this.updates = new EvaluationRoundUpdateWorkflow(env, collaborators);
    this.deletions = new EvaluationRoundDeleteWorkflow(env, collaborators);
    this.advancement = new EvaluationRoundAdvanceWorkflow(env, collaborators);
  }

  addNextRound(
    ...args: Parameters<EvaluationRoundAddWorkflow["addNextRound"]>
  ) {
    return this.additions.addNextRound(...args);
  }

  updateDraftRound(
    ...args: Parameters<EvaluationRoundUpdateWorkflow["updateDraftRound"]>
  ) {
    return this.updates.updateDraftRound(...args);
  }

  deleteDraftRound(
    ...args: Parameters<EvaluationRoundDeleteWorkflow["deleteDraftRound"]>
  ) {
    return this.deletions.deleteDraftRound(...args);
  }

  advanceRound(
    ...args: Parameters<EvaluationRoundAdvanceWorkflow["advanceRound"]>
  ) {
    return this.advancement.advanceRound(...args);
  }
}
