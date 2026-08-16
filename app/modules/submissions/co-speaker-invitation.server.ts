import { z } from "zod";
import { emailDeliveryIssue } from "~/modules/communications/email-deliverability";
import { requiresProductionSecurity } from "~/platform/runtime-environment.server";
import { requireEmailProviderConfiguration } from "~/modules/communications/email-provider.server";
import { hashApplicantToken } from "./applicant-session.server";
import { SubmissionStateError } from "./submission-repository-shared";

const coSpeakerQueueMessageSchema = z
  .object({
    type: z.literal("communication.send"),
    operationId: z.string().min(1).max(200),
    communicationId: z.string().min(1).max(200),
    eventId: z.string().min(1).max(200),
    organisationId: z.string().min(1).max(200),
    idempotencyKey: z.string().min(8).max(300),
  })
  .strict();

export type CoSpeakerQueueMessage = z.infer<typeof coSpeakerQueueMessageSchema>;

export function parseCoSpeakerQueueMessage(
  payloadJson: string,
  expected: {
    operationId: string;
    communicationId: string;
    eventId: string;
    organisationId: string;
    idempotencyKey: string;
  },
) {
  let input: unknown;
  try {
    input = JSON.parse(payloadJson);
  } catch {
    throw new Error(
      "The persisted co-speaker invitation operation contains invalid JSON.",
    );
  }
  const result = coSpeakerQueueMessageSchema.safeParse(input);
  if (!result.success) {
    throw new Error(
      "The persisted co-speaker invitation operation has an invalid queue payload.",
    );
  }
  if (
    result.data.operationId !== expected.operationId ||
    result.data.communicationId !== expected.communicationId ||
    result.data.eventId !== expected.eventId ||
    result.data.organisationId !== expected.organisationId ||
    result.data.idempotencyKey !== expected.idempotencyKey
  ) {
    throw new Error(
      "The persisted co-speaker invitation queue payload does not match its authoritative operation.",
    );
  }
  return result.data;
}

export type CoSpeakerInvitationPlan = {
  speakerId: string;
  claimUrl: string;
  operationId: string;
  communicationId: string;
  deliveryId: string;
  tokenHash: string;
  previousTokenHash: string | null;
  message: CoSpeakerQueueMessage;
  statements: D1PreparedStatement[];
};

type InvitationContext = {
  organisationId: string;
  eventId: string;
  eventName: string;
  brandAccent: string;
  startsAt: number;
  endsAt: number;
  physicalAddress: string;
  formId: string;
  publicSlug: string;
  submissionId: string;
  submissionTitle: string;
  requestedByPersonId: string;
  submissionOperationId?: string;
  operationId?: string;
};

type InvitationSpeaker = {
  id: string;
  email: string;
  displayName: string;
  claimTokenHash: string | null;
};

function claimBaseUrl(env: CloudflareEnvironment) {
  const configured = env.BETTER_AUTH_URL?.trim();
  if (!configured) {
    throw new SubmissionStateError(
      "BETTER_AUTH_URL is required to create co-speaker claim links.",
    );
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    throw new SubmissionStateError(
      "BETTER_AUTH_URL must be a valid absolute URL before co-speaker invitations can be created.",
    );
  }
  if (requiresProductionSecurity(env.APP_ENV) && url.protocol !== "https:") {
    throw new SubmissionStateError(
      "BETTER_AUTH_URL must use HTTPS before production co-speaker invitations can be created.",
    );
  }
  return url;
}

