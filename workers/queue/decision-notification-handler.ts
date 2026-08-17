import { z } from "zod";

import { communicationContentSnapshotSchema } from "./communication-delivery-batch";
import { processCommunicationSend } from "./communication-send";
import type { QueueProviderDependencies } from "./handler-types";

const legacyDecisionNotificationMessageSchema = z
  .object({
    type: z.literal("decision.notification"),
    operationId: z.string().min(1),
    eventId: z.string().min(1),
    organisationId: z.string().min(1),
    idempotencyKey: z.string().min(8),
    payload: z.object({ decisionId: z.string().min(1) }).strict(),
  })
  .strict();

const decisionNotificationMessageSchema =
  legacyDecisionNotificationMessageSchema
    .extend({ communicationId: z.string().min(1) })
    .strict();

const decisionNotificationAudienceSchema = z
  .object({
    type: z.literal("decision"),
    decisionId: z.string().min(1),
    submissionId: z.string().min(1),
    renderContractVersion: z.literal(1),
  })
  .strict();

const decisionNotificationContentSnapshotSchema =
  communicationContentSnapshotSchema
    .extend({
      renderContractVersion: z.literal(1),
      category: z.literal("decision"),
      template: z
        .object({
          id: z.string().min(1),
          name: z.string().min(1),
          versionNumber: z.number().int().positive(),
        })
        .strict(),
      sender: z
        .object({
          id: z.string().min(1),
          provider: z.enum(["resend", "mailpit"]),
          fromName: z.string().min(1),
          fromEmail: z.string().min(1),
          replyToEmail: z.string().nullable(),
        })
        .strict(),
    })
    .strict();

type DecisionNotificationOperation = {
  status: string;
  decisionStatus: string;
  payloadJson: string;
  audienceJson: string;
  contentSnapshotJson: string;
  templateVersionId: string | null;
  senderProfileId: string | null;
  recipientCount: number;
  submissionId: string;
};

type DecisionNotificationDelivery = {
  id: string;
  recipientAddress: string;
  recipientName: string | null;
  sourceId: string | null;
  provider: string | null;
  renderedSubject: string | null;
  renderedBodySha256: string | null;
  operationItemId: string | null;
};

function parsePinnedDecisionIntent(operation: DecisionNotificationOperation) {
  try {
    return {
      audience: decisionNotificationAudienceSchema.parse(
        JSON.parse(operation.audienceJson),
      ),
      snapshot: decisionNotificationContentSnapshotSchema.parse(
        JSON.parse(operation.contentSnapshotJson),
      ),
    };
  } catch {
    throw new Error(
      "The durable decision notification is missing its pinned render contract.",
    );
  }
}

async function isCancelledLegacyDecisionNotification(
  input: unknown,
  env: CloudflareEnvironment,
) {
  const parsed = legacyDecisionNotificationMessageSchema.safeParse(input);
  if (!parsed.success) return false;
  const operation = await env.DB.prepare(
    `SELECT operation.payload_json AS payloadJson
       FROM operation_jobs operation
       JOIN events event
         ON event.id = operation.event_id
        AND event.organisation_id = operation.organisation_id
       JOIN audit_events cancellation
         ON cancellation.organisation_id = operation.organisation_id
        AND cancellation.event_id = operation.event_id
        AND cancellation.action = 'decision.notification.legacy_cancelled'
        AND cancellation.entity_type = 'operation_job'
        AND cancellation.entity_id = operation.id
      WHERE operation.id = ? AND operation.event_id = ?
        AND operation.organisation_id = ?
        AND operation.type = 'decision.notification'
        AND operation.status = 'cancelled'`,
  )
    .bind(
      parsed.data.operationId,
      parsed.data.eventId,
      parsed.data.organisationId,
    )
    .first<{ payloadJson: string }>();
  if (!operation) return false;
  try {
    const saved = legacyDecisionNotificationMessageSchema.parse(
      JSON.parse(operation.payloadJson),
    );
    return JSON.stringify(saved) === JSON.stringify(parsed.data);
  } catch {
    return false;
  }
}

