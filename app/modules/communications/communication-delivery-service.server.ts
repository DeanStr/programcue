import type { Viewer } from "~/platform/auth/authorize.server";
import {
  confirmCommunicationSchema,
  previewCommunicationSchema,
  type ConfirmCommunicationInput,
  type PreviewCommunicationInput,
} from "./communication-schema";
import { renderProgramCueEmail } from "./email-templates/render-email.server";
import { renderMergeTemplate } from "./merge-template";
import { RecipientQuery } from "./recipient-query.server";
import {
  assertMergeAudienceCompatible,
  communicationDeliveryIdempotencyKey,
  communicationReplay,
  communicationRequestHash,
  CommunicationNotFoundError,
  CommunicationQueueUnavailableError,
  CommunicationStateError,
  mergeValues,
  recipientFingerprint,
  snapshotSourceValues,
  sourceVariables,
  type CommunicationPreview,
  type EventMergeRow,
  type ExistingCommunication,
  type SenderRow,
} from "./communication-service-shared";
import { CommunicationTemplateService } from "./communication-template-service.server";

export class CommunicationDeliveryService {
  private readonly templates: CommunicationTemplateService;
  private readonly recipients: RecipientQuery;

  constructor(private readonly env: CloudflareEnvironment) {
    this.templates = new CommunicationTemplateService(env);
    this.recipients = new RecipientQuery(env);
  }

  async preview(
    viewer: Viewer,
    input: PreviewCommunicationInput,
  ): Promise<CommunicationPreview> {
    const parsed = previewCommunicationSchema.parse(input);
    const [template, event, sender] = await Promise.all([
      this.templates.getTemplateVersion(viewer, parsed.templateVersionId),
      this.getEvent(viewer),
      this.getVerifiedSender(viewer),
    ]);
    assertMergeAudienceCompatible(template, parsed.audienceType);
    const recipients = await this.recipients.preview(viewer, {
      audienceType: parsed.audienceType,
      manualRecipients: parsed.manualRecipients,
      category: template.category,
      kind: parsed.kind,
    });
    const requiredSourceVariables = sourceVariables(template);
    if (
      requiredSourceVariables.length &&
      recipients.deliverable.some((recipient) => !recipient.sourceId)
    ) {
      throw new CommunicationStateError(
        "The selected audience contains a recipient without the source record required by this template.",
      );
    }
    const sourceSnapshots = await snapshotSourceValues(
      this.env,
      viewer.eventId,
      requiredSourceVariables,
      recipients.deliverable,
    );
    const representativeRecipient = recipients.deliverable[0];
    const values = {
      ...mergeValues(event, representativeRecipient),
      ...(representativeRecipient?.sourceId
        ? sourceSnapshots.get(representativeRecipient.sourceId)
        : {}),
    };
    const subject = renderMergeTemplate(template.subject, values);
    const body = renderMergeTemplate(template.content.body, values);
    const rendered = await renderProgramCueEmail({
      preview: subject,
      heading: subject,
      body,
      eventName: event.eventName,
      physicalAddress: template.content.physicalAddress,
      buttonText: template.content.buttonText,
      buttonUrl: template.content.buttonUrl,
    });
    const confirmation = {
      recipientFingerprint: await recipientFingerprint([
        ...recipients.deliverable,
        ...recipients.suppressed,
      ]),
      deliverableFingerprint: await recipientFingerprint(
        recipients.deliverable,
      ),
      suppressedCount: recipients.suppressed.length,
    };
    return {
      template,
      recipients,
      confirmation,
      rendered: { subject, ...rendered },
      provider: {
        configured: Boolean(this.env.RESEND_API_KEY?.trim() && sender),
        sender: sender ? `${sender.fromName} <${sender.fromEmail}>` : null,
        queueConfigured: Boolean(this.env.OPERATIONS_QUEUE),
      },
    };
  }

