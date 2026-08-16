import type { Viewer } from "~/platform/auth/authorize.server";
import { CommunicationDeliveryRecorder } from "./communication-delivery-recorder.server";
import {
  type ConfirmCommunicationInput,
  confirmCommunicationSchema,
  type PreviewCommunicationInput,
  type ScheduleCommunicationInput,
  scheduleCommunicationSchema,
  type TestCommunicationInput,
  testCommunicationSchema,
} from "./communication-schema";
import {
  CommunicationNotFoundError,
  CommunicationStateError,
  communicationReplay,
  communicationRequestHash,
  type ExistingCommunication,
} from "./communication-service-shared";

export abstract class CommunicationDeliveryActions extends CommunicationDeliveryRecorder {
  async confirm(viewer: Viewer, input: ConfirmCommunicationInput) {
    const parsed = confirmCommunicationSchema.parse(input);
    return this.record(viewer, parsed, null, false);
  }

  async schedule(viewer: Viewer, input: ScheduleCommunicationInput) {
    const parsed = scheduleCommunicationSchema.parse(input);
    if (!this.env.OPERATIONS_QUEUE)
      throw new CommunicationStateError(
        "Required OPERATIONS_QUEUE binding is unavailable; scheduled delivery cannot be enabled.",
      );
    const now = Math.floor(Date.now() / 1_000);
    if (parsed.scheduledAt <= now + 60)
      throw new CommunicationStateError(
        "Scheduled delivery must be at least one minute in the future.",
      );
    return this.record(viewer, parsed, parsed.scheduledAt, false);
  }

  async confirmDraft(
    viewer: Viewer,
    input: ConfirmCommunicationInput & {
      draftId: string;
      draftRevision: number;
      scheduledAt: number | null;
    },
  ) {
    const parsed = confirmCommunicationSchema.parse(input);
    if (input.scheduledAt !== null) {
      if (!this.env.OPERATIONS_QUEUE) {
        throw new CommunicationStateError(
          "Required OPERATIONS_QUEUE binding is unavailable; scheduled delivery cannot be enabled.",
        );
      }
      const now = Math.floor(Date.now() / 1_000);
      if (input.scheduledAt <= now + 60) {
        throw new CommunicationStateError(
          "Scheduled delivery must be at least one minute in the future.",
        );
      }
    }
    return this.record(viewer, parsed, input.scheduledAt, false, {
      id: input.draftId,
      revision: input.draftRevision,
    });
  }

  async replayDraftConfirmation(
    viewer: Viewer,
    input: {
      draftId: string;
      draftRevision: number;
      recipientFingerprint: string;
      deliverableFingerprint: string;
      suppressedCount: number;
    },
  ) {
    const row = await this.env.DB.prepare(
      `SELECT communication.id,
              communication.template_version_id AS templateVersionId,
              communication.idempotency_key AS idempotencyKey,
              communication.kind, communication.scheduled_at AS scheduledAt,
              communication.operation_id AS operationId, communication.status,
              operation.status AS operationStatus,
              json_extract(communication.audience_json, '$.type') AS audienceType,
              json_extract(communication.audience_json, '$.requestHash') AS requestHash,
              json_extract(communication.audience_json, '$.confirmedDraftRevision') AS confirmedDraftRevision
         FROM communications communication
         JOIN events event
           ON event.id = communication.event_id AND event.organisation_id = ?
         LEFT JOIN operation_jobs operation
           ON operation.id = communication.operation_id
          AND operation.event_id = communication.event_id
        WHERE communication.id = ? AND communication.event_id = ?`,
    )
      .bind(viewer.organisationId, input.draftId, viewer.eventId)
      .first<
        ExistingCommunication & {
          templateVersionId: string | null;
          idempotencyKey: string;
          kind: string;
          scheduledAt: number | null;
          audienceType: string | null;
          confirmedDraftRevision: number | null;
        }
      >();
    if (!row) {
      throw new CommunicationNotFoundError(
        "The communication draft was not found in this event.",
      );
    }
    if (
      row.status === "draft" ||
      row.confirmedDraftRevision !== input.draftRevision
    ) {
      throw new CommunicationStateError(
        "This communication draft is no longer awaiting that confirmation.",
      );
    }
    const parsed = confirmCommunicationSchema.parse({
      templateVersionId: row.templateVersionId,
      audienceType: row.audienceType,
      manualRecipients: "",
      kind: row.kind,
      idempotencyKey: row.idempotencyKey,
      recipientFingerprint: input.recipientFingerprint,
      deliverableFingerprint: input.deliverableFingerprint,
      suppressedCount: input.suppressedCount,
    });
    const requestHash = await communicationRequestHash({
      ...parsed,
      scheduledAt: row.scheduledAt,
      mode: "send",
    });
    if (row.requestHash !== requestHash) {
      throw new CommunicationStateError(
        "This idempotency key is already associated with a different communication request.",
      );
    }
    if (row.operationStatus === "queue_failed") {
      return communicationReplay(row, requestHash);
    }
    if (["failed", "partially_failed", "cancelled"].includes(row.status)) {
      throw new CommunicationStateError(
        `This communication is ${row.status.replaceAll("_", " ")} and cannot be confirmed again. Inspect its durable history before taking another action.`,
      );
    }
    return communicationReplay(row, requestHash);
  }

  async testSend(viewer: Viewer, input: TestCommunicationInput) {
    const parsed = testCommunicationSchema.parse(input);
    const previewInput: PreviewCommunicationInput = {
      templateVersionId: parsed.templateVersionId,
      audienceType: "manual",
      manualRecipients: `Alex Morgan <${parsed.recipient}>`,
      kind: "transactional",
    };
    const preview = await this.previewParsed(viewer, previewInput, true);
    return this.record(
      viewer,
      {
        ...previewInput,
        idempotencyKey: parsed.idempotencyKey,
        ...preview.confirmation,
      },
      null,
      true,
    );
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
        INSERT INTO audit_events (id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at)
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'communication.cancelled', 'communication', ?, '{}', unixepoch()
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
}
