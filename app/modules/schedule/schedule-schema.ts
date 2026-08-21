import { z } from "zod";
import { eventResourceSchema } from "~/modules/events/event-schema";

const editorIdempotencyKeySchema = z.string().uuid();

const nullableIdentifierSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.string().trim().min(1).max(128).nullable(),
);

export const schedulePlacementSchema = z
  .object({
    scheduleVersionId: z.string().trim().min(1),
    scheduleRevision: z.coerce.number().int().positive(),
    sessionId: z.string().trim().min(1),
    roomId: z.string().trim().min(1),
    startsAt: z.coerce.number().int().positive(),
    endsAt: z.coerce.number().int().positive(),
  })
  .refine((value) => value.endsAt > value.startsAt, {
    path: ["endsAt"],
    message: "The session must end after it starts.",
  });

export const schedulePublishSchema = z.object({
  scheduleVersionId: z.string().trim().min(1),
  scheduleRevision: z.coerce.number().int().positive(),
});

export const SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT =
  "unpublished-speaker-names" as const;

export const SCHEDULE_REVIEW_LINK_PURPOSE_MAX_LENGTH = 80;
export const SCHEDULE_REVIEW_LINK_TTL_DAY_OPTIONS = [1, 3, 7, 30] as const;
export const SCHEDULE_REVIEW_LINK_DEFAULT_TTL_DAYS = 7;

export const scheduleReviewLinkCreateSchema = z
  .object({
    scheduleVersionId: z.string().trim().min(1),
    scheduleRevision: z.coerce.number().int().positive(),
    acknowledgement: z.literal(SCHEDULE_REVIEW_LINK_ACKNOWLEDGEMENT),
    projectionHash: z
      .string()
      .regex(/^[0-9a-f]{64}$/u, "The draft snapshot confirmation is invalid."),
    createIntentId: z.string().uuid(),
    ttlDays: z.coerce
      .number()
      .int()
      .refine(
        (
          value,
        ): value is (typeof SCHEDULE_REVIEW_LINK_TTL_DAY_OPTIONS)[number] =>
          (SCHEDULE_REVIEW_LINK_TTL_DAY_OPTIONS as readonly number[]).includes(
            value,
          ),
        "Choose an expiry of 1, 3, 7 or 30 days.",
      ),
    purpose: z
      .string()
      .trim()
      .min(
        1,
        "Give this review link a short purpose so it can be identified later.",
      )
      .max(
        SCHEDULE_REVIEW_LINK_PURPOSE_MAX_LENGTH,
        "Keep the purpose to 80 characters.",
      )
      .refine(
        (value) => !/[\r\n\0]/u.test(value),
        "The purpose cannot contain line breaks.",
      ),
  })
  .strict();

export const scheduleReviewLinkRevokeSchema = z
  .object({
    linkId: z.string().trim().min(1).max(128),
    confirmation: z.literal("revoke-draft-review-link"),
  })
  .strict();

export const scheduleMutationSchema = z.object({
  scheduleVersionId: z.string().trim().min(1),
  scheduleRevision: z.coerce.number().int().positive(),
  entryId: z.string().trim().min(1),
});

export const scheduleUndoSchema = z.object({
  scheduleVersionId: z.string().trim().min(1),
  scheduleRevision: z.coerce.number().int().positive(),
  undoToken: z.string().uuid(),
});

const autoPlacementSessionRevisionSchema = z.object({
  sessionId: z.string().trim().min(1),
  revision: z.coerce.number().int().positive(),
});

const autoPlacementCandidateSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    roomId: z.string().trim().min(1),
    startsAt: z.coerce.number().int().positive(),
    endsAt: z.coerce.number().int().positive(),
  })
  .refine((value) => value.endsAt > value.startsAt, {
    path: ["endsAt"],
    message: "The proposed session must end after it starts.",
  });

const autoPlacementUnplacedSchema = z.object({
  sessionId: z.string().trim().min(1),
  reason: z.string().trim().min(1).max(2_000),
});

export const MAX_AUTO_PLACEMENT_SESSIONS = 500;

