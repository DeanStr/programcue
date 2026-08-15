import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";

import { type AiModelProvider } from "./openai-responses-provider.server";

export const generationInputSchema = z
  .object({
    generationIntentId: z.uuid("Refresh before generating this AI assessment."),
    roundId: z.string().trim().min(1).max(200),
    submissionId: z.string().trim().min(1).max(200),
    retryFailedOperationId: z.string().trim().min(1).max(200).optional(),
    duplicateRiskAcknowledged: z.literal(true).optional(),
    confirmed: z.literal(true, {
      error: "Confirm the AI first-pass assessment before generating it.",
    }),
  })
  .strict()
  .superRefine((input, context) => {
    if (
      Boolean(input.retryFailedOperationId) !==
      Boolean(input.duplicateRiskAcknowledged)
    ) {
      context.addIssue({
        code: "custom",
        path: ["duplicateRiskAcknowledged"],
        message:
          "Explicitly acknowledge the possible duplicate provider request or charge before retrying a failed AI assessment.",
      });
    }
  });

export const generationReconciliationInputSchema = z
  .object({
    operationId: z.string().trim().min(1).max(200),
  })
  .strict();

export const GENERATION_LEASE_SECONDS = 5 * 60;

export const overrideInputSchema = z
  .object({
    assessmentId: z.string().trim().min(1).max(200),
    expectedRevision: z.coerce.number().int().positive(),
    score: z.coerce.number().finite().min(1).max(5),
    rationale: z.string().trim().min(10).max(2_000),
    confirmed: z.literal(true, {
      error: "Confirm the human AI-score override before saving it.",
    }),
  })
  .strict();

export const generatedAssessmentSchema = z
  .object({
    score: z.number().finite().min(1).max(5),
    rationale: z.string().trim().min(40).max(2_000),
  })
  .strict();

export const generatedAssessmentTextFormat = {
  name: "program_cue_ai_review_assessment",
  description:
    "A bounded first-pass abstract assessment with an overall score and evidence-grounded rationale.",
  schema: {
    type: "object",
    properties: {
      score: {
        type: "number",
        minimum: 1,
        maximum: 5,
        description: "Overall first-pass score on a one-to-five scale.",
      },
      rationale: {
        type: "string",
        minLength: 40,
        maxLength: 2000,
        description:
          "Submission-specific reasoning grounded in the supplied abstract and rubric.",
      },
    },
    required: ["score", "rationale"],
    additionalProperties: false,
  },
} as const;

export type ProviderKey = "workers_ai" | "openai" | "anthropic";

export const providerKeys: Record<
  AiModelProvider["providerName"],
  ProviderKey
> = {
  "Workers AI": "workers_ai",
  OpenAI: "openai",
  Anthropic: "anthropic",
};

export const providerLabels: Record<
  ProviderKey,
  AiModelProvider["providerName"]
> = {
  workers_ai: "Workers AI",
  openai: "OpenAI",
  anthropic: "Anthropic",
};

export type AiReviewAssessmentRow = {
  id: string;
  eventId: string;
  roundId: string;
  roundName: string;
  submissionId: string;
  submissionTitle: string;
  submissionReference: string;
  scorecardId: string;
  scorecardVersion: number;
  roundRevision: number;
  score: number;
  rationale: string;
  provider: ProviderKey;
  model: string;
  providerResponseId: string;
  generatedByPersonId: string;
  generatedByName: string;
  generatedAt: number;
  overrideScore: number | null;
  overrideRationale: string | null;
  overrideByPersonId: string | null;
  overrideByName: string | null;
  overrideAt: number | null;
  revision: number;
  updatedAt: number;
};

export type AiReviewAssessment = Omit<AiReviewAssessmentRow, "provider"> & {
  provider: ProviderKey;
  providerLabel: AiModelProvider["providerName"];
  effectiveScore: number;
  overridden: boolean;
};

export type AiReviewAssessmentDependencies = {
  provider?: AiModelProvider;
  now?: () => Date;
  beforeGenerationReserved?: () => void | Promise<void>;
  beforeProviderResultPersisted?: () => void | Promise<void>;
  afterProviderResultPersisted?: () => void | Promise<void>;
  beforeOverridePersisted?: () => void | Promise<void>;
};

export type GenerationTarget = {
  roundId: string;
  roundName: string;
  roundStatus: string;
  blindedReviewing: number | boolean;
  scorecardId: string;
  scorecardVersion: number;
  roundRevision: number;
  submissionId: string;
  submissionTitle: string;
  submissionReference: string;
  submissionStatus: string;
  submittedAt: number | null;
  submittedSnapshotJson: string | null;
  existingAssessmentId: string | null;
};

export type PersistedCriterion = {
  id: string;
  name: string;
  description: string | null;
  inputType: string;
  optionsJson: string;
  weightPercent: number;
  required: number | boolean;
  position: number;
};

export type GenerationOperationRow = {
  id: string;
  organisationId: string | null;
  eventId: string | null;
  requestedByPersonId: string | null;
  type: string;
  idempotencyKey: string;
  status: string;
  payloadJson: string;
  resultJson: string | null;
  lastError: string | null;
  claimToken: string | null;
  claimExpiresAt: number | null;
};

import {
  AiReviewAssessmentConflictError,
  AiReviewAssessmentIntentConflictError,
  AiReviewAssessmentStateError,
} from "./ai-review-assessment-errors";

import { type AiReviewAssessmentGenerationAttempt } from "./ai-review-assessment-reader.server";

export {
  AiReviewAssessmentConflictError,
  AiReviewAssessmentIntentConflictError,
  AiReviewAssessmentStateError,
} from "./ai-review-assessment-errors";

export type { AiReviewAssessmentGenerationAttempt } from "./ai-review-assessment-reader.server";

export function assessmentFromRow(
  row: AiReviewAssessmentRow,
): AiReviewAssessment {
  return {
    ...row,
    providerLabel: providerLabels[row.provider],
    effectiveScore: row.overrideScore ?? row.score,
    overridden: row.overrideScore !== null,
  };
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function assertAssessmentAdministrator(viewer: Viewer) {
  if (viewer.role !== "owner" && viewer.role !== "administrator") {
    throw new Response("AI review assessment changes are not authorised.", {
      status: 403,
    });
  }
}

export function epochSeconds(value: Date) {
  const epoch = Math.floor(value.getTime() / 1_000);
  if (!Number.isFinite(epoch)) {
    throw new Error("AI assessment time source returned an invalid date.");
  }
  return epoch;
}
