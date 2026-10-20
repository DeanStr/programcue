import { z } from "zod";
import type {
  AiProviderLabel,
  OpenAiResponse,
} from "./openai-responses-provider.server";

const tokenCount = z.number().int().nonnegative().nullable().optional();
export const providerUsageSchema = z
  .object({
    input_tokens: tokenCount,
    output_tokens: tokenCount,
    total_tokens: tokenCount,
    input_tokens_details: z
      .object({
        cached_tokens: tokenCount,
        cache_write_tokens: tokenCount,
        uncached_tokens: tokenCount,
      })
      .passthrough()
      .nullable()
      .optional(),
    output_tokens_details: z
      .object({ reasoning_tokens: tokenCount })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const pricingSchema = z.array(
  z
    .object({
      provider: z.enum(["OpenAI", "Workers AI", "Anthropic"]),
      model: z.string().min(1),
      source: z.url(),
      asOf: z.iso.date(),
      inputUsdPerMillion: z.number().nonnegative(),
      outputUsdPerMillion: z.number().nonnegative(),
      cachedInputUsdPerMillion: z.number().nonnegative(),
      cacheWriteInputUsdPerMillion: z.number().nonnegative().optional(),
    })
    .strict(),
);
export type InferencePrice = z.infer<typeof pricingSchema>[number];

export function readInferencePricing(encoded: string | undefined) {
  if (!encoded?.trim()) return [];
  try {
    const prices = pricingSchema.parse(JSON.parse(encoded));
    if (
      new Set(prices.map((p) => `${p.provider}:${p.model}`)).size !==
      prices.length
    )
      throw new Error("Duplicate model prices");
    return prices;
  } catch (cause) {
    const error = new Error(
      "AI_INFERENCE_PRICING must contain unique provider/model prices, dated source URLs and input/output/cached-input USD rates per million tokens.",
      { cause },
    );
    error.name = "AiConfigurationError";
    throw error;
  }
}

export type ModelCallMeasurement = {
  attemptId: string;
  requestedModel: string;
  returnedModel: string | null;
  responseId: string | null;
  durationMs: number;
  status: "completed" | "failed";
  usageIsPartial: boolean;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    totalTokens: number | null;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
    uncachedInputTokens: number | null;
    reasoningOutputTokens: number | null;
  };
  estimatedCostUsd: number | null;
  pricing: InferencePrice | null;
  failure: string | null;
};

export function measureModelCall(input: {
  attemptId: string;
  provider: AiProviderLabel;
  requestedModel: string;
  durationMs: number;
  response?: OpenAiResponse;
  failure?: string;
  prices: InferencePrice[];
}): ModelCallMeasurement {
  const raw = input.response?.usage;
  const usageIsPartial = input.response?.usage_is_partial === true;
  const usage = {
    inputTokens: raw?.input_tokens ?? null,
    outputTokens: raw?.output_tokens ?? null,
    totalTokens: raw?.total_tokens ?? null,
    cachedInputTokens: raw?.input_tokens_details?.cached_tokens ?? null,
    cacheWriteInputTokens:
      raw?.input_tokens_details?.cache_write_tokens ?? null,
    uncachedInputTokens: raw?.input_tokens_details?.uncached_tokens ?? null,
    reasoningOutputTokens: raw?.output_tokens_details?.reasoning_tokens ?? null,
  };
  const model = input.response?.model ?? input.requestedModel;
  const pricing =
    input.prices.find(
      (p) => p.provider === input.provider && p.model === model,
    ) ?? null;
  const {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
  } = usage;
  // Equal configured write/input rates make the write split irrelevant to cost.
  // Keep the unavailable usage count null; zero here is only algebraic cancellation.
  const writeTokensForCost =
    cacheWriteInputTokens ??
    (pricing &&
    pricing.cacheWriteInputUsdPerMillion === pricing.inputUsdPerMillion
      ? 0
      : null);
  const estimatedCostUsd =
    !usageIsPartial &&
    pricing &&
    inputTokens !== null &&
    outputTokens !== null &&
    cachedInputTokens !== null &&
    writeTokensForCost !== null &&
    cachedInputTokens + writeTokensForCost <= inputTokens &&
    (writeTokensForCost === 0 ||
      pricing.cacheWriteInputUsdPerMillion !== undefined)
      ? ((inputTokens - cachedInputTokens - writeTokensForCost) *
          pricing.inputUsdPerMillion +
          cachedInputTokens * pricing.cachedInputUsdPerMillion +
          writeTokensForCost * (pricing.cacheWriteInputUsdPerMillion ?? 0) +
          outputTokens * pricing.outputUsdPerMillion) /
        1_000_000
      : null;
  return {
    attemptId: input.attemptId,
    requestedModel: input.requestedModel,
    returnedModel: input.response?.model ?? null,
    responseId: input.response?.id ?? null,
    durationMs: input.durationMs,
    status: input.failure ? "failed" : "completed",
    usageIsPartial,
    usage,
    estimatedCostUsd,
    pricing,
    failure: input.failure ?? null,
  };
}

export function aggregateModelCalls(calls: ModelCallMeasurement[]) {
  const total = (key: keyof ModelCallMeasurement["usage"]) =>
    calls.length &&
    calls.every((call) => !call.usageIsPartial && call.usage[key] !== null)
      ? calls.reduce((sum, call) => sum + (call.usage[key] ?? 0), 0)
      : null;
  return {
    callCount: calls.length,
    inputTokens: total("inputTokens"),
    outputTokens: total("outputTokens"),
    totalTokens: total("totalTokens"),
    estimatedCostUsd:
      calls.length && calls.every((call) => call.estimatedCostUsd !== null)
        ? calls.reduce((sum, call) => sum + (call.estimatedCostUsd ?? 0), 0)
        : null,
    knownEstimatedCostUsd: calls.reduce(
      (sum, call) => sum + (call.estimatedCostUsd ?? 0),
      0,
    ),
    callsWithUnknownCost: calls.filter((call) => call.estimatedCostUsd === null)
      .length,
  };
}
