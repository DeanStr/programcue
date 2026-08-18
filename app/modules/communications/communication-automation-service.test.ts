import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ensureDemoData } from "~/platform/demo/seed.server";
import { CommunicationAutomationService } from "./communication-automation-service.server";
import { CommunicationService } from "./communication-service.server";

const viewer: Viewer = {
  personId: "person-demo-admin",
  name: "Olivia Bennett",
  email: "olivia@example.com",
  role: "administrator",
  organisationId: "org-future-events",
  eventId: "evt-foe-2025",
  demo: true,
};

afterEach(() => vi.restoreAllMocks());

async function environment() {
  const queued: unknown[] = [];
  const testEnv = {
    ...(env as unknown as CloudflareEnvironment),
    SOURCE_REVISION: "test-revision",
    DB: env.DB,
    RESEND_API_KEY: "automation-test-key",
    OPERATIONS_QUEUE: {
      send: async (message: unknown) => {
        queued.push(message);
      },
    },
  } as unknown as CloudflareEnvironment;
  await ensureDemoData(testEnv);
  await env.DB.prepare(
    `INSERT OR IGNORE INTO sender_profiles (
       id, event_id, name, from_name, from_email, provider, status,
       created_at, updated_at
     ) VALUES ('sender-automation-tests', ?, 'Automation sender',
               'Program Cue', 'automation@example.com', 'resend', 'verified',
               unixepoch(), unixepoch())`,
  )
    .bind(viewer.eventId)
    .run();
  return { testEnv, queued };
}

async function publishedTemplate(
  service: CommunicationService,
  category: "ad_hoc" | "task_reminder",
  body = "Hello {{recipient.firstName}}",
) {
  const saved = await service.saveTemplate(viewer, {
    name: `${category}-${crypto.randomUUID()}`,
    category,
    subject: "Update from {{event.name}}",
    content: {
      body,
      physicalAddress: "100 Programme Way",
    },
  });
  await service.publishTemplate(viewer, saved.versionId);
  return saved;
}

