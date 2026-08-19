import { z } from "zod";

import { recommendationChoicesSchema } from "./evaluation-recommendation-choices";

export const criterionSchema = z.object({
  id: z.string().trim().min(1).max(80),
  name: z.string().trim().min(1, "Criterion name is required.").max(120),
  description: z.string().trim().max(500).default(""),
  inputType: z.enum(["scale_5", "scale_10", "yes_no", "free_text", "dropdown"]),
  options: z
    .array(
      z.string().trim().min(1, "Dropdown options cannot be blank.").max(120),
    )
    .max(100)
    .default([]),
  weightPercent: z.coerce.number().int().min(0).max(100),
  required: z.boolean(),
  position: z.coerce.number().int().min(0),
});

export const evaluationRoundSchema = z
  .object({
    id: z.string().trim().min(1).max(80),
    name: z.string().trim().min(1, "Round name is required.").max(120),
    opensAt: z.iso.datetime({ offset: true }).nullable().optional(),
    closesAt: z.iso.datetime({ offset: true }).nullable().optional(),
    dueAt: z.iso.datetime({ offset: true }).nullable().optional(),
    anonymous: z.boolean().default(false),
    scorecardId: z.string().trim().min(1).max(120).optional(),
    scorecardVersion: z.coerce.number().int().positive().default(1),
    recommendationChoices: recommendationChoicesSchema,
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
      if (criterion.inputType === "dropdown") {
        if (criterion.options.length === 0) {
          context.addIssue({
            code: "custom",
            path: ["criteria", index, "options"],
            message: "Dropdown criteria need at least one option.",
          });
        }
        if (new Set(criterion.options).size !== criterion.options.length) {
          context.addIssue({
            code: "custom",
            path: ["criteria", index, "options"],
            message: "Dropdown options must be unique.",
          });
        }
      } else if (criterion.options.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "options"],
          message: "Only dropdown criteria can define options.",
        });
      }
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
          message:
            "Yes/no, dropdown and free-text criteria must have zero weight.",
        });
      }
    }
    const opensAt = round.opensAt ?? null;
    const closesAt =
      round.closesAt !== undefined ? round.closesAt : (round.dueAt ?? null);
    if (opensAt && closesAt && Date.parse(closesAt) <= Date.parse(opensAt)) {
      context.addIssue({
        code: "custom",
        path: ["closesAt"],
        message: "The round close date must be after its open date.",
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
    const normalisedRoundNames = plan.rounds.map((round) =>
      round.name.trim().toLowerCase(),
    );
    if (new Set(normalisedRoundNames).size !== normalisedRoundNames.length) {
      context.addIssue({
        code: "custom",
        path: ["rounds"],
        message: "Round names must be unique within an evaluation plan.",
      });
    }
  });

const reviewCycleRoundDefinitionSchema = z
  .object({
    name: z.string().trim().min(1, "Round name is required.").max(120),
    opensAt: z.iso.datetime({ offset: true }).nullable().optional(),
    closesAt: z.iso.datetime({ offset: true }).nullable().optional(),
    anonymous: z.boolean().default(false),
    recommendationChoices: recommendationChoicesSchema,
    criteria: z
      .array(criterionSchema.omit({ id: true, position: true }))
      .min(1)
      .max(30),
  })
  .superRefine((round, context) => {
    const validation = evaluationRoundSchema.safeParse({
      id: "new-review-cycle-round",
      ...round,
      criteria: round.criteria.map((criterion, index) => ({
        ...criterion,
        id: `new-review-cycle-criterion-${index}`,
        position: index,
      })),
    });
    if (!validation.success) {
      for (const issue of validation.error.issues) {
        context.addIssue({
          ...issue,
          path: issue.path,
        });
      }
    }
  });

export const reviewCycleStartSchema = z.object({
  currentPlanId: z.string().trim().min(1).max(80),
  currentPlanRevision: z.coerce.number().int().positive(),
  expectedRunningAssessmentOperationCount: z.coerce
    .number()
    .int()
    .nonnegative(),
  expectedUnfinishedAssignmentCount: z.coerce.number().int().nonnegative(),
  expectedUnfinishedReviewCount: z.coerce.number().int().nonnegative(),
  planName: z.string().trim().min(1, "Plan name is required.").max(120),
  round: reviewCycleRoundDefinitionSchema,
  confirmed: z.literal(true),
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

const recommendationSchema = z.string().trim().min(1).max(80);

export const reviewerAiCriterionSuggestionsSchema = z
  .array(
    z
      .object({
        criterionId: z.string().trim().min(1).max(200),
        suggestedValue: z.string().max(500).nullable(),
        rationale: z.string().trim().min(20).max(800),
        evidenceFieldIds: z.array(z.string().trim().min(1).max(200)).max(20),
      })
      .strict(),
  )
  .min(1)
  .max(30);

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
    /* The reviewer's answer to the conflict question. A draft may be saved
       before it is answered; a submission may not. Absent means unanswered,
       which is the same as a negative for every rule that reads it. */
    conflictAffirmed: z
      .union([z.boolean(), z.enum(["true", "false", ""])])
      .optional()
      .transform((value) => value === true || value === "true"),
    suggestionId: z.string().trim().min(1).max(200).nullable().default(null),
    importedCriterionIds: z
      .array(z.string().trim().min(1).max(200))
      .max(30)
      .default([]),
    confirmedAiCriterionIds: z
      .array(z.string().trim().min(1).max(200))
      .max(30)
      .default([]),
    intent: z.enum(["save", "submit"]),
  })
  .superRefine((review, context) => {
    if (
      new Set(review.importedCriterionIds).size !==
      review.importedCriterionIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["importedCriterionIds"],
        message: "Each imported AI criterion must appear once.",
      });
    }
    if (
      new Set(review.confirmedAiCriterionIds).size !==
      review.confirmedAiCriterionIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["confirmedAiCriterionIds"],
        message: "Confirm each unchanged AI criterion once.",
      });
    }
    if (!review.suggestionId && review.importedCriterionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["suggestionId"],
        message: "Imported AI criteria require their suggestion identifier.",
      });
    }
    if (review.intent !== "submit" && review.confirmedAiCriterionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["confirmedAiCriterionIds"],
        message: "AI-derived criteria are confirmed only when submitting.",
      });
    }
    if (review.intent === "submit" && !review.conflictAffirmed) {
      context.addIssue({
        code: "custom",
        path: ["conflictAffirmed"],
        message:
          "Confirm you hold no conflict of interest before submitting, or declare a conflict to return this assignment.",
      });
    }
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

