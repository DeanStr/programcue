import { ZodError, z } from "zod";

import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "~/modules/evaluations/evaluation-errors";
import {
  assignmentBatchSchema,
  evaluationPlanSchema,
  evaluationRoundReviewerSchema,
  nextRoundSchema,
  roundAdvancementSchema,
} from "~/modules/evaluations/evaluation-schema";
import { ApiError } from "./api.server";

const criterionInputSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(500).default(""),
    inputType: z.enum([
      "scale_5",
      "scale_10",
      "yes_no",
      "free_text",
      "dropdown",
    ]),
    options: z.array(z.string().trim().min(1).max(120)).max(100).default([]),
    weightPercent: z.number().int().min(0).max(100),
    required: z.boolean(),
    position: z.number().int().nonnegative(),
  })
  .strict();

const roundInputSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1).max(120),
    opensAt: z.iso.datetime({ offset: true }).nullable().optional(),
    closesAt: z.iso.datetime({ offset: true }).nullable().optional(),
    dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
    anonymous: z.boolean(),
    scorecardId: z.string().trim().min(1).max(120),
    scorecardVersion: z.number().int().positive(),
    criteria: z.array(criterionInputSchema).min(1).max(30),
  })
  .strict();

export const apiEvaluationPlanSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    name: z.string().trim().min(1).max(120),
    status: z.enum(["draft", "active", "closed"]),
    decisionRole: z.enum(["administrator", "committee_chair"]),
    rounds: z.array(roundInputSchema).min(1).max(10),
  })
  .strict()
  .transform((input) => evaluationPlanSchema.parse(input));

export const apiNextRoundSchema = z
  .object({
    planId: z.string().trim().min(1).max(200),
    planRevision: z.number().int().positive(),
    name: z.string().trim().min(1).max(120),
    opensAt: z.iso.datetime({ offset: true }).nullable().optional(),
    closesAt: z.iso.datetime({ offset: true }).nullable().optional(),
    dueAt: z.iso.datetime({ offset: true }).nullable().default(null),
    anonymous: z.boolean().optional(),
    scorecardId: z.string().trim().min(1).max(120).nullable().optional(),
    scorecardVersion: z.number().int().positive().optional(),
    cloneRoundId: z.string().trim().min(1).max(200),
  })
  .strict()
  .transform((input) => nextRoundSchema.parse(input));

export const apiAssignmentSchema = z
  .object({
    roundId: z.string().trim().min(1).max(200),
    targetType: z.enum(["submission", "session"]),
    targetIds: z.array(z.string().trim().min(1).max(200)).min(1).max(1_000),
    evaluatorPersonIds: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .default([]),
    teamId: z.string().trim().min(1).max(200).nullable().default(null),
  })
  .strict()
  .transform((input) => assignmentBatchSchema.parse(input));

export const apiRoundReviewerSchema = z
  .object({
    roundId: z.string().trim().min(1).max(200),
    personId: z.string().trim().min(1).max(200),
    operation: z.enum(["add", "remove"]),
    confirmed: z.literal(true).optional(),
  })
  .strict()
  .transform((input) => evaluationRoundReviewerSchema.parse(input));

export const apiRoundAdvancementSchema = z
  .object({
    fromRoundId: z.string().trim().min(1).max(200),
    fromRoundRevision: z.number().int().positive(),
    toRoundId: z.string().trim().min(1).max(200),
    toRoundRevision: z.number().int().positive(),
    submissionIds: z.array(z.string().trim().min(1).max(200)).min(1).max(1_000),
    evaluatorPersonIds: z
      .array(z.string().trim().min(1).max(200))
      .max(100)
      .default([]),
    teamId: z.string().trim().min(1).max(200).nullable().default(null),
    confirmed: z.literal(true),
  })
  .strict()
  .transform((input) => roundAdvancementSchema.parse(input));

export function evaluationApiError(error: unknown) {
  if (error instanceof ZodError) {
    return new ApiError(
      422,
      "VALIDATION_ERROR",
      "The evaluation command is invalid",
      error.issues,
    );
  }
  if (error instanceof EvaluationRevisionConflictError) {
    return new ApiError(409, "EVALUATION_REVISION_CONFLICT", error.message);
  }
  if (error instanceof EvaluationStateError) {
    return new ApiError(409, "EVALUATION_STATE_CONFLICT", error.message);
  }
  if (error instanceof EvaluationValidationError) {
    return new ApiError(422, "EVALUATION_VALIDATION_ERROR", error.message);
  }
  if (error instanceof Response) {
    return new ApiError(
      error.status,
      error.status === 403 ? "AUTH_FORBIDDEN" : "EVALUATION_REQUEST_FAILED",
      error.statusText || "The evaluation request failed",
    );
  }
  return error;
}
