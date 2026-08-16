import type { Viewer } from "~/platform/auth/authorize.server";
import { sourceRevisionForLog } from "~/platform/observability/source-revision.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { representativeSourceSnapshot } from "./communication-delivery-foundation.server";
import { CommunicationDeliveryPreview } from "./communication-delivery-preview.server";
import type { ConfirmCommunicationInput } from "./communication-schema";
import {
  CommunicationQueueUnavailableError,
  CommunicationStateError,
  communicationDeliveryIdempotencyKey,
  communicationReplay,
  communicationRequestHash,
  type ExistingCommunication,
  sourceVariables,
} from "./communication-service-shared";
import { requireEmailProviderConfiguration } from "./email-provider.server";

export abstract class CommunicationDeliveryRecorder extends CommunicationDeliveryPreview {
  protected async record(
    viewer: Viewer,
    parsed: ConfirmCommunicationInput,
    scheduledAt: number | null,
    representativeTest: boolean,
    draft?: { id: string; revision: number },
  ) {
    const requestHash = await communicationRequestHash({
      ...parsed,
      scheduledAt,
      mode: representativeTest ? "test" : "send",
    });
    const existing = await this.env.DB.prepare(
      `
      SELECT c.id, c.operation_id AS operationId, c.status, c.revision,
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
      .first<ExistingCommunication & { revision: number }>();
    if (!draft && existing) return communicationReplay(existing, requestHash);
    if (
      draft &&
      existing &&
      existing.id === draft.id &&
      existing.status !== "draft"
    ) {
      return communicationReplay(existing, requestHash);
    }
    if (
      draft &&
      (!existing ||
        existing.id !== draft.id ||
        existing.status !== "draft" ||
        existing.revision !== draft.revision)
    ) {
      throw new CommunicationStateError(
        "This communication draft changed after it was previewed. Preview it again before confirming.",
      );
    }

    const preview = await this.previewParsed(
      viewer,
      parsed,
      representativeTest,
    );
    if (
      preview.confirmation.recipientFingerprint !== parsed.recipientFingerprint
    ) {
      throw new CommunicationStateError(
        "The audience changed after it was previewed, or its content or sender is no longer exact. Preview again before confirming.",
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
    const sender = preview.provider.senderProfile;
    if (!sender)
      throw new CommunicationStateError(
        "A verified sender profile is required before sending.",
      );
    let emailProvider: ReturnType<typeof requireEmailProviderConfiguration>;
    try {
      emailProvider = requireEmailProviderConfiguration(this.env);
    } catch (error) {
      throw new CommunicationStateError(
        error instanceof Error
          ? error.message
          : "Email provider configuration is invalid.",
      );
    }
    await new WebhookService(this.env).assertEventDeliveryReady(
      viewer,
      "communication.completed",
    );

    const communicationId = draft?.id ?? crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const requiredSourceVariables = sourceVariables(preview.template);
    const representativeSources = representativeSourceSnapshot(
      requiredSourceVariables,
    );
    const deliveries = await Promise.all(
      preview.recipients.deliverable.map(async (recipient) => ({
        id: crypto.randomUUID(),
        personId: recipient.personId,
        address: recipient.address,
        name: recipient.name,
        sourceId: recipient.sourceId,
        sourceValues: representativeTest
          ? representativeSources
          : recipient.sourceId
            ? (preview.mergeSnapshot.sourceValues[recipient.sourceId] ?? {})
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
      event: preview.mergeSnapshot.event,
      sender,
    };
    const audienceSnapshot = {
      type: parsed.audienceType,
      kind: parsed.kind,
      selected: preview.recipients.selected,
      invalid: preview.recipients.invalid.length,
      suppressed: preview.recipients.suppressed.length,
      requestHash,
      recordingClaimId: operationId,
      confirmedDraftRevision: draft?.revision ?? null,
      test: representativeTest,
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
    const communicationRecord = draft
      ? this.env.DB.prepare(
          `
          UPDATE communications
             SET sender_profile_id = ?, operation_id = ?, kind = ?,
                 status = ?, audience_json = ?, content_snapshot_json = ?,
                 recipient_count = ?, scheduled_at = ?,
                 queued_at = CASE WHEN ? IS NULL THEN unixepoch() ELSE NULL END,
                 revision = revision + 1, updated_at = unixepoch()
           WHERE id = ? AND event_id = ? AND status = 'draft' AND revision = ?
             AND template_version_id = ?
             AND EXISTS (
               SELECT 1 FROM events event
                WHERE event.id = communications.event_id
                  AND event.organisation_id = ?
             )
             AND EXISTS (
               SELECT 1 FROM communication_template_versions exact_template
                WHERE exact_template.id = communications.template_version_id
                  AND exact_template.event_id = communications.event_id
                  AND exact_template.status = 'published'
             )
             AND EXISTS (
               SELECT 1 FROM sender_profiles exact_sender
                WHERE exact_sender.id = ?
                  AND exact_sender.event_id = communications.event_id
                  AND exact_sender.status = 'verified'
                  AND exact_sender.provider = ?
                  AND exact_sender.from_name = ?
                  AND exact_sender.from_email = ?
                  AND exact_sender.reply_to_email IS ?
             )
        `,
        ).bind(
          sender.id,
          scheduledAt === null ? operationId : null,
          parsed.kind,
          scheduledAt === null ? "queued" : "scheduled",
          JSON.stringify(audienceSnapshot),
          JSON.stringify(contentSnapshot),
          deliveries.length,
          scheduledAt,
          scheduledAt,
          communicationId,
          viewer.eventId,
          draft.revision,
          preview.template.id,
          viewer.organisationId,
          sender.id,
          emailProvider.provider,
          sender.fromName,
          sender.fromEmail,
          sender.replyToEmail,
        )
      : this.env.DB.prepare(
          `
        INSERT OR IGNORE INTO communications (
          id, event_id, template_version_id, sender_profile_id, operation_id, idempotency_key,
          kind, channel, status, audience_json, content_snapshot_json, recipient_count,
          scheduled_at, queued_at, created_by_person_id, created_at, updated_at
        ) SELECT ?, e.id, ?, exact_sender.id, ?, ?, ?, 'email', ?, ?, ?, ?, ?,
                 CASE WHEN ? IS NULL THEN unixepoch() ELSE NULL END,
                 ?, unixepoch(), unixepoch()
            FROM events e
            JOIN sender_profiles exact_sender
              ON exact_sender.id = ? AND exact_sender.event_id = e.id
             AND exact_sender.status = 'verified' AND exact_sender.provider = ?
             AND exact_sender.from_name = ? AND exact_sender.from_email = ?
             AND exact_sender.reply_to_email IS ?
           WHERE e.id = ? AND e.organisation_id = ?
             AND EXISTS (
               SELECT 1 FROM communication_template_versions exact_template
                WHERE exact_template.id = ? AND exact_template.event_id = e.id
                  AND exact_template.status = 'published'
             )
      `,
        ).bind(
          communicationId,
          preview.template.id,
          scheduledAt === null ? operationId : null,
          parsed.idempotencyKey,
          parsed.kind,
          scheduledAt === null ? "queued" : "scheduled",
          JSON.stringify(audienceSnapshot),
          JSON.stringify(contentSnapshot),
          deliveries.length,
          scheduledAt,
          scheduledAt,
          viewer.personId,
          sender.id,
          emailProvider.provider,
          sender.fromName,
          sender.fromEmail,
          sender.replyToEmail,
          viewer.eventId,
          viewer.organisationId,
          preview.template.id,
        );
    const results = await this.env.DB.batch([
      communicationRecord,
      this.env.DB.prepare(
        `
        INSERT INTO communication_deliveries (
          id, event_id, communication_id, person_id, recipient_address, recipient_name,
          source_id, source_values_json, channel, provider, idempotency_key, status, created_at, updated_at
        )
        SELECT json_extract(value, '$.id'), ?, ?, json_extract(value, '$.personId'),
               json_extract(value, '$.address'), json_extract(value, '$.name'),
               json_extract(value, '$.sourceId'), json_extract(value, '$.sourceValues'),
               'email', ?, json_extract(value, '$.idempotencyKey'), 'queued', unixepoch(), unixepoch()
          FROM json_each(?)
         WHERE EXISTS (
           SELECT 1 FROM communications
            WHERE id = ? AND event_id = ? AND status IN ('queued','scheduled')
              AND json_extract(audience_json, '$.recordingClaimId') = ?
         )
      `,
      ).bind(
        viewer.eventId,
        communicationId,
        emailProvider.provider,
        deliveriesJson,
        communicationId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type, idempotency_key,
          correlation_id, status, payload_json, progress_total, progress_completed,
          progress_failed, cancellable, created_at, updated_at
        ) SELECT ?, ?, ?, ?, 'communication.send', ?, ?, 'queued', ?, ?, 0, 0, 1, unixepoch(), unixepoch()
           WHERE ? IS NULL
             AND EXISTS (
               SELECT 1 FROM communications
                WHERE id = ? AND event_id = ? AND status = 'queued'
                  AND json_extract(audience_json, '$.recordingClaimId') = ?
             )
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
        scheduledAt,
        communicationId,
        viewer.eventId,
        operationId,
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
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
        ) SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, ?, 'communication', ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM communications
              WHERE id = ? AND event_id = ? AND status IN ('queued','scheduled')
                AND json_extract(audience_json, '$.recordingClaimId') = ?
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        scheduledAt === null
          ? "communication.queued"
          : "communication.scheduled",
        communicationId,
        JSON.stringify({
          operationId: scheduledAt === null ? operationId : null,
          recipientCount: deliveries.length,
          category: preview.template.category,
          scheduledAt,
        }),
        communicationId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
        SELECT ?, 'communication', ?, 'created', ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM communications
            WHERE id = ? AND event_id = ? AND status IN ('queued','scheduled')
              AND json_extract(audience_json, '$.recordingClaimId') = ?
         )
      `,
      ).bind(
        viewer.eventId,
        communicationId,
        correlationId,
        communicationId,
        viewer.eventId,
        operationId,
      ),
    ]);
    if ((results[0].meta.changes ?? 0) !== 1) {
      if (draft) {
        const race = await this.env.DB.prepare(
          `SELECT communication.id,
                  communication.operation_id AS operationId,
                  communication.status,
                  json_extract(communication.audience_json, '$.requestHash') AS requestHash,
                  operation.status AS operationStatus
             FROM communications communication
             JOIN events event
               ON event.id = communication.event_id
              AND event.organisation_id = ?
             LEFT JOIN operation_jobs operation
               ON operation.id = communication.operation_id
              AND operation.event_id = communication.event_id
            WHERE communication.id = ? AND communication.event_id = ?`,
        )
          .bind(viewer.organisationId, draft.id, viewer.eventId)
          .first<ExistingCommunication>();
        if (race && race.status !== "draft") {
          return communicationReplay(race, requestHash);
        }
        throw new CommunicationStateError(
          "This communication draft changed after it was previewed. Preview it again before confirming.",
        );
      }
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

    if (scheduledAt !== null) {
      return {
        communicationId,
        operationId: null,
        status: "scheduled",
        operationStatus: null,
        duplicate: false as const,
      };
    }

    try {
      if (!this.env.OPERATIONS_QUEUE)
        throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
      await this.env.OPERATIONS_QUEUE.send(queueMessage);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          subsystem: "communication-dispatch",
          event: "queue-dispatch-failed",
          sourceRevision: sourceRevisionForLog(this.env),
          eventId: viewer.eventId,
          operationId,
          provider: "cloudflare-queue",
          errorName: error instanceof Error ? error.name : "UnknownError",
          message: "The durable communication operation could not be queued.",
        }),
      );
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
}
