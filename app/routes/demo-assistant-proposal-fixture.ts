import {
  type ActionFunctionArgs,
  data,
  type LoaderFunctionArgs,
} from "react-router";
import { AiAssistantService } from "~/modules/ai/ai-assistant-service.server";
import { AiProviderSettingsService } from "~/modules/ai/ai-provider.server";
import { assistantProposalMetadataSchema } from "~/modules/ai/ai-tools.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { requireEmailProviderConfiguration } from "~/modules/communications/email-provider.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  type ReadinessFixtureScenario,
  runDemonstrationReadinessScenario,
  seedReadinessAcceptanceEvent,
} from "~/platform/demo/assistant-readiness-fixture.server";
import {
  DEMO_ASSISTANT_FIXTURE_MODEL,
  DEMO_IDENTITIES,
} from "~/platform/demo/demo-identities";
import { ensureDemoData } from "~/platform/demo/seed.server";

const EVENT_ID = "evt-foe-2025";
const ORGANISATION_ID = "org-future-events";
const ADMIN_ID = "person-demo-admin";
const CONFIRMATION = "seed-assistant-approval-browser-fixture";
const TASK_TITLE = "Confirm venue accessibility handoff";
const REMINDER_SUBJECT = "Complete {{task.title}} before event handoff";
const DEMO_ADMIN: Viewer = {
  personId: ADMIN_ID,
  name: "Jordan Alvarez",
  email: "sbek-organizer@example.com",
  role: "administrator",
  organisationId: ORGANISATION_ID,
  eventId: EVENT_ID,
  demo: true,
};
const DEMO_OWNER: Viewer = {
  personId: DEMO_IDENTITIES.owner.personId,
  name: DEMO_IDENTITIES.owner.name,
  email: DEMO_IDENTITIES.owner.email,
  role: "owner",
  organisationId: ORGANISATION_ID,
  eventId: EVENT_ID,
  demo: true,
};

function requireDemo(env: CloudflareEnvironment) {
  if (String(env.DEMO_MODE) !== "true") {
    throw new Response("Not found", { status: 404 });
  }
}

function requireE2eFixtures(env: CloudflareEnvironment) {
  if (
    (
      env as CloudflareEnvironment & {
        PROGRAM_CUE_E2E_FIXTURES?: string;
      }
    ).PROGRAM_CUE_E2E_FIXTURES !== "true"
  ) {
    throw new Response("Not found", { status: 404 });
  }
}

export function loader({ context }: LoaderFunctionArgs) {
  const { env } = getCloudflareContext(context);
  requireDemo(env);
  return data(
    { ok: false, error: "The assistant demo fixture requires POST." },
    {
      status: 405,
      headers: { allow: "POST", "cache-control": "private, no-store" },
    },
  );
}

