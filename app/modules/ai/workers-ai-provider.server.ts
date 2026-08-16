import { z } from "zod";

import {
  AiConfigurationError,
  type AiModelProvider,
  AiProviderError,
  aiProviderResponseSchema,
  type OpenAiResponse,
  type OpenAiResponsesRequest,
  openAiOutputText,
} from "./openai-responses-provider.server";

export const WORKERS_AI_MODEL =
  "@cf/deepseek-ai/deepseek-v4-flash-0731" as const;

export type WorkersAiBinding = {
  aiGatewayLogId: string | null;
  run(
    model: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown> | ReadableStream<Uint8Array>>;
};

type ChatToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type ChatMessage =
  | { role: "system" | "user"; content: string }
  | {
      role: "assistant";
      content: string | null;
      tool_calls?: ChatToolCall[];
    }
  | { role: "tool"; tool_call_id: string; content: string };

const chatToolCallSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    type: z.literal("function"),
    function: z
      .object({
        name: z.string().trim().min(1).max(100),
        arguments: z.string().max(512_000),
      })
      .passthrough(),
  })
  .passthrough();

const chatCompletionSchema = z
  .object({
    id: z.string().trim().min(1).max(200),
    model: z.string().trim().min(1).max(200),
    choices: z
      .array(
        z
          .object({
            index: z.literal(0),
            finish_reason: z.string().trim().min(1).max(100).nullable(),
            message: z
              .object({
                role: z.literal("assistant"),
                content: z.string().max(512_000).nullable(),
                refusal: z
                  .string()
                  .trim()
                  .min(1)
                  .max(2_000)
                  .nullable()
                  .optional(),
                tool_calls: z
                  .array(chatToolCallSchema)
                  .max(10)
                  .nullable()
                  .optional(),
              })
              .passthrough(),
          })
          .passthrough(),
      )
      .length(1),
  })
  .passthrough();

const transcriptMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.string().max(512_000),
  })
  .passthrough();

const responseMessageSchema = z
  .object({
    type: z.literal("message"),
    role: z.literal("assistant"),
    content: z
      .array(
        z.union([
          z
            .object({
              type: z.literal("output_text"),
              text: z.string().max(512_000),
            })
            .passthrough(),
          z
            .object({
              type: z.literal("refusal"),
              refusal: z.string().max(2_000),
            })
            .passthrough(),
        ]),
      )
      .max(100),
  })
  .passthrough();

const responseFunctionCallSchema = z
  .object({
    type: z.literal("function_call"),
    call_id: z.string().trim().min(1).max(200),
    name: z.string().trim().min(1).max(100),
    arguments: z.string().max(512_000),
  })
  .passthrough();

const responseFunctionOutputSchema = z
  .object({
    type: z.literal("function_call_output"),
    call_id: z.string().trim().min(1).max(200),
    output: z.string().max(512_000),
  })
  .passthrough();

function chatMessages(request: OpenAiResponsesRequest): ChatMessage[] {
  const messages: ChatMessage[] = [
    { role: "system", content: request.instructions },
  ];
  if (typeof request.input === "string") {
    messages.push({ role: "user", content: request.input });
    return messages;
  }

  let pendingAssistant:
    | { content: string[]; toolCalls: ChatToolCall[] }
    | undefined;
  const flushAssistant = () => {
    if (!pendingAssistant) return;
    const content = pendingAssistant.content.join("\n\n").trim();
    messages.push({
      role: "assistant",
      content: content || null,
      ...(pendingAssistant.toolCalls.length
        ? { tool_calls: pendingAssistant.toolCalls }
        : {}),
    });
    pendingAssistant = undefined;
  };

  for (const item of request.input) {
    const transcriptMessage = transcriptMessageSchema.safeParse(item);
    if (transcriptMessage.success) {
      flushAssistant();
      messages.push({
        role: transcriptMessage.data.role,
        content: transcriptMessage.data.content,
      });
      continue;
    }

    const responseMessage = responseMessageSchema.safeParse(item);
    if (responseMessage.success) {
      flushAssistant();
      pendingAssistant = { content: [], toolCalls: [] };
      for (const part of responseMessage.data.content) {
        pendingAssistant.content.push(
          part.type === "output_text" ? part.text : part.refusal,
        );
      }
      continue;
    }

    const functionCall = responseFunctionCallSchema.safeParse(item);
    if (functionCall.success) {
      pendingAssistant ??= { content: [], toolCalls: [] };
      pendingAssistant.toolCalls.push({
        id: functionCall.data.call_id,
        type: "function",
        function: {
          name: functionCall.data.name,
          arguments: functionCall.data.arguments,
        },
      });
      continue;
    }

    const functionOutput = responseFunctionOutputSchema.safeParse(item);
    if (functionOutput.success) {
      flushAssistant();
      messages.push({
        role: "tool",
        tool_call_id: functionOutput.data.call_id,
        content: functionOutput.data.output,
      });
      continue;
    }

    throw new AiProviderError(
      "Workers AI received an unsupported assistant transcript item.",
    );
  }
  flushAssistant();
  return messages;
}

