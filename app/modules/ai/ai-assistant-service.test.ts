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
  WorkersAiResponsesProvider,
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
        model: "@cf/openai/gpt-oss-120b",
        revision: 1,
      }),
    ).rejects.toBeInstanceOf(AiProviderSettingsConflictError);
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

  it("maps Workers AI Responses calls without provider fallback", async () => {
    const run = vi.fn().mockResolvedValue({
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Workers result" }],
        },
      ],
    });
    const provider = new WorkersAiResponsesProvider(
      { aiGatewayLogId: "workers-ai-log-1", run },
      "@cf/openai/gpt-oss-120b",
    );
    const result = await provider.create({
      instructions: "Use the tool only when needed.",
      input: [{ role: "user", content: "Inspect readiness" }],
      safetyIdentifier: "pc_test",
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
      id: "workers-ai-log-1",
      model: "@cf/openai/gpt-oss-120b",
    });
    expect(run).toHaveBeenCalledWith(
      "@cf/openai/gpt-oss-120b",
      expect.objectContaining({
        parallel_tool_calls: false,
        tool_choice: "auto",
      }),
    );
  });

  it("streams Workers AI Responses deltas through the provider contract", async () => {
    const encoder = new TextEncoder();
    const raw = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_text.delta","delta":"Workers "}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.output_text.delta","delta":"stream"}\n\n',
          ),
        );
        controller.enqueue(
          encoder.encode(
            'data: {"type":"response.completed","response":{"id":"workers-stream-1","model":"@cf/openai/gpt-oss-120b","output":[{"type":"message","content":[{"type":"output_text","text":"Workers stream"}]}]}}\n\n',
          ),
        );
        controller.close();
      },
    });
    const deltas: string[] = [];
    const provider = new WorkersAiResponsesProvider(
      {
        aiGatewayLogId: "workers-log-stream",
        run: vi.fn().mockResolvedValue(raw),
      },
      "@cf/openai/gpt-oss-120b",
    );
    const result = await provider.create({
      instructions: "Answer concisely.",
      input: "Stream a result.",
      safetyIdentifier: "pc_test",
      onTextDelta: (delta) => deltas.push(delta),
    });
    expect(deltas).toEqual(["Workers ", "stream"]);
    expect(result.id).toBe("workers-stream-1");
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
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(body, {
        headers: {
          "content-type": "text/event-stream",
          "request-id": "anthropic-request-stream",
        },
      }),
    );
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
  });

  it("rejects an oversized Anthropic stream before consuming it", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response('data: {"type":"message_stop"}\n\n', {
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
  });
});

