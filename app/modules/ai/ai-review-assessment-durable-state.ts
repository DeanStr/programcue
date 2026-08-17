import { z } from "zod";

export const generationOperationPayloadSchema = z
  .object({
    type: z.literal("ai.review_assessment.generate"),
    generationIntentId: z.uuid(),
    targetKey: z.string().regex(/^ai-review-assessment-target:[a-f0-9]{64}$/u),
    retryOfOperationId: z.string().trim().min(1).max(200).nullable(),
    assessmentId: z.string().trim().min(1).max(200),
    requestHash: z.string().regex(/^[a-f0-9]{64}$/u),
    roundId: z.string().trim().min(1).max(200),
    submissionId: z.string().trim().min(1).max(200),
    provider: z.enum(["workers_ai", "openai", "anthropic"]),
    model: z.string().trim().min(1).max(200),
    roundRevision: z.number().int().positive(),
    scorecardId: z.string().trim().min(1).max(200),
    scorecardVersion: z.number().int().positive(),
    submissionRevisionId: z.string().trim().min(1).max(200),
    submissionRevisionNumber: z.number().int().positive(),
    // Preserve byte-for-byte JSON because its SHA-256 and the final
    // compare-and-set predicate bind the exact submitted source.
    sourceSnapshotJson: z.string().min(2),
    sourceSnapshotSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    modelInputSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    promptVersion: z.number().int().positive(),
    criterionIds: z.array(z.string().trim().min(1).max(200)).min(1).max(100),
  })
  .strict();

export type GenerationOperationPayload = z.infer<
  typeof generationOperationPayloadSchema
>;

export const stagedGenerationResultSchema = z
  .object({
    phase: z.literal("provider_completed"),
    assessmentId: z.string().trim().min(1).max(200),
    score: z.number().finite().min(1).max(5),
    rationale: z.string().trim().min(40).max(6_000),
    provider: z.enum(["workers_ai", "openai", "anthropic"]),
    model: z.string().trim().min(1).max(200),
    responseId: z.string().trim().min(1).max(200),
    rationaleHash: z.string().regex(/^[a-f0-9]{64}$/u),
    generatedAt: z.number().int().nonnegative(),
  })
  .strict();

export type StagedGenerationResult = z.infer<
  typeof stagedGenerationResultSchema
>;

const completedGenerationResultSchema = z
  .object({
    phase: z.literal("completed"),
    assessmentId: z.string().trim().min(1).max(200),
    score: z.number().finite().min(1).max(5),
    provider: z.enum(["workers_ai", "openai", "anthropic"]),
    model: z.string().trim().min(1).max(200),
    responseId: z.string().trim().min(1).max(200),
  })
  .strict();

const failedGenerationResultSchema = z
  .object({
    phase: z.literal("failed"),
    errorType: z.string().trim().min(1).max(200),
    providerRequestId: z.string().trim().min(1).max(200).optional(),
    retrySafe: z.literal(false),
  })
  .strict();

export type FailedGenerationResult = z.infer<
  typeof failedGenerationResultSchema
>;

export function generationAttemptIdempotencyKey(
  operationId: string,
  targetKey: string,
  retryOfOperationId: string | null,
) {
  return retryOfOperationId
    ? `ai-review-assessment-attempt:${operationId}`
    : targetKey;
}

function parseDurableState<T>(
  schema: z.ZodType<T>,
  raw: string,
  invalidMessage: string,
) {
  try {
    const parsed = schema.safeParse(JSON.parse(raw) as unknown);
    if (parsed.success) return parsed.data;
  } catch {
    // Surface corrupt durable state as an invariant error below.
  }
  throw new Error(invalidMessage);
}

export function parseGenerationOperationPayload(
  raw: string,
  operationId: string,
) {
  return parseDurableState(
    generationOperationPayloadSchema,
    raw,
    `AI assessment operation ${operationId} has an invalid durable payload.`,
  );
}

export function parseStagedGenerationResult(raw: string, operationId: string) {
  return parseDurableState(
    stagedGenerationResultSchema,
    raw,
    `Running AI assessment operation ${operationId} has an invalid staged provider result.`,
  );
}

export function parseCompletedGenerationResult(
  raw: string,
  operationId: string,
) {
  return parseDurableState(
    completedGenerationResultSchema,
    raw,
    `Completed AI assessment operation ${operationId} has an invalid durable result.`,
  );
}

export function parseFailedGenerationResult(raw: string, operationId: string) {
  return parseDurableState(
    failedGenerationResultSchema,
    raw,
    `Failed AI assessment operation ${operationId} has an invalid durable result.`,
  );
}