export async function buildCoSpeakerInvitationPlan(
  env: CloudflareEnvironment,
  context: InvitationContext,
  speaker: InvitationSpeaker,
): Promise<CoSpeakerInvitationPlan> {
  const deliveryIssue = emailDeliveryIssue(speaker.email, env.APP_ENV);
  if (deliveryIssue) {
    throw new SubmissionStateError(
      `The co-speaker invitation email address is not deliverable: ${deliveryIssue.toLowerCase()}.`,
    );
  }
  if (!context.physicalAddress.trim()) {
    throw new SubmissionStateError(
      "Configure the event venue or mailing address before co-speaker invitations can be created.",
    );
  }
  let emailProvider: ReturnType<typeof requireEmailProviderConfiguration>;
  try {
    emailProvider = requireEmailProviderConfiguration(env);
  } catch (error) {
    throw new SubmissionStateError(
      error instanceof Error
        ? error.message
        : "Email provider configuration is invalid.",
    );
  }
  const rawToken = crypto.randomUUID() + crypto.randomUUID();
  const tokenHash = await hashApplicantToken(
    `co-speaker-claim:${context.formId}:${speaker.id}:${rawToken}`,
  );
  const claimUrl = new URL(
    `/apply/${encodeURIComponent(context.publicSlug)}`,
    claimBaseUrl(env),
  );
  claimUrl.searchParams.set("claim", rawToken);
  claimUrl.searchParams.set("speaker", speaker.id);

  const sender = await env.DB.prepare(
    `SELECT id FROM sender_profiles
      WHERE event_id = ? AND provider = ? AND status = 'verified'
      ORDER BY updated_at DESC LIMIT 1`,
  )
    .bind(context.eventId, emailProvider.provider)
    .first<{ id: string }>();
  if (!sender) {
    throw new SubmissionStateError(
      "A verified sender profile is required before co-speaker invitations can be created.",
    );
  }
  const operationId = context.operationId ?? crypto.randomUUID();
  const communicationId = crypto.randomUUID();
  const deliveryId = crypto.randomUUID();
  const idempotencyKey = `co-speaker:${speaker.id}:${tokenHash.slice(0, 20)}`;
  const message: CoSpeakerQueueMessage = {
    type: "communication.send",
    operationId,
    communicationId,
    eventId: context.eventId,
    organisationId: context.organisationId,
    idempotencyKey,
  };
  const finalisedSubmission = context.submissionOperationId
    ? `AND EXISTS (
         SELECT 1 FROM submissions finalised
          WHERE finalised.id = speaker.submission_id
            AND finalised.event_id = speaker.event_id
            AND finalised.last_operation_id = ?
            AND finalised.status <> 'draft'
       )`
    : "";
  const finalisedBindings = context.submissionOperationId
    ? [context.submissionOperationId]
    : [];
  const audience = {
    type: "co_speaker_invitation",
    submissionId: context.submissionId,
    speakerId: speaker.id,
    emails: [speaker.email],
    ...(context.submissionOperationId
      ? { submissionOperationId: context.submissionOperationId }
      : {}),
  };
  const contentSnapshot = {
    schemaVersion: 1,
    category: "co_speaker_invitation",
    subjectTemplate: "Join {{submission.title}} as a co-speaker",
    content: {
      body: "Hi {{recipient.firstName}},\n\nYou have been invited to join {{submission.title}} as a co-speaker. This private claim link expires in 14 days:\n\n{{claim.url}}",
      physicalAddress: context.physicalAddress,
    },
    event: {
      eventName: context.eventName,
      brandAccent: context.brandAccent,
      startsAt: context.startsAt,
      endsAt: context.endsAt,
    },
  };
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `UPDATE submission_speakers AS speaker
          SET claim_token_hash = ?, invitation_expires_at = unixepoch() + 1209600,
              invitation_status = 'sent', invited_at = unixepoch(), updated_at = unixepoch()
        WHERE speaker.id = ? AND speaker.event_id = ? AND speaker.submission_id = ?
          AND speaker.is_primary = 0
          AND speaker.invitation_status IN ('pending','sent','expired')
          AND speaker.claim_token_hash IS ?
          ${finalisedSubmission}`,
    ).bind(
      tokenHash,
      speaker.id,
      context.eventId,
      context.submissionId,
      speaker.claimTokenHash,
      ...finalisedBindings,
    ),
    env.DB.prepare(
      `INSERT INTO communications (
         id, event_id, sender_profile_id, operation_id, idempotency_key, kind,
         channel, status, audience_json, content_snapshot_json, recipient_count,
         queued_at, created_by_person_id, created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, 'transactional', 'email', 'queued', ?, ?, 1,
                unixepoch(), ?, unixepoch(), unixepoch()
           FROM submission_speakers speaker
          WHERE speaker.id = ? AND speaker.event_id = ?
            AND speaker.claim_token_hash = ? AND speaker.invitation_status = 'sent'`,
    ).bind(
      communicationId,
      context.eventId,
      sender.id,
      operationId,
      idempotencyKey,
      JSON.stringify(audience),
      JSON.stringify(contentSnapshot),
      context.requestedByPersonId,
      speaker.id,
      context.eventId,
      tokenHash,
    ),
    env.DB.prepare(
      `INSERT INTO communication_deliveries (
         id, event_id, communication_id, recipient_address, recipient_name,
         source_id, source_values_json, channel, provider, idempotency_key,
         status, created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, ?, ?, 'email', ?, ?, 'queued',
                unixepoch(), unixepoch()
           FROM communications communication
          WHERE communication.id = ? AND communication.event_id = ?
            AND communication.operation_id = ?`,
    ).bind(
      deliveryId,
      context.eventId,
      communicationId,
      speaker.email,
      speaker.displayName,
      speaker.id,
      JSON.stringify({
        "submission.title": context.submissionTitle,
        "claim.url": claimUrl.toString(),
      }),
      emailProvider.provider,
      `${idempotencyKey}:${speaker.email}`,
      communicationId,
      context.eventId,
      operationId,
    ),
    env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json, progress_total,
         progress_completed, progress_failed, cancellable, created_at, updated_at
       ) SELECT ?, ?, ?, ?, 'communication.send', ?, ?, 'queued', ?, 1, 0, 0, 0,
                unixepoch(), unixepoch()
           FROM communications communication
          WHERE communication.id = ? AND communication.event_id = ?
            AND communication.operation_id = ?`,
    ).bind(
      operationId,
      context.organisationId,
      context.eventId,
      context.requestedByPersonId,
      idempotencyKey,
      crypto.randomUUID(),
      JSON.stringify(message),
      communicationId,
      context.eventId,
      operationId,
    ),
    env.DB.prepare(
      `INSERT INTO operation_items (
         id, operation_id, item_key, entity_type, entity_id, status, updated_at
       ) SELECT ?, ?, ?, 'communication_delivery', ?, 'pending', unixepoch()
           FROM operation_jobs operation
          WHERE operation.id = ? AND operation.event_id = ?`,
    ).bind(
      crypto.randomUUID(),
      operationId,
      `${idempotencyKey}:${speaker.email}`,
      deliveryId,
      operationId,
      context.eventId,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type,
         entity_id, correlation_id, metadata_json, created_at
       ) SELECT ?, 'person', 'public_form', 1, ?, ?, ?, 'submission.speaker.invitation.queued',
                'submission_speaker', ?, ?, ?, unixepoch()
           FROM operation_jobs operation
          WHERE operation.id = ? AND operation.event_id = ?`,
    ).bind(
      crypto.randomUUID(),
      context.organisationId,
      context.eventId,
      context.requestedByPersonId,
      speaker.id,
      operationId,
      JSON.stringify({
        communicationId,
        expiresInSeconds: 1_209_600,
      }),
      operationId,
      context.eventId,
    ),
  ];
  return {
    speakerId: speaker.id,
    claimUrl: claimUrl.toString(),
    operationId,
    communicationId,
    deliveryId,
    tokenHash,
    previousTokenHash: speaker.claimTokenHash,
    message,
    statements,
  };
}

