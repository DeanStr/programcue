import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  AiAssistantService,
  AiPermissionError,
} from "./ai-assistant-service.server";
import { AiToolPermissionError } from "./ai-tools.server";
import {
  AI_PROVIDER_RESPONSE_MAX_BYTES,
  OpenAiResponsesProvider,
} from "./openai-responses-provider.server";
import {
  AiProviderSettingsConflictError,
  AiProviderSettingsService,
  AnthropicMessagesProvider,
  WORKERS_AI_MODEL,
  WorkersAiProvider,
} from "./ai-provider.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { OperationService } from "~/platform/operations/operation-service.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const evaluator: Viewer = {
  personId: "person-demo-evaluator",
  name: "Jordan Lee",
  email: "jordan.evaluator@example.com",
  role: "evaluator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

const owner: Viewer = {
  ...admin,
  personId: "person-demo-owner",
  name: "Morgan Chen",
  email: "owner@example.com",
  role: "owner",
};

const providerConfiguration = {
  apiKey: "test-openai-key-with-more-than-twenty-characters",
  model: "gpt-5.6-terra",
};

function providerJson(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json",
      "x-request-id": "openai-request-test",
    },
  });
}

function toolResponse(
  name: string,
  args: Record<string, unknown>,
  id = crypto.randomUUID(),
) {
  return providerJson({
    id,
    model: providerConfiguration.model,
    output: [
      {
        type: "reasoning",
        id: `reasoning-${id}`,
        encrypted_content: "opaque-provider-reasoning-state",
      },
      {
        type: "function_call",
        id: `fc-${id}`,
        call_id: `call-${id}`,
        name,
        arguments: JSON.stringify(args),
      },
    ],
  });
}

function textResponse(text: string, id = crypto.randomUUID()) {
  return providerJson({
    id,
    model: providerConfiguration.model,
    output: [
      {
        type: "message",
        id: `message-${id}`,
        role: "assistant",
        content: [{ type: "output_text", text, annotations: [] }],
      },
    ],
  });
}

beforeEach(async () => {
  await ensureDemoData(env as unknown as CloudflareEnvironment);
  await env.DB.prepare(
    `UPDATE organisation_ai_settings
        SET provider = 'openai', model = ?, revision = 1,
            last_updated_by_person_id = ?, updated_at = unixepoch()
      WHERE organisation_id = ?`,
  )
    .bind(providerConfiguration.model, admin.personId, admin.organisationId)
    .run();
});

async function reminderEnvironment() {
  const queued: unknown[] = [];
  const testEnv = {
    ...(env as unknown as CloudflareEnvironment),
    DB: env.DB,
    RESEND_API_KEY: "test-resend-key",
    OPERATIONS_QUEUE: {
      send: async (message: unknown) => {
        queued.push(message);
      },
    },
  } as unknown as CloudflareEnvironment;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sender_profiles (
      id, event_id, name, from_name, from_email, reply_to_email,
      provider, status, created_at, updated_at
    ) VALUES ('sender-ai-reminder', ?, 'AI reminder sender', 'Program Cue',
              'events@example.com', 'reply@example.com', 'resend', 'verified',
              unixepoch(), unixepoch())`,
  )
    .bind(admin.eventId)
    .run();
  const suffix = crypto.randomUUID();
  const deliverablePersonId = `ai-reminder-deliverable-${suffix}`;
  const suppressedPersonId = `ai-reminder-suppressed-${suffix}`;
  const deliverableAddress = `deliverable-${suffix}@example.com`;
  const suppressedAddress = `suppressed-${suffix}@example.com`;
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO people (
        id, email, display_name, email_verified, profile_status,
        created_at, updated_at
      ) VALUES (?, ?, 'Deliverable reminder speaker', 1, 'published',
                unixepoch(), unixepoch())`,
    ).bind(deliverablePersonId, deliverableAddress),
    env.DB.prepare(
      `INSERT INTO people (
        id, email, display_name, email_verified, profile_status,
        created_at, updated_at
      ) VALUES (?, ?, 'Suppressed reminder speaker', 1, 'published',
                unixepoch(), unixepoch())`,
    ).bind(suppressedPersonId, suppressedAddress),
    env.DB.prepare(
      `INSERT INTO task_instances (
        id, event_id, target_type, target_id, owner_person_id, title,
        task_type, impact, status, readiness_state, created_at, updated_at
      ) VALUES (?, ?, 'speaker', ?, ?, 'Upload final slides', 'file_upload',
                'high', 'not_started', 'at_risk', unixepoch(), unixepoch())`,
    ).bind(
      `ai-reminder-task-deliverable-${suffix}`,
      admin.eventId,
      deliverablePersonId,
      deliverablePersonId,
    ),
    env.DB.prepare(
      `INSERT INTO task_instances (
        id, event_id, target_type, target_id, owner_person_id, title,
        task_type, impact, status, readiness_state, created_at, updated_at
      ) VALUES (?, ?, 'speaker', ?, ?, 'Confirm biography', 'short_form',
                'medium', 'not_started', 'at_risk', unixepoch(), unixepoch())`,
    ).bind(
      `ai-reminder-task-suppressed-${suffix}`,
      admin.eventId,
      suppressedPersonId,
      suppressedPersonId,
    ),
    env.DB.prepare(
      `INSERT INTO communication_unsubscribes (
        id, event_id, person_id, address, category, reason, created_at
      ) VALUES (?, ?, ?, ?, 'task_reminder', 'test suppression', unixepoch())`,
    ).bind(
      `ai-reminder-unsubscribe-${suffix}`,
      admin.eventId,
      suppressedPersonId,
      suppressedAddress,
    ),
  ]);
  const communications = new CommunicationService(testEnv);
  const base = await communications.saveTemplate(admin, {
    name: `Approved reminder base ${suffix}`,
    category: "task_reminder",
    subject: "Outstanding task: {{task.title}}",
    content: {
      body: "Hello {{recipient.firstName}}, please complete {{task.title}}.",
      physicalAddress: "100 Programme Way, Toronto",
      buttonText: "Open speaker dashboard",
      buttonUrl: "https://example.com/speaker",
    },
  });
  await communications.publishTemplate(admin, base.versionId);
  return {
    testEnv,
    queued,
    baseTemplateVersionId: base.versionId,
    deliverableAddress,
    suppressedAddress,
  };
}

