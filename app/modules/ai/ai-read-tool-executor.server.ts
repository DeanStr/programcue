import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AiToolPermissionError,
  type AiToolExecution,
} from "./ai-tool-execution";
import { adminRoles } from "./ai-tool-contracts.server";
import { AiOperationalReadTools } from "./ai-operational-read-tools.server";
import { AiContentReadTools } from "./ai-content-read-tools.server";
import { AiWorkspaceReadTools } from "./ai-workspace-read-tools.server";

export { loadReminderCohort } from "./ai-read-tool-shared.server";

export class AiReadToolExecutor {
  private readonly operational: AiOperationalReadTools;
  private readonly content: AiContentReadTools;
  private readonly workspaces: AiWorkspaceReadTools;

  constructor(
    env: CloudflareEnvironment,
    private readonly viewer: Viewer,
  ) {
    this.operational = new AiOperationalReadTools(env, viewer);
    this.content = new AiContentReadTools(env, viewer);
    this.workspaces = new AiWorkspaceReadTools(env, viewer);
  }

  execute(name: string, encodedArguments: string): Promise<AiToolExecution> {
    if (!adminRoles.has(this.viewer.role)) throw new AiToolPermissionError();
    switch (name) {
      case "get_event_readiness":
      case "find_incomplete_speakers":
      case "get_review_progress":
      case "inspect_schedule_conflicts":
      case "inspect_integration_failures":
        return this.operational.execute(name, encodedArguments);
      case "search_submissions":
      case "list_reminder_templates":
      case "list_form_drafts":
      case "draft_reminder":
        return this.content.execute(name, encodedArguments);
      case "get_evaluation_setup":
      case "get_schedule_workspace":
      case "get_accelevents_export_status":
        return this.workspaces.execute(name, encodedArguments);
      default:
        throw new AiToolPermissionError(`Tool ${name} is not a read tool.`);
    }
  }
}