describe("OpenAI Responses provider boundary", () => {
  it("rejects an oversized non-streaming provider response", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", {
        headers: {
          "content-length": String(AI_PROVIDER_RESPONSE_MAX_BYTES + 1),
          "content-type": "application/json",
          "x-request-id": "x".repeat(201),
        },
      }),
    );
    const provider = new OpenAiResponsesProvider(
      providerConfiguration,
      fetcher,
    );

    await expect(
      provider.create({
        instructions: "Answer concisely.",
        input: "Return a result.",
        safetyIdentifier: "pc_test",
      }),
    ).rejects.toMatchObject({
      message: "OpenAI returned an oversized response.",
      providerRequestId: null,
    });
  });

  it("uses store:false and strict direct tools with a privacy-preserving safety identifier", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(toolResponse("get_event_readiness", {}))
      .mockResolvedValueOnce(
        textResponse(
          "Program Cue records show readiness blockers. Review the linked tasks first.",
        ),
      );
    const result = await new AiAssistantService(
      env as unknown as CloudflareEnvironment,
      { fetcher, providerConfiguration },
    ).ask(admin, "What is blocking readiness?");

    expect(result.answer).toContain("Program Cue records");
    expect(result.evidence.map((item) => item.id)).toContain("event-readiness");
    expect(result.attribution).toMatchObject({
      provider: "OpenAI",
      model: providerConfiguration.model,
      advisory: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls[0]![1]?.signal).toBeInstanceOf(AbortSignal);
    const firstRequest = JSON.parse(
      String(fetcher.mock.calls[0]![1]?.body),
    ) as {
      store: boolean;
      include: string[];
      safety_identifier: string;
      parallel_tool_calls: boolean;
      tools: Array<{
        name: string;
        strict: boolean;
        parameters: { additionalProperties: boolean };
      }>;
    };
    expect(firstRequest.store).toBe(false);
    expect(firstRequest.include).toContain("reasoning.encrypted_content");
    expect(firstRequest.safety_identifier).toMatch(/^pc_[a-f0-9]{64}$/);
    expect(firstRequest.parallel_tool_calls).toBe(false);
    expect(firstRequest.tools.length).toBeGreaterThan(5);
    expect(
      firstRequest.tools.every(
        (tool) =>
          tool.strict === true &&
          tool.parameters.additionalProperties === false,
      ),
    ).toBe(true);
    expect(firstRequest.tools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(["publish_schedule", "send_reminder"]),
    );
    const continuation = JSON.parse(
      String(fetcher.mock.calls[1]![1]?.body),
    ) as {
      input: Array<{
        type?: string;
        output?: string;
        encrypted_content?: string;
      }>;
    };
    expect(continuation.input).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "reasoning",
          encrypted_content: "opaque-provider-reasoning-state",
        }),
      ]),
    );
    expect(
      continuation.input.some(
        (item) =>
          item.type === "function_call_output" &&
          item.output?.includes("authoritative_command_centre_snapshot"),
      ),
    ).toBe(true);
    const audit = await env.DB.prepare(
      `SELECT action FROM audit_events
        WHERE event_id = ? AND entity_id = ? ORDER BY created_at, id`,
    )
      .bind(admin.eventId, result.runId)
      .all<{ action: string }>();
    expect(audit.results.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "assistant.requested",
        "assistant.tool.completed",
        "assistant.completed",
      ]),
    );
    const operation = await env.DB.prepare(
      `SELECT type, status, payload_json AS payloadJson,
              result_json AS resultJson, progress_completed AS progressCompleted
         FROM operation_jobs
        WHERE id = ? AND event_id = ?`,
    )
      .bind(result.operationId, admin.eventId)
      .first<{
        type: string;
        status: string;
        payloadJson: string;
        resultJson: string;
        progressCompleted: number;
      }>();
    expect(operation).toMatchObject({
      type: "ai.assistant.run",
      status: "completed",
      progressCompleted: 1,
    });
    expect(JSON.parse(operation!.payloadJson)).not.toHaveProperty("prompt");
    expect(JSON.parse(operation!.resultJson)).toMatchObject({
      responseId: result.attribution.responseId,
      provider: "OpenAI",
    });
    await expect(
      new OperationService(env as unknown as CloudflareEnvironment)
        .list(admin)
        .then((items) => items.find((item) => item.id === result.operationId)),
    ).resolves.toMatchObject({
      type: "ai.assistant.run",
      status: "completed",
      retryable: false,
      cancellable: false,
    });
  });

  it("reports provider errors instead of manufacturing an answer", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        providerJson(
          { error: { message: "The selected model is unavailable." } },
          503,
        ),
      );
    const provider = new OpenAiResponsesProvider(
      providerConfiguration,
      fetcher,
    );
    await expect(
      provider.create({
        instructions: "Return a result.",
        input: "Hello",
        safetyIdentifier: "pc_test",
      }),
    ).rejects.toMatchObject({
      status: 503,
      providerRequestId: "openai-request-test",
      message: "OpenAI request failed: The selected model is unavailable.",
    });
  });

  it("consumes Responses API text deltas and still validates the completed response", async () => {
    const completed = {
      id: "resp-stream-test",
      model: providerConfiguration.model,
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "Grounded answer", annotations: [] },
          ],
        },
      ],
    };
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        [
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "Grounded " })}`,
          `data: ${JSON.stringify({ type: "response.output_text.delta", delta: "answer" })}`,
          `data: ${JSON.stringify({ type: "response.completed", response: completed })}`,
          "data: [DONE]",
          "",
        ].join("\n\n"),
        {
          headers: {
            "content-type": "text/event-stream",
            "x-request-id": "openai-stream-request-test",
          },
        },
      ),
    );
    const deltas: string[] = [];
    const response = await new OpenAiResponsesProvider(
      providerConfiguration,
      fetcher,
    ).create({
      instructions: "Use authorised evidence.",
      input: "Summarise readiness.",
      safetyIdentifier: "pc_stream_test",
      onTextDelta: (delta) => deltas.push(delta),
    });
    expect(deltas.join("")).toBe("Grounded answer");
    expect(response).toMatchObject({ id: "resp-stream-test" });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      stream: true,
      store: false,
    });
  });

  it("normalises transport failures as explicit provider errors", async () => {
    const provider = new OpenAiResponsesProvider(
      providerConfiguration,
      vi.fn<typeof fetch>().mockRejectedValue(new TypeError("network down")),
    );
    await expect(
      provider.create({
        instructions: "Return a result.",
        input: "Hello",
        safetyIdentifier: "pc_test",
      }),
    ).rejects.toMatchObject({
      name: "AiProviderError",
      status: null,
      message: "The OpenAI request could not reach the provider.",
    });
  });
});

describe("agent tool permissions and approval", () => {
  it("rejects a model-requested tool that is not explicitly allow-listed", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(toolResponse("publish_schedule", {}));
    await expect(
      new AiAssistantService(env as unknown as CloudflareEnvironment, {
        fetcher,
        providerConfiguration,
      }).ask(admin, "Publish the schedule without asking."),
    ).rejects.toThrow(AiToolPermissionError);
    expect(fetcher).toHaveBeenCalledOnce();
    const audit = await env.DB.prepare(
      `SELECT action FROM audit_events
        WHERE event_id = ? AND action IN ('assistant.tool.failed','assistant.failed')`,
    )
      .bind(admin.eventId)
      .all<{ action: string }>();
    expect(audit.results.map((row) => row.action)).toEqual(
      expect.arrayContaining(["assistant.tool.failed", "assistant.failed"]),
    );
  });

  it("saves a write preview, requires confirmation and executes idempotently", async () => {
    const title = `Resolve readiness blocker ${crypto.randomUUID()}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        toolResponse("propose_task", {
          title,
          description: "Review the highest-impact readiness blocker.",
          targetType: "event",
          targetId: admin.eventId,
          ownerPersonId: null,
          taskType: "administrator_only",
          impact: "high",
          dueAt: null,
          dependencyIds: [],
        }),
      )
      .mockResolvedValueOnce(
        textResponse(
          "I prepared one task preview. Nothing has been created; review and approve the exact change in Program Cue.",
        ),
      );
    const service = new AiAssistantService(
      env as unknown as CloudflareEnvironment,
      { fetcher, providerConfiguration },
    );
    const result = await service.ask(
      admin,
      "Propose one event task. Do not execute it.",
    );
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({
      approvalRequired: true,
      title,
    });
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM task_instances WHERE event_id = ? AND title = ?",
    )
      .bind(admin.eventId, title)
      .first<{ count: number }>();
    expect(before?.count).toBe(0);

    await expect(
      service.approveProposal(admin, result.proposals[0]!.id, false),
    ).rejects.toThrow("Explicit confirmation is required");
    const approved = await service.approveProposal(
      admin,
      result.proposals[0]!.id,
      true,
    );
    expect(approved).toMatchObject({ title, replayed: false });
    const replay = await service.approveProposal(
      admin,
      result.proposals[0]!.id,
      true,
    );
    expect(replay).toMatchObject({
      taskId: approved.taskId,
      replayed: true,
    });
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM task_instances WHERE event_id = ? AND title = ?",
    )
      .bind(admin.eventId, title)
      .first<{ count: number }>();
    expect(after?.count).toBe(1);
    const executedAudit = await env.DB.prepare(
      `SELECT actor_person_id AS actorPersonId, metadata_json AS metadataJson
         FROM audit_events
        WHERE event_id = ? AND action = 'assistant.action.executed'
          AND entity_id = ?`,
    )
      .bind(admin.eventId, approved.taskId)
      .first<{ actorPersonId: string; metadataJson: string }>();
    expect(executedAudit?.actorPersonId).toBe(admin.personId);
    expect(JSON.parse(executedAudit!.metadataJson)).toMatchObject({
      proposalId: result.proposals[0]!.id,
      toolName: "propose_task",
    });
  });

  it("recovers the exact downstream task after a crash before execution settlement", async () => {
    const title = `Crash-safe assistant task ${crypto.randomUUID()}`;
    const previewService = new AiAssistantService(
      env as unknown as CloudflareEnvironment,
      {
        providerConfiguration,
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            toolResponse("propose_task", {
              title,
              description: "Verify crash-safe assistant execution.",
              targetType: "event",
              targetId: admin.eventId,
              ownerPersonId: null,
              taskType: "administrator_only",
              impact: "high",
              dueAt: null,
              dependencyIds: [],
            }),
          )
          .mockResolvedValueOnce(textResponse("Task preview ready.")),
      },
    );
    const preview = await previewService.ask(
      admin,
      "Prepare one crash-safe task.",
    );
    const proposalId = preview.proposals[0]!.id;
    const crashingService = new AiAssistantService(
      env as unknown as CloudflareEnvironment,
      {
        beforeProposalExecutionCommit: () => {
          throw new Error("simulated crash before proposal settlement");
        },
      },
    );
    await expect(
      crashingService.approveProposal(admin, proposalId, true),
    ).rejects.toThrow("simulated crash before proposal settlement");
    const created = await env.DB.prepare(
      `SELECT id FROM task_instances WHERE event_id = ? AND title = ?`,
    )
      .bind(admin.eventId, title)
      .first<{ id: string }>();
    expect(created).toBeTruthy();
    await expect(
      env.DB.prepare(
        `SELECT status, claim_expires_at AS claimExpiresAt
           FROM assistant_proposal_executions WHERE proposal_id = ?`,
      )
        .bind(proposalId)
        .first(),
    ).resolves.toEqual({ status: "processing", claimExpiresAt: 0 });

    const recovered = await previewService.approveProposal(
      admin,
      proposalId,
      true,
    );
    expect(recovered).toMatchObject({
      kind: "task",
      taskId: created!.id,
      replayed: false,
    });
    await expect(
      previewService.approveProposal(admin, proposalId, true),
    ).resolves.toMatchObject({ taskId: created!.id, replayed: true });
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM task_instances
        WHERE event_id = ? AND title = ?`,
    )
      .bind(admin.eventId, title)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("rejects a concurrent approval while the exact proposal lease is active", async () => {
    const title = `Concurrent assistant task ${crypto.randomUUID()}`;
    const previewService = new AiAssistantService(
      env as unknown as CloudflareEnvironment,
      {
        providerConfiguration,
        fetcher: vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(
            toolResponse("propose_task", {
              title,
              description: "Verify concurrent assistant execution.",
              targetType: "event",
              targetId: admin.eventId,
              ownerPersonId: null,
              taskType: "administrator_only",
              impact: "medium",
              dueAt: null,
              dependencyIds: [],
            }),
          )
          .mockResolvedValueOnce(textResponse("Task preview ready.")),
      },
    );
    const preview = await previewService.ask(
      admin,
      "Prepare one concurrency-safe task.",
    );
    const proposalId = preview.proposals[0]!.id;
    let releaseCommit!: () => void;
    let markReached!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const reachedCommit = new Promise<void>((resolve) => {
      markReached = resolve;
    });
    const firstService = new AiAssistantService(
      env as unknown as CloudflareEnvironment,
      {
        beforeProposalExecutionCommit: async () => {
          markReached();
          await commitGate;
        },
      },
    );
    const firstApproval = firstService.approveProposal(admin, proposalId, true);
    await reachedCommit;
    await expect(
      previewService.approveProposal(admin, proposalId, true),
    ).rejects.toThrow("already executing");
    releaseCommit();
    await expect(firstApproval).resolves.toMatchObject({
      kind: "task",
      replayed: false,
    });
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM task_instances
        WHERE event_id = ? AND title = ?`,
    )
      .bind(admin.eventId, title)
      .first<{ count: number }>();
    expect(count?.count).toBe(1);
  });

  it("durably previews exact reminder recipients and content, then queues once after explicit approval", async () => {
    const {
      testEnv,
      queued,
      baseTemplateVersionId,
      deliverableAddress,
      suppressedAddress,
    } = await reminderEnvironment();
    const subject = "Please complete {{task.title}}";
    const body =
      "Hello {{recipient.firstName}}, your event task {{task.title}} is still outstanding.";
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        toolResponse("propose_reminder_send", {
          baseTemplateVersionId,
          audienceType: "incomplete_speakers",
          kind: "optional",
          subject,
          body,
        }),
      )
      .mockResolvedValueOnce(
        textResponse(
          "I saved an exact reminder preview. Nothing has been queued or sent; inspect the recipients and approve it in Program Cue if correct.",
        ),
      );
    const service = new AiAssistantService(testEnv, {
      fetcher,
      providerConfiguration,
    });
    const result = await service.ask(
      admin,
      "Prepare an exact incomplete-speaker reminder preview. Do not send it.",
    );
    expect(result.proposals).toHaveLength(1);
    const proposal = result.proposals[0]!;
    expect(proposal.toolName).toBe("propose_reminder_send");
    if (proposal.toolName !== "propose_reminder_send") {
      throw new Error("Expected reminder proposal");
    }
    expect(proposal.reminder.template).toMatchObject({
      subject,
      versionStatus: "draft",
      content: { body },
    });
    expect(
      proposal.reminder.recipients.deliverable.map((item) => item.address),
    ).toContain(deliverableAddress);
    expect(
      proposal.reminder.recipients.suppressed.map((item) => item.address),
    ).toContain(suppressedAddress);
    expect(queued).toHaveLength(0);
    const draft = await testEnv.DB.prepare(
      `SELECT status, subject_template AS subject, content_json AS contentJson
         FROM communication_template_versions
        WHERE id = ? AND event_id = ?`,
    )
      .bind(proposal.reminder.template.id, admin.eventId)
      .first<{ status: string; subject: string; contentJson: string }>();
    expect(draft).toMatchObject({ status: "draft", subject });
    expect(JSON.parse(draft!.contentJson)).toMatchObject({ body });

    await expect(
      service.approveProposal(admin, proposal.id, false),
    ).rejects.toThrow("Explicit confirmation is required");
    expect(queued).toHaveLength(0);
    const revisedSubject = "Action required: {{task.title}}";
    const revisedBody =
      "Hello {{recipient.firstName}}, please finish {{task.title}} in your speaker workspace.";
    const revised = await service.reviseReminderProposal(
      admin,
      proposal.id,
      revisedSubject,
      revisedBody,
    );
    expect(revised).toMatchObject({
      toolName: "propose_reminder_send",
      title: revisedSubject,
    });
    await expect(
      service.approveProposal(admin, proposal.id, true),
    ).rejects.toThrow("replaced by an edited preview");
    expect(queued).toHaveLength(0);
    const approved = await service.approveProposal(admin, revised.id, true);
    expect(approved).toMatchObject({
      kind: "communication",
      replayed: false,
      href: expect.stringContaining("/admin/operations?operation="),
    });
    expect(queued).toHaveLength(1);
    const communication = await testEnv.DB.prepare(
      `SELECT content_snapshot_json AS contentSnapshotJson,
              recipient_count AS recipientCount, created_by_person_id AS createdBy
         FROM communications WHERE id = ? AND event_id = ?`,
    )
      .bind(approved.communicationId, admin.eventId)
      .first<{
        contentSnapshotJson: string;
        recipientCount: number;
        createdBy: string;
      }>();
    expect(JSON.parse(communication!.contentSnapshotJson)).toMatchObject({
      category: "task_reminder",
      subjectTemplate: revisedSubject,
      content: { body: revisedBody },
    });
    expect(communication?.createdBy).toBe(admin.personId);
    const deliveries = await testEnv.DB.prepare(
      `SELECT recipient_address AS address
         FROM communication_deliveries
        WHERE communication_id = ? AND event_id = ?`,
    )
      .bind(approved.communicationId, admin.eventId)
      .all<{ address: string }>();
    expect(deliveries.results.map((item) => item.address)).toContain(
      deliverableAddress,
    );
    expect(deliveries.results.map((item) => item.address)).not.toContain(
      suppressedAddress,
    );

    const replay = await service.approveProposal(admin, revised.id, true);
    expect(replay).toMatchObject({
      kind: "communication",
      communicationId: approved.communicationId,
      operationId: approved.operationId,
      replayed: true,
    });
    expect(queued).toHaveLength(1);
    const audit = await testEnv.DB.prepare(
      `SELECT actor_person_id AS actorPersonId, metadata_json AS metadataJson
         FROM audit_events
        WHERE event_id = ? AND action = 'assistant.action.executed'
          AND entity_type = 'communication' AND entity_id = ?`,
    )
      .bind(admin.eventId, approved.communicationId)
      .first<{ actorPersonId: string; metadataJson: string }>();
    expect(audit?.actorPersonId).toBe(admin.personId);
    expect(JSON.parse(audit!.metadataJson)).toMatchObject({
      proposalId: revised.id,
      toolName: "propose_reminder_send",
      result: { operationId: approved.operationId },
    });
  });

  it("previews and explicitly approves an email template draft without publishing or sending", async () => {
    const suffix = crypto.randomUUID();
    const name = `Speaker briefing ${suffix}`;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        toolResponse("propose_email_template_draft", {
          name,
          category: "ad_hoc",
          subject: "Your {{event.name}} briefing",
          body: "Hello {{recipient.firstName}}, here is your event briefing.",
          physicalAddress: "100 Programme Way, Toronto",
          buttonText: "Open event workspace",
          buttonUrl: "https://example.com/admin",
        }),
      )
      .mockResolvedValueOnce(
        textResponse(
          "I prepared an exact email template draft preview. Nothing was published, queued or sent.",
        ),
      );
    const service = new AiAssistantService(
      env as unknown as CloudflareEnvironment,
      { fetcher, providerConfiguration },
    );
    const answer = await service.ask(
      admin,
      "Prepare an email template draft and do not publish or send it.",
    );
    expect(answer.proposals[0]).toMatchObject({
      toolName: "propose_email_template_draft",
      approvalRequired: true,
    });
    const proposalId = answer.proposals[0]!.id;
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM communication_templates WHERE event_id = ? AND name = ?",
    )
      .bind(admin.eventId, name)
      .first<{ count: number }>();
    expect(before?.count).toBe(0);

    const approved = await service.approveProposal(admin, proposalId, true);
    expect(approved).toMatchObject({
      kind: "domain",
      toolName: "propose_email_template_draft",
      replayed: false,
      href: expect.stringContaining("/admin/communications?template="),
    });
    const saved = await env.DB.prepare(
      `SELECT template.status, version.status AS versionStatus,
              version.subject_template AS subject
         FROM communication_templates template
         JOIN communication_template_versions version
           ON version.template_id = template.id AND version.event_id = template.event_id
        WHERE template.id = ? AND template.event_id = ?`,
    )
      .bind(approved.entityId, admin.eventId)
      .first<{ status: string; versionStatus: string; subject: string }>();
    expect(saved).toEqual({
      status: "draft",
      versionStatus: "draft",
      subject: "Your {{event.name}} briefing",
    });
    const communicationCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM communications WHERE event_id = ?",
    )
      .bind(admin.eventId)
      .first<{ count: number }>();
    const replay = await service.approveProposal(admin, proposalId, true);
    expect(replay).toMatchObject({
      kind: "domain",
      entityId: approved.entityId,
      replayed: true,
    });
    const afterCommunicationCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM communications WHERE event_id = ?",
    )
      .bind(admin.eventId)
      .first<{ count: number }>();
    expect(afterCommunicationCount?.count).toBe(communicationCount?.count);
  });

  it("does not let an evaluator use administrator assistant tools", async () => {
    await expect(
      new AiAssistantService(env as unknown as CloudflareEnvironment, {
        fetcher: vi.fn<typeof fetch>(),
        providerConfiguration,
      }).ask(evaluator, "Show all event data."),
    ).rejects.toThrow(AiPermissionError);
  });
});

