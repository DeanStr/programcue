import { z } from "zod";

import {
  AiConfigurationError,
  AiProviderError,
  AI_PROVIDER_REQUEST_TIMEOUT_MS,
  AI_PROVIDER_RESPONSE_MAX_BYTES,
  OpenAiResponsesProvider,
  aiProviderResponseSchema,
  normalizeAiProviderRequestId,
  readResponsesApiStream,
  type AiModelProvider,
  type OpenAiResponse,
  type OpenAiResponsesRequest,
} from "./openai-responses-provider.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  readBoundedResponseJson,
  ResponseBodyTooLargeError,
} from "~/platform/http/read-response";

export const aiProviderKeys = ["workers_ai", "openai", "anthropic"] as const;
export type AiProviderKey = (typeof aiProviderKeys)[number];

export const aiProviderLabels = {
  workers_ai: "Workers AI",
  openai: "OpenAI",
  anthropic: "Anthropic",
} as const satisfies Record<AiProviderKey, string>;

const settingsInputSchema = z
  .object({
    provider: z.enum(aiProviderKeys),
    model: z.string().trim().min(1).max(100),
    revision: z.coerce.number().int().min(0),
  })
  .strict();

const endpointSchema = z.url().refine((value) => value.startsWith("https://"), {
  message: "Provider endpoints must use HTTPS.",
});

export type AiProviderSelection = {
  provider: AiProviderKey;
  model: string;
  revision: number;
};

export type AiProviderReadiness = {
  configured: boolean;
  missing: string[];
  problem: string | null;
  selection: AiProviderSelection | null;
  providerLabel: string | null;
  model: string | null;
};

export class AiProviderSettingsConflictError extends Error {
  constructor() {
    super(
      "AI provider settings changed in another session. Reload before saving.",
    );
    this.name = "AiProviderSettingsConflictError";
  }
}

function assertOrganisationOwner(viewer: Viewer) {
  if (viewer.role !== "owner") {
    throw new Response("Forbidden", { status: 403 });
  }
}

function configurationProblem(
  env: CloudflareEnvironment,
  selection: AiProviderSelection,
) {
  if (selection.provider === "workers_ai") {
    const missing = !env.AI ? ["AI Workers binding"] : [];
    if (missing.length)
      return { missing, problem: `${missing[0]} is required for Workers AI.` };
    if (!/^@cf\/openai\/gpt-oss-(?:20b|120b)$/u.test(selection.model)) {
      return {
        missing: [],
        problem:
          "Workers AI currently requires @cf/openai/gpt-oss-20b or @cf/openai/gpt-oss-120b because the assistant depends on the Responses API and strict function calling.",
      };
    }
    return { missing: [], problem: null };
  }

  const keyName =
    selection.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY";
  const key =
    selection.provider === "openai"
      ? env.OPENAI_API_KEY?.trim()
      : env.ANTHROPIC_API_KEY?.trim();
  if (!key) {
    return {
      missing: [keyName],
      problem: `${keyName} is required for ${aiProviderLabels[selection.provider]}.`,
    };
  }
  if (key.length < 20) {
    return {
      missing: [],
      problem: `${keyName} is invalid; it must contain at least 20 characters.`,
    };
  }
  const endpoint =
    selection.provider === "openai"
      ? env.OPENAI_RESPONSES_URL?.trim()
      : env.ANTHROPIC_MESSAGES_URL?.trim();
  if (endpoint && !endpointSchema.safeParse(endpoint).success) {
    return {
      missing: [],
      problem: `${selection.provider === "openai" ? "OPENAI_RESPONSES_URL" : "ANTHROPIC_MESSAGES_URL"} must be an explicit HTTPS URL.`,
    };
  }
  return { missing: [], problem: null };
}

