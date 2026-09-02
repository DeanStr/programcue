import { z } from "zod";

import type { SchedulePublicationPreview } from "~/modules/schedule/schedule-publication-preview.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import { templateContentSchema } from "./communication-schema";
import {
  CommunicationStateError,
  communicationDeliveryIdempotencyKey,
} from "./communication-service-shared";
import { requireEmailProviderConfiguration } from "./email-provider.server";
import {
  formatEventDateMarkers,
  mergeTemplateVariables,
  renderMergeTemplate,
} from "./merge-template";

const allowedScheduleMergeVariables = new Set([
  "recipient.name",
  "recipient.firstName",
  "event.name",
  "event.dates",
  "schedule.changes",
  "schedule.url",
]);

const settingInputSchema = z.object({
  templateVersionId: z.uuid(),
  enabled: z.boolean(),
});

type PublicationChanges = SchedulePublicationPreview["changes"];

export type ScheduleChangeNotificationSummary = {
  enabled: boolean;
  materialSessionCount: number;
  eligibleParticipantCount: number;
  ready: boolean;
  problem: string | null;
};

type Recipient = {
  personId: string;
  address: string;
  name: string;
  sessionIds: string[];
};

type Configuration = {
  triggerId: string;
  templateId: string;
  templateVersionId: string;
  templateName: string;
  templateVersionNumber: number;
  subjectTemplate: string;
  contentJson: string;
  content: z.infer<typeof templateContentSchema>;
  senderId: string;
  senderProvider: "resend" | "mailpit";
  senderFromName: string;
  senderFromEmail: string;
  senderReplyToEmail: string | null;
  eventName: string;
  eventBrandAccent: string;
  eventStartsAt: number;
  eventEndsAt: number;
  eventTimezone: string;
  eventSlug: string;
};

export type ScheduleChangeNotificationPlan = {
  operationId: string;
  communicationId: string;
  operationIdempotencyKey: string;
  correlationId: string;
  message: {
    type: "communication.send";
    operationId: string;
    communicationId: string;
    eventId: string;
    organisationId: string;
    idempotencyKey: string;
  };
  configuration: Configuration;
  audienceJson: string;
  contentSnapshotJson: string;
  deliveriesJson: string;
  recipientCount: number;
};

type ScheduleChangeNotificationZeroRecipientGuard = {
  configuration: Configuration;
  audienceJson: string;
};

function materialSessionIds(changes: PublicationChanges) {
  return [
    ...new Set([
      ...changes.added.map((item) => item.sessionId),
      ...changes.removed.map((item) => item.sessionId),
      ...changes.moved.map((item) => item.sessionId),
      ...changes.visibility.map((item) => item.sessionId),
      ...changes.content
        .filter((item) => item.fields.some((field) => field.field === "title"))
        .map((item) => item.sessionId),
    ]),
  ].sort();
}

function formatDateTime(epoch: number, timezone: string) {
  return new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: timezone,
  }).format(new Date(epoch * 1_000));
}

