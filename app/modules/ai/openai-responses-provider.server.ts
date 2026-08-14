import { z } from "zod";

import {
  readBoundedResponseJson,
  ResponseBodyTooLargeError,
} from "~/platform/http/read-response";

export const AI_PROVIDER_REQUEST_TIMEOUT_MS = 120_000;
export const AI_PROVIDER_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const AI_PROVIDER_REQUEST_ID_MAX_LENGTH = 200;

const configurationSchema = z.object({
  apiKey: z.string().trim().min(20),
  model: z.string().trim().min(1).max(100),
  endpoint: z.url().optional(),
});

export const aiProviderResponseSchema = z
  .object({
    id: z.string().min(1).max(200),
    model: z.string().min(1).max(200).optional(),
    output: z.array(z.unknown()).max(100),
    output_text: z.string().max(512_000).optional(),
  })
  .passthrough();

const functionCallSchema = z
  .object({
    type: z.literal("function_call"),
    call_id: z.string().min(1).max(200),
    name: z.string().min(1).max(100),
    arguments: z.string().max(512_000),
  })
  .passthrough();

const messageSchema = z
  .object({
    type: z.literal("message"),
    content: z.array(z.unknown()),
  })
  .passthrough();

const outputTextSchema = z
  .object({ type: z.literal("output_text"), text: z.string() })
  .passthrough();

const refusalSchema = z
  .object({ type: z.literal("refusal"), refusal: z.string() })
  .passthrough();

export type OpenAiFunctionTool = {
  type: "function";
  name: string;
  description: string;
  strict: true;
  parameters: Record<string, unknown>;
};

export type OpenAiResponse = z.infer<typeof aiProviderResponseSchema>;

export type OpenAiFunctionCall = z.infer<typeof functionCallSchema>;

export type OpenAiResponsesRequest = {
  instructions: string;
  input: string | unknown[];
  safetyIdentifier: string;
  tools?: OpenAiFunctionTool[];
  maxOutputTokens?: number;
  textFormat?: {
    name: string;
    description: string;
    schema: Record<string, unknown>;
  };
  onTextDelta?: (delta: string) => void;
};

export type AiProviderLabel = "OpenAI" | "Workers AI" | "Anthropic";

export interface AiModelProvider {
  readonly providerName: AiProviderLabel;
  readonly model: string;
  create(request: OpenAiResponsesRequest): Promise<OpenAiResponse>;
}

export class AiConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AiConfigurationError";
  }
}

export type AiProviderFailureKind =
  | "transient"
  | "request-rejected"
  | "invalid-response";

type AiProviderErrorOptions = ErrorOptions & {
  failureKind?: AiProviderFailureKind;
};

export class AiProviderError extends Error {
  readonly failureKind: AiProviderFailureKind;

  constructor(
    message: string,
    readonly status: number | null = null,
    readonly providerRequestId: string | null = null,
    options?: AiProviderErrorOptions,
  ) {
    super(message, options);
    this.name = "AiProviderError";
    this.failureKind =
      options?.failureKind ??
      (status === null || (status >= 200 && status < 400)
        ? "invalid-response"
        : status === 408 || status === 425 || status === 429 || status >= 500
          ? "transient"
          : "request-rejected");
  }
}

function safeProviderMessage(value: unknown) {
  const parsed = z
    .object({
      error: z
        .object({ message: z.string().min(1).max(500) })
        .passthrough()
        .optional(),
    })
    .passthrough()
    .safeParse(value);
  return parsed.success ? parsed.data.error?.message : undefined;
}

export function normalizeAiProviderRequestId(value: string | null) {
  const trimmed = value?.trim();
  return trimmed && trimmed.length <= AI_PROVIDER_REQUEST_ID_MAX_LENGTH
    ? trimmed
    : null;
}

const streamEventSchema = z
  .object({
    type: z.string().min(1).max(100),
    delta: z.string().max(512_000).optional(),
    response: z.unknown().optional(),
    error: z.unknown().optional(),
  })
  .passthrough();