export const evaluationDiscussionTargetSchema = z.object({
  roundId: z.string().trim().min(1).max(200),
  targetType: z.enum(["submission", "session"]),
  targetId: z.string().trim().min(1).max(200),
});

export const evaluationDiscussionPageSchema =
  evaluationDiscussionTargetSchema.extend({
    cursor: z.string().trim().min(1).max(512).optional(),
  });

export const evaluationDiscussionMessageSchema =
  evaluationDiscussionTargetSchema.extend({
    body: z
      .string()
      .trim()
      .min(1, "Enter a discussion message.")
      .max(2000, "Discussion messages must contain at most 2,000 characters."),
    idempotencyKey: z.uuid(),
  });

export const decisionBaseSchema = z.object({
  submissionId: z.string().trim().min(1),
  decision: z.enum(["accepted", "rejected", "waitlisted"]),
  rationale: z.string().trim().max(4_000),
  includeReviewerFeedback: z.boolean().default(false),
  release: z.boolean().default(false),
  confirmedWithoutReview: z.boolean().default(false),
  sessionTrackId: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .nullable()
    .default(null)
    .describe(
      "Required for an accepted decision and must identify one of the proposal's submitted tracks.",
    ),
  sessionFormatKey: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .nullable()
    .default(null)
    .describe(
      "Required for an accepted decision and identifies the current event session format used by the programme session.",
    ),
  sessionDurationMinutes: z.coerce
    .number()
    .int()
    .min(5)
    .max(1_440)
    .nullable()
    .default(null),
});

export const decisionDraftEffectPreviewSchema = z.object({
  includeReviewerFeedback: z.boolean(),
  sessionTrackId: z.string().trim().min(1).max(100).nullable(),
  sessionFormatKey: z.string().trim().min(1).max(100).nullable(),
  sessionDurationMinutes: z.number().int().min(5).max(1_440).nullable(),
});

