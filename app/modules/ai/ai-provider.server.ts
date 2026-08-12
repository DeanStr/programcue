import { z } from "zod";

import {
  AiConfigurationError,
  AiProviderError,
  AI_PROVIDER_REQUEST_TIMEOUT_MS,
  AI_PROVIDER_RESPONSE_MAX_BYTES,
  OpenAiResponsesProvider,
  aiProviderResponseSchema,
  normalizeAiProviderRequestId,
  type AiModelProvider,
  type OpenAiResponse,
  type OpenAiResponsesRequest,
} from "./openai-responses-provider.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  readBoundedResponseJson,
  ResponseBodyTooLargeError,
} from "~/platform/http/read-response";

import { AiProviderSettingsService } from "./ai-provider-settings.server";
import {
  WorkersAiResponsesProvider,
  type WorkersAiBinding,
} from "./workers-ai-responses-provider.server";

export * from "./ai-provider-settings.server";
export { WorkersAiResponsesProvider } from "./workers-ai-responses-provider.server";

type AnthropicBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: unknown };

const anthropicResponseSchema = z
  .object({
    id: z.string().min(1).max(200),
    model: z.string().min(1).max(200),
    content: z
      .array(
        z.union([
          z
            .object({
              type: z.literal("text"),
              text: z.string().max(512_000),
            })
            .passthrough(),
          z
            .object({
              type: z.literal("tool_use"),
              id: z.string().min(1).max(200),
              name: z.string().min(1).max(100),
              input: z.unknown(),
            })
            .passthrough(),
        ]),
      )
      .max(100),
    stop_reason: z.string().max(100).nullable().optional(),
  })
  .passthrough();

function anthropicInput(input: string | unknown[]) {
  if (typeof input === "string") {
    return [{ role: "user", content: [{ type: "text", text: input }] }];
  }
  const messages: Array<{ role: "user" | "assistant"; content: unknown[] }> =
    [];
  const append = (role: "user" | "assistant", block: unknown) => {
    const last = messages.at(-1);
    if (last?.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of input) {
    if (!item || typeof item !== "object") {
      throw new AiProviderError(
        "Anthropic received an unsupported transcript item.",
      );
    }
    const record = item as Record<string, unknown>;
    if (
      (record.role === "user" || record.role === "assistant") &&
      typeof record.content === "string"
    ) {
      append(record.role, { type: "text", text: record.content });
      continue;
    }
    if (record.type === "message" && Array.isArray(record.content)) {
      for (const content of record.content) {
        if (!content || typeof content !== "object") continue;
        const part = content as Record<string, unknown>;
        if (part.type === "output_text" && typeof part.text === "string") {
          append("assistant", { type: "text", text: part.text });
        } else if (
          part.type === "refusal" &&
          typeof part.refusal === "string"
        ) {
          append("assistant", { type: "text", text: part.refusal });
        }
      }
      continue;
    }
    if (
      record.type === "function_call" &&
      typeof record.call_id === "string" &&
      typeof record.name === "string" &&
      typeof record.arguments === "string"
    ) {
      let parsedArguments: unknown;
      try {
        parsedArguments = JSON.parse(record.arguments);
      } catch (error) {
        throw new AiProviderError(
          "A prior tool call contains invalid JSON.",
          null,
          null,
          {
            cause: error,
          },
        );
      }
      append("assistant", {
        type: "tool_use",
        id: record.call_id,
        name: record.name,
        input: parsedArguments,
      });
      continue;
    }
    if (
      record.type === "function_call_output" &&
      typeof record.call_id === "string" &&
      typeof record.output === "string"
    ) {
      append("user", {
        type: "tool_result",
        tool_use_id: record.call_id,
        content: record.output,
      });
      continue;
    }
    throw new AiProviderError(
      "Anthropic received an unsupported transcript item.",
    );
  }
  return messages;
}

function normalizeAnthropicMessage(
  message: z.infer<typeof anthropicResponseSchema>,
) {
  const text = message.content
    .filter(
      (block): block is Extract<AnthropicBlock, { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("");
  const toolCalls = message.content
    .filter(
      (block): block is Extract<AnthropicBlock, { type: "tool_use" }> =>
        block.type === "tool_use",
    )
    .map((block) => ({
      type: "function_call" as const,
      call_id: block.id,
      name: block.name,
      arguments: JSON.stringify(block.input),
    }));
  return aiProviderResponseSchema.parse({
    id: message.id,
    model: message.model,
    output: [
      ...(text
        ? [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text }],
            },
          ]
        : []),
      ...toolCalls,
    ],
    ...(text ? { output_text: text } : {}),
  });
}