export async function readResponsesApiStream(
  response: Response,
  providerName: AiProviderLabel,
  providerRequestId: string | null,
  onTextDelta: (delta: string) => void,
) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > AI_PROVIDER_RESPONSE_MAX_BYTES
  ) {
    throw new AiProviderError(
      `${providerName} returned an oversized streaming response.`,
      response.status,
      providerRequestId,
    );
  }
  if (!response.body) {
    throw new AiProviderError(
      `${providerName} returned an empty streaming response.`,
      response.status,
      providerRequestId,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedBytes = 0;
  let completed: unknown = null;
  const handleBlock = (block: string) => {
    const encoded = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!encoded || encoded === "[DONE]") return;
    let decoded: unknown;
    try {
      decoded = JSON.parse(encoded);
    } catch (error) {
      throw new AiProviderError(
        `${providerName} returned an invalid streaming event.`,
        response.status,
        providerRequestId,
        { cause: error },
      );
    }
    const event = streamEventSchema.safeParse(decoded);
    if (!event.success) {
      throw new AiProviderError(
        `${providerName} returned a streaming event that does not match the Responses API contract.`,
        response.status,
        providerRequestId,
      );
    }
    if (event.data.type === "response.output_text.delta" && event.data.delta) {
      onTextDelta(event.data.delta);
    }
    if (event.data.type === "response.completed") {
      completed = event.data.response;
    }
    if (
      event.data.type === "response.failed" ||
      event.data.type === "response.incomplete" ||
      event.data.type === "error"
    ) {
      const detail = safeProviderMessage(
        event.data.response ?? { error: event.data.error },
      );
      throw new AiProviderError(
        detail
          ? `${providerName} streaming request failed: ${detail}`
          : `${providerName} streaming request ended with ${event.data.type}.`,
        response.status,
        providerRequestId,
      );
    }
  };
  while (true) {
    const { value, done } = await reader.read();
    receivedBytes += value?.byteLength ?? 0;
    if (receivedBytes > AI_PROVIDER_RESPONSE_MAX_BYTES) {
      await reader
        .cancel("AI provider response body limit exceeded")
        .catch(() => {});
      throw new AiProviderError(
        `${providerName} returned an oversized streaming response.`,
        response.status,
        providerRequestId,
      );
    }
    buffer += decoder.decode(value, { stream: !done });
    const blocks = buffer.split(/\r?\n\r?\n/u);
    buffer = blocks.pop() ?? "";
    for (const block of blocks) handleBlock(block);
    if (done) break;
  }
  if (buffer.trim()) handleBlock(buffer);
  const parsed = aiProviderResponseSchema.safeParse(completed);
  if (!parsed.success) {
    throw new AiProviderError(
      `${providerName} streaming completed without a valid Responses API result.`,
      response.status,
      providerRequestId,
    );
  }
  return parsed.data;
}

export class OpenAiResponsesProvider {
  private readonly configuration: z.infer<typeof configurationSchema>;

  constructor(
    configuration: {
      apiKey: string;
      model: string;
      endpoint?: string;
    },
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.configuration = configurationSchema.parse(configuration);
  }

  readonly providerName = "OpenAI" as const;

  get model() {
    return this.configuration.model;
  }

  async create(request: OpenAiResponsesRequest): Promise<OpenAiResponse> {
    const hasTools = Boolean(request.tools?.length);
    let response: Response;
    try {
      response = await this.fetcher(
        this.configuration.endpoint ?? "https://api.openai.com/v1/responses",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.configuration.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: this.configuration.model,
            store: false,
            include: ["reasoning.encrypted_content"],
            instructions: request.instructions,
            input: request.input,
            safety_identifier: request.safetyIdentifier,
            reasoning: { effort: "medium" },
            text: {
              verbosity: "low",
              ...(request.textFormat
                ? {
                    format: {
                      type: "json_schema",
                      name: request.textFormat.name,
                      description: request.textFormat.description,
                      strict: true,
                      schema: request.textFormat.schema,
                    },
                  }
                : {}),
            },
            max_output_tokens: request.maxOutputTokens ?? 1_600,
            ...(request.onTextDelta ? { stream: true } : {}),
            ...(hasTools
              ? {
                  tools: request.tools,
                  tool_choice: "auto",
                  parallel_tool_calls: false,
                }
              : {}),
          }),
          signal: AbortSignal.timeout(AI_PROVIDER_REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      throw new AiProviderError(
        "The OpenAI request could not reach the provider.",
        null,
        null,
        { cause: error, failureKind: "transient" },
      );
    }
    const providerRequestId = normalizeAiProviderRequestId(
      response.headers.get("x-request-id"),
    );
    if (request.onTextDelta && response.ok) {
      return readResponsesApiStream(
        response,
        this.providerName,
        providerRequestId,
        request.onTextDelta,
      );
    }
    let body: unknown;
    try {
      body = await readBoundedResponseJson(
        response,
        AI_PROVIDER_RESPONSE_MAX_BYTES,
      );
    } catch (error) {
      throw new AiProviderError(
        error instanceof ResponseBodyTooLargeError
          ? "OpenAI returned an oversized response."
          : `OpenAI returned a non-JSON response with status ${response.status}.`,
        response.status,
        providerRequestId,
        { cause: error },
      );
    }
    if (!response.ok) {
      const detail = safeProviderMessage(body);
      throw new AiProviderError(
        detail
          ? `OpenAI request failed: ${detail}`
          : `OpenAI request failed with status ${response.status}.`,
        response.status,
        providerRequestId,
      );
    }
    const parsed = aiProviderResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AiProviderError(
        "OpenAI returned a response that does not match the Responses API contract.",
        response.status,
        providerRequestId,
      );
    }
    return parsed.data;
  }
}

export function openAiFunctionCalls(response: OpenAiResponse) {
  return response.output.flatMap((item) => {
    const parsed = functionCallSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}

export function openAiOutputText(response: OpenAiResponse) {
  if (response.output_text?.trim()) return response.output_text.trim();
  const parts: string[] = [];
  for (const item of response.output) {
    const message = messageSchema.safeParse(item);
    if (!message.success) continue;
    for (const content of message.data.content) {
      const text = outputTextSchema.safeParse(content);
      if (text.success && text.data.text.trim())
        parts.push(text.data.text.trim());
      const refusal = refusalSchema.safeParse(content);
      if (refusal.success && refusal.data.refusal.trim()) {
        parts.push(
          `OpenAI declined this request: ${refusal.data.refusal.trim()}`,
        );
      }
    }
  }
  return parts.join("\n\n");
}
