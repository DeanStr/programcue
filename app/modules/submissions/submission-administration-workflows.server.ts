import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { SubmissionAdministrationQueries } from "./submission-administration-queries.server";
import { SubmissionDirectSessionCommands } from "./submission-direct-session-commands.server";
import { SubmissionFormChoiceSynchronization } from "./submission-form-choice-synchronization.server";
import { SubmissionManualApplicationCommands } from "./submission-manual-application-commands.server";

/** Stable administration façade over queries and independent command workflows. */
export class SubmissionAdministrationWorkflows {
  private readonly queries: SubmissionAdministrationQueries;
  private readonly directSessions: SubmissionDirectSessionCommands;
  private readonly manualApplications: SubmissionManualApplicationCommands;

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    const airtable = dependencies.airtable ?? new AirtableProviderBoundary(env);
    const collaborators = { airtable };
    this.queries = new SubmissionAdministrationQueries(env, collaborators);
    this.directSessions = new SubmissionDirectSessionCommands(
      env,
      collaborators,
    );
    this.manualApplications = new SubmissionManualApplicationCommands(
      env,
      collaborators,
    );
  }

  static workspaceToInput(
    ...args: Parameters<
      typeof SubmissionFormChoiceSynchronization.workspaceToInput
    >
  ) {
    return SubmissionFormChoiceSynchronization.workspaceToInput(...args);
  }
  static synchronizeFormEventChoices(
    ...args: Parameters<
      typeof SubmissionFormChoiceSynchronization.synchronizeFormEventChoices
    >
  ) {
    return SubmissionFormChoiceSynchronization.synchronizeFormEventChoices(
      ...args,
    );
  }
  listAdminSubmissions(
    ...args: Parameters<SubmissionAdministrationQueries["listAdminSubmissions"]>
  ) {
    return this.queries.listAdminSubmissions(...args);
  }
  listAdminSubmissionPage(
    ...args: Parameters<
      SubmissionAdministrationQueries["listAdminSubmissionPage"]
    >
  ) {
    return this.queries.listAdminSubmissionPage(...args);
  }
  getAdminSubmissionQueueContext(
    ...args: Parameters<
      SubmissionAdministrationQueries["getAdminSubmissionQueueContext"]
    >
  ) {
    return this.queries.getAdminSubmissionQueueContext(...args);
  }
  getAdminSubmission(
    ...args: Parameters<SubmissionAdministrationQueries["getAdminSubmission"]>
  ) {
    return this.queries.getAdminSubmission(...args);
  }
  createDirectSession(
    ...args: Parameters<SubmissionDirectSessionCommands["createDirectSession"]>
  ) {
    return this.directSessions.createDirectSession(...args);
  }
  createDirectSessionForApi(
    ...args: Parameters<
      SubmissionDirectSessionCommands["createDirectSessionForApi"]
    >
  ) {
    return this.directSessions.createDirectSessionForApi(...args);
  }
  createManualApplication(
    ...args: Parameters<
      SubmissionManualApplicationCommands["createManualApplication"]
    >
  ) {
    return this.manualApplications.createManualApplication(...args);
  }
}