async function assertPinnedDecisionIntent(
  env: CloudflareEnvironment,
  message: z.infer<typeof decisionNotificationMessageSchema>,
  operation: DecisionNotificationOperation,
) {
  const { audience, snapshot } = parsePinnedDecisionIntent(operation);
  if (
    audience.decisionId !== message.payload.decisionId ||
    audience.submissionId !== operation.submissionId ||
    snapshot.template.id !== operation.templateVersionId ||
    snapshot.sender.id !== operation.senderProfileId ||
    operation.recipientCount !== 1
  ) {
    throw new Error(
      "The durable decision notification does not match its pinned communication intent.",
    );
  }
  const deliveries = await env.DB.prepare(
    `SELECT delivery.id,
            delivery.recipient_address AS recipientAddress,
            delivery.recipient_name AS recipientName,
            delivery.source_id AS sourceId,
            delivery.provider,
            delivery.rendered_subject AS renderedSubject,
            delivery.rendered_body_sha256 AS renderedBodySha256,
            operation_item.id AS operationItemId
       FROM communication_deliveries delivery
       LEFT JOIN operation_items operation_item
         ON operation_item.operation_id = ?
        AND operation_item.entity_type = 'communication_delivery'
        AND operation_item.entity_id = delivery.id
      WHERE delivery.communication_id = ? AND delivery.event_id = ?`,
  )
    .bind(message.operationId, message.communicationId, message.eventId)
    .all<DecisionNotificationDelivery>();
  const delivery = deliveries.results[0];
  if (
    deliveries.results.length !== 1 ||
    !delivery ||
    !delivery.operationItemId ||
    !delivery.recipientAddress.trim() ||
    !delivery.recipientName?.trim() ||
    delivery.sourceId !== audience.submissionId ||
    delivery.provider !== snapshot.sender.provider ||
    !delivery.renderedSubject?.trim() ||
    !delivery.renderedBodySha256?.match(/^[0-9a-f]{64}$/)
  ) {
    throw new Error(
      "The durable decision notification is missing its pinned recipient delivery evidence.",
    );
  }
}

/** Delivers the communication intent materialised atomically with release. */
export async function processDecisionNotification(
  input: unknown,
  env: CloudflareEnvironment,
  dependencies: QueueProviderDependencies = {},
) {
  const parsedMessage = decisionNotificationMessageSchema.safeParse(input);
  if (!parsedMessage.success) {
    if (await isCancelledLegacyDecisionNotification(input, env)) return;
    throw parsedMessage.error;
  }
  const message = parsedMessage.data;
  const operation = await env.DB.prepare(
    `SELECT operation.status, decision.status AS decisionStatus,
            operation.payload_json AS payloadJson,
            communication.audience_json AS audienceJson,
            communication.content_snapshot_json AS contentSnapshotJson,
            communication.template_version_id AS templateVersionId,
            communication.sender_profile_id AS senderProfileId,
            communication.recipient_count AS recipientCount,
            decision.submission_id AS submissionId
       FROM operation_jobs operation
       JOIN events event
         ON event.id = operation.event_id AND event.organisation_id = ?
       JOIN submission_decisions decision
         ON decision.notification_operation_id = operation.id
        AND decision.event_id = operation.event_id
        AND decision.id = ?
       JOIN communications communication
         ON communication.operation_id = operation.id
        AND communication.event_id = operation.event_id
        AND communication.id = ?
        AND json_extract(communication.audience_json, '$.type') = 'decision'
        AND json_extract(communication.audience_json, '$.decisionId') =
            decision.id
      WHERE operation.id = ? AND operation.event_id = ?
        AND operation.type = 'decision.notification'
        AND communication.idempotency_key = operation.idempotency_key`,
  )
    .bind(
      message.organisationId,
      message.payload.decisionId,
      message.communicationId,
      message.operationId,
      message.eventId,
    )
    .first<DecisionNotificationOperation>();
  if (!operation) {
    throw new Error(
      "Decision notification intent does not exist in the authorised event.",
    );
  }
  let savedMessage: z.infer<typeof decisionNotificationMessageSchema>;
  try {
    savedMessage = decisionNotificationMessageSchema.parse(
      JSON.parse(operation.payloadJson),
    );
  } catch {
    throw new Error("The durable decision notification payload is invalid.");
  }
  if (JSON.stringify(savedMessage) !== JSON.stringify(message)) {
    throw new Error(
      "The decision notification Queue message does not match its durable operation payload.",
    );
  }
  if (operation.status === "completed" || operation.status === "cancelled") {
    return;
  }
  if (operation.decisionStatus !== "published") {
    throw new Error(
      "The decision notification is active for a decision that is not released.",
    );
  }
  await assertPinnedDecisionIntent(env, message, operation);
  await processCommunicationSend(
    {
      type: "communication.send",
      operationId: message.operationId,
      communicationId: message.communicationId,
      eventId: message.eventId,
      organisationId: message.organisationId,
      idempotencyKey: message.idempotencyKey,
    },
    env,
    dependencies,
  );
}