export class AiProviderSettingsService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async getSelection(
    organisationId: string,
  ): Promise<AiProviderSelection | null> {
    const row = await this.env.DB.prepare(
      `SELECT settings.provider, settings.model, settings.revision
         FROM organisation_ai_settings settings
         JOIN organisations organisation ON organisation.id = settings.organisation_id
        WHERE settings.organisation_id = ?`,
    )
      .bind(organisationId)
      .first<{ provider: string; model: string; revision: number }>();
    if (!row) return null;
    return {
      provider: z.enum(aiProviderKeys).parse(row.provider),
      model: z.string().trim().min(1).max(100).parse(row.model),
      revision: z.number().int().positive().parse(row.revision),
    };
  }

  async readiness(viewer: Viewer): Promise<AiProviderReadiness> {
    const selection = await this.getSelection(viewer.organisationId);
    if (!selection) {
      return {
        configured: false,
        missing: ["organisation AI provider selection"],
        problem:
          "Select an AI provider and explicit model for this organisation.",
        selection: null,
        providerLabel: null,
        model: null,
      };
    }
    const issue = configurationProblem(this.env, selection);
    return {
      configured: issue.problem === null,
      ...issue,
      selection,
      providerLabel: aiProviderLabels[selection.provider],
      model: selection.model,
    };
  }

  async save(viewer: Viewer, raw: unknown) {
    assertOrganisationOwner(viewer);
    const input = settingsInputSchema.parse(raw);
    const operationId = `assistant-provider-settings:${crypto.randomUUID()}`;
    const nextRevision = input.revision + 1;
    const mutation =
      input.revision === 0
        ? this.env.DB.prepare(
            `INSERT INTO organisation_ai_settings (
               organisation_id, provider, model, revision,
               last_updated_by_person_id, last_operation_id,
               created_at, updated_at
             ) SELECT ?, ?, ?, 1, ?, ?, unixepoch(), unixepoch()
               WHERE EXISTS (
                 SELECT 1 FROM events
                  WHERE id = ? AND organisation_id = ?
               )
                 AND EXISTS (SELECT 1 FROM people WHERE id = ?)
                 AND NOT EXISTS (
                   SELECT 1 FROM organisation_ai_settings
                    WHERE organisation_id = ?
                 )`,
          ).bind(
            viewer.organisationId,
            input.provider,
            input.model,
            viewer.personId,
            operationId,
            viewer.eventId,
            viewer.organisationId,
            viewer.personId,
            viewer.organisationId,
          )
        : this.env.DB.prepare(
            `UPDATE organisation_ai_settings
                SET provider = ?, model = ?, revision = revision + 1,
                    last_updated_by_person_id = ?, last_operation_id = ?,
                    updated_at = unixepoch()
              WHERE organisation_id = ? AND revision = ?
                AND EXISTS (
                  SELECT 1 FROM events
                   WHERE id = ? AND organisation_id = ?
                )
                AND EXISTS (SELECT 1 FROM people WHERE id = ?)`,
          ).bind(
            input.provider,
            input.model,
            viewer.personId,
            operationId,
            viewer.organisationId,
            input.revision,
            viewer.eventId,
            viewer.organisationId,
            viewer.personId,
          );
    const metadata = JSON.stringify({
      provider: input.provider,
      model: input.model,
      revision: nextRevision,
    });
    const [updated, audited] = await this.env.DB.batch([
      mutation,
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, settings.organisation_id, ?, ?,
                'assistant.provider.updated', 'organisation_ai_settings',
                settings.organisation_id, ?, ?, unixepoch()
           FROM organisation_ai_settings settings
          WHERE settings.organisation_id = ?
            AND settings.provider = ? AND settings.model = ?
            AND settings.revision = ? AND settings.last_operation_id = ?`,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        metadata,
        viewer.organisationId,
        input.provider,
        input.model,
        nextRevision,
        operationId,
      ),
    ]);
    if (
      (updated.meta.changes ?? 0) !== 1 ||
      (audited.meta.changes ?? 0) !== 1
    ) {
      throw new AiProviderSettingsConflictError();
    }
    return {
      provider: input.provider,
      model: input.model,
      revision: nextRevision,
    } satisfies AiProviderSelection;
  }
}

type WorkersAiBinding = {
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
