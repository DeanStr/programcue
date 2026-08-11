import { TaskAdministrationWorkflows } from "./task-administration-workflows.server";
export {
  TaskEvidenceAttachmentConflictError,
  TaskStateError,
  fixedDateEndEpoch,
  taskTemplateIdForIntent,
  type TaskCompletionMutationResult,
} from "./task-service-foundation.server";

export class TaskService extends TaskAdministrationWorkflows {}