export const scheduleAutoPlacementConfirmSchema = z
  .object({
    idempotencyKey: editorIdempotencyKeySchema,
    scheduleVersionId: z.string().trim().min(1),
    scheduleRevision: z.coerce.number().int().positive(),
    eventRevision: z.coerce.number().int().positive(),
    policyRevision: z.coerce.number().int().positive(),
    sessionRevisions: z
      .array(autoPlacementSessionRevisionSchema)
      .max(MAX_AUTO_PLACEMENT_SESSIONS),
    placements: z
      .array(autoPlacementCandidateSchema)
      .max(MAX_AUTO_PLACEMENT_SESSIONS),
    selectedSessionIds: z
      .array(z.string().trim().min(1))
      .min(1, "Select at least one proposed placement.")
      .max(MAX_AUTO_PLACEMENT_SESSIONS),
    unplaced: z
      .array(autoPlacementUnplacedSchema)
      .max(MAX_AUTO_PLACEMENT_SESSIONS),
  })
  .superRefine((value, context) => {
    const sessionIds = value.sessionRevisions.map((item) => item.sessionId);
    if (new Set(sessionIds).size !== sessionIds.length) {
      context.addIssue({
        code: "custom",
        path: ["sessionRevisions"],
        message: "Each unscheduled session must appear once.",
      });
    }
    const proposedIds = value.placements.map((item) => item.sessionId);
    if (new Set(proposedIds).size !== proposedIds.length) {
      context.addIssue({
        code: "custom",
        path: ["placements"],
        message: "Each proposed session placement must appear once.",
      });
    }
    if (
      new Set(value.selectedSessionIds).size !== value.selectedSessionIds.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["selectedSessionIds"],
        message: "Select each proposed session once.",
      });
    }
    const unplacedIds = value.unplaced.map((item) => item.sessionId);
    if (new Set(unplacedIds).size !== unplacedIds.length) {
      context.addIssue({
        code: "custom",
        path: ["unplaced"],
        message: "Each unplaced session must appear once.",
      });
    }
  });

export const scheduleBreakSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    durationMinutes: z.coerce.number().int().min(5).max(480),
    requiredResources: z.array(eventResourceSchema).max(50),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.requiredResources).size !== value.requiredResources.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiredResources"],
        message: "Choose each required resource once.",
      });
    }
  });

const conflictAction = z.enum(["allow", "warn", "block"]);
const unavailableConflictAction = z.enum(["warn", "block"]);

export const schedulePolicySchema = z.object({
  revision: z.coerce.number().int().positive(),
  roomAction: conflictAction,
  speakerAction: conflictAction,
  resourceAction: conflictAction,
  trackAction: conflictAction,
  boundaryAction: conflictAction,
  capacityAction: conflictAction,
  speakerUnavailableAction: unavailableConflictAction,
  minimumTurnaroundMinutes: z.coerce.number().int().min(0).max(240),
});

export const scheduleSessionResourcesSchema = z
  .object({
    scheduleVersionId: z.string().trim().min(1),
    scheduleRevision: z.coerce.number().int().positive(),
    sessionId: z.string().trim().min(1),
    sessionRevision: z.coerce.number().int().positive(),
    requiredResources: z.array(eventResourceSchema).max(50),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.requiredResources).size !== value.requiredResources.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiredResources"],
        message: "Choose each required resource once.",
      });
    }
  });

export const scheduleSessionContentSchema = z
  .object({
    scheduleVersionId: z.string().trim().min(1),
    scheduleRevision: z.coerce.number().int().positive(),
    sessionId: z.string().trim().min(1),
    sessionRevision: z.coerce.number().int().positive(),
    idempotencyKey: editorIdempotencyKeySchema,
    title: z.string().trim().min(1).max(240),
    description: z.string().max(12_000),
    format: z.string().trim().min(1).max(80),
    durationMinutes: z.coerce.number().int().min(5).max(480),
    trackId: nullableIdentifierSchema,
    visibility: z.enum(["public", "private", "hidden"]),
    requiredResources: z.array(eventResourceSchema).max(50),
  })
  .superRefine((value, context) => {
    if (
      new Set(value.requiredResources).size !== value.requiredResources.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["requiredResources"],
        message: "Choose each required resource once.",
      });
    }
  });

export const scheduleNotesSchema = z.object({
  scheduleVersionId: z.string().trim().min(1),
  scheduleRevision: z.coerce.number().int().positive(),
  idempotencyKey: editorIdempotencyKeySchema,
  notes: z.string().max(12_000),
});

export type SchedulePlacementInput = z.infer<typeof schedulePlacementSchema>;
export type SchedulePublishInput = z.infer<typeof schedulePublishSchema>;
export type ScheduleAutoPlacementConfirmInput = z.infer<
  typeof scheduleAutoPlacementConfirmSchema
>;
export type ScheduleSessionContentInput = z.infer<
  typeof scheduleSessionContentSchema
>;
export type ScheduleNotesInput = z.infer<typeof scheduleNotesSchema>;
