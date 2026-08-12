import type { DuplicatePersonMatch } from "~/modules/people/person-duplicate-service.server";
import type { SubmissionService } from "~/modules/submissions/submission-service.server";

export type SubmissionsAdminActionResult = {
  ok: boolean;
  partial?: boolean;
  message: string;
  operationId?: string;
  duplicateCheck?: {
    intent: "create_direct_session" | "create_manual_application";
    matches: DuplicatePersonMatch[];
    truncated: boolean;
  };
};

export type SubmissionAdminSpeakerInput = {
  name: string;
  email: string;
  biography: string;
};

export type SubmissionAdminDetail = NonNullable<
  Awaited<ReturnType<SubmissionService["getAdminSubmission"]>>
>;