async function readAnthropicStream(
  response: Response,
  providerRequestId: string | null,
  onTextDelta: (delta: string) => void,
) {
  const declaredLength = Number(response.headers.get("content-length") ?? 0);
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > AI_PROVIDER_RESPONSE_MAX_BYTES
  ) {
    throw new AiProviderError(
      "Anthropic returned an oversized streaming response.",
      response.status,
      providerRequestId,
    );
  }
  if (!response.body) {
    throw new AiProviderError(
      "Anthropic returned an empty stream.",
      response.status,
      providerRequestId,
    );
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let receivedBytes = 0;
  let id: string | null = null;
  let model: string | null = null;
  let stopped = false;
  const blocks = new Map<number, AnthropicBlock>();
  const partialToolInputs = new Map<number, string>();
  const handle = (block: string) => {
    const encoded = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!encoded) return;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(encoded) as Record<string, unknown>;
    } catch (error) {
      throw new AiProviderError(
        "Anthropic returned invalid streaming JSON.",
        response.status,
        providerRequestId,
        { cause: error },
      );
    }
    if (event.type === "error") {
      const error = event.error as Record<string, unknown> | undefined;
      throw new AiProviderError(
        typeof error?.message === "string"
          ? `Anthropic streaming request failed: ${error.message}`
          : "Anthropic streaming request failed.",
        response.status,
        providerRequestId,
      );
    }
    if (event.type === "message_start") {
      const message = event.message as Record<string, unknown> | undefined;
      id = typeof message?.id === "string" ? message.id : null;
      model = typeof message?.model === "string" ? message.model : null;
    } else if (
      event.type === "content_block_start" &&
      typeof event.index === "number"
    ) {
      const content = event.content_block as
        Record<string, unknown> | undefined;
      if (content?.type === "text" && typeof content.text === "string") {
        blocks.set(event.index, { type: "text", text: content.text });
      } else if (
        content?.type === "tool_use" &&
        typeof content.id === "string" &&
        typeof content.name === "string"
      ) {
        blocks.set(event.index, {
          type: "tool_use",
          id: content.id,
          name: content.name,
          input: content.input ?? {},
        });
        partialToolInputs.set(event.index, "");
      }
    } else if (
      event.type === "content_block_delta" &&
      typeof event.index === "number"
    ) {
      const delta = event.delta as Record<string, unknown> | undefined;
      const current = blocks.get(event.index);
      if (
        delta?.type === "text_delta" &&
        typeof delta.text === "string" &&
        current?.type === "text"
      ) {
        current.text += delta.text;
        onTextDelta(delta.text);
      } else if (
        delta?.type === "input_json_delta" &&
        typeof delta.partial_json === "string"
      ) {
        partialToolInputs.set(
          event.index,
          (partialToolInputs.get(event.index) ?? "") + delta.partial_json,
        );
      }
    } else if (
      event.type === "content_block_stop" &&
      typeof event.index === "number"
    ) {
      const current = blocks.get(event.index);
      const partial = partialToolInputs.get(event.index);
      if (current?.type === "tool_use" && partial) {
        try {
          current.input = JSON.parse(partial);
        } catch (error) {
          throw new AiProviderError(
            "Anthropic streamed invalid tool input JSON.",
            response.status,
            providerRequestId,
            { cause: error },
          );
        }
      }
    } else if (event.type === "message_stop") {
      stopped = true;
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
        "Anthropic returned an oversized streaming response.",
        response.status,
        providerRequestId,
      );
    }
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/u);
    buffer = events.pop() ?? "";
    for (const event of events) handle(event);
    if (done) break;
  }
  if (buffer.trim()) handle(buffer);
  if (!stopped || !id || !model) {
    throw new AiProviderError(
      "Anthropic streaming ended without a complete attributed message.",
      response.status,
      providerRequestId,
    );
  }
  return normalizeAnthropicMessage({
    id,
    model,
    content: [...blocks.entries()]
      .sort(([left], [right]) => left - right)
      .map(([, block]) => block),
  });
}

