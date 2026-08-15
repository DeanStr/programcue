import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { ParticipantTaskCommentCommands } from "./participant-task-comment-commands.server";
import { ParticipantTaskCompletionCommands } from "./participant-task-completion-commands.server";
import { ParticipantTaskEvidenceCommands } from "./participant-task-evidence-commands.server";
import { ParticipantTaskQueries } from "./participant-task-queries.server";

/** Stable participant-task façade over queries and independent mutations. */
export class ParticipantTaskWorkflows {
  private readonly queries: ParticipantTaskQueries;
  private readonly completion: ParticipantTaskCompletionCommands;
  private readonly evidence: ParticipantTaskEvidenceCommands;
  private readonly comments: ParticipantTaskCommentCommands;

  constructor(
    env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    const airtable = dependencies.airtable ?? new AirtableProviderBoundary(env);
    const collaborators = { airtable };
    this.queries = new ParticipantTaskQueries(env, collaborators);
    this.completion = new ParticipantTaskCompletionCommands(env, collaborators);
    this.evidence = new ParticipantTaskEvidenceCommands(env, collaborators);
    this.comments = new ParticipantTaskCommentCommands(env, collaborators);
  }

  listParticipantTasks(
    ...args: Parameters<ParticipantTaskQueries["listParticipantTasks"]>
  ) {
    return this.queries.listParticipantTasks(...args);
  }
  assertFileEvidenceUploadAllowed(
    ...args: Parameters<
      ParticipantTaskQueries["assertFileEvidenceUploadAllowed"]
    >
  ) {
    return this.queries.assertFileEvidenceUploadAllowed(...args);
  }
  completeParticipant(
    ...args: Parameters<
      ParticipantTaskCompletionCommands["completeParticipant"]
    >
  ) {
    return this.completion.completeParticipant(...args);
  }
  undoCompletion(
    ...args: Parameters<ParticipantTaskCompletionCommands["undoCompletion"]>
  ) {
    return this.completion.undoCompletion(...args);
  }
  attachCompletedFileEvidence(
    ...args: Parameters<
      ParticipantTaskEvidenceCommands["attachCompletedFileEvidence"]
    >
  ) {
    return this.evidence.attachCompletedFileEvidence(...args);
  }
  addComment(
    ...args: Parameters<ParticipantTaskCommentCommands["addComment"]>
  ) {
    return this.comments.addComment(...args);
  }
}
