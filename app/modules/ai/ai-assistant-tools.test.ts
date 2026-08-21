import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CommunicationService } from "~/modules/communications/communication-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import {
  AiAssistantService,
  AiPermissionError,
} from "./ai-assistant-service.server";
import { AiToolPermissionError } from "./ai-tools.server";

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
      `INSERT INTO event_speaker_workflows (
         event_id, person_id, status, source, last_operation_id,
         updated_by_person_id, created_at, updated_at
       ) VALUES (?, ?, 'confirmed', 'manual', ?, ?, unixepoch(), unixepoch())`,
    ).bind(
      admin.eventId,
      deliverablePersonId,
      `ai-reminder-workflow-deliverable-${suffix}`,
      admin.personId,
    ),
    env.DB.prepare(
      `INSERT INTO event_speaker_workflows (
         event_id, person_id, status, source, last_operation_id,
         updated_by_person_id, created_at, updated_at
       ) VALUES (?, ?, 'confirmed', 'manual', ?, ?, unixepoch(), unixepoch())`,
    ).bind(
      admin.eventId,
      suppressedPersonId,
      `ai-reminder-workflow-suppressed-${suffix}`,
      admin.personId,
    ),
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

  it("rejects an unresolved placeholder in an agent reminder draft", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      toolResponse("draft_reminder", {
        cohort: "incomplete_speakers",
        subject: "Complete your speaker tasks",
        body: "Please finish the outstanding work by [insert deadline].",
      }),
    );

    await expect(
      new AiAssistantService(env as unknown as CloudflareEnvironment, {
        fetcher,
        providerConfiguration,
      }).ask(admin, "Draft an incomplete-speaker reminder."),
    ).rejects.toThrow(
      'Body contains unresolved template token "[insert deadline]"',
    );
  });

  it("rejects a merge field that is unsupported for the reminder cohort", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      toolResponse("draft_reminder", {
        cohort: "reviewers_with_open_assignments",
        subject: "Complete your assigned reviews",
        body: "Please complete {{task.title}} before the review window closes.",
      }),
    );

    await expect(
      new AiAssistantService(env as unknown as CloudflareEnvironment, {
        fetcher,
        providerConfiguration,
      }).ask(admin, "Draft a reviewer reminder."),
    ).rejects.toThrow(
      'Body contains unresolved template token "{{task.title}}"',
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
    const versionCountBeforeUnsafeEdit = await testEnv.DB.prepare(
      `SELECT COUNT(*) AS count
         FROM communication_template_versions
        WHERE event_id = ? AND template_id = ?`,
    )
      .bind(admin.eventId, proposal.reminder.template.templateId)
      .first<{ count: number }>();
    await expect(
      service.reviseReminderProposal(
        admin,
        proposal.id,
        "Action required: {{task.title}}",
        "Please finish {{task.title}} by [insert deadline].",
      ),
    ).rejects.toThrow(
      'Body contains unresolved template token "[insert deadline]"',
    );
    await expect(
      testEnv.DB.prepare(
        `SELECT COUNT(*) AS count
           FROM communication_template_versions
          WHERE event_id = ? AND template_id = ?`,
      )
        .bind(admin.eventId, proposal.reminder.template.templateId)
        .first<{ count: number }>(),
    ).resolves.toEqual(versionCountBeforeUnsafeEdit);
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

  it("rejects an unsafe reminder proposal before saving its draft version", async () => {
    const { testEnv, baseTemplateVersionId } = await reminderEnvironment();
    const versionsBefore = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS count FROM communication_template_versions WHERE event_id = ?",
    )
      .bind(admin.eventId)
      .first<{ count: number }>();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      toolResponse("propose_reminder_send", {
        baseTemplateVersionId,
        audienceType: "incomplete_speakers",
        kind: "optional",
        subject: "Please complete {{task.title}}",
        body: "Please complete {{task.title}}. [Add deadline if applicable]",
      }),
    );

    await expect(
      new AiAssistantService(testEnv, {
        fetcher,
        providerConfiguration,
      }).ask(admin, "Prepare an incomplete-speaker reminder preview."),
    ).rejects.toThrow(
      'Body contains unresolved template token "[Add deadline if applicable]"',
    );
    await expect(
      testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM communication_template_versions WHERE event_id = ?",
      )
        .bind(admin.eventId)
        .first<{ count: number }>(),
    ).resolves.toEqual(versionsBefore);
  });

  it("rejects unresolved static fields before persisting an email template proposal", async () => {
    const proposalsBefore = await env.DB.prepare(
      `SELECT COUNT(*) AS count FROM audit_events
        WHERE event_id = ? AND actor_person_id = ?
          AND action = 'assistant.proposal.previewed'`,
    )
      .bind(admin.eventId, admin.personId)
      .first<{ count: number }>();
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      toolResponse("propose_email_template_draft", {
        name: `Unsafe footer ${crypto.randomUUID()}`,
        category: "ad_hoc",
        subject: "Event briefing",
        body: "The event briefing is ready.",
        physicalAddress: "{{event.name}} offices",
        buttonText: null,
        buttonUrl: null,
      }),
    );

    await expect(
      new AiAssistantService(env as unknown as CloudflareEnvironment, {
        fetcher,
        providerConfiguration,
      }).ask(admin, "Prepare an email template draft."),
    ).rejects.toThrow(
      'Physical address contains unresolved template token "{{event.name}}"',
    );
    await expect(
      env.DB.prepare(
        `SELECT COUNT(*) AS count FROM audit_events
          WHERE event_id = ? AND actor_person_id = ?
            AND action = 'assistant.proposal.previewed'`,
      )
        .bind(admin.eventId, admin.personId)
        .first<{ count: number }>(),
    ).resolves.toEqual(proposalsBefore);
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

    const storedProposal = await env.DB.prepare(
      `SELECT id, metadata_json AS metadataJson
         FROM audit_events
        WHERE event_id = ? AND actor_person_id = ?
          AND action = 'assistant.proposal.previewed'
          AND entity_type = 'assistant_proposal' AND entity_id = ?
        ORDER BY created_at DESC, id DESC LIMIT 1`,
    )
      .bind(admin.eventId, admin.personId, proposalId)
      .first<{ id: string; metadataJson: string }>();
    const unsafeMetadata = JSON.parse(storedProposal!.metadataJson) as {
      snapshot: { content: { body: string } };
    };
    unsafeMetadata.snapshot.content.body =
      "Contact [Administrator name/email] for details.";
    await env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id,
         actor_person_id, actor_id, action, entity_type, entity_id,
         correlation_id, metadata_json, created_at
       )
       SELECT ?, actor_kind, origin, metadata_version, organisation_id,
              event_id, actor_person_id, actor_id, action, entity_type,
              entity_id, correlation_id, ?, created_at + 1
         FROM audit_events WHERE id = ? AND event_id = ?`,
    )
      .bind(
        crypto.randomUUID(),
        JSON.stringify(unsafeMetadata),
        storedProposal!.id,
        admin.eventId,
      )
      .run();
    await expect(
      service.approveProposal(admin, proposalId, true),
    ).rejects.toThrow(
      'Body contains unresolved template token "[Administrator name/email]"',
    );
    await expect(
      env.DB.prepare(
        "SELECT COUNT(*) AS count FROM communication_templates WHERE event_id = ? AND name = ?",
      )
        .bind(admin.eventId, name)
        .first<{ count: number }>(),
    ).resolves.toEqual(before);
    await env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id,
         actor_person_id, actor_id, action, entity_type, entity_id,
         correlation_id, metadata_json, created_at
       )
       SELECT ?, actor_kind, origin, metadata_version, organisation_id,
              event_id, actor_person_id, actor_id, action, entity_type,
              entity_id, correlation_id, metadata_json, created_at + 2
         FROM audit_events WHERE id = ? AND event_id = ?`,
    )
      .bind(crypto.randomUUID(), storedProposal!.id, admin.eventId)
      .run();

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