export async function action({ request, context }: ActionFunctionArgs) {
  const { env } = getCloudflareContext(context);
  requireDemo(env);
  if (request.method !== "POST") {
    return data(
      { ok: false, error: "The assistant demo fixture requires POST." },
      {
        status: 405,
        headers: { allow: "POST", "cache-control": "private, no-store" },
      },
    );
  }
  const form = await request.formData();
  if (form.get("confirm") !== CONFIRMATION) {
    throw new Response("Explicit demo fixture confirmation is required", {
      status: 400,
    });
  }
  if (
    form.get("intent") === "seed_readiness_event" ||
    form.get("intent") === "run_readiness_workflow" ||
    form.get("intent") === "interrupt_task_settlement"
  ) {
    requireE2eFixtures(env);
    await ensureDemoData(env);
    const scenario = String(form.get("scenario"));
    if (
      ![
        "success",
        "insufficient_information",
        "no_blockers",
        "delivery_failures",
        "provider_failure",
        "stale_before_approval",
      ].includes(scenario)
    )
      throw new Response("Unknown readiness scenario", { status: 400 });
    if (form.get("intent") === "seed_readiness_event") {
      const fixture = await seedReadinessAcceptanceEvent(
        env,
        DEMO_ADMIN,
        scenario as ReadinessFixtureScenario,
      );
      return data(
        {
          demonstrationOnly: true,
          providerCalled: false,
          ...fixture,
          result: null,
          error: null,
        },
        { headers: { "cache-control": "private, no-store" } },
      );
    }
    const eventId = form.get("eventId");
    const prompt = form.get("prompt");
    if (typeof eventId !== "string" || typeof prompt !== "string")
      throw new Response("A fixture event and original request are required", {
        status: 400,
      });
    const existing = await env.DB.prepare(
      `SELECT event.id, conflict.id AS conflictId FROM events event LEFT JOIN schedule_conflicts conflict ON conflict.event_id = event.id WHERE event.id = ? AND event.organisation_id = ? AND event.id LIKE 'assistant-acceptance-%' AND event.slug = event.id AND event.name = 'Assistant acceptance event' AND EXISTS (SELECT 1 FROM memberships membership WHERE membership.event_id = event.id AND membership.organisation_id = event.organisation_id AND membership.person_id = ? AND membership.role = 'administrator' AND membership.accepted_at IS NOT NULL AND membership.revoked_at IS NULL) ORDER BY conflict.id LIMIT 1`,
    )
      .bind(eventId, ORGANISATION_ID, ADMIN_ID)
      .first<{ id: string; conflictId: string | null }>();
    if (
      !existing ||
      (!["no_blockers", "delivery_failures"].includes(scenario) &&
        !existing.conflictId)
    )
      throw new Response("The isolated assistant fixture is unavailable", {
        status: 409,
      });
    if (form.get("intent") === "interrupt_task_settlement") {
      if (form.get("confirmed") !== "yes")
        throw new Response("Explicit fixture task approval is required", {
          status: 400,
        });
      const message = "Explicitly injected interruption after task creation";
      try {
        await new AiAssistantService(env, {
          beforeProposalExecutionCommit: () => {
            throw new Error(message);
          },
        }).approveProposal(
          { ...DEMO_ADMIN, eventId },
          form.get("proposalId"),
          true,
        );
      } catch (error) {
        if (!(error instanceof Error) || error.message !== message) throw error;
        return data(
          { demonstrationOnly: true, providerCalled: false, error: message },
          { status: 500 },
        );
      }
      throw new Error(
        "Expected the fixture to interrupt task result settlement",
      );
    }
    const fixture = await runDemonstrationReadinessScenario(
      env,
      DEMO_ADMIN,
      scenario as ReadinessFixtureScenario,
      prompt,
      {
        viewer: { ...DEMO_ADMIN, eventId },
        eventId,
        conflictId: existing.conflictId,
      },
    );
    return data(fixture, { headers: { "cache-control": "private, no-store" } });
  }
  if (form.get("intent") === "configure_stream_test") {
    requireE2eFixtures(env);
    await ensureDemoData(env);
    const enabled = form.get("enabled") === "yes";
    const settings = new AiProviderSettingsService(env);
    const current = await settings.getSelection(ORGANISATION_ID);
    const selection = await settings.save(DEMO_OWNER, {
      provider: enabled ? "anthropic" : "openai",
      model: enabled ? "claude-sonnet-4-6" : "gpt-5.6-terra",
      revision: current?.revision ?? 0,
    });
    return data(
      {
        ok: true,
        demonstrationOnly: true,
        providerCalled: false,
        selection,
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }
  if (form.get("intent") === "seed_reminder") {
    await ensureDemoData(env);
    const emailProvider = requireEmailProviderConfiguration(env).provider;
    const suffix = crypto.randomUUID();
    const deliverablePersonId = `demo-ai-reminder-deliverable-${suffix}`;
    const suppressedPersonId = `demo-ai-reminder-suppressed-${suffix}`;
    const deliverableAddress = `deliverable-${suffix}@example.com`;
    const suppressedAddress = `suppressed-${suffix}@example.com`;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO sender_profiles (
          id, event_id, name, from_name, from_email, reply_to_email,
          provider, status, created_at, updated_at
        ) VALUES (?, ?, ?,
                  'Program Cue Demo', 'demo-sender@example.invalid',
                  'demo-reply@example.invalid', ?, 'verified',
                  unixepoch(), unixepoch())`,
      ).bind(
        `sender-demo-ai-reminder-${emailProvider}`,
        EVENT_ID,
        `Demo AI reminder sender (${emailProvider})`,
        emailProvider,
      ),
      env.DB.prepare(
        `INSERT INTO people (
          id, email, display_name, email_verified, profile_status,
          created_at, updated_at
        ) VALUES (?, ?, 'E2E deliverable speaker', 1, 'published',
                  unixepoch(), unixepoch())`,
      ).bind(deliverablePersonId, deliverableAddress),
      env.DB.prepare(
        `INSERT INTO people (
          id, email, display_name, email_verified, profile_status,
          created_at, updated_at
        ) VALUES (?, ?, 'E2E suppressed speaker', 1, 'published',
                  unixepoch(), unixepoch())`,
      ).bind(suppressedPersonId, suppressedAddress),
      env.DB.prepare(
        `INSERT INTO event_speaker_workflows (
           event_id, person_id, status, source, last_operation_id,
           updated_by_person_id, created_at, updated_at
         ) VALUES (?, ?, 'confirmed', 'manual', ?, ?, unixepoch(), unixepoch())`,
      ).bind(
        EVENT_ID,
        deliverablePersonId,
        `demo-ai-reminder-workflow-deliverable-${suffix}`,
        ADMIN_ID,
      ),
      env.DB.prepare(
        `INSERT INTO event_speaker_workflows (
           event_id, person_id, status, source, last_operation_id,
           updated_by_person_id, created_at, updated_at
         ) VALUES (?, ?, 'confirmed', 'manual', ?, ?, unixepoch(), unixepoch())`,
      ).bind(
        EVENT_ID,
        suppressedPersonId,
        `demo-ai-reminder-workflow-suppressed-${suffix}`,
        ADMIN_ID,
      ),
      env.DB.prepare(
        `INSERT INTO task_instances (
          id, event_id, target_type, target_id, owner_person_id, title,
          task_type, impact, evidence_mode, configuration_json, status,
          readiness_state, created_at, updated_at
        ) VALUES (?, ?, 'speaker', ?, ?, 'Upload signed participant agreement', 'file_upload',
                  'high', 'file', '{"fileScope":"participant_document"}', 'not_started', 'at_risk',
                  unixepoch(), unixepoch())`,
      ).bind(
        `demo-ai-reminder-task-deliverable-${suffix}`,
        EVENT_ID,
        deliverablePersonId,
        deliverablePersonId,
      ),
      env.DB.prepare(
        `INSERT INTO task_instances (
          id, event_id, target_type, target_id, owner_person_id, title,
          task_type, impact, evidence_mode, configuration_json, status,
          readiness_state, created_at, updated_at
        ) VALUES (?, ?, 'speaker', ?, ?, 'Confirm biography', 'short_form',
                  'medium', 'text', '{}', 'not_started', 'at_risk',
                  unixepoch(), unixepoch())`,
      ).bind(
        `demo-ai-reminder-task-suppressed-${suffix}`,
        EVENT_ID,
        suppressedPersonId,
        suppressedPersonId,
      ),
      env.DB.prepare(
        `INSERT INTO communication_unsubscribes (
          id, event_id, person_id, address, category, reason, created_at
        ) VALUES (?, ?, ?, ?, 'task_reminder', 'demo optional suppression',
                  unixepoch())`,
      ).bind(
        `demo-ai-reminder-unsubscribe-${suffix}`,
        EVENT_ID,
        suppressedPersonId,
        suppressedAddress,
      ),
    ]);
    const communications = new CommunicationService(env);
    const base = await communications.saveTemplate(DEMO_ADMIN, {
      name: `Demo approved reminder foundation ${suffix}`,
      category: "task_reminder",
      subject: "Outstanding event task: {{task.title}}",
      content: {
        body: "Hello {{recipient.firstName}}, please complete {{task.title}}.",
        physicalAddress: "100 Programme Way, Toronto",
        buttonText: "Open speaker workspace",
        buttonUrl: "https://example.com/speaker",
      },
    });
    await communications.publishTemplate(DEMO_ADMIN, base.versionId);
    const requestLabel =
      "Prepare an exact incomplete-speaker reminder preview. Do not send it.";
    let modelCall = 0;
    const prepared = await new AiAssistantService(env, {
      providerConfiguration: {
        apiKey: "explicit-demo-reminder-key-not-a-provider-credential",
        model: DEMO_ASSISTANT_FIXTURE_MODEL,
      },
      // Explicit simulated model; the normal assistant loop retains the request.
      fetcher: async () =>
        Response.json({
          id: crypto.randomUUID(),
          model: DEMO_ASSISTANT_FIXTURE_MODEL,
          status: "completed",
          output:
            modelCall++ === 0
              ? [
                  {
                    type: "function_call",
                    call_id: crypto.randomUUID(),
                    name: "propose_reminder_send",
                    arguments: JSON.stringify({
                      baseTemplateVersionId: base.versionId,
                      audienceType: "incomplete_speakers",
                      kind: "optional",
                      subject: REMINDER_SUBJECT,
                      body: "Hello {{recipient.firstName}}, please complete {{task.title}} in your speaker workspace.",
                    }),
                  },
                ]
              : [
                  {
                    type: "message",
                    role: "assistant",
                    content: [
                      {
                        type: "output_text",
                        text: "The exact reminder preview is ready for review. Nothing has been queued or sent.",
                      },
                    ],
                  },
                ],
        }),
    }).ask(DEMO_ADMIN, requestLabel);
    const proposal = prepared.proposals[0];
    if (proposal?.toolName !== "propose_reminder_send")
      throw new Error("The simulated reminder fixture did not save a preview.");
    return data(
      {
        ok: true,
        demonstrationOnly: true,
        providerCalled: false,
        proposalId: proposal.id,
        runId: prepared.runId,
        requestLabel,
        subject: REMINDER_SUBJECT,
        deliverableAddress,
        suppressedAddress,
        assistantPath: "/admin/assistant",
      },
      { headers: { "cache-control": "private, no-store" } },
    );
  }
  if (form.get("intent") !== "seed") {
    throw new Response("Unsupported demo fixture action", { status: 400 });
  }
  await ensureDemoData(env);
  const proposalId = crypto.randomUUID();
  const runId = crypto.randomUUID();
  const preview = {
    id: proposalId,
    toolName: "propose_task" as const,
    title: TASK_TITLE,
    summary:
      "Create one high administrator only task for Future of Events 2027.",
    consequence:
      "Approval creates one durable task in this event. It does not send a message, publish data or create additional tasks.",
    changes: [
      { field: "Task", before: null, after: TASK_TITLE },
      {
        field: "Target",
        before: null,
        after: "event: Future of Events 2027",
      },
      { field: "Impact", before: null, after: "high" },
      { field: "Due date", before: null, after: "No due date" },
    ],
    approvalRequired: true as const,
  };
  const metadata = assistantProposalMetadataSchema.parse({
    version: 1,
    toolName: "propose_task",
    runId,
    model: DEMO_ASSISTANT_FIXTURE_MODEL,
    arguments: {
      title: TASK_TITLE,
      description:
        "Confirm the documented accessibility handoff with the venue team.",
      targetType: "event",
      targetId: EVENT_ID,
      ownerPersonId: null,
      taskType: "administrator_only",
      impact: "high",
      dueAt: null,
      dependencyIds: [],
    },
    preview,
  });
  await env.DB.prepare(
    `INSERT INTO audit_events (
      id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
      entity_type, entity_id, correlation_id, metadata_json, created_at
    ) VALUES (?, 'person', 'internal', 1, ?, ?, ?, 'assistant.proposal.previewed',
              'assistant_proposal', ?, ?, ?, unixepoch())`,
  )
    .bind(
      crypto.randomUUID(),
      ORGANISATION_ID,
      EVENT_ID,
      ADMIN_ID,
      proposalId,
      runId,
      JSON.stringify(metadata),
    )
    .run();
  return data(
    {
      ok: true,
      demonstrationOnly: true,
      providerCalled: false,
      proposalId,
      preview,
      runId,
      taskTitle: TASK_TITLE,
      assistantPath: "/admin/assistant",
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
