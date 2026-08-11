import { requiresProductionSecurity } from "~/platform/runtime-environment.server";
import { requireEmailProviderConfiguration } from "~/modules/communications/email-provider.server";
import { hashApplicantToken } from "./applicant-session.server";
import { SubmissionStateError } from "./submission-repository-shared";

export type CoSpeakerQueueMessage = {
  type: "communication.send";
  operationId: string;
  communicationId: string;
  eventId: string;
  organisationId: string;
  idempotencyKey: string;
};

export type CoSpeakerInvitationPlan = {
  speakerId: string;
  claimUrl: string;
  operationId: string;
  communicationId: string;
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
  if (!context.physicalAddress.trim()) {
    throw new SubmissionStateError(
      "Configure the event venue or mailing address before co-speaker invitations can be created.",
    );
  }
  let emailProvider;
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
  const operationId = crypto.randomUUID();
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
         id, organisation_id, event_id, actor_person_id, action, entity_type,
         entity_id, correlation_id, metadata_json, created_at
       ) SELECT ?, ?, ?, ?, 'submission.speaker.invitation.queued',
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
  const internalMessage = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 2_000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND status = 'queued'`,
    ).bind(internalMessage, plan.operationId, plan.message.eventId),
    env.DB.prepare(
      `UPDATE communications SET status = 'failed', updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND operation_id = ? AND status = 'queued'`,
    ).bind(plan.communicationId, plan.message.eventId, plan.operationId),
    env.DB.prepare(
      `UPDATE submission_speakers
          SET invitation_status = 'pending', updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND claim_token_hash = ?
          AND invitation_status = 'sent'`,
    ).bind(plan.speakerId, plan.message.eventId, plan.tokenHash),
  ]);
}