  async confirm(viewer: Viewer, input: ConfirmCommunicationInput) {
    const parsed = confirmCommunicationSchema.parse(input);
    const requestHash = await communicationRequestHash(parsed);
    const existing = await this.env.DB.prepare(
      `
      SELECT c.id, c.operation_id AS operationId, c.status,
             json_extract(c.audience_json, '$.requestHash') AS requestHash,
             operation.status AS operationStatus
        FROM communications c
        JOIN events e ON e.id = c.event_id AND e.organisation_id = ?
        LEFT JOIN operation_jobs operation
          ON operation.id = c.operation_id AND operation.event_id = c.event_id
       WHERE c.event_id = ? AND c.idempotency_key = ?
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, parsed.idempotencyKey)
      .first<ExistingCommunication>();
    if (existing) return communicationReplay(existing, requestHash);

    const preview = await this.preview(viewer, parsed);
    if (
      preview.confirmation.recipientFingerprint !== parsed.recipientFingerprint
    ) {
      throw new CommunicationStateError(
        "The audience changed after it was previewed. Preview the recipients again before confirming.",
      );
    }
    if (
      preview.confirmation.deliverableFingerprint !==
        parsed.deliverableFingerprint &&
      preview.confirmation.suppressedCount <= parsed.suppressedCount
    ) {
      throw new CommunicationStateError(
        "The deliverable audience changed after it was previewed. Preview the recipients again before confirming.",
      );
    }
    if (preview.template.versionStatus !== "published")
      throw new CommunicationStateError(
        "Publish this template version before sending it.",
      );
    if (!preview.recipients.deliverable.length)
      throw new CommunicationStateError(
        "The audience contains no deliverable recipients.",
      );
    const sender = await this.getVerifiedSender(viewer);
    if (!sender)
      throw new CommunicationStateError(
        "A verified Resend sender profile is required before sending.",
      );
    if (!this.env.RESEND_API_KEY?.trim())
      throw new CommunicationStateError(
        "RESEND_API_KEY is required before sending.",
      );

    const communicationId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const requiredSourceVariables = sourceVariables(preview.template);
    const sourceSnapshots = await snapshotSourceValues(
      this.env,
      viewer.eventId,
      requiredSourceVariables,
      preview.recipients.deliverable,
    );
    const deliveries = await Promise.all(
      preview.recipients.deliverable.map(async (recipient) => ({
        id: crypto.randomUUID(),
        personId: recipient.personId,
        address: recipient.address,
        name: recipient.name,
        sourceId: recipient.sourceId,
        sourceValues: recipient.sourceId
          ? (sourceSnapshots.get(recipient.sourceId) ?? {})
          : {},
        idempotencyKey: await communicationDeliveryIdempotencyKey(
          parsed.idempotencyKey,
          recipient.address,
        ),
      })),
    );
    const contentSnapshot = {
      schemaVersion: 1,
      category: preview.template.category,
      subjectTemplate: preview.template.subject,
      content: preview.template.content,
      event: await this.getEvent(viewer),
    };
    const audienceSnapshot = {
      type: parsed.audienceType,
      kind: parsed.kind,
      selected: preview.recipients.selected,
      invalid: preview.recipients.invalid.length,
      suppressed: preview.recipients.suppressed.length,
      requestHash,
    };
    const queueMessage = {
      type: "communication.send",
      operationId,
      communicationId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
      idempotencyKey: parsed.idempotencyKey,
    };
    const deliveriesJson = JSON.stringify(deliveries);
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        INSERT OR IGNORE INTO communications (
          id, event_id, template_version_id, sender_profile_id, operation_id, idempotency_key,
          kind, channel, status, audience_json, content_snapshot_json, recipient_count,
          queued_at, created_by_person_id, created_at, updated_at
        ) SELECT ?, e.id, ?, ?, ?, ?, ?, 'email', 'queued', ?, ?, ?, unixepoch(), ?, unixepoch(), unixepoch()
            FROM events e
           WHERE e.id = ? AND e.organisation_id = ?
      `,
      ).bind(
        communicationId,
        preview.template.id,
        sender.id,
        operationId,
        parsed.idempotencyKey,
        parsed.kind,
        JSON.stringify(audienceSnapshot),
        JSON.stringify(contentSnapshot),
        deliveries.length,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO communication_deliveries (
          id, event_id, communication_id, person_id, recipient_address, recipient_name,
          source_id, source_values_json, channel, provider, idempotency_key, status, created_at, updated_at
        )
        SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.personId'),
               json_extract(value, '$.address'), json_extract(value, '$.name'),
               json_extract(value, '$.sourceId'), json_extract(value, '$.sourceValues'),
               'email', 'resend', json_extract(value, '$.idempotencyKey'), 'queued', unixepoch(), unixepoch()
          FROM json_each(?)
         WHERE EXISTS (SELECT 1 FROM communications WHERE id = ? AND event_id = ?)
      `,
      ).bind(
        viewer.eventId,
        communicationId,
        deliveriesJson,
        communicationId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type, idempotency_key,
          correlation_id, status, payload_json, progress_total, progress_completed,
          progress_failed, cancellable, created_at, updated_at
        ) SELECT ?, ?, ?, ?, 'communication.send', ?, ?, 'queued', ?, ?, 0, 0, 1, unixepoch(), unixepoch()
           WHERE EXISTS (SELECT 1 FROM communications WHERE id = ? AND event_id = ?)
      `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        correlationId,
        JSON.stringify(queueMessage),
        deliveries.length,
        communicationId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO operation_items (id, operation_id, item_key, entity_type, entity_id, status, result_json, updated_at)
        SELECT lower(hex(randomblob(16))), ?, json_extract(value, '$.idempotencyKey'),
               'communication_delivery', json_extract(value, '$.id'), 'pending',
               json_object('sourceId', json_extract(value, '$.sourceId')), unixepoch()
          FROM json_each(?)
         WHERE EXISTS (SELECT 1 FROM operation_jobs WHERE id = ?)
      `,
      ).bind(operationId, deliveriesJson, operationId),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'communication.queued', 'communication', ?, ?, unixepoch()
           WHERE EXISTS (SELECT 1 FROM communications WHERE id = ?)
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        communicationId,
        JSON.stringify({
          operationId,
          recipientCount: deliveries.length,
          category: preview.template.category,
        }),
        communicationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
        SELECT ?, 'communication', ?, 'created', ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM communications WHERE id = ?)
      `,
      ).bind(viewer.eventId, communicationId, correlationId, communicationId),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      const race = await this.env.DB.prepare(
        `
        SELECT communication.id, communication.operation_id AS operationId,
               communication.status,
               json_extract(communication.audience_json, '$.requestHash') AS requestHash,
               operation.status AS operationStatus
          FROM communications communication
          LEFT JOIN operation_jobs operation
            ON operation.id = communication.operation_id
           AND operation.event_id = communication.event_id
         WHERE communication.event_id = ? AND communication.idempotency_key = ?
      `,
      )
        .bind(viewer.eventId, parsed.idempotencyKey)
        .first<ExistingCommunication>();
      if (race) return communicationReplay(race, requestHash);
      throw new CommunicationStateError(
        "The communication could not be recorded in the authorised event.",
      );
    }

