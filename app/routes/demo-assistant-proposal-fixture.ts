import {
  data,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import {
  assistantProposalMetadataSchema,
  prepareReminderSendProposal,
} from "~/modules/ai/ai-tools.server";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import { requireEmailProviderConfiguration } from "~/modules/communications/email-provider.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { DEMO_ASSISTANT_FIXTURE_MODEL } from "~/platform/demo/demo-identities";
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

function requireDemo(env: CloudflareEnvironment) {
  if (String(env.DEMO_MODE) !== "true") {
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
        `INSERT INTO task_instances (
          id, event_id, target_type, target_id, owner_person_id, title,
          task_type, impact, status, readiness_state, created_at, updated_at
        ) VALUES (?, ?, 'speaker', ?, ?, 'Upload final slides', 'file_upload',
                  'high', 'not_started', 'at_risk', unixepoch(), unixepoch())`,
      ).bind(
        `demo-ai-reminder-task-deliverable-${suffix}`,
        EVENT_ID,
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
    const prepared = await prepareReminderSendProposal(env, DEMO_ADMIN, {
      runId: crypto.randomUUID(),
      model: DEMO_ASSISTANT_FIXTURE_MODEL,
      arguments: {
        baseTemplateVersionId: base.versionId,
        audienceType: "incomplete_speakers",
        kind: "optional",
        subject: REMINDER_SUBJECT,
        body: "Hello {{recipient.firstName}}, please complete {{task.title}} in your speaker workspace.",
      },
    });
    return data(
      {
        ok: true,
        demonstrationOnly: true,
        providerCalled: false,
        proposalId: prepared.preview.id,
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
      id, organisation_id, event_id, actor_person_id, action,
      entity_type, entity_id, correlation_id, metadata_json, created_at
    ) VALUES (?, ?, ?, ?, 'assistant.proposal.previewed',
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
      taskTitle: TASK_TITLE,
      assistantPath: "/admin/assistant",
    },
    { headers: { "cache-control": "private, no-store" } },
  );
}
