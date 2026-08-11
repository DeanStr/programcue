import { z, ZodError } from "zod";

import type { Route } from "./+types/api-participant-submission-command";
import {
  PublicFormUnavailableError,
  SubmissionService,
} from "~/modules/submissions/submission-service.server";
import {
  SubmissionDraftSavedError,
  SubmissionRevisionConflictError,
  SubmissionStateError,
} from "~/modules/submissions/submission-repository.server";
import {
  speakerInputSchema,
  uploadReferenceSchema,
} from "~/modules/submissions/submission-schema";
import { ApiParticipantService } from "~/platform/api/api-participant-service.server";
import {
  ApiError,
  apiFailure,
  apiRequestHash,
  apiSuccess,
  correlationId,
  readJson,
  requireIdempotencyKey,
} from "~/platform/api/api.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { WebhookService } from "~/platform/operations/webhook-service.server";

const commandSchema = z.enum(["submit", "withdraw"]);
const answerSchema = z.union([
  z.string().max(5_000),
  z.array(z.string().max(200)).max(30),
]);
const answersSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{1,39}$/u),
    answerSchema,
  )
  .refine((answers) => Object.keys(answers).length <= 50, {
    message: "A submission may contain at most 50 answers",
  });
const strictSpeakerSchema = speakerInputSchema.strict();
const speakersSchema = z
  .array(strictSpeakerSchema)
  .min(1)
  .max(20)
  .superRefine((speakers, context) => {
    const emails = speakers.map((speaker) => speaker.email);
    if (new Set(emails).size !== emails.length) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "Each speaker must use a different email address",
      });
    }
  });
const uploadsSchema = z
  .record(
    z.string().regex(/^[a-z][a-z0-9_]{1,39}$/u),
    uploadReferenceSchema.strict(),
  )
  .refine((uploads) => Object.keys(uploads).length <= 1, {
    message: "A submission may reference at most one native video upload",
  })
  .default({});
const submitSchema = z
  .object({
    confirmed: z.literal(true),
    revision: z.number().int().nonnegative(),
    answers: answersSchema,
    speakers: speakersSchema,
    uploads: uploadsSchema,
  })
  .strict();
const withdrawSchema = z
  .object({
    confirmed: z.literal(true),
    revision: z.number().int().positive(),
  })
  .strict();

function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new ApiError(
      403,
      "SAME_ORIGIN_REQUIRED",
      "Participant mutations require an exact same-origin request",
    );
  }
}

function participantCommandError(error: unknown) {
  if (error instanceof ZodError) {
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      "The participant submission command is invalid",
      error.issues,
    );
  }
  if (error instanceof SubmissionDraftSavedError) {
    return new ApiError(
      409,
      "SUBMISSION_BLOCKED_DRAFT_SAVED",
      error.message,
      {
        committed: true,
        submissionId: error.submissionId,
        draftRevision: error.draftRevision,
      },
    );
  }
  if (error instanceof SubmissionRevisionConflictError) {
    return new ApiError(409, "SUBMISSION_REVISION_CONFLICT", error.message);
  }
  if (
    error instanceof SubmissionStateError ||
    error instanceof PublicFormUnavailableError
  ) {
    return new ApiError(409, "SUBMISSION_STATE_CONFLICT", error.message);
  }
  if (error instanceof Response) {
    if (error.status === 401) {
      return new ApiError(401, "AUTH_REQUIRED", "Authentication is required");
    }
    if (error.status === 403) {
      return new ApiError(
        403,
        "EVENT_FORBIDDEN",
        "The authenticated participant cannot access this event",
      );
    }
    if (error.status === 404) {
      return new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission not found");
    }
  }
  return error;
}