    try {
      if (!this.env.OPERATIONS_QUEUE)
        throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
      await this.env.OPERATIONS_QUEUE.send(queueMessage);
    } catch (error) {
      console.error("Communication Queue dispatch failed", {
        operationId,
        cause: error instanceof Error ? error.message : String(error),
      });
      await this.env.DB.batch([
        this.env.DB.prepare(
          "UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch() WHERE id = ? AND status = 'queued'",
        ).bind(
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : String(error).slice(0, 2_000),
          operationId,
        ),
        this.env.DB.prepare(
          "UPDATE communications SET status = 'failed', updated_at = unixepoch() WHERE id = ? AND status = 'queued'",
        ).bind(communicationId),
      ]);
      throw new CommunicationQueueUnavailableError(operationId, error);
    }
    return {
      communicationId,
      operationId,
      status: "queued",
      operationStatus: "queued",
      duplicate: false as const,
    };
  }

  async cancel(viewer: Viewer, communicationId: string) {
    // This status claim competes atomically with the worker's queued -> sending
    // claim; only the winner may update the linked deliveries and operation.
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE communications
           SET status = 'cancelled', cancelled_at = unixepoch(), updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status IN ('draft','scheduled','queued','failed')
           AND EXISTS (SELECT 1 FROM events WHERE id = ? AND organisation_id = ?)
           AND (
             operation_id IS NULL
             OR EXISTS (
               SELECT 1 FROM operation_jobs cancellable_operation
                WHERE cancellable_operation.id = communications.operation_id
                  AND cancellable_operation.event_id = communications.event_id
                  AND cancellable_operation.status IN (
                    'queued','queue_failed','received','retrying','failed','partially_failed'
                  )
             )
           )
      `,
      ).bind(
        communicationId,
        viewer.eventId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE communication_deliveries
           SET status = 'cancelled', updated_at = unixepoch()
         WHERE communication_id = ? AND event_id = ? AND status IN ('queued','failed')
           AND EXISTS (
             SELECT 1 FROM communications cancelled_communication
              WHERE cancelled_communication.id = communication_deliveries.communication_id
                AND cancelled_communication.event_id = communication_deliveries.event_id
                AND cancelled_communication.status = 'cancelled'
           )
      `,
      ).bind(communicationId, viewer.eventId),
      this.env.DB.prepare(
        `
        UPDATE operation_items
           SET status = 'skipped', error_code = 'COMMUNICATION_CANCELLED',
               error_message = 'The communication was cancelled before delivery.',
               completed_at = unixepoch(), updated_at = unixepoch()
         WHERE operation_id = (
           SELECT operation_id FROM communications
            WHERE id = ? AND event_id = ? AND status = 'cancelled'
         )
           AND status IN ('pending','failed')
      `,
      ).bind(communicationId, viewer.eventId),
      this.env.DB.prepare(
        `
        UPDATE operation_jobs
           SET status = 'cancelled', last_error = NULL,
               completed_at = unixepoch(), updated_at = unixepoch()
         WHERE id = (
           SELECT operation_id FROM communications
            WHERE id = ? AND event_id = ? AND status = 'cancelled'
         )
           AND event_id = ?
           AND status IN ('queued','queue_failed','received','retrying','failed','partially_failed')
      `,
      ).bind(communicationId, viewer.eventId, viewer.eventId),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at)
        SELECT ?, ?, ?, ?, 'communication.cancelled', 'communication', ?, '{}', unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM communications cancelled_communication
            WHERE cancelled_communication.id = ? AND cancelled_communication.event_id = ?
              AND cancelled_communication.status = 'cancelled'
         )
           AND NOT EXISTS (
             SELECT 1 FROM audit_events cancellation_audit
              WHERE cancellation_audit.event_id = ?
                AND cancellation_audit.action = 'communication.cancelled'
                AND cancellation_audit.entity_type = 'communication'
                AND cancellation_audit.entity_id = ?
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        communicationId,
        communicationId,
        viewer.eventId,
        viewer.eventId,
        communicationId,
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      throw new CommunicationStateError(
        "Only an unsent communication can be cancelled.",
      );
    }
  }
  private async getEvent(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      `
      SELECT e.name AS eventName, e.starts_at AS startsAt, e.ends_at AS endsAt
        FROM events e WHERE e.id = ? AND e.organisation_id = ?
    `,
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<EventMergeRow>();
    if (!event)
      throw new CommunicationNotFoundError(
        "The event was not found in the authorised organisation.",
      );
    return event;
  }

  private async getVerifiedSender(viewer: Viewer) {
    return this.env.DB.prepare(
      `
      SELECT sp.id, sp.from_name AS fromName, sp.from_email AS fromEmail,
             sp.reply_to_email AS replyToEmail
        FROM sender_profiles sp
        JOIN events e ON e.id = sp.event_id AND e.organisation_id = ?
       WHERE sp.event_id = ? AND sp.status = 'verified' AND sp.provider = 'resend'
       ORDER BY sp.updated_at DESC LIMIT 1
    `,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .first<SenderRow>();
  }
}