export async function persistQueueFailure(
  env: CloudflareEnvironment,
  plan: CoSpeakerInvitationPlan,
  error: unknown,
) {
  return persistCoSpeakerQueueFailure(
    env,
    {
      organisationId: plan.message.organisationId,
      eventId: plan.message.eventId,
      operationId: plan.operationId,
      communicationId: plan.communicationId,
      deliveryId: plan.deliveryId,
      speakerId: plan.speakerId,
      tokenHash: plan.tokenHash,
    },
    error,
  );
}

export async function persistCoSpeakerQueueFailure(
  env: CloudflareEnvironment,
  reference: {
    organisationId: string;
    eventId: string;
    operationId: string;
    communicationId: string;
    deliveryId: string;
    speakerId: string;
    tokenHash: string;
  },
  error: unknown,
) {
  const internalMessage = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 2_000);
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
        WHERE id = ? AND organisation_id = ? AND event_id = ?
          AND status = 'queued'`,
    ).bind(
      internalMessage,
      reference.operationId,
      reference.organisationId,
      reference.eventId,
    ),
    env.DB.prepare(
      `UPDATE operation_items
          SET status = 'failed', error_code = 'QUEUE_UNAVAILABLE',
              error_message = ?, completed_at = unixepoch(),
              updated_at = unixepoch()
        WHERE operation_id = ? AND entity_type = 'communication_delivery'
          AND entity_id = ? AND status = 'pending'`,
    ).bind(internalMessage, reference.operationId, reference.deliveryId),
    env.DB.prepare(
      `UPDATE communications SET status = 'failed', updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND operation_id = ? AND status = 'queued'`,
    ).bind(reference.communicationId, reference.eventId, reference.operationId),
    env.DB.prepare(
      `UPDATE communication_deliveries
          SET status = 'failed', failure_code = 'QUEUE_UNAVAILABLE',
              failure_message = ?, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND communication_id = ?
          AND source_id = ? AND status = 'queued'`,
    ).bind(
      internalMessage,
      reference.deliveryId,
      reference.eventId,
      reference.communicationId,
      reference.speakerId,
    ),
    env.DB.prepare(
      `UPDATE submission_speakers
          SET invitation_status = 'pending', updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND claim_token_hash = ?
          AND invitation_status = 'sent'`,
    ).bind(reference.speakerId, reference.eventId, reference.tokenHash),
  ]);
  if (results.some((result) => (result.meta.changes ?? 0) !== 1)) {
    throw new Error(
      "The persisted co-speaker invitation queue failure was inconsistent.",
    );
  }
}

export async function dispatchCoSpeakerInvitationsForSubmissionRevision(input: {
  env: CloudflareEnvironment;
  organisationId: string;
  eventId: string;
  submissionId: string;
  commandId: string;
  expectedCount: number;
}) {
  const operations = await input.env.DB.prepare(
    `SELECT operation.id AS operationId, operation.status,
            operation.payload_json AS payloadJson,
            operation.idempotency_key AS operationIdempotencyKey,
            operation.dispatched_at AS dispatchedAt,
            communication.id AS communicationId,
            delivery.id AS deliveryId,
            speaker.id AS speakerId,
            speaker.claim_token_hash AS claimTokenHash
       FROM operation_jobs operation
       JOIN communications communication
         ON communication.operation_id = operation.id
        AND communication.event_id = operation.event_id
       JOIN communication_deliveries delivery
         ON delivery.communication_id = communication.id
        AND delivery.event_id = communication.event_id
       JOIN submission_speakers speaker
         ON speaker.id = delivery.source_id
        AND speaker.event_id = delivery.event_id
       JOIN submissions submission
         ON submission.id = speaker.submission_id
        AND submission.event_id = speaker.event_id
       JOIN events event
         ON event.id = submission.event_id
        AND event.organisation_id = operation.organisation_id
      WHERE operation.organisation_id = ? AND operation.event_id = ?
        AND operation.type = 'communication.send'
        AND submission.id = ?
        AND json_extract(communication.audience_json, '$.type') =
            'co_speaker_invitation'
        AND json_extract(communication.audience_json,
                         '$.submissionOperationId') = ?
      ORDER BY operation.id`,
  )
    .bind(
      input.organisationId,
      input.eventId,
      input.submissionId,
      input.commandId,
    )
    .all<{
      operationId: string;
      status: string;
      payloadJson: string;
      operationIdempotencyKey: string;
      dispatchedAt: number | null;
      communicationId: string;
      deliveryId: string;
      speakerId: string;
      claimTokenHash: string | null;
    }>();
  if (operations.results.length !== input.expectedCount) {
    throw new Error(
      "The committed submission revision is missing a durable co-speaker invitation operation.",
    );
  }

  let queueFailed = 0;
  for (const operation of operations.results) {
    if (
      ["queue_failed", "partially_failed", "failed", "cancelled"].includes(
        operation.status,
      )
    ) {
      queueFailed += 1;
      continue;
    }
    if (
      !["queued", "received", "running", "retrying", "completed"].includes(
        operation.status,
      )
    ) {
      throw new Error(
        `The committed co-speaker invitation has unsupported status ${JSON.stringify(operation.status)}.`,
      );
    }
    if (operation.status !== "queued" || operation.dispatchedAt !== null) {
      continue;
    }
    if (!input.env.OPERATIONS_QUEUE) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }
    const message = parseCoSpeakerQueueMessage(operation.payloadJson, {
      operationId: operation.operationId,
      communicationId: operation.communicationId,
      eventId: input.eventId,
      organisationId: input.organisationId,
      idempotencyKey: operation.operationIdempotencyKey,
    });
    try {
      await input.env.OPERATIONS_QUEUE.send(message);
    } catch (error) {
      if (!operation.claimTokenHash) {
        throw new Error(
          "The queued co-speaker invitation is missing its claim token hash.",
        );
      }
      await persistCoSpeakerQueueFailure(
        input.env,
        {
          organisationId: input.organisationId,
          eventId: input.eventId,
          operationId: operation.operationId,
          communicationId: operation.communicationId,
          deliveryId: operation.deliveryId,
          speakerId: operation.speakerId,
          tokenHash: operation.claimTokenHash,
        },
        error,
      );
      queueFailed += 1;
      continue;
    }
    const dispatched = await input.env.DB.prepare(
      `UPDATE operation_jobs
          SET dispatched_at = COALESCE(dispatched_at, unixepoch()),
              updated_at = unixepoch()
        WHERE id = ? AND organisation_id = ? AND event_id = ?
          AND type = 'communication.send' AND status = 'queued'
          AND dispatched_at IS NULL`,
    )
      .bind(operation.operationId, input.organisationId, input.eventId)
      .run();
    if ((dispatched.meta.changes ?? 0) !== 1) {
      const converged = await input.env.DB.prepare(
        `SELECT dispatched_at AS dispatchedAt
           FROM operation_jobs
          WHERE id = ? AND organisation_id = ? AND event_id = ?
            AND type = 'communication.send'`,
      )
        .bind(operation.operationId, input.organisationId, input.eventId)
        .first<{ dispatchedAt: number | null }>();
      if (!converged?.dispatchedAt) {
        throw new Error(
          "The co-speaker invitation dispatch could not be recorded consistently.",
        );
      }
    }
  }
  return {
    queued: operations.results.length - queueFailed,
    queueFailed,
  };
}