describe("communication scheduling and reminder automation", () => {
  it("queues a real test send with representative source merge data", async () => {
    const { testEnv, queued } = await environment();
    const service = new CommunicationService(testEnv);
    const template = await publishedTemplate(
      service,
      "task_reminder",
      "Test reminder for {{task.title}} and {{recipient.firstName}}.",
    );

    const result = await service.testSend(viewer, {
      templateVersionId: template.versionId,
      recipient: "test-recipient@example.com",
      idempotencyKey: `test-send-${crypto.randomUUID()}`,
    });

    expect(result).toMatchObject({ status: "queued", duplicate: false });
    expect(queued).toHaveLength(1);
    const stored = await testEnv.DB.prepare(
      `SELECT communication.audience_json AS audienceJson,
              delivery.source_values_json AS sourceValuesJson
         FROM communications communication
         JOIN communication_deliveries delivery
           ON delivery.communication_id = communication.id
        WHERE communication.id = ?`,
    )
      .bind(result.communicationId)
      .first<{ audienceJson: string; sourceValuesJson: string }>();
    expect(JSON.parse(stored!.audienceJson)).toMatchObject({ test: true });
    expect(JSON.parse(stored!.sourceValuesJson)).toMatchObject({
      "task.title": "Upload final presentation",
    });
  });

  it("persists a scheduled send without queueing before its due instant", async () => {
    const { testEnv, queued } = await environment();
    const service = new CommunicationService(testEnv);
    const automation = new CommunicationAutomationService(testEnv);
    const template = await publishedTemplate(service, "ad_hoc");
    const now = Math.floor(Date.now() / 1_000);
    const preview = await service.preview(viewer, {
      templateVersionId: template.versionId,
      audienceType: "manual",
      manualRecipients: "Scheduled Person <scheduled@example.com>",
      kind: "transactional",
    });

    const scheduled = await service.schedule(viewer, {
      templateVersionId: template.versionId,
      audienceType: "manual",
      manualRecipients: "Scheduled Person <scheduled@example.com>",
      kind: "transactional",
      idempotencyKey: `scheduled-${crypto.randomUUID()}`,
      scheduledAt: now + 120,
      ...preview.confirmation,
    });

    expect(scheduled).toMatchObject({
      status: "scheduled",
      operationId: null,
      duplicate: false,
    });
    expect(queued).toHaveLength(0);
    await expect(automation.dispatchDueScheduled(now + 119)).resolves.toEqual({
      queued: 0,
      queueFailed: 0,
    });
    await expect(automation.dispatchDueScheduled(now + 120)).resolves.toEqual({
      queued: 1,
      queueFailed: 0,
    });
    expect(queued).toHaveLength(1);
    await expect(
      testEnv.DB.prepare(
        `SELECT communication.status, communication.operation_id AS operationId,
                operation.status AS operationStatus
           FROM communications communication
           JOIN operation_jobs operation ON operation.id = communication.operation_id
          WHERE communication.id = ?`,
      )
        .bind(scheduled.communicationId)
        .first(),
    ).resolves.toMatchObject({
      status: "queued",
      operationStatus: "queued",
    });
    await expect(automation.dispatchDueScheduled(now + 120)).resolves.toEqual({
      queued: 0,
      queueFailed: 0,
    });
  });

  it("rejects a scheduled send before durable intent when Queue is unbound", async () => {
    const { testEnv } = await environment();
    const missingQueueEnv = {
      ...testEnv,
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment;
    const service = new CommunicationService(missingQueueEnv);
    const template = await publishedTemplate(service, "ad_hoc");
    const now = Math.floor(Date.now() / 1_000);
    const idempotencyKey = `scheduled-unbound-${crypto.randomUUID()}`;
    const preview = await service.preview(viewer, {
      templateVersionId: template.versionId,
      audienceType: "manual",
      manualRecipients: "unbound-schedule@example.com",
      kind: "transactional",
    });

    await expect(
      service.schedule(viewer, {
        templateVersionId: template.versionId,
        audienceType: "manual",
        manualRecipients: "unbound-schedule@example.com",
        kind: "transactional",
        idempotencyKey,
        scheduledAt: now + 120,
        ...preview.confirmation,
      }),
    ).rejects.toThrow(/OPERATIONS_QUEUE/);
    await expect(
      testEnv.DB.prepare(
        "SELECT COUNT(*) AS count FROM communications WHERE event_id = ? AND idempotency_key = ?",
      )
        .bind(viewer.eventId, idempotencyKey)
        .first(),
    ).resolves.toEqual({ count: 0 });
  });

  it("records Queue failure durably when a due scheduled send cannot dispatch", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { testEnv } = await environment();
    const service = new CommunicationService(testEnv);
    const now = Math.floor(Date.now() / 1_000);
    const template = await publishedTemplate(service, "ad_hoc");
    const preview = await service.preview(viewer, {
      templateVersionId: template.versionId,
      audienceType: "manual",
      manualRecipients: "failed-schedule@example.com",
      kind: "transactional",
    });
    const scheduled = await service.schedule(viewer, {
      templateVersionId: template.versionId,
      audienceType: "manual",
      manualRecipients: "failed-schedule@example.com",
      kind: "transactional",
      idempotencyKey: `scheduled-failure-${crypto.randomUUID()}`,
      scheduledAt: now + 120,
      ...preview.confirmation,
    });
    testEnv.OPERATIONS_QUEUE = {
      send: async () => {
        throw new Error("queue transport unavailable");
      },
    } as unknown as Queue;

    await expect(
      new CommunicationAutomationService(testEnv).dispatchDueScheduled(
        now + 120,
      ),
    ).resolves.toEqual({ queued: 0, queueFailed: 1 });
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toMatchObject({
      subsystem: "communication-scheduler",
      event: "queue-dispatch-failed",
      sourceRevision: "test-revision",
      eventId: viewer.eventId,
      provider: "cloudflare-queue",
      message: "The scheduled communication operation could not be queued.",
    });
    expect(JSON.stringify(log.mock.calls)).not.toContain(
      "queue transport unavailable",
    );
    await expect(
      testEnv.DB.prepare(
        `SELECT communication.status, operation.status AS operationStatus,
                operation.last_error AS lastError
           FROM communications communication
           JOIN operation_jobs operation ON operation.id = communication.operation_id
          WHERE communication.id = ?`,
      )
        .bind(scheduled.communicationId)
        .first(),
    ).resolves.toEqual({
      status: "failed",
      operationStatus: "queue_failed",
      lastError: "queue transport unavailable",
    });
  });

  it("queues each configured reminder cohort once per UTC day and escalates overdue tasks", async () => {
    const { testEnv, queued } = await environment();
    const service = new CommunicationService(testEnv);
    const automation = new CommunicationAutomationService(testEnv);
    const now = Math.floor(Date.now() / 1_000);
    const template = await publishedTemplate(
      service,
      "task_reminder",
      "Please complete {{task.title}}, {{recipient.firstName}}.",
    );
    const taskId = crypto.randomUUID();
    await testEnv.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, target_type, target_id, title, task_type, impact,
         status, readiness_state, readiness_percent, revision, due_at,
         created_at, updated_at
       ) VALUES (?, ?, 'speaker', 'person-demo-speaker', 'Upload slides',
                 'file_upload', 'critical', 'in_progress', 'at_risk', 20, 1, ?,
                 unixepoch(), unixepoch())`,
    )
      .bind(taskId, viewer.eventId, now - 60)
      .run();
    await service.saveTrigger(viewer, {
      templateId: template.templateId,
      triggerType: "task_overdue",
      audienceType: "overdue_speakers",
      kind: "transactional",
      sendHourUtc: new Date(now * 1_000).getUTCHours(),
      enabled: true,
    });

    const first = await automation.run(now);
    const second = await automation.run(now + 60);

    expect(first.overdueTasks).toBeGreaterThanOrEqual(1);
    expect(first.reminders.queued).toBe(1);
    expect(second.reminders.queued).toBe(0);
    expect(queued).toHaveLength(1);
    await expect(
      testEnv.DB.prepare(
        `SELECT status, readiness_state AS readinessState,
                readiness_percent AS readinessPercent
           FROM task_instances WHERE id = ?`,
      )
        .bind(taskId)
        .first(),
    ).resolves.toEqual({
      status: "overdue",
      readinessState: "overdue",
      readinessPercent: 0,
    });
  });

  it("marks a no-recipient reminder day complete instead of retrying all day", async () => {
    const { testEnv } = await environment();
    const service = new CommunicationService(testEnv);
    const automation = new CommunicationAutomationService(testEnv);
    const now = Math.floor(Date.parse("2027-05-20T12:00:00Z") / 1_000);
    const template = await publishedTemplate(service, "task_reminder");
    const trigger = await service.saveTrigger(viewer, {
      templateId: template.templateId,
      triggerType: "task_due",
      audienceType: "due_speakers",
      kind: "transactional",
      sendHourUtc: 9,
      enabled: true,
    });

    const first = await automation.run(now);
    const second = await automation.run(now + 60);
    expect(first.reminders).toMatchObject({ queued: 0, noRecipients: 1 });
    expect(second.reminders).toMatchObject({ queued: 0, noRecipients: 0 });
    await expect(
      testEnv.DB.prepare(
        `SELECT json_extract(configuration_json, '$.lastRunBucket') AS lastRunBucket
           FROM communication_triggers WHERE id = ? AND event_id = ?`,
      )
        .bind(trigger.id, viewer.eventId)
        .first(),
    ).resolves.toEqual({ lastRunBucket: "2027-05-20" });
    await testEnv.DB.prepare(
      "UPDATE communication_triggers SET enabled = 0 WHERE id = ? AND event_id = ?",
    )
      .bind(trigger.id, viewer.eventId)
      .run();
  });

  it("isolates an invalid trigger and continues with later event reminders", async () => {
    const { testEnv, queued } = await environment();
    const service = new CommunicationService(testEnv);
    const automation = new CommunicationAutomationService(testEnv);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const now = Math.floor(Date.now() / 1_000);
    const template = await publishedTemplate(service, "task_reminder");
    await testEnv.DB.prepare(
      `INSERT INTO communication_triggers (
         id, event_id, template_id, trigger_type, configuration_json, enabled,
         created_at, updated_at
       ) VALUES ('00000000-invalid-trigger', ?, ?, 'task_due', '{}', 1,
                 unixepoch(), unixepoch())`,
    )
      .bind(viewer.eventId, template.templateId)
      .run();
    await service.saveTrigger(viewer, {
      templateId: template.templateId,
      triggerType: "task_overdue",
      audienceType: "overdue_speakers",
      kind: "transactional",
      sendHourUtc: new Date(now * 1_000).getUTCHours(),
      enabled: true,
    });
    await testEnv.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, target_type, target_id, title, task_type, impact,
         status, readiness_state, readiness_percent, revision, due_at,
         created_at, updated_at
       ) VALUES (?, ?, 'speaker', 'person-demo-speaker', 'Invalid trigger isolation',
                 'checklist', 'high', 'overdue', 'overdue', 0, 1, ?,
                 unixepoch(), unixepoch())`,
    )
      .bind(crypto.randomUUID(), viewer.eventId, now - 60)
      .run();

    await expect(automation.runReminderTriggers(now)).resolves.toEqual({
      queued: 1,
      noRecipients: 0,
      failed: 1,
    });
    expect(queued).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('"triggerId":"00000000-invalid-trigger"'),
    );
  });

  it("allows disabled trigger drafts but requires Queue, provider, and sender before enabling", async () => {
    const { testEnv } = await environment();
    const service = new CommunicationService(testEnv);
    const template = await publishedTemplate(service, "task_reminder");
    const input = {
      templateId: template.templateId,
      triggerType: "task_due" as const,
      audienceType: "due_speakers" as const,
      kind: "transactional" as const,
      sendHourUtc: 9,
      enabled: true,
    };
    const missingQueueEnv = {
      ...testEnv,
      OPERATIONS_QUEUE: undefined,
    } as unknown as CloudflareEnvironment;
    const missingQueueService = new CommunicationService(missingQueueEnv);

    await expect(
      missingQueueService.saveTrigger(viewer, input),
    ).rejects.toThrow(/OPERATIONS_QUEUE/);
    const trigger = await missingQueueService.saveTrigger(viewer, {
      ...input,
      enabled: false,
    });

    const invalidProviderService = new CommunicationService({
      ...testEnv,
      EMAIL_PROVIDER: undefined,
    } as unknown as CloudflareEnvironment);
    await expect(
      invalidProviderService.setTriggerEnabled(viewer, trigger.id, true),
    ).rejects.toThrow(/EMAIL_PROVIDER/);

    await testEnv.DB.prepare(
      "UPDATE sender_profiles SET status = 'disabled' WHERE event_id = ? AND status = 'verified'",
    )
      .bind(viewer.eventId)
      .run();
    await expect(
      service.setTriggerEnabled(viewer, trigger.id, true),
    ).rejects.toThrow(/verified sender profile/i);
    await testEnv.DB.prepare(
      "UPDATE sender_profiles SET status = 'verified' WHERE id = 'sender-automation-tests' AND event_id = ?",
    )
      .bind(viewer.eventId)
      .run();
    await expect(
      testEnv.DB.prepare(
        "SELECT enabled FROM communication_triggers WHERE id = ? AND event_id = ?",
      )
        .bind(trigger.id, viewer.eventId)
        .first(),
    ).resolves.toEqual({ enabled: 0 });
  });

  it("rejects enabling a trigger whose reminder template is no longer published", async () => {
    const { testEnv } = await environment();
    const service = new CommunicationService(testEnv);
    const template = await publishedTemplate(service, "task_reminder");
    const trigger = await service.saveTrigger(viewer, {
      templateId: template.templateId,
      triggerType: "task_due",
      audienceType: "due_speakers",
      kind: "transactional",
      sendHourUtc: 9,
      enabled: false,
    });
    await testEnv.DB.prepare(
      `UPDATE communication_template_versions
          SET status = 'draft', published_at = NULL
        WHERE id = ? AND event_id = ?`,
    )
      .bind(template.versionId, viewer.eventId)
      .run();

    await expect(
      service.setTriggerEnabled(viewer, trigger.id, true),
    ).rejects.toThrow(/published email version/i);
    await expect(
      testEnv.DB.prepare(
        "SELECT enabled FROM communication_triggers WHERE id = ? AND event_id = ?",
      )
        .bind(trigger.id, viewer.eventId)
        .first(),
    ).resolves.toEqual({ enabled: 0 });
  });

  it("preserves today's run marker when an existing trigger is re-saved", async () => {
    const { testEnv } = await environment();
    const service = new CommunicationService(testEnv);
    const template = await publishedTemplate(service, "task_reminder");
    const trigger = await service.saveTrigger(viewer, {
      templateId: template.templateId,
      triggerType: "task_due",
      audienceType: "due_speakers",
      kind: "transactional",
      sendHourUtc: 9,
      enabled: false,
    });
    await testEnv.DB.prepare(
      `UPDATE communication_triggers
          SET configuration_json = json_set(
            configuration_json, '$.lastRunBucket', '2027-05-20'
          )
        WHERE id = ? AND event_id = ?`,
    )
      .bind(trigger.id, viewer.eventId)
      .run();

    const updated = await service.saveTrigger(viewer, {
      templateId: template.templateId,
      triggerType: "task_due",
      audienceType: "event_administrators",
      kind: "optional",
      sendHourUtc: 11,
      enabled: false,
    });

    expect(updated.id).toBe(trigger.id);
    const stored = await testEnv.DB.prepare(
      `SELECT configuration_json AS configurationJson
         FROM communication_triggers WHERE id = ? AND event_id = ?`,
    )
      .bind(trigger.id, viewer.eventId)
      .first<{ configurationJson: string }>();
    expect(JSON.parse(stored!.configurationJson)).toEqual({
      audienceType: "event_administrators",
      kind: "optional",
      sendHourUtc: 11,
      lastRunBucket: "2027-05-20",
    });
  });

  it("does not overwrite a submitted task while marking incomplete work overdue", async () => {
    const { testEnv } = await environment();
    const automation = new CommunicationAutomationService(testEnv);
    const now = Math.floor(Date.now() / 1_000);
    const submittedTaskId = crypto.randomUUID();
    await testEnv.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, target_type, target_id, title, task_type, impact,
         status, readiness_state, readiness_percent, revision, due_at,
         submitted_at, created_at, updated_at
       ) VALUES (?, ?, 'speaker', 'person-demo-speaker', 'Awaiting review',
                 'file_upload', 'high', 'submitted', 'on_track', 80, 1, ?, ?,
                 unixepoch(), unixepoch())`,
    )
      .bind(submittedTaskId, viewer.eventId, now - 60, now - 120)
      .run();

    await automation.markOverdueTasks(now);

    await expect(
      testEnv.DB.prepare(
        "SELECT status, readiness_state AS readinessState FROM task_instances WHERE id = ?",
      )
        .bind(submittedTaskId)
        .first(),
    ).resolves.toEqual({ status: "submitted", readinessState: "on_track" });
  });

  it("runs overdue transitions through the repository authority boundary", async () => {
    const { testEnv } = await environment();
    const now = Math.floor(Date.now() / 1_000);
    const taskId = `authority-overdue-${crypto.randomUUID()}`;
    await testEnv.DB.prepare(
      `INSERT INTO task_instances (
         id, event_id, target_type, target_id, title, task_type, impact,
         status, readiness_state, readiness_percent, revision, due_at,
         created_at, updated_at
       ) VALUES (?, ?, 'event', ?, 'Authority-aware overdue task',
                 'checklist', 'high', 'in_progress', 'at_risk', 40, 1, ?,
                 unixepoch(), unixepoch())`,
    )
      .bind(taskId, viewer.eventId, viewer.eventId, now - 60)
      .run();
    const reads: string[] = [];
    const commands: Array<{ operation: string; eventId: string }> = [];
    const airtable = {
      assertReadable: async (scope: { eventId: string }) => {
        reads.push(scope.eventId);
        return null;
      },
      executeIdempotent: async <T>(
        scope: { eventId: string },
        command: { operation: string },
        execute: () => Promise<T>,
      ) => {
        commands.push({ operation: command.operation, eventId: scope.eventId });
        return execute();
      },
    } as unknown as AirtableProviderBoundary;

    await expect(
      new CommunicationAutomationService(testEnv, {
        airtable,
      }).markOverdueTasks(now),
    ).resolves.toBeGreaterThanOrEqual(1);
    expect(reads).toContain(viewer.eventId);
    expect(commands).toContainEqual({
      operation: "task.overdue.automatic",
      eventId: viewer.eventId,
    });
    await expect(
      testEnv.DB.prepare("SELECT status FROM task_instances WHERE id = ?")
        .bind(taskId)
        .first(),
    ).resolves.toEqual({ status: "overdue" });
  });

  it("does not discover inactive events for overdue automation", async () => {
    const { testEnv } = await environment();
    const now = Math.floor(Date.now() / 1_000);
    const eventId = `inactive-overdue-${crypto.randomUUID()}`;
    const taskId = `inactive-overdue-task-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           brand_accent, session_formats_json, repository_provider,
           activation_status, retention_months, submission_access_mode,
           allow_anonymous_drafts, duplicate_person_warnings, file_policy_json,
           revision, last_updated_by_person_id, created_at, updated_at
         )
         SELECT ?, organisation_id, 'Inactive automation event', ?, timezone,
                starts_at, ends_at, brand_accent, session_formats_json,
                'airtable', 'provisioning_failed', retention_months,
                submission_access_mode, allow_anonymous_drafts,
                duplicate_person_warnings, file_policy_json, 1,
                last_updated_by_person_id, unixepoch(), unixepoch()
           FROM events WHERE id = ? AND organisation_id = ?`,
      ).bind(
        eventId,
        `inactive-automation-${crypto.randomUUID()}`,
        viewer.eventId,
        viewer.organisationId,
      ),
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           status, readiness_state, readiness_percent, revision, due_at,
           created_at, updated_at
         ) VALUES (?, ?, 'event', ?, 'Inactive event task', 'checklist',
                   'high', 'in_progress', 'at_risk', 40, 1, ?,
                   unixepoch(), unixepoch())`,
      ).bind(taskId, eventId, eventId, now - 60),
    ]);
    const checkedEvents: string[] = [];
    const airtable = {
      assertReadable: async (scope: { eventId: string }) => {
        checkedEvents.push(scope.eventId);
        return null;
      },
      executeIdempotent: async <T>(
        _scope: { eventId: string },
        _command: { operation: string },
        execute: () => Promise<T>,
      ) => execute(),
    } as unknown as AirtableProviderBoundary;

    await new CommunicationAutomationService(testEnv, {
      airtable,
    }).markOverdueTasks(now);

    expect(checkedEvents).not.toContain(eventId);
    await expect(
      testEnv.DB.prepare("SELECT status FROM task_instances WHERE id = ?")
        .bind(taskId)
        .first(),
    ).resolves.toEqual({ status: "in_progress" });
  });

  it("continues overdue processing after one event authority check fails", async () => {
    const { testEnv } = await environment();
    const now = Math.floor(Date.now() / 1_000);
    const blockedEventId = `aaa-blocked-${crypto.randomUUID()}`;
    const blockedTaskId = `blocked-overdue-${crypto.randomUUID()}`;
    const laterTaskId = `later-overdue-${crypto.randomUUID()}`;
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO events (
           id, organisation_id, name, slug, timezone, starts_at, ends_at,
           brand_accent, session_formats_json, repository_provider,
           activation_status, retention_months, submission_access_mode, allow_anonymous_drafts,
           duplicate_person_warnings, file_policy_json, revision,
           last_updated_by_person_id, created_at, updated_at
         )
         SELECT ?, organisation_id, 'Blocked automation event', ?, timezone,
                starts_at, ends_at, brand_accent, session_formats_json,
                'airtable', 'provisioning', retention_months, submission_access_mode,
                allow_anonymous_drafts, duplicate_person_warnings,
                file_policy_json, 1, last_updated_by_person_id,
                unixepoch(), unixepoch()
           FROM events WHERE id = ? AND organisation_id = ?`,
      ).bind(
        blockedEventId,
        `blocked-automation-${crypto.randomUUID()}`,
        viewer.eventId,
        viewer.organisationId,
      ),
      testEnv.DB.prepare(
        `UPDATE events
            SET activation_status = 'active', repository_locked_at = unixepoch()
          WHERE id = ? AND activation_status = 'provisioning'`,
      ).bind(blockedEventId),
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           status, readiness_state, readiness_percent, revision, due_at,
           created_at, updated_at
         ) VALUES (?, ?, 'event', ?, 'Blocked event task', 'checklist',
                   'high', 'in_progress', 'at_risk', 40, 1, ?,
                   unixepoch(), unixepoch())`,
      ).bind(blockedTaskId, blockedEventId, blockedEventId, now - 60),
      testEnv.DB.prepare(
        `INSERT INTO task_instances (
           id, event_id, target_type, target_id, title, task_type, impact,
           status, readiness_state, readiness_percent, revision, due_at,
           created_at, updated_at
         ) VALUES (?, ?, 'event', ?, 'Later event task', 'checklist',
                   'high', 'in_progress', 'at_risk', 40, 1, ?,
                   unixepoch(), unixepoch())`,
      ).bind(laterTaskId, viewer.eventId, viewer.eventId, now - 60),
    ]);
    const projectionFailure = new Error(
      "The Airtable projection is unavailable.",
    );
    const airtable = {
      assertReadable: async (scope: { eventId: string }) => {
        if (scope.eventId === blockedEventId) throw projectionFailure;
        return null;
      },
      executeIdempotent: async <T>(
        _scope: { eventId: string },
        _command: { operation: string },
        execute: () => Promise<T>,
      ) => execute(),
    } as unknown as AirtableProviderBoundary;
    vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(
      new CommunicationAutomationService(testEnv, {
        airtable,
      }).markOverdueTasks(now),
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [projectionFailure],
    });
    await expect(
      testEnv.DB.prepare("SELECT status FROM task_instances WHERE id = ?")
        .bind(blockedTaskId)
        .first(),
    ).resolves.toEqual({ status: "in_progress" });
    await expect(
      testEnv.DB.prepare("SELECT status FROM task_instances WHERE id = ?")
        .bind(laterTaskId)
        .first(),
    ).resolves.toEqual({ status: "overdue" });
  });

  it("runs reminder and scheduled-send stages when overdue processing fails", async () => {
    const { testEnv } = await environment();
    const automation = new CommunicationAutomationService(testEnv);
    const overdueFailure = new Error("Airtable projection is unavailable.");
    vi.spyOn(automation, "markOverdueTasks").mockRejectedValue(overdueFailure);
    const reminders = vi
      .spyOn(automation, "runReminderTriggers")
      .mockResolvedValue({ queued: 1, noRecipients: 0, failed: 0 });
    const scheduled = vi
      .spyOn(automation, "dispatchDueScheduled")
      .mockResolvedValue({ queued: 2, queueFailed: 0 });

    await expect(automation.run(1_800_000_000)).rejects.toMatchObject({
      name: "AggregateError",
      errors: [overdueFailure],
    });
    expect(reminders).toHaveBeenCalledWith(1_800_000_000);
    expect(scheduled).toHaveBeenCalledWith(1_800_000_000);
  });
});
