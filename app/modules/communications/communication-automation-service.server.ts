import { z } from "zod";

import {
  AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { sourceRevisionForLog } from "~/platform/observability/source-revision.server";
import { CommunicationDeliveryService } from "./communication-delivery-service.server";
import {
  type AudienceType,
  communicationTriggerConfigurationSchema,
  type SaveCommunicationTriggerInput,
  saveCommunicationTriggerSchema,
} from "./communication-schema";
import {
  assertReminderTriggerTemplateCompatible,
  CommunicationQueueUnavailableError,
  CommunicationStateError,
} from "./communication-service-shared";
import { CommunicationTemplateService } from "./communication-template-service.server";
import { requireEmailProviderConfiguration } from "./email-provider.server";

type ScheduledRow = {
  id: string;
  eventId: string;
  organisationId: string;
  requestedByPersonId: string | null;
  idempotencyKey: string;
  recipientCount: number;
};

type TriggerRow = {
  id: string;
  eventId: string;
  organisationId: string;
  templateId: string;
  templateVersionId: string;
  triggerType:
    | "task_due"
    | "task_overdue"
    | "application_draft"
    | "participation_pending";
  configurationJson: string;
  requestedByPersonId: string;
  requestedByName: string;
  requestedByEmail: string;
};

export type CommunicationAutomationResult = {
  scheduled: { queued: number; queueFailed: number };
  reminders: { queued: number; noRecipients: number; failed: number };
  overdueTasks: number;
};

function queueMessage(
  row: Pick<
    ScheduledRow,
    "id" | "eventId" | "organisationId" | "idempotencyKey"
  >,
  operationId: string,
) {
  return {
    type: "communication.send" as const,
    operationId,
    communicationId: row.id,
    eventId: row.eventId,
    organisationId: row.organisationId,
    idempotencyKey: row.idempotencyKey,
  };
}

function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    2_000,
  );
}

