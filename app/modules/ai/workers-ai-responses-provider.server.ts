import {
  AiProviderError,
  aiProviderResponseSchema,
  readResponsesApiStream,
  type AiModelProvider,
  type OpenAiResponse,
  type OpenAiResponsesRequest,
} from "./openai-responses-provider.server";

export type WorkersAiBinding = {
  aiGatewayLogId: string | null;
  run(
    model: string,
    input: Record<string, unknown>,
  ): Promise<Record<string, unknown> | ReadableStream<Uint8Array>>;
};

export class WorkersAiResponsesProvider implements AiModelProvider {
  readonly providerName = "Workers AI" as const;

  constructor(
    private readonly binding: WorkersAiBinding,
    readonly model: string,
  ) {}

  async create(request: OpenAiResponsesRequest): Promise<OpenAiResponse> {
    const payload: Record<string, unknown> = {
      instructions: request.instructions,
      input: request.input,
      safety_identifier: request.safetyIdentifier,
      reasoning: { effort: "medium" },
      max_output_tokens: request.maxOutputTokens ?? 1_600,
      ...(request.onTextDelta ? { stream: true } : {}),
      ...(request.textFormat
        ? {
            text: {
              format: {
                type: "json_schema",
                name: request.textFormat.name,
                description: request.textFormat.description,
                strict: true,
                schema: request.textFormat.schema,
              },
            },
          }
        : {}),
      ...(request.tools?.length
        ? {
            tools: request.tools,
            tool_choice: "auto",
            parallel_tool_calls: false,
          }
        : {}),
    };
    let raw: Record<string, unknown> | ReadableStream<Uint8Array>;
    try {
      raw = await this.binding.run(this.model, payload);
    } catch (error) {
      throw new AiProviderError(
        "The Workers AI request failed before returning a provider result.",
        null,
        this.binding.aiGatewayLogId,
        { cause: error },
      );
    }
    if (request.onTextDelta) {
      if (!(raw instanceof ReadableStream)) {
        throw new AiProviderError(
          "Workers AI did not return the requested Responses API stream.",
          null,
          this.binding.aiGatewayLogId,
        );
      }
      return readResponsesApiStream(
        new Response(raw),
        this.providerName,
        this.binding.aiGatewayLogId,
        request.onTextDelta,
      );
    }
    if (raw instanceof ReadableStream) {
      throw new AiProviderError("Workers AI returned an unexpected stream.");
    }
    const parsed = aiProviderResponseSchema.safeParse({
      ...raw,
      id: raw.id ?? this.binding.aiGatewayLogId,
      model: raw.model ?? this.model,
    });
    if (!parsed.success) {
      throw new AiProviderError(
        "Workers AI returned a result without a provider request ID or valid Responses API output.",
        null,
        this.binding.aiGatewayLogId,
      );
    }
    return parsed.data;
  }
}