function normalizeChatCompletion(
  raw: Record<string, unknown>,
  model: string,
  gatewayRequestId: string | null,
) {
  const parsed = chatCompletionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AiProviderError(
      "Workers AI returned a result without a request ID or valid Chat Completions output.",
      null,
      gatewayRequestId,
    );
  }
  if (parsed.data.model !== model) {
    throw new AiProviderError(
      `Workers AI returned model ${parsed.data.model} after ${model} was requested; no result was accepted.`,
      null,
      parsed.data.id,
    );
  }
  const choice = parsed.data.choices[0]!;
  const providerRequestId = parsed.data.id;
  const toolCalls = choice.message.tool_calls ?? [];
  if (choice.finish_reason === "length") {
    throw new AiProviderError(
      "Workers AI exhausted the DeepSeek completion-token budget; no result was accepted.",
      null,
      providerRequestId,
    );
  }
  if (choice.finish_reason === "tool_calls" && toolCalls.length === 0) {
    throw new AiProviderError(
      "Workers AI ended for tool calls without returning a valid tool call.",
      null,
      providerRequestId,
    );
  }
  if (choice.finish_reason === "stop" && toolCalls.length > 0) {
    throw new AiProviderError(
      "Workers AI returned tool calls with an inconsistent stop reason; no result was accepted.",
      null,
      providerRequestId,
    );
  }
  if (
    choice.finish_reason !== "stop" &&
    choice.finish_reason !== "tool_calls"
  ) {
    throw new AiProviderError(
      `Workers AI response ended with ${choice.finish_reason ?? "no finish reason"}; no result was accepted.`,
      null,
      providerRequestId,
    );
  }
  if (choice.message.refusal) {
    throw new AiProviderError(
      `Workers AI declined the request: ${choice.message.refusal}`,
      null,
      providerRequestId,
    );
  }

  const content = choice.message.content?.trim() ?? "";
  if (!content && toolCalls.length === 0) {
    throw new AiProviderError(
      "Workers AI returned neither assistant text nor a tool call.",
      null,
      providerRequestId,
    );
  }
  return aiProviderResponseSchema.parse({
    id: providerRequestId,
    model: parsed.data.model,
    status: "completed",
    output: [
      ...(content
        ? [
            {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: content }],
            },
          ]
        : []),
      ...toolCalls.map((call) => ({
        type: "function_call" as const,
        call_id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })),
    ],
    ...(content ? { output_text: content } : {}),
  });
}

export class WorkersAiProvider implements AiModelProvider {
  readonly providerName = "Workers AI" as const;

  constructor(
    private readonly binding: WorkersAiBinding,
    readonly model: string,
  ) {
    if (model !== WORKERS_AI_MODEL) {
      throw new AiConfigurationError(
        `Workers AI requires the model ${WORKERS_AI_MODEL}.`,
      );
    }
  }

  async create(request: OpenAiResponsesRequest): Promise<OpenAiResponse> {
    const payload = {
      messages: chatMessages(request),
      user: request.safetyIdentifier,
      n: 1,
      reasoning_effort: request.textFormat ? null : "medium",
      max_completion_tokens: request.maxOutputTokens ?? 1_600,
      ...(request.textFormat
        ? {
            response_format: {
              type: "json_schema",
              json_schema: {
                name: request.textFormat.name,
                description: request.textFormat.description,
                schema: request.textFormat.schema,
                strict: true,
              },
            },
          }
        : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
                strict: tool.strict,
              },
            })),
            tool_choice: "auto",
            parallel_tool_calls: false,
          }
        : {}),
    } satisfies ChatCompletionsMessagesInput;
    let raw: Record<string, unknown> | ReadableStream<Uint8Array>;
    try {
      raw = await this.binding.run(this.model, payload);
    } catch (error) {
      throw new AiProviderError(
        "The Workers AI request failed before returning a provider result.",
        null,
        this.binding.aiGatewayLogId,
        { cause: error, failureKind: "transient" },
      );
    }
    if (raw instanceof ReadableStream) {
      throw new AiProviderError("Workers AI returned an unexpected stream.");
    }
    const completed = normalizeChatCompletion(
      raw,
      this.model,
      this.binding.aiGatewayLogId,
    );
    if (request.onTextDelta) {
      const text = openAiOutputText(completed);
      if (text) request.onTextDelta(text);
    }
    return completed;
  }
}
