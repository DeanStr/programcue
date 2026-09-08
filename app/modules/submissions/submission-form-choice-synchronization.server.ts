import {
  D1SubmissionRepository,
  type FormWorkspace,
} from "./submission-repository.server";
import type { SaveFormInput } from "./submission-schema";

export function submissionFormWorkspaceToInput(
  workspace: FormWorkspace,
): SaveFormInput {
  return {
    id: workspace.id,
    revision: workspace.revision,
    draftRevision: workspace.draftVersion.revision,
    name: workspace.name,
    kind: workspace.kind,
    publicSlug: workspace.publicSlug,
    openDate: D1SubmissionRepository.closeDateFromEpoch(
      workspace.opensAt,
      workspace.eventTimezone,
    ),
    closeDate: D1SubmissionRepository.closeDateFromEpoch(
      workspace.closesAt,
      workspace.eventTimezone,
    ),
    submissionLimit: workspace.submissionLimit,
    perPersonSubmissionLimit: workspace.perPersonSubmissionLimit,
    minSpeakers: workspace.minSpeakers,
    maxSpeakers: workspace.maxSpeakers,
    accessMode: workspace.accessMode,
    accessPassword: "",
    schema: workspace.draftVersion.schema,
    routing: { ...workspace.draftVersion.routing, passwordHash: null },
  };
}