describe("contextual review assistance", () => {
  it("grounds an advisory aid in the evaluator's own assignment without changing the review", async () => {
    await ensureDemoEvaluationData(env as unknown as CloudflareEnvironment);
    const assignment = await env.DB.prepare(
      `SELECT id FROM evaluator_assignments
        WHERE event_id = ? AND evaluator_person_id = ?
        ORDER BY assigned_at LIMIT 1`,
    )
      .bind(evaluator.eventId, evaluator.personId)
      .first<{ id: string }>();
    expect(assignment).toBeTruthy();
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        textResponse(
          "Advisory summary\n\nAudience relevance: the session overview describes the target operational context.\n\nMissing evidence: no measured outcome is stated.",
        ),
      );
    const before = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM reviews WHERE event_id = ? AND assignment_id = ?",
    )
      .bind(evaluator.eventId, assignment!.id)
      .first<{ count: number }>();
    const result = await new AiAssistantService(
      env as unknown as CloudflareEnvironment,
      { fetcher, providerConfiguration },
    ).generateReviewAid(
      evaluator,
      assignment!.id,
      "Focus on missing evidence.",
    );
    expect(result).toMatchObject({
      kind: "review_aid",
      advisory: true,
      attribution: {
        provider: "OpenAI",
        model: providerConfiguration.model,
        advisory: true,
      },
    });
    expect(result.content).toContain("Missing evidence");
    expect(result.evidence.map((item) => item.id)).toEqual(
      expect.arrayContaining([expect.stringMatching(/^submission:/)]),
    );
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as {
      tools?: unknown;
      input: string;
    };
    expect(request.tools).toBeUndefined();
    expect(request.input).toContain("authorised Program Cue evidence");
    const after = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM reviews WHERE event_id = ? AND assignment_id = ?",
    )
      .bind(evaluator.eventId, assignment!.id)
      .first<{ count: number }>();
    expect(after?.count).toBe(before?.count);
  });
});

