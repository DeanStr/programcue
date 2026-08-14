import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { TaskAdministrationWorkflows } from "./task-administration-workflows.server";
import { ParticipantTaskWorkflows } from "./participant-task-workflows.server";
import { TaskTemplateWorkflows } from "./task-template-workflows.server";
export {
  TaskEvidenceAttachmentConflictError,
  TaskStateError,
  fixedDateEndEpoch,
  taskTemplateIdForIntent,
  type TaskCompletionMutationResult,
} from "./task-service-foundation.server";

/** Stable task-domain façade over independent template, participant and admin workflows. */
export class TaskService {
  private readonly templates: TaskTemplateWorkflows;
  private readonly participants: ParticipantTaskWorkflows;
  private readonly administration: TaskAdministrationWorkflows;

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    const airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(env);
    const collaborators = { airtable };
    this.templates = new TaskTemplateWorkflows(env, collaborators);
    this.participants = new ParticipantTaskWorkflows(env, collaborators);
    this.administration = new TaskAdministrationWorkflows(env, collaborators);
  }

  createTemplate(...args: Parameters<TaskTemplateWorkflows["createTemplate"]>) {
    return this.templates.createTemplate(...args);
  }

  createTravelOnboardingTemplates(
    ...args: Parameters<TaskTemplateWorkflows["createTravelOnboardingTemplates"]>
  ) {
    return this.templates.createTravelOnboardingTemplates(...args);
  }

  assignTemplate(...args: Parameters<TaskTemplateWorkflows["assignTemplate"]>) {
    return this.templates.assignTemplate(...args);
  }

  listParticipantTasks(
    ...args: Parameters<ParticipantTaskWorkflows["listParticipantTasks"]>
  ) {
    return this.participants.listParticipantTasks(...args);
  }

  assertFileEvidenceUploadAllowed(
    ...args: Parameters<
      ParticipantTaskWorkflows["assertFileEvidenceUploadAllowed"]
    >
  ) {
    return this.participants.assertFileEvidenceUploadAllowed(...args);
  }

  completeParticipant(
    ...args: Parameters<ParticipantTaskWorkflows["completeParticipant"]>
  ) {
    return this.participants.completeParticipant(...args);
  }

  undoCompletion(
    ...args: Parameters<ParticipantTaskWorkflows["undoCompletion"]>
  ) {
    return this.participants.undoCompletion(...args);
  }

  attachCompletedFileEvidence(
    ...args: Parameters<
      ParticipantTaskWorkflows["attachCompletedFileEvidence"]
    >
  ) {
    return this.participants.attachCompletedFileEvidence(...args);
  }

  addComment(...args: Parameters<ParticipantTaskWorkflows["addComment"]>) {
    return this.participants.addComment(...args);
  }

  getAdminWorkspace(
    ...args: Parameters<TaskAdministrationWorkflows["getAdminWorkspace"]>
  ) {
    return this.administration.getAdminWorkspace(...args);
  }

  administerTask(
    ...args: Parameters<TaskAdministrationWorkflows["administerTask"]>
  ) {
    return this.administration.administerTask(...args);
  }
}
