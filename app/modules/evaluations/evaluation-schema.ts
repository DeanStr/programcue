import { z } from "zod";

export const criterionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1, "Criterion name is required.").max(120),
  description: z.string().trim().max(500).default(""),
  inputType: z.enum(["scale_5", "scale_10", "yes_no", "free_text"]),
  weightPercent: z.coerce.number().int().min(0).max(100),
  required: z.boolean(),
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
    const scaledCriteria = round.criteria.filter((criterion) =>
      criterion.inputType.startsWith("scale_"),
    );
    const total = scaledCriteria.reduce(
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
    for (const [index, criterion] of round.criteria.entries()) {
      if (
        criterion.inputType.startsWith("scale_") &&
        criterion.weightPercent === 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "weightPercent"],
          message: "A scored criterion must have a positive weight.",
        });
      }
      if (criterion.inputType.startsWith("scale_") && !criterion.required) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "required"],
          message:
            "Scored criteria must be required so the weighted result is complete.",
        });
      }
      if (
        !criterion.inputType.startsWith("scale_") &&
        criterion.weightPercent !== 0
      ) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "weightPercent"],
          message: "Yes/no and free-text criteria must have zero weight.",
        });
      }
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
    decisionRole: z
      .enum(["administrator", "committee_chair"])
      .default("administrator"),
    rounds: z
      .array(evaluationRoundSchema)
      .min(1, "Add at least one evaluation round.")
      .max(10),
  })
  .superRefine((plan, context) => {
    if (
      new Set(plan.rounds.map((round) => round.id)).size !== plan.rounds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["rounds"],
        message: "Round identifiers must be unique.",
      });
    }
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
    targetType: z.enum(["submission", "session"]),
    targetIds: z.array(z.string().trim().min(1)).min(1).max(1_000),
    evaluatorPersonIds: z.array(z.string().trim().min(1)).max(100).default([]),
    teamId: z.string().trim().min(1).nullable().default(null),
  })
  .superRefine((assignment, context) => {
    if (!assignment.teamId && assignment.evaluatorPersonIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evaluatorPersonIds"],
        message: "Choose an evaluator or an evaluation team.",
      });
    }
    if (assignment.teamId && assignment.evaluatorPersonIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["teamId"],
        message: "Choose a team or individual evaluators, not both.",
      });
    }
  })
  .transform((value) => ({
    ...value,
    targetIds: [...new Set(value.targetIds)],
    evaluatorPersonIds: [...new Set(value.evaluatorPersonIds)],
  }));

export const assignmentUndoSchema = z.object({
  operationId: z.string().trim().min(1),
  confirmed: z.literal(true),
});

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
    scores: z.record(
      z.string().min(1),
      z.union([z.string().max(8_000), z.number(), z.boolean()]),
    ),
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
  confirmedWithoutReview: z.boolean().default(false),
  sessionDurationMinutes: z.coerce
    .number()
    .int()
    .min(5)
    .max(1_440)
    .nullable()
    .default(null),
});

export const evaluationTeamSchema = z.object({
  teamId: z.string().trim().min(1).nullable().default(null),
  name: z.string().trim().min(1, "Team name is required.").max(120),
  description: z.string().trim().max(1_000).default(""),
  chairPersonId: z.string().trim().min(1).nullable().default(null),
  status: z.enum(["active", "archived"]),
});

export const evaluationTeamMemberSchema = z.object({
  teamId: z.string().trim().min(1),
  personId: z.string().trim().min(1),
  role: z.enum(["chair", "evaluator"]),
  operation: z.enum(["add", "remove"]),
});

export const evaluationMemberInvitationSchema = z
  .object({
    name: z.string().trim().min(1, "Participant name is required.").max(120),
    email: z
      .email("Enter a valid participant email address.")
      .transform((value) => value.toLowerCase()),
    role: z.enum(["evaluator", "committee_chair"]),
    teamId: z.string().trim().min(1).nullable().default(null),
  })
  .superRefine((invitation, context) => {
    if (invitation.role === "committee_chair" && invitation.teamId) {
      context.addIssue({
        code: "custom",
        path: ["teamId"],
        message:
          "Invite the committee chair first, then assign them to a team after acceptance.",
      });
    }
  });

