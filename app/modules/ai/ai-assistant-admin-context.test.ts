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
      max_output_tokens: number;
    };
    expect(request.tools).toBeUndefined();
    expect(request.input).toContain('"readiness"');
    expect(request.max_output_tokens).toBe(4_000);
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