describe("contextual administrator actions", () => {
  it("summarises the authoritative readiness snapshot without exposing mutation tools", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        textResponse(
          "Recorded fact: current readiness is derived from the linked Program Cue blockers. Inference: address critical tasks before lower-impact work.",
        ),
      );
    const result = await new AiAssistantService(
      env as unknown as CloudflareEnvironment,
      { fetcher, providerConfiguration },
    ).summarizeReadiness(admin);
    expect(result.kind).toBe("readiness_summary");
    expect(result.evidence.map((item) => item.id)).toContain("event-readiness");
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as {
      tools?: unknown;
      input: string;
    };
    expect(request.tools).toBeUndefined();
    expect(request.input).toContain('"readiness"');
  });

  it("drafts a cohort reminder without exposing send tools or claiming delivery", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      textResponse(
        JSON.stringify({
          subject: "Complete your outstanding Program Cue tasks",
          body: "Please review the remaining items in your speaker dashboard. [Add deadline if applicable]",
        }),
      ),
    );
    const result = await new AiAssistantService(
      env as unknown as CloudflareEnvironment,
      { fetcher, providerConfiguration },
    ).draftReminder(
      admin,
      "incomplete_speakers",
      "Explain the outstanding work and provide a clear next step.",
    );
    expect(result).toMatchObject({
      kind: "reminder_draft",
      advisory: true,
    });
    expect(result).toMatchObject({
      content: expect.stringContaining("Subject:"),
      draft: {
        subject: "Complete your outstanding Program Cue tasks",
        body: expect.stringContaining("speaker dashboard"),
      },
    });
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as {
      tools?: unknown;
      input: string;
      instructions: string;
      text: { format?: { type: string; strict: boolean; name: string } };
    };
    expect(request.tools).toBeUndefined();
    expect(request.input).toContain('"recipientCount"');
    expect(request.instructions).toContain(
      "do not claim it was queued or sent",
    );
    expect(request.text.format).toMatchObject({
      type: "json_schema",
      strict: true,
      name: "program_cue_reminder_draft",
    });
  });

  it("explains a scoped deterministic schedule conflict without claiming an unvalidated slot", async () => {
    const suffix = crypto.randomUUID();
    const versionId = `ai-version-${suffix}`;
    const firstSessionId = `ai-session-a-${suffix}`;
    const secondSessionId = `ai-session-b-${suffix}`;
    const firstEntryId = `ai-entry-a-${suffix}`;
    const secondEntryId = `ai-entry-b-${suffix}`;
    const conflictId = `ai-conflict-${suffix}`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, status,
          visibility, created_at, updated_at
        ) VALUES (?, ?, 'AI schedule source A', ?, 'presentation', 45,
                  'scheduled', 'public', unixepoch(), unixepoch())`,
      ).bind(firstSessionId, admin.eventId, `ai-source-a-${suffix}`),
      env.DB.prepare(
        `INSERT INTO sessions (
          id, event_id, title, slug, format, duration_minutes, status,
          visibility, created_at, updated_at
        ) VALUES (?, ?, 'AI schedule source B', ?, 'presentation', 45,
                  'scheduled', 'public', unixepoch(), unixepoch())`,
      ).bind(secondSessionId, admin.eventId, `ai-source-b-${suffix}`),
      env.DB.prepare(
        `INSERT INTO schedule_versions (
          id, event_id, version_number, name, status, created_by_person_id,
          created_at
        ) VALUES (?, ?, (SELECT COALESCE(MAX(version_number), 0) + 100
                           FROM schedule_versions WHERE event_id = ?),
                  'AI conflict fixture', 'draft', ?, unixepoch())`,
      ).bind(versionId, admin.eventId, admin.eventId, admin.personId),
      env.DB.prepare(
        `INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id, starts_at,
          ends_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'main', 1747731600, 1747734300,
                  unixepoch(), unixepoch())`,
      ).bind(firstEntryId, admin.eventId, versionId, firstSessionId),
      env.DB.prepare(
        `INSERT INTO schedule_entries (
          id, event_id, schedule_version_id, session_id, room_id, starts_at,
          ends_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'main', 1747732500, 1747735200,
                  unixepoch(), unixepoch())`,
      ).bind(secondEntryId, admin.eventId, versionId, secondSessionId),
      env.DB.prepare(
        `INSERT INTO schedule_conflicts (
          id, event_id, schedule_version_id, conflict_type, severity,
          fingerprint, primary_entry_id, conflicting_entry_id, details_json,
          created_at
        ) VALUES (?, ?, ?, 'room', 'blocking', ?, ?, ?,
                  '{"room":"Main Stage","overlapMinutes":30}', unixepoch())`,
      ).bind(
        conflictId,
        admin.eventId,
        versionId,
        `ai-fingerprint-${suffix}`,
        firstEntryId,
        secondEntryId,
      ),
    ]);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        textResponse(
          "The two recorded sessions overlap in Main Stage under the blocking room-overlap policy. Validate any replacement time in the schedule planner before moving either session.",
        ),
      );
    const result = await new AiAssistantService(
      env as unknown as CloudflareEnvironment,
      { fetcher, providerConfiguration },
    ).explainScheduleConflict(admin, conflictId);
    expect(result).toMatchObject({
      kind: "schedule_conflict_explanation",
      advisory: true,
    });
    expect(result.evidence[0]).toMatchObject({
      id: `schedule-conflict:${conflictId}`,
      href: `/admin/schedule?conflict=${conflictId}`,
    });
    const request = JSON.parse(String(fetcher.mock.calls[0]![1]?.body)) as {
      tools?: unknown;
      instructions: string;
      input: string;
    };
    expect(request.tools).toBeUndefined();
    expect(request.instructions).toContain(
      "Do not claim a proposed time is conflict-free",
    );
    expect(request.input).toContain("AI schedule source A");
  });
});
