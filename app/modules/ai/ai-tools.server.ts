import { AiProposalToolExecutor } from "./ai-proposal-tool-executor.server";

export { prepareReminderSendProposal } from "./ai-proposal-tool-executor.server";

import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { AiReadToolExecutor } from "./ai-read-tool-executor.server";
import {
  type AiToolExecution,
  AiToolPermissionError,
  AiToolValidationError,
} from "./ai-tool-execution";
import type { OpenAiFunctionTool } from "./openai-responses-provider.server";

export { loadReminderCohort } from "./ai-read-tool-executor.server";

import { AI_TOOLS, adminRoles } from "./ai-tool-contracts.server";

export {
  acceleventsRunProposalArgumentsSchema,
  assistantProposalMetadataSchema,
  emailTemplateDraftProposalArgumentsSchema,
  formDraftProposalArgumentsSchema,
  formPublicationProposalArgumentsSchema,
  reminderCohortSchema,
  reminderSendAudienceSchema,
  reminderSendProposalArgumentsSchema,
  supportedReminderMergeVariables,
  taskProposalArgumentsSchema,
} from "./ai-tool-contracts.server";
export type { AiToolExecution } from "./ai-tool-execution";
export {
  AiToolPermissionError,
  AiToolValidationError,
} from "./ai-tool-execution";

export function availableAiTools(viewer: Viewer): OpenAiFunctionTool[] {
  if (!adminRoles.has(viewer.role)) return [];
  return AI_TOOLS.map(
    ({ class: _class, argumentsSchema: _argumentsSchema, ...tool }) => tool,
  );
}

export class AiToolExecutor {
  private readonly airtable: AirtableProviderBoundary;
  private readonly reads: AiReadToolExecutor;

  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly viewer: Viewer,
    private readonly runId: string,
    private readonly model: string,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
    this.reads = new AiReadToolExecutor(this.env, this.viewer);
  }

  async execute(
    name: string,
    encodedArguments: string,
  ): Promise<AiToolExecution> {
    if (!adminRoles.has(this.viewer.role)) throw new AiToolPermissionError();
    const definition = AI_TOOLS.find((tool) => tool.name === name);
    if (!definition) {
      throw new AiToolPermissionError(
        `The selected AI provider requested the non-allow-listed tool ${name}.`,
      );
    }
    const decodedArguments = (() => {
      try {
        return JSON.parse(encodedArguments);
      } catch {
        return null;
      }
    })();
    if (!definition.argumentsSchema.safeParse(decodedArguments).success) {
      throw new AiToolValidationError(
        `The selected AI provider supplied invalid arguments for ${name}.`,
      );
    }
    await this.airtable.assertReadable(this.viewer);
    switch (name) {
      case "get_event_readiness":
      case "find_incomplete_speakers":
      case "get_review_progress":
      case "inspect_schedule_conflicts":
      case "inspect_integration_failures":
      case "search_submissions":
      case "list_reminder_templates":
      case "get_evaluation_setup":
      case "get_schedule_workspace":
      case "list_form_drafts":
      case "get_accelevents_export_status":
      case "draft_reminder":
        return this.reads.execute(name, encodedArguments);
      case "propose_reminder_send":
      case "propose_form_draft":
      case "propose_rubric_update":
      case "propose_reviewer_assignment":
      case "propose_email_template_draft":
      case "propose_schedule_placement":
      case "propose_form_publication":
      case "propose_schedule_publication":
      case "propose_accelevents_run":
      case "propose_task":
        return new AiProposalToolExecutor(
          this.env,
          this.viewer,
          this.runId,
          this.model,
        ).execute(name, encodedArguments);
    }
    throw new AiToolPermissionError(`Tool ${name} is not allow-listed.`);
  }
}