function descriptionsFor(
  changes: PublicationChanges,
  sessionIds: ReadonlySet<string>,
  timezone: string,
) {
  const descriptions: string[] = [];
  for (const item of changes.added) {
    if (sessionIds.has(item.sessionId))
      descriptions.push(`Added to the published schedule: ${item.title}`);
  }
  for (const item of changes.removed) {
    if (sessionIds.has(item.sessionId))
      descriptions.push(`Removed from the published schedule: ${item.title}`);
  }
  for (const item of changes.moved) {
    if (!sessionIds.has(item.sessionId)) continue;
    descriptions.push(
      `Moved: ${item.title} — ${item.from.room}, ${formatDateTime(item.from.startsAt, timezone)} to ${formatDateTime(item.from.endsAt, timezone)} → ${item.to.room}, ${formatDateTime(item.to.startsAt, timezone)} to ${formatDateTime(item.to.endsAt, timezone)}`,
    );
  }
  for (const item of changes.visibility) {
    if (sessionIds.has(item.sessionId))
      descriptions.push(
        `Visibility changed: ${item.title} — ${item.from} → ${item.to}`,
      );
  }
  for (const item of changes.content) {
    if (!sessionIds.has(item.sessionId)) continue;
    for (const field of item.fields) {
      if (field.field === "title")
        descriptions.push(`Title changed: ${field.before} → ${field.after}`);
    }
  }
  return descriptions;
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function publicProgrammeUrl(env: CloudflareEnvironment, slug: string) {
  let base: URL;
  try {
    base = new URL(env.BETTER_AUTH_URL);
  } catch {
    throw new CommunicationStateError(
      "BETTER_AUTH_URL must be a valid absolute URL before schedule-change notifications can be enabled.",
    );
  }
  return new URL(
    `/public/programme/${encodeURIComponent(slug)}`,
    base,
  ).toString();
}

export class ScheduleChangeNotificationService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async getSetting(viewer: Pick<Viewer, "organisationId" | "eventId">) {
    const row = await this.env.DB.prepare(
      `SELECT trigger.id, trigger.enabled, trigger.template_id AS templateId,
              version.id AS templateVersionId, version.name AS templateName,
              version.version_number AS templateVersionNumber
         FROM communication_triggers trigger
         JOIN events event
           ON event.id = trigger.event_id AND event.organisation_id = ?
         LEFT JOIN communication_template_versions version
           ON version.template_id = trigger.template_id
          AND version.event_id = trigger.event_id
          AND version.channel = 'email' AND version.status = 'published'
        WHERE trigger.event_id = ?
          AND trigger.trigger_type = 'schedule_published'
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .first<{
        id: string;
        enabled: number;
        templateId: string;
        templateVersionId: string | null;
        templateName: string | null;
        templateVersionNumber: number | null;
      }>();
    return row
      ? { ...row, enabled: row.enabled === 1 }
      : {
          id: null,
          enabled: false,
          templateId: null,
          templateVersionId: null,
          templateName: null,
          templateVersionNumber: null,
        };
  }

  async saveSetting(viewer: Viewer, input: unknown) {
    const parsed = settingInputSchema.parse(input);
    const version = await this.env.DB.prepare(
      `SELECT version.id, version.template_id AS templateId
         FROM communication_template_versions version
         JOIN communication_templates template
           ON template.id = version.template_id
          AND template.event_id = version.event_id
         JOIN events event
           ON event.id = version.event_id AND event.organisation_id = ?
        WHERE version.id = ? AND version.event_id = ?
          AND version.status = 'published' AND version.channel = 'email'
          AND version.category = 'schedule'
          AND template.status = 'active' AND template.category = 'schedule'`,
    )
      .bind(viewer.organisationId, parsed.templateVersionId, viewer.eventId)
      .first<{ id: string; templateId: string }>();
    if (!version) {
      throw new CommunicationStateError(
        "Schedule-change notifications require an active schedule template with a published email version.",
      );
    }
    if (parsed.enabled) {
      if (!this.env.OPERATIONS_QUEUE) {
        throw new CommunicationStateError(
          "Required OPERATIONS_QUEUE binding is unavailable; schedule-change notifications cannot be enabled.",
        );
      }
      await this.assertProspectiveConfiguration(viewer, version.id);
    }
    const existing = await this.getSetting(viewer);
    const id = existing.id ?? crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO communication_triggers (
           id, event_id, template_id, trigger_type, configuration_json,
           enabled, created_at, updated_at
         )
         SELECT ?, version.event_id, version.template_id,
                'schedule_published', '{"kind":"transactional"}', ?,
                unixepoch(), unixepoch()
           FROM communication_template_versions version
           JOIN communication_templates template
             ON template.id = version.template_id
            AND template.event_id = version.event_id
           JOIN events event
             ON event.id = version.event_id AND event.organisation_id = ?
          WHERE version.id = ? AND version.event_id = ?
            AND version.status = 'published' AND version.channel = 'email'
            AND version.category = 'schedule'
            AND template.status = 'active' AND template.category = 'schedule'
         ON CONFLICT(id) DO UPDATE SET
           template_id = excluded.template_id,
           configuration_json = excluded.configuration_json,
           enabled = excluded.enabled, updated_at = unixepoch()
         WHERE communication_triggers.event_id = excluded.event_id
           AND communication_triggers.trigger_type = 'schedule_published'`,
        ).bind(
          id,
          parsed.enabled ? 1 : 0,
          viewer.organisationId,
          version.id,
          viewer.eventId,
        ),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, metadata_json,
           created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                'communication.schedule_change_setting.saved',
                'communication_trigger', ?, ?, unixepoch()
          WHERE changes() = 1`,
        ).bind(
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          id,
          JSON.stringify({
            enabled: parsed.enabled,
            templateVersionId: version.id,
          }),
        ),
        atomicBatchGuardStatement(
          this.env,
          `NOT (
             EXISTS (
               SELECT 1 FROM communication_triggers trigger
               JOIN events event
                 ON event.id = trigger.event_id AND event.organisation_id = ?
              WHERE trigger.id = ? AND trigger.event_id = ?
                AND trigger.template_id = ?
                AND trigger.trigger_type = 'schedule_published'
                AND trigger.enabled = ?
             )
             AND EXISTS (
               SELECT 1 FROM audit_events audit
                WHERE audit.id = ? AND audit.organisation_id = ?
                  AND audit.event_id = ? AND audit.actor_person_id = ?
                  AND audit.action = 'communication.schedule_change_setting.saved'
                  AND audit.entity_type = 'communication_trigger'
                  AND audit.entity_id = ?
             )
           )`,
          [
            viewer.organisationId,
            id,
            viewer.eventId,
            version.templateId,
            parsed.enabled ? 1 : 0,
            auditEventId,
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            id,
          ],
        ),
      ]);
    } catch (error) {
      if (
        !isAtomicBatchGuardError(error) &&
        !(
          error instanceof Error &&
          /UNIQUE constraint failed: communication_triggers\.event_id/iu.test(
            error.message,
          )
        )
      ) {
        throw error;
      }
      throw new CommunicationStateError(
        "The schedule-change notification setting changed before it could be saved.",
      );
    }
    return { id, enabled: parsed.enabled };
  }

  async disableSetting(viewer: Viewer) {
    const auditEventId = crypto.randomUUID();
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `UPDATE communication_triggers
            SET enabled = 0, updated_at = unixepoch()
          WHERE event_id = ? AND trigger_type = 'schedule_published'
            AND enabled = 1
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = communication_triggers.event_id
                 AND event.organisation_id = ?
            )`,
        ).bind(viewer.eventId, viewer.organisationId),
        this.env.DB.prepare(
          `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, metadata_json,
           created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                'communication.schedule_change_setting.disabled',
                'communication_trigger', trigger.id, '{}', unixepoch()
           FROM communication_triggers trigger
           JOIN events event
             ON event.id = trigger.event_id AND event.organisation_id = ?
          WHERE trigger.event_id = ?
            AND trigger.trigger_type = 'schedule_published'
            AND trigger.enabled = 0 AND changes() = 1`,
        ).bind(
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          viewer.organisationId,
          viewer.eventId,
        ),
        atomicBatchGuardStatement(
          this.env,
          `NOT (
             EXISTS (
               SELECT 1 FROM communication_triggers trigger
               JOIN events event
                 ON event.id = trigger.event_id AND event.organisation_id = ?
              WHERE trigger.event_id = ?
                AND trigger.trigger_type = 'schedule_published'
                AND trigger.enabled = 0
             )
             AND EXISTS (
               SELECT 1 FROM audit_events audit
                WHERE audit.id = ? AND audit.organisation_id = ?
                  AND audit.event_id = ? AND audit.actor_person_id = ?
                  AND audit.action = 'communication.schedule_change_setting.disabled'
                  AND audit.entity_type = 'communication_trigger'
             )
           )`,
          [
            viewer.organisationId,
            viewer.eventId,
            auditEventId,
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
          ],
        ),
      ]);
    } catch (error) {
      if (!isAtomicBatchGuardError(error)) throw error;
      throw new CommunicationStateError(
        "Schedule-change notifications are already disabled for this event.",
      );
    }
  }

  private async assertProspectiveConfiguration(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
    templateVersionId: string,
  ) {
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
    const row = await this.env.DB.prepare(
      `SELECT version.subject_template AS subjectTemplate,
              version.content_json AS contentJson, event.slug AS eventSlug
         FROM communication_template_versions version
         JOIN communication_templates template
           ON template.id = version.template_id
          AND template.event_id = version.event_id
          AND template.status = 'active' AND template.category = 'schedule'
         JOIN events event
           ON event.id = version.event_id AND event.organisation_id = ?
         JOIN sender_profiles sender
           ON sender.event_id = event.id AND sender.status = 'verified'
          AND sender.provider = ?
        WHERE version.id = ? AND version.event_id = ?
          AND version.status = 'published' AND version.channel = 'email'
          AND version.category = 'schedule'
        ORDER BY sender.updated_at DESC
        LIMIT 1`,
    )
      .bind(viewer.organisationId, provider, templateVersionId, viewer.eventId)
      .first<{
        subjectTemplate: string | null;
        contentJson: string;
        eventSlug: string;
      }>();
    if (!row?.subjectTemplate) {
      throw new CommunicationStateError(
        "Schedule-change notifications require an active published schedule email template and a verified sender for the configured provider.",
      );
    }
    const content = templateContentSchema.parse(JSON.parse(row.contentJson));
    const unsupported = [
      ...new Set(
        [
          ...mergeTemplateVariables(row.subjectTemplate),
          ...mergeTemplateVariables(content.body),
        ].filter((variable) => !allowedScheduleMergeVariables.has(variable)),
      ),
    ].sort();
    if (unsupported.length) {
      throw new CommunicationStateError(
        `The schedule-change template uses unavailable merge variables: ${unsupported.join(", ")}.`,
      );
    }
    publicProgrammeUrl(this.env, row.eventSlug);
  }

  private async loadConfiguration(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
  ): Promise<Configuration> {
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
    const row = await this.env.DB.prepare(
      `SELECT trigger.id AS triggerId, template.id AS templateId,
              version.id AS templateVersionId, version.name AS templateName,
              version.version_number AS templateVersionNumber,
              version.subject_template AS subjectTemplate,
              version.content_json AS contentJson,
              sender.id AS senderId, sender.provider AS senderProvider,
              sender.from_name AS senderFromName,
              sender.from_email AS senderFromEmail,
              sender.reply_to_email AS senderReplyToEmail,
              event.name AS eventName, event.brand_accent AS eventBrandAccent,
              event.starts_at AS eventStartsAt, event.ends_at AS eventEndsAt,
              event.timezone AS eventTimezone, event.slug AS eventSlug
         FROM communication_triggers trigger
         JOIN events event
           ON event.id = trigger.event_id AND event.organisation_id = ?
         JOIN communication_templates template
           ON template.id = trigger.template_id
          AND template.event_id = trigger.event_id
          AND template.status = 'active' AND template.category = 'schedule'
         JOIN communication_template_versions version
           ON version.template_id = template.id
          AND version.event_id = template.event_id
          AND version.status = 'published' AND version.channel = 'email'
          AND version.category = 'schedule'
         JOIN sender_profiles sender
           ON sender.event_id = event.id AND sender.status = 'verified'
          AND sender.provider = ?
        WHERE trigger.event_id = ?
          AND trigger.trigger_type = 'schedule_published'
          AND trigger.enabled = 1
        ORDER BY sender.updated_at DESC
        LIMIT 1`,
    )
      .bind(viewer.organisationId, provider, viewer.eventId)
      .first<Omit<Configuration, "content">>();
    if (!row) {
      throw new CommunicationStateError(
        "Schedule-change notifications require an enabled event setting, an active published schedule email template, and a verified sender for the configured provider.",
      );
    }
    if (!row.subjectTemplate) {
      throw new CommunicationStateError(
        "The schedule-change email template requires a subject.",
      );
    }
    const content = templateContentSchema.parse(JSON.parse(row.contentJson));
    const variables = [
      ...mergeTemplateVariables(row.subjectTemplate),
      ...mergeTemplateVariables(content.body),
    ];
    const unsupported = [
      ...new Set(
        variables.filter(
          (variable) => !allowedScheduleMergeVariables.has(variable),
        ),
      ),
    ].sort();
    if (unsupported.length) {
      throw new CommunicationStateError(
        `The schedule-change template uses unavailable merge variables: ${unsupported.join(", ")}.`,
      );
    }
    publicProgrammeUrl(this.env, row.eventSlug);
    return { ...row, content };
  }

  private async recipients(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
    sessionIds: string[],
  ) {
    if (!sessionIds.length) return [];
    const rows = await this.env.DB.prepare(
      `SELECT role.person_id AS personId, person.email AS address,
              person.display_name AS name, role.session_id AS sessionId
         FROM session_participant_roles role
         JOIN events event
           ON event.id = role.event_id AND event.organisation_id = ?
         JOIN people person ON person.id = role.person_id
        WHERE role.event_id = ?
          AND role.session_id IN (
            SELECT CAST(value AS TEXT) FROM json_each(?)
          )
          AND role.participation_status IN ('pending','confirmed')
        ORDER BY person.id, role.session_id`,
    )
      .bind(viewer.organisationId, viewer.eventId, JSON.stringify(sessionIds))
      .all<{
        personId: string;
        address: string;
        name: string;
        sessionId: string;
      }>();
    const recipients = new Map<string, Recipient>();
    for (const row of rows.results) {
      const recipient = recipients.get(row.personId) ?? {
        personId: row.personId,
        address: row.address,
        name: row.name,
        sessionIds: [],
      };
      if (!recipient.sessionIds.includes(row.sessionId))
        recipient.sessionIds.push(row.sessionId);
      recipients.set(row.personId, recipient);
    }
    return [...recipients.values()];
  }

  async inspect(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
    publishedVersionNumber: number | null,
    changes: PublicationChanges,
  ): Promise<ScheduleChangeNotificationSummary> {
    const setting = await this.getSetting(viewer);
    const sessionIds = publishedVersionNumber
      ? materialSessionIds(changes)
      : [];
    if (!setting.enabled) {
      return {
        enabled: false,
        materialSessionCount: sessionIds.length,
        eligibleParticipantCount: 0,
        ready: true,
        problem: null,
      };
    }
    const recipients = await this.recipients(viewer, sessionIds);
    try {
      await this.loadConfiguration(viewer);
      return {
        enabled: true,
        materialSessionCount: sessionIds.length,
        eligibleParticipantCount: recipients.length,
        ready: true,
        problem: null,
      };
    } catch (error) {
      return {
        enabled: true,
        materialSessionCount: sessionIds.length,
        eligibleParticipantCount: recipients.length,
        ready: false,
        problem:
          error instanceof Error
            ? error.message
            : "Schedule-change notification configuration is invalid.",
      };
    }
  }

  async prepare(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
    publishedVersionNumber: number | null,
    scheduleVersionId: string,
    changes: PublicationChanges,
  ): Promise<{
    summary: ScheduleChangeNotificationSummary;
    plan: ScheduleChangeNotificationPlan | null;
    zeroRecipientGuard: ScheduleChangeNotificationZeroRecipientGuard | null;
  }> {
    const summary = await this.inspect(viewer, publishedVersionNumber, changes);
    if (!summary.enabled) {
      return { summary, plan: null, zeroRecipientGuard: null };
    }
    if (!summary.ready || summary.problem) {
      throw new CommunicationStateError(
        summary.problem ??
          "Schedule-change notification configuration is invalid.",
      );
    }
    const sessionIds = materialSessionIds(changes);
    const recipients = await this.recipients(viewer, sessionIds);
    const configuration = await this.loadConfiguration(viewer);
    const preparedSummary = {
      ...summary,
      eligibleParticipantCount: recipients.length,
    };
    const audienceJson = JSON.stringify({
      type: "schedule_change",
      scheduleVersionId,
      sessionIds,
      renderContractVersion: 1,
    });
    if (!recipients.length) {
      return {
        summary: preparedSummary,
        plan: null,
        zeroRecipientGuard: { configuration, audienceJson },
      };
    }
    const operationId = crypto.randomUUID();
    const communicationId = crypto.randomUUID();
    const operationIdempotencyKey = `schedule-change-notification:${scheduleVersionId}`;
    const correlationId = crypto.randomUUID();
    const scheduleUrl = publicProgrammeUrl(this.env, configuration.eventSlug);
    const deliveries = await Promise.all(
      recipients.map(async (recipient) => {
        const descriptions = descriptionsFor(
          changes,
          new Set(recipient.sessionIds),
          configuration.eventTimezone,
        );
        if (!descriptions.length) {
          throw new Error(
            `Participant ${recipient.personId} has no material schedule changes.`,
          );
        }
        const sourceValues = {
          "schedule.changes": descriptions.join("\n"),
          "schedule.url": scheduleUrl,
        };
        const values = {
          "recipient.name": recipient.name,
          "recipient.firstName":
            recipient.name.trim().split(/\s+/)[0] || recipient.name,
          "event.name": configuration.eventName,
          "event.dates": formatEventDateMarkers(
            configuration.eventStartsAt,
            configuration.eventEndsAt,
          ),
          ...sourceValues,
        };
        const renderedSubject = renderMergeTemplate(
          configuration.subjectTemplate,
          values,
        );
        const renderedBody = renderMergeTemplate(
          configuration.content.body,
          values,
        );
        return {
          id: crypto.randomUUID(),
          personId: recipient.personId,
          address: recipient.address,
          name: recipient.name,
          sourceId: scheduleVersionId,
          sourceValuesJson: JSON.stringify(sourceValues),
          sessionIds: recipient.sessionIds,
          idempotencyKey: await communicationDeliveryIdempotencyKey(
            operationIdempotencyKey,
            recipient.address,
          ),
          renderedSubject,
          renderedBodySha256: await sha256(renderedBody),
        };
      }),
    );
    const message = {
      type: "communication.send" as const,
      operationId,
      communicationId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
      idempotencyKey: operationIdempotencyKey,
    };
    return {
      summary: preparedSummary,
      zeroRecipientGuard: null,
      plan: {
        operationId,
        communicationId,
        operationIdempotencyKey,
        correlationId,
        message,
        configuration,
        recipientCount: deliveries.length,
        deliveriesJson: JSON.stringify(deliveries),
        audienceJson,
        contentSnapshotJson: JSON.stringify({
          schemaVersion: 1,
          renderContractVersion: 1,
          category: "schedule",
          subjectTemplate: configuration.subjectTemplate,
          template: {
            id: configuration.templateVersionId,
            name: configuration.templateName,
            versionNumber: configuration.templateVersionNumber,
          },
          sender: {
            id: configuration.senderId,
            provider: configuration.senderProvider,
            fromName: configuration.senderFromName,
            fromEmail: configuration.senderFromEmail,
            replyToEmail: configuration.senderReplyToEmail,
          },
          content: configuration.content,
          event: {
            eventName: configuration.eventName,
            brandAccent: configuration.eventBrandAccent,
            startsAt: configuration.eventStartsAt,
            endsAt: configuration.eventEndsAt,
          },
        }),
      },
    };
  }

  zeroRecipientPublicationGuardStatement(input: {
    viewer: Pick<Viewer, "organisationId" | "eventId">;
    scheduleVersionId: string;
    publicationOperationId: string;
    guard: ScheduleChangeNotificationZeroRecipientGuard;
  }) {
    const { viewer, scheduleVersionId, publicationOperationId, guard } = input;
    const configuration = guard.configuration;
    return atomicBatchGuardStatement(
      this.env,
      `EXISTS (
         SELECT 1 FROM schedule_versions version
          WHERE version.id = ? AND version.event_id = ?
            AND version.status = 'published'
            AND version.publication_operation_id = ?
       ) AND NOT (
         EXISTS (
           SELECT 1 FROM communication_triggers trigger
           JOIN events event
             ON event.id = trigger.event_id AND event.organisation_id = ?
           JOIN communication_templates template
             ON template.id = trigger.template_id
            AND template.event_id = trigger.event_id
            AND template.status = 'active' AND template.category = 'schedule'
           JOIN communication_template_versions version
             ON version.id = ? AND version.template_id = template.id
            AND version.event_id = template.event_id
            AND version.status = 'published' AND version.channel = 'email'
            AND version.category = 'schedule'
            AND version.version_number = ?
            AND version.subject_template = ? AND version.content_json = ?
           JOIN sender_profiles sender
             ON sender.id = ? AND sender.event_id = trigger.event_id
            AND sender.status = 'verified' AND sender.provider = ?
            AND sender.from_name = ? AND sender.from_email = ?
            AND sender.reply_to_email IS ?
          WHERE trigger.id = ? AND trigger.event_id = ?
            AND trigger.template_id = ?
            AND trigger.trigger_type = 'schedule_published'
            AND trigger.enabled = 1
         )
         AND NOT EXISTS (
           SELECT 1 FROM session_participant_roles eligible_role
           JOIN events eligible_event
             ON eligible_event.id = eligible_role.event_id
            AND eligible_event.organisation_id = ?
          WHERE eligible_role.event_id = ?
            AND eligible_role.participation_status IN ('pending','confirmed')
            AND EXISTS (
              SELECT 1 FROM json_each(json_extract(?, '$.sessionIds')) material_session
               WHERE material_session.value = eligible_role.session_id
            )
         )
       )`,
      [
        scheduleVersionId,
        viewer.eventId,
        publicationOperationId,
        viewer.organisationId,
        configuration.templateVersionId,
        configuration.templateVersionNumber,
        configuration.subjectTemplate,
        configuration.contentJson,
        configuration.senderId,
        configuration.senderProvider,
        configuration.senderFromName,
        configuration.senderFromEmail,
        configuration.senderReplyToEmail,
        configuration.triggerId,
        viewer.eventId,
        configuration.templateId,
        viewer.organisationId,
        viewer.eventId,
        guard.audienceJson,
      ],
    );
  }

  publicationStatements(input: {
    viewer: Pick<Viewer, "organisationId" | "eventId"> & {
      personId: string | null;
    };
    actorId: string | null;
    scheduleVersionId: string;
    publicationOperationId: string;
    plan: ScheduleChangeNotificationPlan;
  }) {
    const { viewer, actorId, scheduleVersionId, publicationOperationId, plan } =
      input;
    const configuration = plan.configuration;
    return [
      this.env.DB.prepare(
        `INSERT INTO operation_jobs (
           id, organisation_id, event_id, requested_by_person_id, type,
           idempotency_key, correlation_id, status, payload_json,
           progress_total, progress_completed, progress_failed, cancellable,
           created_at, updated_at
         )
         SELECT ?, ?, ?, ?, 'communication.send', ?, ?, 'queued', ?,
                ?, 0, 0, 1, unixepoch(), unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM schedule_versions version
             WHERE version.id = ? AND version.event_id = ?
               AND version.status = 'published'
               AND version.publication_operation_id = ?
          )`,
      ).bind(
        plan.operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        plan.operationIdempotencyKey,
        plan.correlationId,
        JSON.stringify(plan.message),
        plan.recipientCount,
        scheduleVersionId,
        viewer.eventId,
        publicationOperationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO communications (
           id, event_id, template_version_id, sender_profile_id, operation_id,
           idempotency_key, kind, channel, status, audience_json,
           content_snapshot_json, recipient_count, queued_at,
           created_by_person_id, created_at, updated_at
         )
         SELECT ?, trigger.event_id, version.id, sender.id, ?, ?,
                'transactional', 'email', 'queued', ?, ?, ?, unixepoch(), ?,
                unixepoch(), unixepoch()
           FROM communication_triggers trigger
           JOIN communication_templates template
             ON template.id = trigger.template_id
            AND template.event_id = trigger.event_id
            AND template.status = 'active' AND template.category = 'schedule'
           JOIN communication_template_versions version
             ON version.id = ? AND version.template_id = template.id
            AND version.event_id = template.event_id
            AND version.status = 'published' AND version.channel = 'email'
            AND version.version_number = ?
            AND version.subject_template = ? AND version.content_json = ?
           JOIN sender_profiles sender
             ON sender.id = ? AND sender.event_id = trigger.event_id
            AND sender.status = 'verified' AND sender.provider = ?
            AND sender.from_name = ? AND sender.from_email = ?
            AND sender.reply_to_email IS ?
           JOIN operation_jobs operation
             ON operation.id = ? AND operation.event_id = trigger.event_id
            AND operation.status = 'queued'
          WHERE trigger.id = ? AND trigger.event_id = ?
            AND trigger.trigger_type = 'schedule_published'
            AND trigger.enabled = 1`,
      ).bind(
        plan.communicationId,
        plan.operationId,
        plan.operationIdempotencyKey,
        plan.audienceJson,
        plan.contentSnapshotJson,
        plan.recipientCount,
        viewer.personId,
        configuration.templateVersionId,
        configuration.templateVersionNumber,
        configuration.subjectTemplate,
        configuration.contentJson,
        configuration.senderId,
        configuration.senderProvider,
        configuration.senderFromName,
        configuration.senderFromEmail,
        configuration.senderReplyToEmail,
        plan.operationId,
        configuration.triggerId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `INSERT INTO communication_deliveries (
           id, event_id, communication_id, person_id, recipient_address,
           recipient_name, source_id, source_values_json, channel, provider,
           idempotency_key, status, rendered_subject, rendered_body_sha256,
           created_at, updated_at
         )
         SELECT json_extract(recipient.value, '$.id'), ?, ?,
                json_extract(recipient.value, '$.personId'),
                json_extract(recipient.value, '$.address'),
                json_extract(recipient.value, '$.name'),
                json_extract(recipient.value, '$.sourceId'),
                json_extract(recipient.value, '$.sourceValuesJson'),
                'email', ?, json_extract(recipient.value, '$.idempotencyKey'),
                'queued', json_extract(recipient.value, '$.renderedSubject'),
                json_extract(recipient.value, '$.renderedBodySha256'),
                unixepoch(), unixepoch()
           FROM json_each(?) recipient
          WHERE EXISTS (
            SELECT 1 FROM communications communication
             WHERE communication.id = ? AND communication.event_id = ?
               AND communication.operation_id = ?
          )
            AND EXISTS (
              SELECT 1 FROM people person
               WHERE person.id = json_extract(recipient.value, '$.personId')
                 AND person.email = json_extract(recipient.value, '$.address')
            )
            AND NOT EXISTS (
              SELECT 1
                FROM json_each(json_extract(recipient.value, '$.sessionIds')) session
               WHERE NOT EXISTS (
                 SELECT 1 FROM session_participant_roles role
                  WHERE role.event_id = ?
                    AND role.person_id = json_extract(recipient.value, '$.personId')
                    AND role.session_id = session.value
                    AND role.participation_status IN ('pending','confirmed')
               )
            )`,
      ).bind(
        viewer.eventId,
        plan.communicationId,
        configuration.senderProvider,
        plan.deliveriesJson,
        plan.communicationId,
        viewer.eventId,
        plan.operationId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `INSERT INTO operation_items (
           id, operation_id, item_key, entity_type, entity_id, status,
           result_json, updated_at
         )
         SELECT lower(hex(randomblob(16))), ?, delivery.idempotency_key,
                'communication_delivery', delivery.id, 'pending',
                json_object('sourceId', delivery.source_id), unixepoch()
           FROM communication_deliveries delivery
          WHERE delivery.communication_id = ? AND delivery.event_id = ?
            AND EXISTS (
              SELECT 1 FROM operation_jobs operation
               WHERE operation.id = ? AND operation.status = 'queued'
            )`,
      ).bind(
        plan.operationId,
        plan.communicationId,
        viewer.eventId,
        plan.operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, actor_id, action, entity_type, entity_id,
           correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, 1, ?, ?, ?, ?,
                'schedule.change_notification.prepared', 'communication', ?,
                ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM communications
             WHERE id = ? AND event_id = ? AND operation_id = ?
          )`,
      ).bind(
        crypto.randomUUID(),
        viewer.personId ? "person" : "api_key",
        viewer.personId ? "admin_ui" : "api",
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        actorId,
        plan.communicationId,
        plan.correlationId,
        JSON.stringify({
          scheduleVersionId,
          operationId: plan.operationId,
          recipientCount: plan.recipientCount,
          templateVersionId: configuration.templateVersionId,
        }),
        plan.communicationId,
        viewer.eventId,
        plan.operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id,
           created_at
         )
         SELECT ?, 'communication', ?, 'created', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM communications
             WHERE id = ? AND event_id = ? AND operation_id = ?
          )`,
      ).bind(
        viewer.eventId,
        plan.communicationId,
        plan.correlationId,
        plan.communicationId,
        viewer.eventId,
        plan.operationId,
      ),
      atomicBatchGuardStatement(
        this.env,
        `EXISTS (
           SELECT 1 FROM schedule_versions version
            WHERE version.id = ? AND version.event_id = ?
              AND version.status = 'published'
              AND version.publication_operation_id = ?
         ) AND NOT (
           EXISTS (
             SELECT 1 FROM communications communication
              WHERE communication.id = ? AND communication.event_id = ?
                AND communication.operation_id = ?
                AND communication.recipient_count = ?
           )
           AND (SELECT COUNT(*) FROM communication_deliveries delivery
                 WHERE delivery.communication_id = ? AND delivery.event_id = ?) = ?
           AND (SELECT COUNT(*) FROM operation_items item
                 WHERE item.operation_id = ?
                   AND item.entity_type = 'communication_delivery') = ?
           AND (SELECT COUNT(DISTINCT eligible_role.person_id)
                  FROM session_participant_roles eligible_role
                  JOIN events eligible_event
                    ON eligible_event.id = eligible_role.event_id
                   AND eligible_event.organisation_id = ?
                 WHERE eligible_role.event_id = ?
                   AND eligible_role.participation_status IN ('pending','confirmed')
                   AND EXISTS (
                     SELECT 1 FROM json_each(json_extract(?, '$.sessionIds')) material_session
                      WHERE material_session.value = eligible_role.session_id
                   )) = ?
           AND NOT EXISTS (
             SELECT 1 FROM session_participant_roles eligible_role
             JOIN events eligible_event
               ON eligible_event.id = eligible_role.event_id
              AND eligible_event.organisation_id = ?
            WHERE eligible_role.event_id = ?
              AND eligible_role.participation_status IN ('pending','confirmed')
              AND EXISTS (
                SELECT 1 FROM json_each(json_extract(?, '$.sessionIds')) material_session
                 WHERE material_session.value = eligible_role.session_id
              )
              AND NOT EXISTS (
                SELECT 1 FROM communication_deliveries delivery
                 WHERE delivery.communication_id = ?
                   AND delivery.event_id = eligible_role.event_id
                   AND delivery.person_id = eligible_role.person_id
              )
           )
         )`,
        [
          scheduleVersionId,
          viewer.eventId,
          publicationOperationId,
          plan.communicationId,
          viewer.eventId,
          plan.operationId,
          plan.recipientCount,
          plan.communicationId,
          viewer.eventId,
          plan.recipientCount,
          plan.operationId,
          plan.recipientCount,
          viewer.organisationId,
          viewer.eventId,
          plan.audienceJson,
          plan.recipientCount,
          viewer.organisationId,
          viewer.eventId,
          plan.audienceJson,
          plan.communicationId,
        ],
      ),
    ];
  }
}