export const committeeChairAccessSchema = z.object({
  personId: z.string().trim().min(1),
  operation: z.enum(["promote", "revoke"]),
  confirmed: z.literal(true),
});

export const nextRoundSchema = z.object({
  planId: z.string().trim().min(1),
  planRevision: z.coerce.number().int().positive(),
  name: z.string().trim().min(1, "Round name is required.").max(120),
  dueAt: z.iso.datetime({ offset: true }).nullable().default(null),
  cloneRoundId: z.string().trim().min(1),
});

export const draftRoundUpdateSchema = z
  .object({
    roundId: z.string().trim().min(1),
    revision: z.coerce.number().int().positive(),
    name: z.string().trim().min(1, "Round name is required.").max(120),
    dueAt: z.iso.datetime({ offset: true }).nullable().default(null),
    criteria: z.array(criterionSchema).min(1).max(30),
  })
  .superRefine((round, context) => {
    const scaledCriteria = round.criteria.filter((criterion) =>
      criterion.inputType.startsWith("scale_"),
    );
    const total = scaledCriteria.reduce(
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
    for (const [index, criterion] of round.criteria.entries()) {
      const scaled = criterion.inputType.startsWith("scale_");
      if (scaled && criterion.weightPercent === 0) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "weightPercent"],
          message: "A scored criterion must have a positive weight.",
        });
      }
      if (scaled && !criterion.required) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "required"],
          message:
            "Scored criteria must be required so the weighted result is complete.",
        });
      }
      if (!scaled && criterion.weightPercent !== 0) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "weightPercent"],
          message: "Yes/no and free-text criteria must have zero weight.",
        });
      }
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

export const roundAdvancementSchema = z
  .object({
    fromRoundId: z.string().trim().min(1),
    fromRoundRevision: z.coerce.number().int().positive(),
    toRoundId: z.string().trim().min(1),
    toRoundRevision: z.coerce.number().int().positive(),
    submissionIds: z.array(z.string().trim().min(1)).min(1).max(1_000),
    evaluatorPersonIds: z.array(z.string().trim().min(1)).max(100).default([]),
    teamId: z.string().trim().min(1).nullable().default(null),
    confirmed: z.literal(true),
  })
  .superRefine((advancement, context) => {
    if (!advancement.teamId && advancement.evaluatorPersonIds.length === 0) {
      context.addIssue({
        code: "custom",
        path: ["evaluatorPersonIds"],
        message: "Choose the evaluators for the next round.",
      });
    }
    if (advancement.teamId && advancement.evaluatorPersonIds.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["teamId"],
        message: "Choose a team or individual evaluators, not both.",
      });
    }
  })
  .transform((value) => ({
    ...value,
    submissionIds: [...new Set(value.submissionIds)],
    evaluatorPersonIds: [...new Set(value.evaluatorPersonIds)],
  }));

export const moderationSchema = z.object({
  roundId: z.string().trim().min(1),
  submissionId: z.string().trim().min(1),
  expectedModerationId: z.string().trim().min(1).nullable().default(null),
  recommendation: z.enum(["accept", "waitlist", "reject", "advance"]),
  moderatedScore: z.coerce.number().min(1).max(5).nullable(),
  notes: z.string().trim().min(1, "Moderation notes are required.").max(8_000),
  status: z.enum(["draft", "confirmed"]),
  confirmed: z.boolean().default(false),
});

export const reviewReopenSchema = z.object({
  assignmentId: z.string().trim().min(1),
  reason: z
    .string()
    .trim()
    .min(10, "Explain why the submitted review must be reopened.")
    .max(2_000),
  confirmed: z.literal(true),
});

export type EvaluationPlanInput = z.infer<typeof evaluationPlanSchema>;
export type AssignmentBatchInput = z.infer<typeof assignmentBatchSchema>;
export type ReviewDraftInput = z.infer<typeof reviewDraftSchema>;
export type ConflictDeclarationInput = z.infer<
  typeof conflictDeclarationSchema
>;
export type DecisionInput = z.infer<typeof decisionSchema>;
