import { ZodError, z } from "zod";
import { EvaluationStateError } from "~/modules/evaluations/evaluation-errors";
import { PersonDuplicateService } from "~/modules/people/person-duplicate-service.server";
import {
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "~/modules/submissions/submission-repository.server";
import { speakerInputSchema } from "~/modules/submissions/submission-schema";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  WebhookService,
  webhookActorForAudit,
} from "~/platform/operations/webhook-service.server";
import type {
  SubmissionAdminSpeakerInput,
  SubmissionsAdminActionResult,
} from "./submissions-admin-types";

class InvalidAdminCreationPayloadError extends Error {}
class InvalidAdminCreationSpeakerError extends Error {}

export function adminCreationSpeakers(formData: FormData) {
  const rawSpeakers = formData.get("speakers");
  if (typeof rawSpeakers !== "string" || rawSpeakers.trim() === "") {
    throw new InvalidAdminCreationPayloadError(
      "The speaker details are missing. Refresh and try again.",
    );
  }
  try {
    const parsed: unknown = JSON.parse(rawSpeakers);
    const result = z.array(speakerInputSchema).min(1).max(20).safeParse(parsed);
    if (!result.success) {
      throw new InvalidAdminCreationSpeakerError(
        "Add at least one speaker with a name and valid email.",
      );
    }
    return result.data as SubmissionAdminSpeakerInput[];
  } catch (error) {
    if (error instanceof InvalidAdminCreationSpeakerError) throw error;
    throw new InvalidAdminCreationPayloadError(
      "The speaker details are invalid. Refresh and try again.",
    );
  }
}

export async function duplicateCreationWarning(
  env: CloudflareEnvironment,
  viewer: Viewer,
  formData: FormData,
  people: unknown[],
  intent: "create_direct_session" | "create_manual_application",
): Promise<SubmissionsAdminActionResult | null> {
  const duplicateCheck = await new PersonDuplicateService(
    env,
  ).findLikelyDuplicates(viewer, people);
  if (
    duplicateCheck.matches.length === 0 ||
    formData.get("confirmDuplicatePeople") === "yes"
  ) {
    return null;
  }
  return {
    ok: false,
    message:
      intent === "create_direct_session"
        ? "Review the likely existing people before creating this direct session."
        : "Review the likely existing people before creating this application record.",
    duplicateCheck: {
      intent,
      matches: duplicateCheck.matches,
      truncated: duplicateCheck.truncated,
    },
  };
}

export async function manualApplicationWebhookWarning(
  env: CloudflareEnvironment,
  viewer: Viewer,
  submissionId: string,
  routedTeamIds: string[],
) {
  const webhookService = new WebhookService(env);
  const warnings = await Promise.all(
    (["submission.created", "submission.submitted"] as const).map(
      async (eventType) => {
        try {
          const deliveries = await webhookService.queueEvent(
            webhookActorForAudit(viewer, "admin_ui"),
            {
              eventType,
              entityType: "submission",
              entityId: submissionId,
              idempotencyKey: `${eventType}:${submissionId}`,
              correlationId: crypto.randomUUID(),
              data: {
                source: "administrator_manual_entry",
                status: "submitted",
                routedTeamIds,
              },
            },
          );
          return deliveries.some((delivery) =>
            [
              "queue_failed",
              "partially_failed",
              "failed",
              "cancelled",
            ].includes(delivery.status),
          )
            ? "One or more outbound webhook deliveries require retry."
            : null;
        } catch (error) {
          console.error("Failed to resume a manual-application webhook", {
            eventType,
            errorName: error instanceof Error ? error.name : "UnknownError",
          });
          return "An outbound webhook event could not be recorded.";
        }
      },
    ),
  );
  return (
    [...new Set(warnings.filter((warning) => warning !== null))].join(" ") ||
    null
  );
}

export function adminCreationFailure(error: unknown): {
  result: SubmissionsAdminActionResult;
  status: number;
} | null {
  if (error instanceof ZodError) {
    const speakerIssue = error.issues.find(
      (issue) => issue.path[0] === "speakers",
    );
    const speakerMessage = speakerIssue
      ? speakerIssue.code === "custom"
        ? speakerIssue.message
        : "Add at least one speaker with a name and valid email."
      : null;
    return {
      result: {
        ok: false,
        message:
          speakerMessage ??
          error.issues[0]?.message ??
          "Review the submitted record details.",
        ...(speakerMessage
          ? { fieldErrors: { speakers: speakerMessage } }
          : {}),
      },
      status: 422,
    };
  }
  if (error instanceof InvalidAdminCreationPayloadError) {
    return { result: { ok: false, message: error.message }, status: 400 };
  }
  if (error instanceof InvalidAdminCreationSpeakerError) {
    return {
      result: {
        ok: false,
        message: error.message,
        fieldErrors: { speakers: error.message },
      },
      status: 422,
    };
  }
  if (
    error instanceof SubmissionStateError ||
    error instanceof SubmissionRevisionConflictError ||
    error instanceof EvaluationStateError
  ) {
    return { result: { ok: false, message: error.message }, status: 409 };
  }
  return null;
}