export class CommunicationAutomationService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  private async requireEnabledTriggerReadiness(viewer: Viewer) {
    if (!this.env.OPERATIONS_QUEUE)
      throw new CommunicationStateError(
        "Required OPERATIONS_QUEUE binding is unavailable; reminder triggers cannot be enabled.",
      );
    let provider: "resend" | "mailpit";
    try {
      provider = requireEmailProviderConfiguration(this.env).provider;
    } catch (error) {
      throw new CommunicationStateError(
        error instanceof Error
          ? error.message
          : "Email provider configuration is invalid.",
      );
    }
    const sender = await this.env.DB.prepare(
      `SELECT sender.id
         FROM sender_profiles sender
         JOIN events event
           ON event.id = sender.event_id AND event.organisation_id = ?
        WHERE sender.event_id = ? AND sender.status = 'verified'
          AND sender.provider = ?
        ORDER BY sender.updated_at DESC
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, provider)
      .first<{ id: string }>();
    if (!sender)
      throw new CommunicationStateError(
        "A verified sender profile is required before enabling reminder triggers.",
      );
  }

  async listTriggers(viewer: Viewer) {
    const result = await this.env.DB.prepare(
      `SELECT trigger.id, trigger.template_id AS templateId,
              template.name AS templateName, trigger.trigger_type AS triggerType,
              trigger.configuration_json AS configurationJson,
              trigger.enabled, trigger.updated_at AS updatedAt
         FROM communication_triggers trigger
         JOIN communication_templates template
           ON template.id = trigger.template_id AND template.event_id = trigger.event_id
         JOIN events event
           ON event.id = trigger.event_id AND event.organisation_id = ?
        WHERE trigger.event_id = ?
          AND trigger.trigger_type IN (
            'task_due','task_overdue','application_draft','participation_pending'
          )
        ORDER BY trigger.updated_at DESC`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        id: string;
        templateId: string;
        templateName: string;
        triggerType: TriggerRow["triggerType"];
        configurationJson: string;
        enabled: number;
        updatedAt: number;
      }>();
    return result.results.map((row) => ({
      ...row,
      configuration: communicationTriggerConfigurationSchema.parse(
        JSON.parse(row.configurationJson),
      ),
      enabled: row.enabled === 1,
      configurationJson: undefined,
    }));
  }

  async saveTrigger(viewer: Viewer, input: SaveCommunicationTriggerInput) {
    const parsed = saveCommunicationTriggerSchema.parse(input);
    const allowedAudiences: Record<
      typeof parsed.triggerType,
      ReadonlySet<typeof parsed.audienceType>
    > = {
      task_due: new Set(["due_speakers", "event_administrators"]),
      task_overdue: new Set(["overdue_speakers", "event_administrators"]),
      application_draft: new Set(["draft_applicants", "event_administrators"]),
      participation_pending: new Set([
        "pending_participants",
        "event_administrators",
      ]),
    };
    if (!allowedAudiences[parsed.triggerType].has(parsed.audienceType))
      throw new CommunicationStateError(
        "Choose the audience that matches this reminder trigger, or notify event administrators.",
      );
    const published = await this.env.DB.prepare(
      `SELECT version.id
         FROM communication_templates template
         JOIN communication_template_versions version
           ON version.template_id = template.id AND version.event_id = template.event_id
         JOIN events event
           ON event.id = template.event_id AND event.organisation_id = ?
        WHERE template.id = ? AND template.event_id = ?
          AND template.category = 'task_reminder' AND template.status = 'active'
          AND version.channel = 'email' AND version.status = 'published'`,
    )
      .bind(viewer.organisationId, parsed.templateId, viewer.eventId)
      .first<{ id: string }>();
    if (!published)
      throw new CommunicationStateError(
        "Reminder trigger requires an active task-reminder template with a published email version in this event.",
      );
    const template = await new CommunicationTemplateService(
      this.env,
    ).getTemplateVersion(viewer, published.id);
    assertReminderTriggerTemplateCompatible(template, parsed.audienceType);
    if (parsed.enabled) await this.requireEnabledTriggerReadiness(viewer);
    const existing = parsed.id
      ? null
      : await this.env.DB.prepare(
          `SELECT id FROM communication_triggers
            WHERE event_id = ? AND trigger_type = ? AND template_id = ?`,
        )
          .bind(viewer.eventId, parsed.triggerType, parsed.templateId)
          .first<{ id: string }>();
    const id = parsed.id ?? existing?.id ?? crypto.randomUUID();
    const configuration = {
      audienceType: parsed.audienceType,
      kind: parsed.kind,
      sendHourUtc: parsed.sendHourUtc,
    };
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO communication_triggers (
           id, event_id, template_id, trigger_type, configuration_json,
           enabled, created_at, updated_at
         )
         SELECT ?, template.event_id, template.id, ?, ?, ?, unixepoch(), unixepoch()
           FROM communication_templates template
           JOIN events event
             ON event.id = template.event_id AND event.organisation_id = ?
          WHERE template.id = ? AND template.event_id = ?
            AND template.category = 'task_reminder' AND template.status = 'active'
            AND EXISTS (
              SELECT 1 FROM communication_template_versions version
               WHERE version.template_id = template.id
                 AND version.event_id = template.event_id
                 AND version.id = ?
                 AND version.channel = 'email' AND version.status = 'published'
            )
         ON CONFLICT(id) DO UPDATE SET
           template_id = excluded.template_id,
           trigger_type = excluded.trigger_type,
           configuration_json = CASE
             WHEN json_type(
               communication_triggers.configuration_json,
               '$.lastRunBucket'
             ) = 'text'
             THEN json_set(
               excluded.configuration_json,
               '$.lastRunBucket',
               json_extract(
                 communication_triggers.configuration_json,
                 '$.lastRunBucket'
               )
             )
             ELSE excluded.configuration_json
           END,
           enabled = excluded.enabled,
           updated_at = unixepoch()
         WHERE communication_triggers.event_id = excluded.event_id`,
      ).bind(
        id,
        parsed.triggerType,
        JSON.stringify(configuration),
        parsed.enabled ? 1 : 0,
        viewer.organisationId,
        parsed.templateId,
        viewer.eventId,
        published.id,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'communication.trigger.saved',
                'communication_trigger', ?, ?, unixepoch()
          WHERE changes() = 1
            AND EXISTS (SELECT 1 FROM communication_triggers WHERE id = ? AND event_id = ?)`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        id,
        JSON.stringify({
          triggerType: parsed.triggerType,
          enabled: parsed.enabled,
        }),
        id,
        viewer.eventId,
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1)
      throw new CommunicationStateError(
        "The reminder template changed before the trigger could be saved. Review its audience compatibility and try again.",
      );
    return { id };
  }

  async setTriggerEnabled(viewer: Viewer, triggerId: string, enabled: boolean) {
    const id = z.uuid().parse(triggerId);
    const trigger = await this.env.DB.prepare(
      `SELECT trigger.id, trigger.template_id AS templateId,
              trigger.configuration_json AS configurationJson
         FROM communication_triggers trigger
         JOIN events event
           ON event.id = trigger.event_id AND event.organisation_id = ?
        WHERE trigger.id = ? AND trigger.event_id = ?`,
    )
      .bind(viewer.organisationId, id, viewer.eventId)
      .first<{ id: string; templateId: string; configurationJson: string }>();
    if (!trigger)
      throw new CommunicationStateError(
        "Reminder trigger was not found in this event.",
      );
    let publishedVersionId: string | null = null;
    if (enabled) {
      const configuration = communicationTriggerConfigurationSchema.parse(
        JSON.parse(trigger.configurationJson),
      );
      const published = await this.env.DB.prepare(
        `SELECT version.id
           FROM communication_templates template
           JOIN communication_template_versions version
             ON version.template_id = template.id
            AND version.event_id = template.event_id
           JOIN events event
             ON event.id = template.event_id AND event.organisation_id = ?
          WHERE template.id = ? AND template.event_id = ?
            AND template.category = 'task_reminder'
            AND template.status = 'active'
            AND version.channel = 'email' AND version.status = 'published'`,
      )
        .bind(viewer.organisationId, trigger.templateId, viewer.eventId)
        .first<{ id: string }>();
      if (!published)
        throw new CommunicationStateError(
          "Reminder trigger requires an active task-reminder template with a published email version in this event.",
        );
      publishedVersionId = published.id;
      const template = await new CommunicationTemplateService(
        this.env,
      ).getTemplateVersion(viewer, published.id);
      assertReminderTriggerTemplateCompatible(
        template,
        configuration.audienceType,
      );
      await this.requireEnabledTriggerReadiness(viewer);
    }
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE communication_triggers
            SET enabled = ?, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?
            AND EXISTS (SELECT 1 FROM events WHERE id = ? AND organisation_id = ?)
            AND (
              ? = 0
              OR EXISTS (
                SELECT 1
                  FROM communication_templates template
                  JOIN communication_template_versions version
                    ON version.template_id = template.id
                   AND version.event_id = template.event_id
                 WHERE template.id = communication_triggers.template_id
                   AND template.event_id = communication_triggers.event_id
                   AND template.category = 'task_reminder'
                   AND template.status = 'active'
                   AND version.id = ?
                   AND version.channel = 'email'
                   AND version.status = 'published'
              )
            )`,
      ).bind(
        enabled ? 1 : 0,
        id,
        viewer.eventId,
        viewer.eventId,
        viewer.organisationId,
        enabled ? 1 : 0,
        publishedVersionId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
           entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, ?, 'communication_trigger', ?, '{}', unixepoch()
          WHERE changes() = 1`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        enabled
          ? "communication.trigger.enabled"
          : "communication.trigger.disabled",
        id,
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1)
      throw new CommunicationStateError(
        enabled
          ? "The reminder template changed before the trigger could be enabled. Review its audience compatibility and try again."
          : "Reminder trigger was not found in this event.",
      );
  }

  async dispatchDueScheduled(now = Math.floor(Date.now() / 1_000), limit = 50) {
    const safeLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    const result = await this.env.DB.prepare(
      `SELECT communication.id, communication.event_id AS eventId,
              event.organisation_id AS organisationId,
              communication.created_by_person_id AS requestedByPersonId,
              communication.idempotency_key AS idempotencyKey,
              communication.recipient_count AS recipientCount
         FROM communications communication
         JOIN events event ON event.id = communication.event_id
        WHERE communication.status = 'scheduled'
          AND communication.scheduled_at IS NOT NULL
          AND communication.scheduled_at <= ?
        ORDER BY communication.scheduled_at, communication.id
        LIMIT ?`,
    )
      .bind(now, safeLimit)
      .all<ScheduledRow>();
    let queued = 0;
    let queueFailed = 0;
    for (const scheduled of result.results) {
      const operationId = crypto.randomUUID();
      const correlationId = crypto.randomUUID();
      const message = queueMessage(scheduled, operationId);
      const statements = await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE communications
              SET status = 'queued', operation_id = ?, queued_at = ?, updated_at = ?
            WHERE id = ? AND event_id = ? AND status = 'scheduled'
              AND scheduled_at IS NOT NULL AND scheduled_at <= ?`,
        ).bind(operationId, now, now, scheduled.id, scheduled.eventId, now),
        this.env.DB.prepare(
          `INSERT INTO operation_jobs (
             id, organisation_id, event_id, requested_by_person_id, type,
             idempotency_key, correlation_id, status, payload_json,
             progress_total, progress_completed, progress_failed, cancellable,
             created_at, updated_at
           )
           SELECT ?, ?, ?, ?, 'communication.send', ?, ?, 'queued', ?, ?, 0, 0, 1, ?, ?
            WHERE EXISTS (
              SELECT 1 FROM communications
               WHERE id = ? AND event_id = ? AND operation_id = ? AND status = 'queued'
            )`,
        ).bind(
          operationId,
          scheduled.organisationId,
          scheduled.eventId,
          scheduled.requestedByPersonId,
          scheduled.idempotencyKey,
          correlationId,
          JSON.stringify(message),
          scheduled.recipientCount,
          now,
          now,
          scheduled.id,
          scheduled.eventId,
          operationId,
        ),
        this.env.DB.prepare(
          `INSERT INTO operation_items (
             id, operation_id, item_key, entity_type, entity_id, status,
             result_json, updated_at
           )
           SELECT lower(hex(randomblob(16))), ?, delivery.idempotency_key,
                  'communication_delivery', delivery.id, 'pending',
                  json_object('sourceId', delivery.source_id), ?
             FROM communication_deliveries delivery
            WHERE delivery.communication_id = ? AND delivery.event_id = ?
              AND EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)`,
        ).bind(operationId, now, scheduled.id, scheduled.eventId, operationId),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, metadata_json, created_at
           )
           SELECT ?, 'system', 'scheduled', 1, ?, ?, ?, 'communication.schedule.released',
                  'communication', ?, json_object('operationId', ?), ?
            WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)`,
        ).bind(
          crypto.randomUUID(),
          scheduled.organisationId,
          scheduled.eventId,
          scheduled.requestedByPersonId,
          scheduled.id,
          operationId,
          now,
          operationId,
        ),
      ]);
      if ((statements[0].meta.changes ?? 0) !== 1) continue;
      try {
        if (!this.env.OPERATIONS_QUEUE)
          throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
        await this.env.OPERATIONS_QUEUE.send(message);
        queued += 1;
      } catch (error) {
        queueFailed += 1;
        const failure = errorMessage(error);
        await this.env.DB.batch([
          this.env.DB.prepare(
            `UPDATE operation_jobs
                SET status = 'queue_failed', last_error = ?, updated_at = ?
              WHERE id = ? AND event_id = ? AND status = 'queued'`,
          ).bind(failure, now, operationId, scheduled.eventId),
          this.env.DB.prepare(
            `UPDATE communications SET status = 'failed', updated_at = ?
              WHERE id = ? AND event_id = ? AND operation_id = ? AND status = 'queued'`,
          ).bind(now, scheduled.id, scheduled.eventId, operationId),
        ]);
        console.error(
          JSON.stringify({
            level: "error",
            subsystem: "communication-scheduler",
            event: "queue-dispatch-failed",
            sourceRevision: sourceRevisionForLog(this.env),
            eventId: scheduled.eventId,
            operationId,
            provider: "cloudflare-queue",
            errorName: error instanceof Error ? error.name : "UnknownError",
            message:
              "The scheduled communication operation could not be queued.",
          }),
        );
      }
    }
    return { queued, queueFailed };
  }

  async runReminderTriggers(now = Math.floor(Date.now() / 1_000)) {
    const instant = new Date(now * 1_000);
    const bucket = instant.toISOString().slice(0, 10);
    const hour = instant.getUTCHours();
    const result = await this.env.DB.prepare(
      `SELECT trigger.id, trigger.event_id AS eventId,
              event.organisation_id AS organisationId,
              trigger.template_id AS templateId,
              version.id AS templateVersionId,
              trigger.trigger_type AS triggerType,
              trigger.configuration_json AS configurationJson,
              person.id AS requestedByPersonId,
              person.display_name AS requestedByName,
              person.email AS requestedByEmail
         FROM communication_triggers trigger
         JOIN events event ON event.id = trigger.event_id
         JOIN communication_templates template
           ON template.id = trigger.template_id AND template.event_id = trigger.event_id
          AND template.category = 'task_reminder' AND template.status = 'active'
         JOIN communication_template_versions version
           ON version.template_id = template.id AND version.event_id = template.event_id
          AND version.channel = 'email' AND version.status = 'published'
         JOIN people person ON person.id = template.created_by_person_id
        WHERE trigger.enabled = 1
          AND trigger.trigger_type IN (
            'task_due','task_overdue','application_draft','participation_pending'
          )
        ORDER BY trigger.id`,
    ).all<TriggerRow>();
    let queued = 0;
    let noRecipients = 0;
    let failed = 0;
    for (const trigger of result.results) {
      try {
        const configuration: z.infer<
          typeof communicationTriggerConfigurationSchema
        > = communicationTriggerConfigurationSchema.parse(
          JSON.parse(trigger.configurationJson),
        );
        if (
          configuration.sendHourUtc > hour ||
          configuration.lastRunBucket === bucket
        )
          continue;
        const viewer: Viewer = {
          personId: trigger.requestedByPersonId,
          name: trigger.requestedByName,
          email: trigger.requestedByEmail,
          role: "administrator",
          organisationId: trigger.organisationId,
          eventId: trigger.eventId,
          demo: false,
        };
        const delivery = new CommunicationDeliveryService(this.env);
        const preview = await delivery.preview(viewer, {
          templateVersionId: trigger.templateVersionId,
          audienceType: configuration.audienceType as AudienceType,
          manualRecipients: "",
          kind: configuration.kind,
        });
        if (!preview.recipients.deliverable.length) {
          noRecipients += 1;
        } else {
          await delivery.confirm(viewer, {
            templateVersionId: trigger.templateVersionId,
            audienceType: configuration.audienceType as AudienceType,
            manualRecipients: "",
            kind: configuration.kind,
            idempotencyKey: `reminder:${trigger.id}:${bucket}`,
            ...preview.confirmation,
          });
          queued += 1;
        }
        await this.env.DB.prepare(
          `UPDATE communication_triggers
              SET configuration_json = json_set(configuration_json, '$.lastRunBucket', ?),
                  updated_at = ?
            WHERE id = ? AND event_id = ?
              AND json_extract(configuration_json, '$.lastRunBucket') IS NOT ?`,
        )
          .bind(bucket, now, trigger.id, trigger.eventId, bucket)
          .run();
      } catch (error) {
        failed += 1;
        if (error instanceof CommunicationQueueUnavailableError) {
          // The durable send is retryable from its operation; do not create a
          // second communication for this trigger/day.
          await this.env.DB.prepare(
            `UPDATE communication_triggers
                SET configuration_json = json_set(configuration_json, '$.lastRunBucket', ?),
                    updated_at = ?
              WHERE id = ? AND event_id = ?`,
          )
            .bind(bucket, now, trigger.id, trigger.eventId)
            .run();
        }
        console.error(
          JSON.stringify({
            level: "error",
            subsystem: "communication-reminders",
            event: "trigger-run-failed",
            sourceRevision: sourceRevisionForLog(this.env),
            eventId: trigger.eventId,
            triggerId: trigger.id,
            workflow: "daily-reminder-trigger",
            ...(error instanceof CommunicationQueueUnavailableError
              ? {
                  operationId: error.operationId,
                  provider: "cloudflare-queue",
                }
              : {}),
            errorName: error instanceof Error ? error.name : "UnknownError",
            message: "The reminder trigger did not complete.",
          }),
        );
      }
    }
    return { queued, noRecipients, failed };
  }

  private async markEventOverdueTasks(
    scope: { eventId: string; organisationId: string },
    now: number,
  ) {
    await this.airtable.assertReadable(scope);
    const candidates = await this.env.DB.prepare(
      `SELECT id, revision, due_at AS dueAt, status
           FROM task_instances
          WHERE event_id = ? AND due_at IS NOT NULL AND due_at < ?
            AND status NOT IN ('submitted','completed','waived','overdue')
          ORDER BY id`,
    )
      .bind(scope.eventId, now)
      .all<{
        id: string;
        revision: number;
        dueAt: number;
        status: string;
      }>();
    if (!candidates.results.length) return 0;
    const commandScope = { ...scope, personId: null };
    const idempotencyKey = await airtableCommandKey(
      "task.overdue.automatic",
      commandScope,
      { now, tasks: candidates.results },
    );
    return this.airtable.executeIdempotent(
      commandScope,
      { idempotencyKey, operation: "task.overdue.automatic" },
      async () => {
        const results = await this.env.DB.batch([
          this.env.DB.prepare(
            `INSERT INTO audit_events (
                 id, actor_kind, origin, metadata_version, organisation_id, event_id, action, entity_type, entity_id,
                 metadata_json, created_at
               )
               SELECT lower(hex(randomblob(16))), 'system', 'scheduled', 1, event.organisation_id,
                      task.event_id, 'task.overdue.automatic',
                      'task_instance', task.id,
                      json_object('dueAt', task.due_at), ?
                 FROM task_instances task
                 JOIN events event ON event.id = task.event_id
                WHERE task.event_id = ?
                  AND event.organisation_id = ?
                  AND task.due_at IS NOT NULL AND task.due_at < ?
                  AND task.status NOT IN ('submitted','completed','waived','overdue')`,
          ).bind(now, scope.eventId, scope.organisationId, now),
          this.env.DB.prepare(
            `INSERT INTO event_changes (
                 event_id, entity_type, entity_id, change_type,
                 correlation_id, created_at
               )
               SELECT task.event_id, 'task', task.id, 'updated',
                      lower(hex(randomblob(16))), ?
                 FROM task_instances task
                 JOIN events event ON event.id = task.event_id
                WHERE task.event_id = ?
                  AND event.organisation_id = ?
                  AND task.due_at IS NOT NULL AND task.due_at < ?
                  AND task.status NOT IN ('submitted','completed','waived','overdue')`,
          ).bind(now, scope.eventId, scope.organisationId, now),
          this.env.DB.prepare(
            `UPDATE task_instances
                  SET status = 'overdue', readiness_state = 'overdue',
                      readiness_percent = 0,
                      revision = revision + 1, updated_at = ?
                WHERE event_id = ?
                  AND due_at IS NOT NULL AND due_at < ?
                  AND status NOT IN ('submitted','completed','waived','overdue')
                  AND EXISTS (
                    SELECT 1 FROM events event
                     WHERE event.id = task_instances.event_id
                       AND event.organisation_id = ?
                  )`,
          ).bind(now, scope.eventId, now, scope.organisationId),
        ]);
        const auditCount = results[0].meta.changes ?? 0;
        const changeCount = results[1].meta.changes ?? 0;
        const updateCount = results[2].meta.changes ?? 0;
        if (auditCount !== updateCount || changeCount !== updateCount) {
          throw new Error(
            "The automatic overdue task transition did not record every changed task.",
          );
        }
        return updateCount;
      },
    );
  }

  async markOverdueTasks(now = Math.floor(Date.now() / 1_000)) {
    const scopes = await this.env.DB.prepare(
      `SELECT event.id AS eventId, event.organisation_id AS organisationId
         FROM events event
        WHERE event.activation_status = 'active'
          AND (
            event.repository_provider = 'airtable'
            OR EXISTS (
              SELECT 1 FROM task_instances task
               WHERE task.event_id = event.id
                 AND task.due_at IS NOT NULL AND task.due_at < ?
                 AND task.status NOT IN ('submitted','completed','waived','overdue')
            )
          )
        ORDER BY event.id`,
    )
      .bind(now)
      .all<{ eventId: string; organisationId: string }>();
    let changed = 0;
    const failures: unknown[] = [];
    for (const scope of scopes.results) {
      try {
        changed += await this.markEventOverdueTasks(scope, now);
      } catch (error) {
        failures.push(error);
        console.error(
          JSON.stringify({
            level: "error",
            subsystem: "communication-automation",
            event: "overdue-event-failed",
            sourceRevision: sourceRevisionForLog(this.env),
            eventId: scope.eventId,
            workflow: "automatic-overdue-transition",
            errorName: error instanceof Error ? error.name : "UnknownError",
            message:
              "Automatic overdue processing failed for one event and continued with later events.",
          }),
        );
      }
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        "Automatic overdue processing failed for one or more events.",
      );
    }
    return changed;
  }

  async run(now = Math.floor(Date.now() / 1_000)) {
    const failures: unknown[] = [];
    let overdueTasks = 0;
    let reminders: CommunicationAutomationResult["reminders"] = {
      queued: 0,
      noRecipients: 0,
      failed: 0,
    };
    let scheduled: CommunicationAutomationResult["scheduled"] = {
      queued: 0,
      queueFailed: 0,
    };
    try {
      overdueTasks = await this.markOverdueTasks(now);
    } catch (error) {
      failures.push(error);
    }
    try {
      reminders = await this.runReminderTriggers(now);
    } catch (error) {
      failures.push(error);
    }
    try {
      scheduled = await this.dispatchDueScheduled(now);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length) {
      throw new AggregateError(
        failures,
        "One or more communication automation stages failed.",
      );
    }
    return {
      scheduled,
      reminders,
      overdueTasks,
    } satisfies CommunicationAutomationResult;
  }
}

export async function runCommunicationAutomation(
  env: CloudflareEnvironment,
  now = Math.floor(Date.now() / 1_000),
) {
  return new CommunicationAutomationService(env).run(now);
}
