import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { OperationService } from "~/platform/operations/operation-service.server";
import { AiAssistantService } from "./ai-assistant-service.server";
import {
  AI_PROVIDER_RESPONSE_MAX_BYTES,
  OpenAiResponsesProvider,
} from "./openai-responses-provider.server";

const admin: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
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
    status: "completed",
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
    status: "completed",
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
      `SELECT action, actor_kind AS actorKind, origin,
              actor_person_id AS actorPersonId, actor_id AS actorId
         FROM audit_events
        WHERE event_id = ? AND entity_id = ? ORDER BY created_at, id`,
    )
      .bind(admin.eventId, result.runId)
      .all<{
        action: string;
        actorKind: string;
        origin: string;
        actorPersonId: string | null;
        actorId: string | null;
      }>();
    expect(audit.results.map((row) => row.action)).toEqual(
      expect.arrayContaining([
        "assistant.requested",
        "assistant.tool.completed",
        "assistant.completed",
      ]),
    );
    expect(
      audit.results.find((row) => row.action === "assistant.requested"),
    ).toMatchObject({
      actorKind: "person",
      origin: "admin_ui",
      actorPersonId: admin.personId,
      actorId: null,
    });
    for (const action of ["assistant.tool.completed", "assistant.completed"]) {
      expect(audit.results.find((row) => row.action === action)).toMatchObject({
        actorKind: "agent",
        origin: "admin_ui",
        actorPersonId: admin.personId,
        actorId: "program_cue_agent",
      });
    }
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

  it("rejects an incomplete non-streaming Responses result", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      providerJson({
        id: "resp-incomplete-test",
        model: providerConfiguration.model,
        status: "incomplete",
        incomplete_details: { reason: "max_output_tokens" },
        output: [],
      }),
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
      name: "AiProviderError",
      providerRequestId: "openai-request-test",
      message:
        "OpenAI response status was incomplete (max_output_tokens); no result was accepted.",
    });
  });

  it("retains the provider detail from a failed Responses result", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      providerJson({
        id: "resp-failed-test",
        model: providerConfiguration.model,
        status: "failed",
        error: { message: "Model execution failed before completion." },
        output: [],
      }),
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
      name: "AiProviderError",
      providerRequestId: "openai-request-test",
      message:
        "OpenAI response status was failed (Model execution failed before completion.); no result was accepted.",
    });
  });

  it("consumes Responses API text deltas and still validates the completed response", async () => {
    const completed = {
      id: "resp-stream-test",
      model: providerConfiguration.model,
      status: "completed",
      output: [
        {
          type: "message",
          content: [
            { type: "output_text", text: "Grounded answer", annotations: [] },
          ],
        },
      ],
    };
    const providerResponse = new Response(
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
    );
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(providerResponse);
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
    expect(providerResponse.body?.locked).toBe(false);
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
      stream: true,
      store: false,
    });
  });

  it("cancels and unlocks a rejected Responses API stream", async () => {
    let cancellationReason: unknown = null;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("data: not-json\n\n"));
      },
      cancel(reason) {
        cancellationReason = reason;
      },
    });
    const provider = new OpenAiResponsesProvider(
      providerConfiguration,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    await expect(
      provider.create({
        instructions: "Return a result.",
        input: "Hello",
        safetyIdentifier: "pc_stream_rejection_test",
        onTextDelta: () => {},
      }),
    ).rejects.toThrow("OpenAI returned an invalid streaming event.");
    expect(cancellationReason).toBe("AI provider stream rejected");
    expect(body.locked).toBe(false);
  });

  it("cancels a Responses API stream rejected by its declared size", async () => {
    let cancellationReason: unknown = null;
    const body = new ReadableStream<Uint8Array>({
      cancel(reason) {
        cancellationReason = reason;
      },
    });
    const provider = new OpenAiResponsesProvider(
      providerConfiguration,
      vi.fn<typeof fetch>().mockResolvedValue(
        new Response(body, {
          headers: {
            "content-length": String(AI_PROVIDER_RESPONSE_MAX_BYTES + 1),
            "content-type": "text/event-stream",
          },
        }),
      ),
    );

    await expect(
      provider.create({
        instructions: "Return a result.",
        input: "Hello",
        safetyIdentifier: "pc_stream_size_test",
        onTextDelta: () => {},
      }),
    ).rejects.toThrow("OpenAI returned an oversized streaming response.");
    expect(cancellationReason).toBe("AI provider response body limit exceeded");
    expect(body.locked).toBe(false);
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
      failureKind: "transient",
      message: "The OpenAI request could not reach the provider.",
    });
  });
});