async function queueWebhook(
  env: CloudflareEnvironment,
  actor: {
    organisationId: string;
    eventId: string;
    personId: string;
  },
  input: Parameters<WebhookService["queueEvent"]>[1],
) {
  try {
    const deliveries = await new WebhookService(env).queueEvent(actor, input);
    return {
      deliveries,
      warning: deliveries.some(
        (delivery) => delivery.status === "queue_failed",
      )
        ? "One or more outbound webhook deliveries require retry."
        : null,
    };
  } catch (error) {
    console.error("Failed to record participant API webhook event", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    throw error;
  }
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const requestCorrelationId = correlationId(request);
  try {
    if (request.method.toUpperCase() !== "POST") {
      throw new ApiError(
        405,
        "METHOD_NOT_ALLOWED",
        "Participant submission commands require POST",
      );
    }
    requireSameOrigin(request);
    if (!params.eventId || !params.submissionId) {
      throw new ApiError(404, "SUBMISSION_NOT_FOUND", "Submission not found");
    }
    const command = commandSchema.parse(params.command);
    const viewer = await requireEventRole(
      request,
      env,
      params.eventId,
      ["speaker", "submitter"],
      "response",
    );
    const idempotencyKey = requireIdempotencyKey(request);
    const rawInput = await readJson(
      request,
      command === "submit" ? 256_000 : 16_000,
    );
    const parsedCommand =
      command === "submit"
        ? ({
            command: "submit" as const,
            input: submitSchema.parse(rawInput),
          } as const)
        : ({
            command: "withdraw" as const,
            input: withdrawSchema.parse(rawInput),
          } as const);
    const participantService = new ApiParticipantService(env);
    const { applicant, publicSlug } =
      await participantService.submissionCommandContext(
        viewer,
        params.submissionId,
      );
    const finishCommand = async (
      operationId: string,
      domain: {
        submission: {
          id: string;
          status: string;
          revision?: number;
          directSessionId?: string | null;
        };
      },
      resumeNotifications: boolean,
    ) => {
      if (resumeNotifications && parsedCommand.command === "submit") {
        await participantService.resumeSubmissionNotifications(
          viewer,
          domain.submission.id,
        );
      }
      const notifications =
        parsedCommand.command === "submit"
          ? await participantService.submissionNotificationState(
              viewer,
              domain.submission.id,
            )
          : [];
      const [primaryWebhook, sessionWebhook, realtime] = await Promise.all([
        queueWebhook(env, viewer, {
          eventType:
            parsedCommand.command === "withdraw"
              ? "submission.withdrawn"
              : "submission.submitted",
          entityType: "submission",
          entityId: domain.submission.id,
          idempotencyKey:
            parsedCommand.command === "withdraw"
              ? `submission.withdrawn:${domain.submission.id}`
              : `submission.submitted:${domain.submission.id}`,
          correlationId: operationId,
          data: {
            status: domain.submission.status,
            ...(domain.submission.revision === undefined
              ? {}
              : { revision: domain.submission.revision }),
            ...(domain.submission.directSessionId === undefined
              ? {}
              : { directSessionId: domain.submission.directSessionId }),
          },
        }),
        parsedCommand.command === "submit" &&
        domain.submission.directSessionId
          ? queueWebhook(env, viewer, {
              eventType: "session.created",
              entityType: "session",
              entityId: domain.submission.directSessionId,
              idempotencyKey: `session.created:${domain.submission.directSessionId}`,
              correlationId: operationId,
              data: {
                source: "participant_api_direct_session_form",
                intakeReference: domain.submission.id,
              },
            })
          : Promise.resolve({ deliveries: [], warning: null }),
        participantService.recordSubmissionCommandChange(
          viewer,
          operationId,
          domain.submission.id,
          parsedCommand.command === "withdraw" ? "updated" : "created",
        ),
      ]);
      const webhookDeliveries = [
        ...primaryWebhook.deliveries,
        ...sessionWebhook.deliveries,
      ].map(({ duplicate: _duplicate, ...delivery }) => delivery);
      const warnings = [
        notifications.some((notification) =>
          ["queue_failed", "failed"].includes(notification.status),
        )
          ? "One or more submission notification operations require retry."
          : null,
        primaryWebhook.warning,
        sessionWebhook.warning,
        realtime.realtimeWarning,
      ].filter((warning): warning is string => Boolean(warning));
      return {
        ...domain,
        notifications,
        webhookDeliveries,
        changeCursor: realtime.changeCursor,
        warnings,
      };
    };
    const result = await participantService.runCommand(
      viewer,
      `participant.submission.${command}`,
      idempotencyKey,
      await apiRequestHash({
        submissionId: params.submissionId,
        ...parsedCommand.input,
      }),
      async (operationId) => {
        const submissionService = new SubmissionService(env);
        if (parsedCommand.command === "withdraw") {
          const input = parsedCommand.input;
          const withdrawn =
            await submissionService.withdrawSubmissionForParticipantApi(
              publicSlug,
              applicant,
              {
                submissionId: params.submissionId,
                revision: input.revision,
              },
              operationId,
            );
          return finishCommand(operationId, {
            submission: {
              id: withdrawn.submissionId,
              status: "withdrawn",
              revision: withdrawn.revision,
            },
          }, false);
        }

        const input = parsedCommand.input;
        const submitted =
          await submissionService.submitDraftForParticipantApi(
            publicSlug,
            applicant,
            {
              submissionId: params.submissionId,
              revision: input.revision,
              answers: input.answers,
              speakers: input.speakers,
              uploads: input.uploads,
            },
            operationId,
          );
        return finishCommand(operationId, {
          submission: {
            id: submitted.submissionId,
            status: submitted.status,
            directSessionId: submitted.directSessionId,
          },
        }, false);
      },
      async (operationId) => {
        const recovered = await participantService.recoverSubmissionCommand(
          viewer,
          params.submissionId,
          parsedCommand.command,
          operationId,
        );
        return recovered.response
          ? {
              response: await finishCommand(
                operationId,
                recovered.response,
                true,
              ),
              progressed: true,
            }
          : recovered;
      },
    );
    return apiSuccess({
      ...result.response,
      replayed: result.replayed,
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    const response = apiFailure(
      participantCommandError(error),
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
    if (error instanceof ApiError && error.status === 405) {
      response.headers.set("allow", "POST");
    }
    return response;
  }
}

export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const response = apiFailure(
    new ApiError(
      405,
      "METHOD_NOT_ALLOWED",
      "Participant submission commands require POST",
    ),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "POST");
  return response;
}