describe("organisation AI provider boundary", () => {
  it("persists an explicit provider/model with CAS and fails fast for its selected credential", async () => {
    const settings = new AiProviderSettingsService(
      env as unknown as CloudflareEnvironment,
    );
    await expect(settings.readiness(admin)).resolves.toMatchObject({
      configured: false,
      missing: ["OPENAI_API_KEY"],
      selection: { provider: "openai", model: providerConfiguration.model },
    });
    const selected = await settings.save(owner, {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      revision: 1,
    });
    expect(selected).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      revision: 2,
    });
    await expect(settings.readiness(admin)).resolves.toMatchObject({
      configured: false,
      missing: ["ANTHROPIC_API_KEY"],
    });
    await expect(
      settings.save(owner, {
        provider: "workers_ai",
        model: "@cf/deepseek-ai/deepseek-v4-flash-0731",
        revision: 1,
      }),
    ).rejects.toBeInstanceOf(AiProviderSettingsConflictError);
  });

  it("accepts only DeepSeek V4 Flash for Workers AI", async () => {
    const settings = new AiProviderSettingsService(
      env as unknown as CloudflareEnvironment,
    );
    await expect(
      settings.save(owner, {
        provider: "workers_ai",
        model: WORKERS_AI_MODEL,
        revision: 1,
      }),
    ).resolves.toEqual({
      provider: "workers_ai",
      model: WORKERS_AI_MODEL,
      revision: 2,
    });
    await expect(
      settings.save(owner, {
        provider: "workers_ai",
        model: "@cf/openai/gpt-oss-120b",
        revision: 2,
      }),
    ).rejects.toThrow(`Workers AI requires the model ${WORKERS_AI_MODEL}.`);
    await expect(settings.getSelection(owner.organisationId)).resolves.toEqual({
      provider: "workers_ai",
      model: WORKERS_AI_MODEL,
      revision: 2,
    });
  });

  it("rolls back the provider CAS when its audit cannot commit", async () => {
    const settings = new AiProviderSettingsService(
      env as unknown as CloudflareEnvironment,
    );
    await env.DB.prepare(
      `CREATE TRIGGER reject_provider_settings_audit
       BEFORE INSERT ON audit_events
       WHEN NEW.action = 'assistant.provider.updated'
       BEGIN
         SELECT RAISE(ABORT, 'provider settings audit rejected by test');
       END`,
    ).run();
    try {
      await expect(
        settings.save(owner, {
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          revision: 1,
        }),
      ).rejects.toThrow("provider settings audit rejected by test");
      await expect(
        settings.getSelection(owner.organisationId),
      ).resolves.toEqual({
        provider: "openai",
        model: providerConfiguration.model,
        revision: 1,
      });
    } finally {
      await env.DB.prepare("DROP TRIGGER reject_provider_settings_audit").run();
    }
  });

  it("maps DeepSeek Chat Completions calls without provider fallback", async () => {
    const run = vi.fn().mockResolvedValue({
      id: "workers-ai-chat-1",
      model: WORKERS_AI_MODEL,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: {
            role: "assistant",
            content: '{"summary":"Workers result"}',
          },
        },
      ],
    });
    const provider = new WorkersAiProvider(
      { aiGatewayLogId: "workers-ai-log-1", run },
      WORKERS_AI_MODEL,
    );
    const result = await provider.create({
      instructions: "Use the tool only when needed.",
      input: [{ role: "user", content: "Inspect readiness" }],
      safetyIdentifier: "pc_test",
      textFormat: {
        name: "program_cue_readiness_advisory",
        description: "A structured readiness advisory.",
        schema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          additionalProperties: false,
        },
      },
      tools: [
        {
          type: "function",
          name: "get_event_readiness",
          description: "Read readiness",
          strict: true,
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    });
    expect(result).toMatchObject({
      id: "workers-ai-chat-1",
      model: WORKERS_AI_MODEL,
      output_text: '{"summary":"Workers result"}',
    });
    expect(run).toHaveBeenCalledWith(WORKERS_AI_MODEL, {
      messages: [
        { role: "system", content: "Use the tool only when needed." },
        { role: "user", content: "Inspect readiness" },
      ],
      user: "pc_test",
      n: 1,
      reasoning_effort: null,
      max_completion_tokens: 1_600,
      parallel_tool_calls: false,
      tool_choice: "auto",
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "program_cue_readiness_advisory",
          description: "A structured readiness advisory.",
          schema: {
            type: "object",
            properties: { summary: { type: "string" } },
            required: ["summary"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
      tools: [
        {
          type: "function",
          function: {
            name: "get_event_readiness",
            description: "Read readiness",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            strict: true,
          },
        },
      ],
    });
  });

  it("rejects obsolete Workers AI models before calling the binding", () => {
    const run = vi.fn();
    expect(
      () =>
        new WorkersAiProvider(
          { aiGatewayLogId: null, run },
          "@cf/openai/gpt-oss-120b",
        ),
    ).toThrow(`Workers AI requires the model ${WORKERS_AI_MODEL}.`);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a Workers AI result attributed to another model", async () => {
    const run = vi.fn().mockResolvedValue({
      id: "workers-wrong-model",
      model: "@cf/another/model",
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Unexpected model result" },
        },
      ],
    });
    const provider = new WorkersAiProvider(
      { aiGatewayLogId: "workers-wrong-model-log", run },
      WORKERS_AI_MODEL,
    );

    await expect(
      provider.create({
        instructions: "Answer concisely.",
        input: "Inspect readiness",
        safetyIdentifier: "pc_test",
      }),
    ).rejects.toMatchObject({
      name: "AiProviderError",
      providerRequestId: "workers-wrong-model",
      message: `Workers AI returned model @cf/another/model after ${WORKERS_AI_MODEL} was requested; no result was accepted.`,
    });
  });

  it("maps DeepSeek tool calls and their results through the shared transcript", async () => {
    const run = vi
      .fn()
      .mockResolvedValueOnce({
        id: "workers-tool-1",
        model: WORKERS_AI_MODEL,
        choices: [
          {
            index: 0,
            finish_reason: "tool_calls",
            message: {
              role: "assistant",
              content: null,
              tool_calls: [
                {
                  id: "call-readiness-1",
                  type: "function",
                  function: {
                    name: "get_event_readiness",
                    arguments: "{}",
                  },
                },
              ],
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        id: "workers-text-2",
        model: WORKERS_AI_MODEL,
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Readiness is at risk." },
          },
        ],
      });
    const provider = new WorkersAiProvider(
      { aiGatewayLogId: "workers-tool-log", run },
      WORKERS_AI_MODEL,
    );
    const request = {
      instructions: "Use Program Cue evidence.",
      input: [{ role: "user", content: "Inspect readiness" }] as unknown[],
      safetyIdentifier: "pc_test",
      tools: [
        {
          type: "function" as const,
          name: "get_event_readiness",
          description: "Read readiness",
          strict: true as const,
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    };

    const toolResponse = await provider.create(request);
    expect(toolResponse.output).toContainEqual({
      type: "function_call",
      call_id: "call-readiness-1",
      name: "get_event_readiness",
      arguments: "{}",
    });
    const final = await provider.create({
      ...request,
      input: [
        ...request.input,
        ...toolResponse.output,
        {
          type: "function_call_output",
          call_id: "call-readiness-1",
          output: '{"percentage":73,"status":"at_risk"}',
        },
      ],
    });
    expect(final.output_text).toBe("Readiness is at risk.");
    expect(run).toHaveBeenNthCalledWith(
      2,
      WORKERS_AI_MODEL,
      expect.objectContaining({
        messages: [
          { role: "system", content: "Use Program Cue evidence." },
          { role: "user", content: "Inspect readiness" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call-readiness-1",
                type: "function",
                function: {
                  name: "get_event_readiness",
                  arguments: "{}",
                },
              },
            ],
          },
          {
            role: "tool",
            tool_call_id: "call-readiness-1",
            content: '{"percentage":73,"status":"at_risk"}',
          },
        ],
      }),
    );
  });

  it("returns a buffered DeepSeek result to streaming callers without requesting a binding stream", async () => {
    const raw = {
      id: "workers-buffered-1",
      model: WORKERS_AI_MODEL,
      choices: [
        {
          index: 0,
          finish_reason: "stop",
          message: { role: "assistant", content: "Workers result" },
        },
      ],
    };
    const deltas: string[] = [];
    const run = vi.fn().mockResolvedValue(raw);
    const provider = new WorkersAiProvider(
      {
        aiGatewayLogId: "workers-log-buffered",
        run,
      },
      WORKERS_AI_MODEL,
    );
    const result = await provider.create({
      instructions: "Answer concisely.",
      input: "Stream a result.",
      safetyIdentifier: "pc_test",
      onTextDelta: (delta) => deltas.push(delta),
    });
    expect(deltas).toEqual(["Workers result"]);
    expect(result.id).toBe("workers-buffered-1");
    expect(run).toHaveBeenCalledWith(
      WORKERS_AI_MODEL,
      expect.not.objectContaining({ stream: true }),
    );
  });

  it("fails fast when DeepSeek exhausts the response budget", async () => {
    const run = vi.fn().mockResolvedValue({
      id: "workers-incomplete-1",
      model: WORKERS_AI_MODEL,
      choices: [
        {
          index: 0,
          finish_reason: "length",
          message: { role: "assistant", content: '{"score":4' },
        },
      ],
    });
    const provider = new WorkersAiProvider(
      { aiGatewayLogId: "workers-log-incomplete", run },
      WORKERS_AI_MODEL,
    );

    await expect(
      provider.create({
        instructions: "Return a structured result.",
        input: "Assess this proposal.",
        safetyIdentifier: "pc_test",
      }),
    ).rejects.toMatchObject({
      name: "AiProviderError",
      providerRequestId: "workers-incomplete-1",
      message:
        "Workers AI exhausted the DeepSeek completion-token budget; no result was accepted.",
    });
  });

  it("rejects DeepSeek tool calls with an inconsistent stop reason", async () => {
    const provider = new WorkersAiProvider(
      {
        aiGatewayLogId: "workers-log-inconsistent",
        run: vi.fn().mockResolvedValue({
          id: "workers-inconsistent-1",
          model: WORKERS_AI_MODEL,
          choices: [
            {
              index: 0,
              finish_reason: "stop",
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call-inconsistent-1",
                    type: "function",
                    function: {
                      name: "get_event_readiness",
                      arguments: "{}",
                    },
                  },
                ],
              },
            },
          ],
        }),
      },
      WORKERS_AI_MODEL,
    );

    await expect(
      provider.create({
        instructions: "Use Program Cue evidence.",
        input: "Inspect readiness.",
        safetyIdentifier: "pc_test",
      }),
    ).rejects.toMatchObject({
      name: "AiProviderError",
      providerRequestId: "workers-inconsistent-1",
      message:
        "Workers AI returned tool calls with an inconsistent stop reason; no result was accepted.",
    });
  });

  it("maps strict Anthropic tool calls and results through the shared contract", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        providerJson({
          id: "msg-tool",
          model: "claude-sonnet-4-6",
          content: [
            {
              type: "tool_use",
              id: "toolu-1",
              name: "get_event_readiness",
              input: {},
            },
          ],
          stop_reason: "tool_use",
        }),
      )
      .mockResolvedValueOnce(
        providerJson({
          id: "msg-text",
          model: "claude-sonnet-4-6",
          content: [{ type: "text", text: "Readiness is blocked." }],
          stop_reason: "end_turn",
        }),
      );
    const provider = new AnthropicMessagesProvider(
      { apiKey: "test-anthropic-key-with-more-than-twenty-characters" },
      "claude-sonnet-4-6",
      fetcher,
    );
    const request = {
      instructions: "Use Program Cue evidence.",
      input: [{ role: "user", content: "Inspect readiness" }] as unknown[],
      safetyIdentifier: "pc_test",
      tools: [
        {
          type: "function" as const,
          name: "get_event_readiness",
          description: "Read readiness",
          strict: true as const,
          parameters: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
        },
      ],
    };
    const toolCall = await provider.create(request);
    const final = await provider.create({
      ...request,
      input: [
        ...request.input,
        ...toolCall.output,
        {
          type: "function_call_output",
          call_id: "toolu-1",
          output: '{"readiness":72}',
        },
      ],
    });
    expect(final.output_text).toBe("Readiness is blocked.");
    const firstBody = JSON.parse(String(fetcher.mock.calls[0]![1]?.body));
    expect(firstBody).toMatchObject({
      model: "claude-sonnet-4-6",
      metadata: { user_id: "pc_test" },
      tool_choice: { type: "auto", disable_parallel_tool_use: true },
      tools: [{ name: "get_event_readiness", strict: true }],
    });
    expect(fetcher.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    const secondBody = JSON.parse(String(fetcher.mock.calls[1]![1]?.body));
    expect(secondBody.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          role: "assistant",
          content: [
            expect.objectContaining({ type: "tool_use", id: "toolu-1" }),
          ],
        }),
        expect.objectContaining({
          role: "user",
          content: [
            expect.objectContaining({
              type: "tool_result",
              tool_use_id: "toolu-1",
            }),
          ],
        }),
      ]),
    );
  });

  it("streams Anthropic text deltas and requires a complete attributed message", async () => {
    const body = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg-stream","model":"claude-sonnet-4-6"}}',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Anthropic "}}',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"stream"}}',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}',
      'event: message_stop\ndata: {"type":"message_stop"}',
      "",
    ].join("\n\n");
    const providerResponse = new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "request-id": "anthropic-request-stream",
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(providerResponse);
    const deltas: string[] = [];
    const result = await new AnthropicMessagesProvider(
      { apiKey: "test-anthropic-key-with-more-than-twenty-characters" },
      "claude-sonnet-4-6",
      fetcher,
    ).create({
      instructions: "Answer concisely.",
      input: "Stream a result.",
      safetyIdentifier: "pc_test",
      onTextDelta: (delta) => deltas.push(delta),
    });
    expect(deltas).toEqual(["Anthropic ", "stream"]);
    expect(result).toMatchObject({
      id: "msg-stream",
      model: "claude-sonnet-4-6",
      output_text: "Anthropic stream",
    });
    expect(providerResponse.body?.locked).toBe(false);
  });

  it("cancels and unlocks a rejected Anthropic stream", async () => {
    let cancellationReason: unknown = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: not-json\n\n"));
      },
      cancel(reason) {
        cancellationReason = reason;
      },
    });
    const provider = new AnthropicMessagesProvider(
      { apiKey: "test-anthropic-key-with-more-than-twenty-characters" },
      "claude-sonnet-4-6",
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    await expect(
      provider.create({
        instructions: "Answer concisely.",
        input: "Stream a result.",
        safetyIdentifier: "pc_stream_rejection_test",
        onTextDelta: () => {},
      }),
    ).rejects.toThrow("Anthropic returned invalid streaming JSON.");
    expect(cancellationReason).toBe("AI provider stream rejected");
    expect(body.locked).toBe(false);
  });

  it("rejects an oversized Anthropic stream before consuming it", async () => {
    let cancellationReason: unknown = null;
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationReason = reason;
      },
    });
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        headers: {
          "content-length": String(AI_PROVIDER_RESPONSE_MAX_BYTES + 1),
          "content-type": "text/event-stream",
          "request-id": "anthropic-oversized-stream",
        },
      }),
    );
    const provider = new AnthropicMessagesProvider(
      { apiKey: "test-anthropic-key-with-more-than-twenty-characters" },
      "claude-sonnet-4-6",
      fetcher,
    );

    await expect(
      provider.create({
        instructions: "Answer concisely.",
        input: "Stream a result.",
        safetyIdentifier: "pc_test",
        onTextDelta: () => {},
      }),
    ).rejects.toThrow("Anthropic returned an oversized streaming response.");
    expect(cancellationReason).toBe("AI provider response body limit exceeded");
    expect(body.locked).toBe(false);
  });
});
