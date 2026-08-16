import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { AiAssistantService } from "./ai-assistant-service.server";
import { ensureDemoEvaluationData } from "~/modules/evaluations/demo.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";

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