export class AnthropicMessagesProvider implements AiModelProvider {
  readonly providerName = "Anthropic" as const;

  constructor(
    private readonly configuration: { apiKey: string; endpoint?: string },
    readonly model: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async create(request: OpenAiResponsesRequest): Promise<OpenAiResponse> {
    let response: Response;
    try {
      response = await this.fetcher(
        this.configuration.endpoint ?? "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "anthropic-version": "2023-06-01",
            "content-type": "application/json",
            "x-api-key": this.configuration.apiKey,
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: request.maxOutputTokens ?? 1_600,
            system: request.instructions,
            messages: anthropicInput(request.input),
            metadata: { user_id: request.safetyIdentifier },
            ...(request.onTextDelta ? { stream: true } : {}),
            ...(request.textFormat
              ? {
                  output_config: {
                    format: {
                      type: "json_schema",
                      schema: request.textFormat.schema,
                    },
                  },
                }
              : {}),
            ...(request.tools?.length
              ? {
                  tools: request.tools.map((tool) => ({
                    name: tool.name,
                    description: tool.description,
                    strict: true,
                    input_schema: tool.parameters,
                  })),
                  tool_choice: {
                    type: "auto",
                    disable_parallel_tool_use: true,
                  },
                }
              : {}),
          }),
          signal: AbortSignal.timeout(AI_PROVIDER_REQUEST_TIMEOUT_MS),
        },
      );
    } catch (error) {
      if (error instanceof AiProviderError) throw error;
      throw new AiProviderError(
        "The Anthropic request could not reach the provider.",
        null,
        null,
        { cause: error },
      );
    }
    const providerRequestId = normalizeAiProviderRequestId(
      response.headers.get("request-id"),
    );
    if (request.onTextDelta && response.ok) {
      return readAnthropicStream(
        response,
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
          ? "Anthropic returned an oversized response."
          : `Anthropic returned a non-JSON response with status ${response.status}.`,
        response.status,
        providerRequestId,
        { cause: error },
      );
    }
    if (!response.ok) {
      const parsed = z
        .object({ error: z.object({ message: z.string() }).passthrough() })
        .passthrough()
        .safeParse(body);
      throw new AiProviderError(
        parsed.success
          ? `Anthropic request failed: ${parsed.data.error.message}`
          : `Anthropic request failed with status ${response.status}.`,
        response.status,
        providerRequestId,
      );
    }
    const parsed = anthropicResponseSchema.safeParse(body);
    if (!parsed.success) {
      throw new AiProviderError(
        "Anthropic returned a response that does not match the Messages API contract.",
        response.status,
        providerRequestId,
      );
    }
    return normalizeAnthropicMessage(parsed.data);
  }
}

export async function resolveAiProvider(
  env: CloudflareEnvironment,
  viewer: Viewer,
  options: {
    fetcher?: typeof fetch;
    testOpenAiConfiguration?: { apiKey: string; model: string };
  } = {},
): Promise<AiModelProvider> {
  if (options.testOpenAiConfiguration) {
    return new OpenAiResponsesProvider(
      options.testOpenAiConfiguration,
      options.fetcher,
    );
  }
  const settings = new AiProviderSettingsService(env);
  const readiness = await settings.readiness(viewer);
  if (!readiness.configured || !readiness.selection) {
    throw new AiConfigurationError(
      readiness.problem ?? "The organisation AI provider is not configured.",
    );
  }
  const { provider, model } = readiness.selection;
  if (provider === "workers_ai") {
    return new WorkersAiResponsesProvider(
      env.AI as unknown as WorkersAiBinding,
      model,
    );
  }
  if (provider === "openai") {
    return new OpenAiResponsesProvider(
      {
        apiKey: env.OPENAI_API_KEY!.trim(),
        model,
        endpoint: env.OPENAI_RESPONSES_URL?.trim() || undefined,
      },
      options.fetcher,
    );
  }
  return new AnthropicMessagesProvider(
    {
      apiKey: env.ANTHROPIC_API_KEY!.trim(),
      endpoint: env.ANTHROPIC_MESSAGES_URL?.trim() || undefined,
    },
    model,
    options.fetcher,
  );
}