export function requireAcceptedSessionConfiguration(
  decision: {
    decision: string;
    sessionTrackId: string | null;
    sessionFormatKey: string | null;
  },
  context: z.RefinementCtx,
) {
  if (decision.decision === "accepted" && !decision.sessionTrackId) {
    context.addIssue({
      code: "custom",
      path: ["sessionTrackId"],
      message: "Choose the programme track for the accepted session.",
    });
  }
  if (decision.decision === "accepted" && !decision.sessionFormatKey) {
    context.addIssue({
      code: "custom",
      path: ["sessionFormatKey"],
      message: "Choose the current session format for the accepted session.",
    });
  }
}

export const decisionSchema = decisionBaseSchema.superRefine(
  requireAcceptedSessionConfiguration,
);

export const decisionReopenSchema = z.object({
  submissionId: z.string().trim().min(1),
  reason: z
    .string()
    .trim()
    .min(10, "Explain why the released decision must be reopened.")
    .max(2_000),
  confirmed: z.literal(true),
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

export const evaluationRoundReviewerSchema = z
  .object({
    roundId: z.string().trim().min(1),
    personId: z.string().trim().min(1),
    operation: z.enum(["add", "remove"]),
    confirmed: z.literal(true).optional(),
  })
  .superRefine((input, context) => {
    if (input.operation === "remove" && input.confirmed !== true) {
      context.addIssue({
        code: "custom",
        path: ["confirmed"],
        message:
          "Confirm the round reviewer removal; unfinished assignments will be cancelled.",
      });
    }
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

export const nextRoundSchema = z
  .object({
    planId: z.string().trim().min(1),
    planRevision: z.coerce.number().int().positive(),
    name: z.string().trim().min(1, "Round name is required.").max(120),
    opensAt: z.iso.datetime({ offset: true }).nullable().optional(),
    closesAt: z.iso.datetime({ offset: true }).nullable().optional(),
    dueAt: z.iso.datetime({ offset: true }).nullable().default(null),
    anonymous: z.boolean().optional(),
    scorecardId: z.string().trim().min(1).max(120).nullable().optional(),
    scorecardVersion: z.coerce.number().int().positive().optional(),
    cloneRoundId: z.string().trim().min(1),
  })
  .superRefine((round, context) => {
    const closesAt =
      round.closesAt !== undefined ? round.closesAt : round.dueAt;
    if (
      round.opensAt &&
      closesAt &&
      Date.parse(closesAt) <= Date.parse(round.opensAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["closesAt"],
        message: "The round close date must be after its open date.",
      });
    }
  });

export const draftRoundUpdateSchema = z
  .object({
    roundId: z.string().trim().min(1),
    revision: z.coerce.number().int().positive(),
    name: z.string().trim().min(1, "Round name is required.").max(120),
    opensAt: z.iso.datetime({ offset: true }).nullable().optional(),
    closesAt: z.iso.datetime({ offset: true }).nullable().optional(),
    dueAt: z.iso.datetime({ offset: true }).nullable().default(null),
    anonymous: z.boolean().optional(),
    scorecardId: z.string().trim().min(1).max(120).nullable().optional(),
    scorecardVersion: z.coerce.number().int().positive().optional(),
    recommendationChoices: recommendationChoicesSchema,
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
      if (criterion.inputType === "dropdown") {
        if (criterion.options.length === 0) {
          context.addIssue({
            code: "custom",
            path: ["criteria", index, "options"],
            message: "Dropdown criteria need at least one option.",
          });
        }
        if (new Set(criterion.options).size !== criterion.options.length) {
          context.addIssue({
            code: "custom",
            path: ["criteria", index, "options"],
            message: "Dropdown options must be unique.",
          });
        }
      } else if (criterion.options.length > 0) {
        context.addIssue({
          code: "custom",
          path: ["criteria", index, "options"],
          message: "Only dropdown criteria can define options.",
        });
      }
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
          message:
            "Yes/no, dropdown and free-text criteria must have zero weight.",
        });
      }
    }
    const closesAt =
      round.closesAt !== undefined ? round.closesAt : round.dueAt;
    if (
      round.opensAt &&
      closesAt &&
      Date.parse(closesAt) <= Date.parse(round.opensAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["closesAt"],
        message: "The round close date must be after its open date.",
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

export const evaluationRoundDeleteSchema = z.object({
  roundId: z.string().trim().min(1),
  roundRevision: z.coerce.number().int().positive(),
  planRevision: z.coerce.number().int().positive(),
  expectedReviewerPersonIds: z
    .array(z.string().trim().min(1).max(128))
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: "Expected reviewer identifiers must be unique.",
    }),
  confirmed: z.literal(true),
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
