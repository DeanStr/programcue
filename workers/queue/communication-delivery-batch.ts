import { z } from "zod";

import { templateContentSchema } from "../../app/modules/communications/communication-schema";
import {
  type EmailProvider,
  TRACKED_DELIVERY_EMAIL_TAG,
} from "../../app/modules/communications/email-provider";
import { renderProgramCueEmail } from "../../app/modules/communications/email-templates/render-email.server";
import {
  formatEventDateMarkers,
  renderMergeTemplate,
} from "../../app/modules/communications/merge-template";
import { createCommunicationUnsubscribeUrl } from "../../app/modules/communications/unsubscribe.server";
import {
  assertOperationClaim,
  errorDetails,
  renewOperationClaim,
} from "./claim-infrastructure";

type CommunicationSendMessage = {
  type: "communication.send";
  operationId: string;
  communicationId: string;
  eventId: string;
  organisationId: string;
  idempotencyKey: string;
  includeFailed?: boolean;
};

export const communicationContentSnapshotSchema = z.object({
  schemaVersion: z.literal(1),
  category: z.string(),
  subjectTemplate: z.string(),
  content: templateContentSchema,
  event: z.object({
    eventName: z.string(),
    brandAccent: z.string().regex(/^#[0-9a-f]{6}$/i),
    startsAt: z.number(),
    endsAt: z.number(),
  }),
});

type CommunicationSnapshot = z.infer<typeof communicationContentSnapshotSchema>;

type ClaimedCommunication = {
  kind: "transactional" | "optional";
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
};

type CommunicationDelivery = {
  id: string;
  personId: string | null;
  address: string;
  name: string;
  idempotencyKey: string;
  sourceValuesJson: string;
};

const sourceMergeValuesSchema = z.record(
  z.string(),
  z.union([z.string(), z.number(), z.null()]),
);

export async function deliverCommunicationBatch(input: {
  env: CloudflareEnvironment;
  message: CommunicationSendMessage;
  communication: ClaimedCommunication;
  snapshot: CommunicationSnapshot;
  deliveries: { results: CommunicationDelivery[] };
  claimToken: string;
  provider: EmailProvider;
}) {
  const {
    env,
    message,
    communication,
    snapshot,
    deliveries,
    claimToken,
    provider,
  } = input;
  for (const delivery of deliveries.results) {
    await renewOperationClaim(
      env,
      { organisationId: message.organisationId, eventId: message.eventId },
      message.operationId,
      claimToken,
    );
    if (snapshot.category === "accepted_speaker_invitation") {
      const invitationAuthority = await env.DB.batch([
        env.DB.prepare(
          `UPDATE communication_deliveries
              SET status = 'suppressed', failure_code = 'invitation_unavailable',
                  failure_message = 'Speaker invitation is no longer pending.',
                  next_attempt_at = NULL, updated_at = unixepoch()
            WHERE id = ? AND communication_id = ? AND event_id = ?
              AND status IN ('queued','failed','sending')
              AND NOT EXISTS (
                SELECT 1 FROM memberships membership
                 WHERE membership.id = communication_deliveries.source_id
                   AND membership.organisation_id = ?
                   AND membership.event_id = communication_deliveries.event_id
                   AND membership.person_id = communication_deliveries.person_id
                   AND membership.role = 'speaker'
                   AND membership.accepted_at IS NULL
                   AND membership.revoked_at IS NULL
                   AND membership.invitation_expires_at > unixepoch()
              )
              AND EXISTS (
                SELECT 1 FROM communications claimed_communication
                JOIN operation_jobs claimed_operation
                  ON claimed_operation.id = claimed_communication.operation_id
                 AND claimed_operation.event_id = claimed_communication.event_id
                 WHERE claimed_communication.id = communication_deliveries.communication_id
                   AND claimed_communication.event_id = communication_deliveries.event_id
                   AND claimed_communication.status = 'sending'
                   AND claimed_operation.status = 'running'
                   AND claimed_operation.claim_token = ?
              )`,
        ).bind(
          delivery.id,
          message.communicationId,
          message.eventId,
          message.organisationId,
          claimToken,
        ),
        env.DB.prepare(
          `UPDATE operation_items
              SET status = 'skipped',
                  result_json = json_object('reason', 'invitation_unavailable'),
                  completed_at = unixepoch(), updated_at = unixepoch()
            WHERE operation_id = ? AND entity_id = ?
              AND status IN ('pending','failed','running')
              AND EXISTS (
                SELECT 1 FROM communication_deliveries suppressed_delivery
                JOIN operation_jobs claimed_operation
                  ON claimed_operation.id = operation_items.operation_id
                 WHERE suppressed_delivery.id = operation_items.entity_id
                   AND suppressed_delivery.communication_id = ?
                   AND suppressed_delivery.event_id = ?
                   AND suppressed_delivery.status = 'suppressed'
                   AND suppressed_delivery.failure_code = 'invitation_unavailable'
                   AND claimed_operation.status = 'running'
                   AND claimed_operation.claim_token = ?
              )`,
        ).bind(
          message.operationId,
          delivery.id,
          message.communicationId,
          message.eventId,
          claimToken,
        ),
      ]);
      if ((invitationAuthority[0].meta.changes ?? 0) === 1) {
        if ((invitationAuthority[1].meta.changes ?? 0) !== 1) {
          throw new Error(
            "The unavailable speaker invitation could not be recorded consistently.",
          );
        }
        continue;
      }
    }
    const deliveryClaimResults = await env.DB.batch([
      env.DB.prepare(
        `
      UPDATE communication_deliveries
         SET status = 'suppressed', failure_code = 'recipient_unsubscribed',
             failure_message = 'Recipient unsubscribed before provider delivery.',
             next_attempt_at = NULL, updated_at = unixepoch()
       WHERE id = ? AND communication_id = ? AND event_id = ? AND status IN ('queued','failed','sending')
         AND EXISTS (
           SELECT 1 FROM communication_unsubscribes u
            WHERE u.event_id = communication_deliveries.event_id
              AND lower(u.address) = lower(communication_deliveries.recipient_address)
              AND u.revoked_at IS NULL
              AND (u.category = '*' OR (? = 'optional' AND u.category = ?))
         )
         AND EXISTS (
           SELECT 1 FROM communications claimed_communication
           JOIN operation_jobs claimed_operation
             ON claimed_operation.id = claimed_communication.operation_id
            AND claimed_operation.event_id = claimed_communication.event_id
            WHERE claimed_communication.id = communication_deliveries.communication_id
              AND claimed_communication.event_id = communication_deliveries.event_id
              AND claimed_communication.operation_id = ?
              AND claimed_communication.status = 'sending'
              AND claimed_operation.status = 'running'
              AND claimed_operation.claim_token = ?
         )
    `,
      ).bind(
        delivery.id,
        message.communicationId,
        message.eventId,
        communication.kind,
        snapshot.category,
        message.operationId,
        claimToken,
      ),
      env.DB.prepare(
        `
      UPDATE operation_items
         SET status = 'skipped', result_json = json_object('reason', 'recipient_unsubscribed'),
             completed_at = unixepoch(), updated_at = unixepoch()
       WHERE operation_id = ? AND entity_id = ? AND status IN ('pending','failed','running')
         AND EXISTS (
           SELECT 1 FROM communication_deliveries suppressed_delivery
           JOIN operation_jobs claimed_operation ON claimed_operation.id = operation_items.operation_id
            WHERE suppressed_delivery.id = operation_items.entity_id
              AND suppressed_delivery.communication_id = ?
              AND suppressed_delivery.event_id = ?
              AND suppressed_delivery.status = 'suppressed'
              AND suppressed_delivery.failure_code = 'recipient_unsubscribed'
              AND claimed_operation.status = 'running'
              AND claimed_operation.claim_token = ?
         )
    `,
      ).bind(
        message.operationId,
        delivery.id,
        message.communicationId,
        message.eventId,
        claimToken,
      ),
      env.DB.prepare(
        `
      UPDATE communication_deliveries
         SET status = 'sending', attempt_count = attempt_count + 1,
             failure_code = NULL, failure_message = NULL, updated_at = unixepoch()
       WHERE id = ? AND communication_id = ? AND event_id = ? AND status IN ('queued','failed','sending')
         AND NOT EXISTS (
             SELECT 1 FROM communication_unsubscribes u
              WHERE u.event_id = communication_deliveries.event_id
                AND lower(u.address) = lower(communication_deliveries.recipient_address)
                AND u.revoked_at IS NULL
                AND (u.category = '*' OR (? = 'optional' AND u.category = ?))
         )
         AND EXISTS (
           SELECT 1 FROM communications claimed_communication
           JOIN operation_jobs claimed_operation
             ON claimed_operation.id = claimed_communication.operation_id
            AND claimed_operation.event_id = claimed_communication.event_id
            WHERE claimed_communication.id = communication_deliveries.communication_id
              AND claimed_communication.event_id = communication_deliveries.event_id
              AND claimed_communication.operation_id = ?
              AND claimed_communication.status = 'sending'
              AND claimed_operation.status = 'running'
              AND claimed_operation.claim_token = ?
         )
    `,
      ).bind(
        delivery.id,
        message.communicationId,
        message.eventId,
        communication.kind,
        snapshot.category,
        message.operationId,
        claimToken,
      ),
      env.DB.prepare(
        `
      UPDATE operation_items
         SET status = 'running', attempt_count = attempt_count + 1,
             started_at = COALESCE(started_at, unixepoch()), completed_at = NULL,
             error_code = NULL, error_message = NULL, updated_at = unixepoch()
       WHERE operation_id = ? AND entity_id = ? AND status IN ('pending','failed','running')
         AND EXISTS (
           SELECT 1 FROM communication_deliveries claimed_delivery
           JOIN operation_jobs claimed_operation ON claimed_operation.id = operation_items.operation_id
            WHERE claimed_delivery.id = operation_items.entity_id
              AND claimed_delivery.communication_id = ?
              AND claimed_delivery.event_id = ?
              AND claimed_delivery.status = 'sending'
              AND claimed_operation.status = 'running'
              AND claimed_operation.claim_token = ?
         )
    `,
      ).bind(
        message.operationId,
        delivery.id,
        message.communicationId,
        message.eventId,
        claimToken,
      ),
    ]);
    if ((deliveryClaimResults[0].meta.changes ?? 0) === 1) {
      if ((deliveryClaimResults[1].meta.changes ?? 0) !== 1) {
        throw new Error(
          "The recipient suppression could not be recorded consistently.",
        );
      }
      continue;
    }
    if ((deliveryClaimResults[2].meta.changes ?? 0) !== 1) {
      await assertOperationClaim(
        env,
        message.operationId,
        message.eventId,
        claimToken,
      );
      throw new Error(
        "The communication delivery could not be claimed while its operation remained active.",
      );
    }
    if ((deliveryClaimResults[3].meta.changes ?? 0) !== 1) {
      throw new Error(
        "The communication operation item could not be claimed consistently with its delivery.",
      );
    }
    try {
      const values = {
        "recipient.name": delivery.name,
        "recipient.firstName":
          delivery.name.trim().split(/\s+/)[0] || delivery.name,
        "event.name": snapshot.event.eventName,
        "event.dates": formatEventDateMarkers(
          snapshot.event.startsAt,
          snapshot.event.endsAt,
        ),
        ...sourceMergeValuesSchema.parse(JSON.parse(delivery.sourceValuesJson)),
      };
      const subject = renderMergeTemplate(snapshot.subjectTemplate, values);
      const body = renderMergeTemplate(snapshot.content.body, values);
      const rendered = await renderProgramCueEmail({
        preview: subject,
        heading: subject,
        body,
        eventName: snapshot.event.eventName,
        accent: snapshot.event.brandAccent,
        physicalAddress: snapshot.content.physicalAddress,
        buttonText: snapshot.content.buttonText,
        buttonUrl: snapshot.content.buttonUrl,
        unsubscribeUrl:
          communication.kind === "optional"
            ? await createCommunicationUnsubscribeUrl(env, delivery.id)
            : undefined,
      });
      const result = await provider.send({
        from: `${communication.fromName} <${communication.fromEmail}>`,
        replyTo: communication.replyToEmail,
        to: delivery.address,
        subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: delivery.idempotencyKey,
        tags: [TRACKED_DELIVERY_EMAIL_TAG],
      });
      const deliveryCompletionResults = await env.DB.batch([
        env.DB.prepare(
          `UPDATE communication_deliveries SET status = 'sent', provider_message_id = ?,
        failure_code = NULL, failure_message = NULL, updated_at = unixepoch()
        WHERE id = ? AND communication_id = ? AND event_id = ? AND status = 'sending'
          AND EXISTS (
            SELECT 1 FROM communications claimed_communication
            JOIN operation_jobs claimed_operation
              ON claimed_operation.id = claimed_communication.operation_id
             AND claimed_operation.event_id = claimed_communication.event_id
             WHERE claimed_communication.id = communication_deliveries.communication_id
               AND claimed_communication.event_id = communication_deliveries.event_id
               AND claimed_communication.operation_id = ?
               AND claimed_communication.status = 'sending'
               AND claimed_operation.status = 'running'
               AND claimed_operation.claim_token = ?
          )`,
        ).bind(
          result.messageId,
          delivery.id,
          message.communicationId,
          message.eventId,
          message.operationId,
          claimToken,
        ),
        env.DB.prepare(
          `UPDATE operation_items SET status = 'completed', result_json = ?, completed_at = unixepoch(),
        updated_at = unixepoch() WHERE operation_id = ? AND entity_id = ? AND status = 'running'
          AND EXISTS (
            SELECT 1 FROM communication_deliveries completed_delivery
            JOIN operation_jobs claimed_operation ON claimed_operation.id = operation_items.operation_id
             WHERE completed_delivery.id = operation_items.entity_id
               AND completed_delivery.communication_id = ?
               AND completed_delivery.event_id = ?
               AND completed_delivery.status = 'sent'
               AND completed_delivery.provider_message_id = ?
               AND claimed_operation.status = 'running'
               AND claimed_operation.claim_token = ?
          )`,
        ).bind(
          JSON.stringify({
            provider: provider.name,
            providerMessageId: result.messageId,
          }),
          message.operationId,
          delivery.id,
          message.communicationId,
          message.eventId,
          result.messageId,
          claimToken,
        ),
      ]);
      if ((deliveryCompletionResults[0].meta.changes ?? 0) !== 1) {
        throw new Error(
          "The delivery send claim changed before the provider result could be recorded.",
        );
      }
      if ((deliveryCompletionResults[1].meta.changes ?? 0) !== 1) {
        throw new Error(
          "The communication operation item could not record the provider result consistently.",
        );
      }
    } catch (error) {
      const failure = errorDetails(error);
      const failureResults = await env.DB.batch([
        env.DB.prepare(
          `UPDATE communication_deliveries SET status = 'failed', failure_code = ?, failure_message = ?,
        next_attempt_at = unixepoch() + 60, updated_at = unixepoch()
        WHERE id = ? AND communication_id = ? AND event_id = ? AND status = 'sending'
          AND EXISTS (
            SELECT 1 FROM communications claimed_communication
            JOIN operation_jobs claimed_operation
              ON claimed_operation.id = claimed_communication.operation_id
             AND claimed_operation.event_id = claimed_communication.event_id
             WHERE claimed_communication.id = communication_deliveries.communication_id
               AND claimed_communication.event_id = communication_deliveries.event_id
               AND claimed_communication.operation_id = ?
               AND claimed_communication.status = 'sending'
               AND claimed_operation.status = 'running'
               AND claimed_operation.claim_token = ?
          )`,
        ).bind(
          failure.code,
          failure.message,
          delivery.id,
          message.communicationId,
          message.eventId,
          message.operationId,
          claimToken,
        ),
        env.DB.prepare(
          `UPDATE operation_items SET status = 'failed', error_code = ?, error_message = ?,
        completed_at = unixepoch(), updated_at = unixepoch()
        WHERE operation_id = ? AND entity_id = ? AND status = 'running'
          AND EXISTS (
            SELECT 1 FROM communication_deliveries failed_delivery
            JOIN operation_jobs claimed_operation ON claimed_operation.id = operation_items.operation_id
             WHERE failed_delivery.id = operation_items.entity_id
               AND failed_delivery.communication_id = ?
               AND failed_delivery.event_id = ?
               AND failed_delivery.status = 'failed'
               AND claimed_operation.status = 'running'
               AND claimed_operation.claim_token = ?
          )`,
        ).bind(
          failure.code,
          failure.message,
          message.operationId,
          delivery.id,
          message.communicationId,
          message.eventId,
          claimToken,
        ),
      ]);
      if ((failureResults[0].meta.changes ?? 0) !== 1) {
        await assertOperationClaim(
          env,
          message.operationId,
          message.eventId,
          claimToken,
        );
        throw error;
      }
      if ((failureResults[1].meta.changes ?? 0) !== 1) {
        throw new Error(
          "The communication operation item could not record the delivery failure consistently.",
        );
      }
    }
  }
}
