import { z } from "zod";

export const criterionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1, "Criterion name is required.").max(120),
  description: z.string().trim().max(500).default(""),
  weightPercent: z.coerce.number().int().min(1).max(100),
  position: z.coerce.number().int().min(0),
});

export const evaluationRoundSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1, "Round name is required.").max(120),
    dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
    anonymous: z.boolean().default(false),
    criteria: z
      .array(criterionSchema)
      .min(1, "Add at least one criterion.")
      .max(30),
  })
  .superRefine((round, context) => {
    const total = round.criteria.reduce(
      (sum, criterion) => sum + criterion.weightPercent,
      0,
    );
    if (total !== 100) {
      context.addIssue({
        code: "custom",
        path: ["criteria"],
        message: `Criterion weights must total 100%; the current total is ${total}%.`,
      });
    }
    if (
      new Set(round.criteria.map((criterion) => criterion.id)).size !==
      round.criteria.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "Criterion identifiers must be unique.",
      });
    }
  });

export const evaluationPlanSchema = z
  .object({
    revision: z.coerce.number().int().min(0),
    name: z.string().trim().min(1, "Plan name is required.").max(120),
    status: z.enum(["draft", "active", "closed"]),
    rounds: z
      .array(evaluationRoundSchema)
      .min(1, "Add at least one evaluation round.")
      .max(10),
  })
  .superRefine((plan, context) => {
    if (new Set(plan.rounds.map((round) => round.anonymous)).size > 1) {
      context.addIssue({
        code: "custom",
        path: ["rounds"],
        message:
          "Blinded reviewing applies to the whole evaluation plan, so every round must use the same setting.",
      });
    }
  });

export const assignmentBatchSchema = z
  .object({
    roundId: z.string().trim().min(1),
    submissionIds: z.array(z.string().trim().min(1)).min(1).max(1_000),
    evaluatorPersonIds: z.array(z.string().trim().min(1)).min(1).max(100),
  })
  .transform((value) => ({
    ...value,
    submissionIds: [...new Set(value.submissionIds)],
    evaluatorPersonIds: [...new Set(value.evaluatorPersonIds)],
  }));

const recommendationSchema = z.enum([
  "accept",
  "minor_changes",
  "conditional_accept",
  "waitlist",
  "reject",
]);

export const reviewDraftSchema = z
  .object({
    assignmentId: z.string().trim().min(1),
    revision: z.coerce.number().int().min(0),
    scores: z.record(z.string().min(1), z.coerce.number().int().min(1).max(5)),
    recommendation: recommendationSchema.nullable(),
    confidence: z.coerce.number().int().min(1).max(5).nullable(),
    submitterFeedback: z.string().trim().max(8_000),
    privateNotes: z.string().trim().max(8_000),
    intent: z.enum(["save", "submit"]),
  })
  .superRefine((review, context) => {
    if (review.intent === "submit" && !review.recommendation) {
      context.addIssue({
        code: "custom",
        path: ["recommendation"],
        message: "Choose a recommendation before submitting.",
      });
    }
    if (review.intent === "submit" && !review.confidence) {
      context.addIssue({
        code: "custom",
        path: ["confidence"],
        message: "Choose a confidence rating before submitting.",
      });
    }
  });

export const conflictDeclarationSchema = z.object({
  assignmentId: z.string().trim().min(1),
  reason: z
    .string()
    .trim()
    .min(10, "Explain the conflict so it can be reassigned.")
    .max(2_000),
});

export const decisionSchema = z.object({
  submissionId: z.string().trim().min(1),
  decision: z.enum(["accepted", "rejected", "waitlisted"]),
  rationale: z.string().trim().max(4_000),
  release: z.boolean().default(false),
});

export type EvaluationPlanInput = z.infer<typeof evaluationPlanSchema>;
export type AssignmentBatchInput = z.infer<typeof assignmentBatchSchema>;
export type ReviewDraftInput = z.infer<typeof reviewDraftSchema>;
export type ConflictDeclarationInput = z.infer<
  typeof conflictDeclarationSchema
>;
export type DecisionInput = z.infer<typeof decisionSchema>;
