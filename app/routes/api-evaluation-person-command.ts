import { z } from "zod";
import { EvaluationService } from "~/modules/evaluations/evaluation-service.server";
import {
  ApiError,
  apiFailure,
  apiSuccess,
  correlationId,
  readJson,
} from "~/platform/api/api.server";
import { evaluationApiError } from "~/platform/api/api-evaluation-commands.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  EventRealtimeService,
  type RecordEventChangeInput,
} from "~/platform/realtime/event-realtime.server";
import type { Route } from "./+types/api-evaluation-person-command";

const commandSchema = z.enum(["review", "conflict", "moderation", "reopen"]);
const recommendationSchema = z.enum([
  "accept",
  "minor_changes",
  "conditional_accept",
  "waitlist",
  "reject",
]);
const reviewSchema = z
  .object({
    assignmentId: z.string().trim().min(1).max(200),
    revision: z.number().int().nonnegative(),
    scores: z
      .record(
        z.string().trim().min(1).max(100),
        z.union([z.string().max(8_000), z.number(), z.boolean()]),
      )
      .refine((scores) => Object.keys(scores).length <= 50, {
        message: "A review may contain at most 50 criterion responses",
      }),
    recommendation: recommendationSchema.nullable(),
    confidence: z.number().int().min(1).max(5).nullable(),
    submitterFeedback: z.string().trim().max(8_000),
    privateNotes: z.string().trim().max(8_000),
    conflictAffirmed: z.boolean().optional(),
    intent: z.enum(["save", "submit"]),
  })
  .strict()
  .superRefine((review, context) => {
    if (review.intent === "submit" && !review.recommendation) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "Choose a recommendation before submitting",
      });
    }
    if (review.intent === "submit" && !review.confidence) {
      context.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "Choose a confidence rating before submitting",
      });
    }
  });
const conflictSchema = z
  .object({
    assignmentId: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(10).max(2_000),
  })
  .strict();
const moderationSchema = z
  .object({
    roundId: z.string().trim().min(1).max(200),
    submissionId: z.string().trim().min(1).max(200),
    expectedModerationId: z.string().trim().min(1).max(200).nullable(),
    recommendation: z.enum(["accept", "waitlist", "reject", "advance"]),
    moderatedScore: z.number().min(1).max(5).nullable(),
    notes: z.string().trim().min(1).max(8_000),
    status: z.enum(["draft", "confirmed"]),
    confirmed: z.boolean(),
  })
  .strict();
const reopenSchema = z
  .object({
    assignmentId: z.string().trim().min(1).max(200),
    reason: z.string().trim().min(10).max(2_000),
    confirmed: z.literal(true),
  })
  .strict();

function requireSameOrigin(request: Request) {
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    throw new ApiError(
      403,
      "SAME_ORIGIN_REQUIRED",
      "Authenticated-person evaluation commands require an exact same-origin request",
    );
  }
}

async function recordPersonChange(
  env: CloudflareEnvironment,
  viewer: Awaited<ReturnType<typeof requireEventRole>>,
  input: RecordEventChangeInput,
) {
  const service = new EventRealtimeService(env);
  try {
    const change = await service.commitChange(viewer, input);
    try {
      await service.notifyCommittedChange(viewer, change.cursor);
      return { changeCursor: change.cursor, realtimeWarning: null };
    } catch (error) {
      console.error("Failed to notify an evaluation API change", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return {
        changeCursor: change.cursor,
        realtimeWarning:
          "The evaluation command committed, but live invalidation failed.",
      };
    }
  } catch (error) {
    console.error("Failed to record an evaluation API change", {
      errorName: error instanceof Error ? error.name : "UnknownError",
    });
    return {
      changeCursor: null,
      realtimeWarning:
        "The evaluation command committed, but its durable live invalidation could not be recorded.",
    };
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
        "Evaluation person commands require POST",
      );
    }
    requireSameOrigin(request);
    if (!params.eventId) {
      throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
    }
    const command = commandSchema.parse(params.command);
    const viewer = await requireEventRole(
      request,
      env,
      params.eventId,
      ["owner", "administrator", "committee_chair", "evaluator"],
      "response",
    );
    const raw = await readJson(request, 256_000);
    const service = new EvaluationService(env);
    if (command === "conflict") {
      const input = conflictSchema.parse(raw);
      await service.declareConflict(viewer, input);
      const realtime = await recordPersonChange(env, viewer, {
        entityType: "evaluator_assignment",
        entityId: input.assignmentId,
        changeType: "updated",
        correlationId: requestCorrelationId,
      });
      return apiSuccess({
        assignmentId: input.assignmentId,
        status: "recused",
        ...realtime,
        correlationId: requestCorrelationId,
      });
    }
    if (command === "review") {
      const input = reviewSchema.parse(raw);
      const result = await service.saveReview(viewer, input);
      const realtime = await recordPersonChange(env, viewer, {
        entityType: "review",
        entityId: result.reviewId,
        changeType: input.intent === "submit" ? "published" : "updated",
        correlationId: requestCorrelationId,
      });
      const { webhookDeliveries, ...reviewResult } = result;
      return apiSuccess({
        ...reviewResult,
        ...realtime,
        webhookDeliveries: webhookDeliveries.map(
          ({ duplicate: _duplicate, ...delivery }) => delivery,
        ),
        webhookWarning: webhookDeliveries.some(
          (delivery) => delivery.status === "queue_failed",
        )
          ? "One or more outbound webhook deliveries require retry."
          : null,
        correlationId: requestCorrelationId,
      });
    }
    if (command === "moderation") {
      const input = moderationSchema.parse(raw);
      const moderationId = await service.moderate(viewer, input);
      const realtime = await recordPersonChange(env, viewer, {
        entityType: "review_moderation",
        entityId: moderationId,
        changeType: input.status === "confirmed" ? "published" : "updated",
        correlationId: requestCorrelationId,
      });
      return apiSuccess({
        moderationId,
        status: input.status,
        ...realtime,
        correlationId: requestCorrelationId,
      });
    }
    const input = reopenSchema.parse(raw);
    const result = await service.reopenReview(viewer, input);
    const realtime = await recordPersonChange(env, viewer, {
      entityType: "review",
      entityId: result.reviewId,
      changeType: "updated",
      correlationId: requestCorrelationId,
    });
    const { webhookDeliveries, ...reopenResult } = result;
    return apiSuccess({
      ...reopenResult,
      ...realtime,
      webhookDeliveries: webhookDeliveries.map(
        ({ duplicate: _duplicate, ...delivery }) => delivery,
      ),
      webhookWarning: webhookDeliveries.some(
        (delivery) => delivery.status === "queue_failed",
      )
        ? "One or more outbound webhook deliveries require retry."
        : null,
      correlationId: requestCorrelationId,
    });
  } catch (error) {
    return apiFailure(
      evaluationApiError(error),
      request,
      env.APP_ENV ?? "unknown",
      requestCorrelationId,
    );
  }
}

export function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const response = apiFailure(
    new ApiError(
      405,
      "METHOD_NOT_ALLOWED",
      "Evaluation person commands require POST",
    ),
    request,
    env.APP_ENV ?? "unknown",
  );
  response.headers.set("allow", "POST");
  return response;
}
