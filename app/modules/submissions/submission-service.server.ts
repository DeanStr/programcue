import { SubmissionAdministrationWorkflows } from "./submission-administration-workflows.server";
export {
  PublicFormUnavailableError,
  type SubmissionApiActor,
} from "./submission-service-foundation.server";

export class SubmissionService extends SubmissionAdministrationWorkflows {}
