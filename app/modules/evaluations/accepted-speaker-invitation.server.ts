import { z } from "zod";
import { emailDeliveryIssue } from "~/modules/communications/email-deliverability";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  type AcceptedEvent,
  type AcceptedSpeakerInvitationMessage,
  type AcceptedSpeakerInvitationPlan,
  acceptedSpeakerInvitationReadiness,
  deterministicResendToken,
  magicLink,
  sha256Base64Url,
} from "./accepted-speaker-invitation-plan.server";
import {
  EvaluationDecisionAuthorityError,
  EvaluationStateError,
} from "./evaluation-errors";
export {
  prepareAcceptedSpeakerInvitationPlans,
  type AcceptedSpeakerInvitationMessage,
  type AcceptedSpeakerInvitationPlan,
} from "./accepted-speaker-invitation-plan.server";

const resendAcceptedSpeakerInvitationSchema = z
  .object({
    decisionId: z.string().trim().min(1).max(160),
    membershipId: z.string().trim().min(1).max(160),
    expectedExpiresAt: z.coerce.number().int().positive(),
  })
  .strict();

type ResendSpeakerRow = AcceptedEvent & {
  personId: string;
  email: string;
  membershipId: string;
  sessionId: string;
  decisionId: string;
  expiresAt: number;
};

export async function resendAcceptedSpeakerInvitation(input: {
  env: CloudflareEnvironment;
  viewer: Viewer;
  value: unknown;
}) {
  const { env, viewer } = input;
  if (viewer.role !== "owner" && viewer.role !== "administrator") {
    throw new EvaluationDecisionAuthorityError();
  }
  if (String(env.DEMO_MODE) === "true") {
    throw new EvaluationStateError(
      "Accepted-speaker invitation resend is unavailable in demonstration mode because no email is sent.",
    );
  }
  if (!env.OPERATIONS_QUEUE) {
    throw new EvaluationStateError(
      "Required OPERATIONS_QUEUE binding is unavailable; the speaker invitation was not renewed.",
    );
  }
  const parsed = resendAcceptedSpeakerInvitationSchema.parse(input.value);
  const speaker = await env.DB.prepare(
    `SELECT person.id AS personId, person.email,
            membership.id AS membershipId,
            membership.invitation_expires_at AS expiresAt,
            session.id AS sessionId, decision.id AS decisionId,
            event.name, event.brand_accent AS brandAccent,
            event.starts_at AS startsAt, event.ends_at AS endsAt,
            event.venue_name AS venueName, event.city
       FROM memberships membership
       JOIN events event
         ON event.id = membership.event_id
        AND event.organisation_id = membership.organisation_id
       JOIN people person ON person.id = membership.person_id
       JOIN session_speakers relationship
         ON relationship.event_id = membership.event_id
        AND relationship.person_id = membership.person_id
       JOIN sessions session
         ON session.id = relationship.session_id
        AND session.event_id = relationship.event_id
       JOIN submission_decisions decision
         ON decision.submission_id = session.source_submission_id
        AND decision.event_id = session.event_id
      WHERE membership.id = ? AND membership.organisation_id = ?
        AND membership.event_id = ? AND membership.role = 'speaker'
        AND membership.accepted_at IS NULL AND membership.revoked_at IS NULL
        AND membership.invitation_expires_at = ?
        AND decision.id = ? AND decision.status = 'published'
        AND decision.decision = 'accepted'`,
  )
    .bind(
      parsed.membershipId,
      viewer.organisationId,
      viewer.eventId,
      parsed.expectedExpiresAt,
      parsed.decisionId,
    )
    .first<ResendSpeakerRow>();
  if (!speaker) {
    const replayIdentity = (
      await sha256Base64Url(
        JSON.stringify([
          "resend",
          parsed.decisionId,
          parsed.membershipId,
          parsed.expectedExpiresAt,
        ]),
      )
    ).slice(0, 32);
    const replay = await env.DB.prepare(
      `SELECT operation.id AS operationId, operation.status,
              communication.id AS communicationId,
              membership.invitation_expires_at AS expiresAt
         FROM operation_jobs operation
         JOIN communications communication
           ON communication.operation_id = operation.id
          AND communication.event_id = operation.event_id
         JOIN memberships membership
           ON membership.id = ? AND membership.organisation_id = operation.organisation_id
          AND membership.event_id = operation.event_id
        WHERE operation.id = ? AND operation.organisation_id = ?
          AND operation.event_id = ?
          AND operation.type = 'communication.send'`,
    )
      .bind(
        parsed.membershipId,
        `asi-ro:${replayIdentity}`,
        viewer.organisationId,
        viewer.eventId,
      )
      .first<{
        operationId: string;
        communicationId: string;
        status: string;
        expiresAt: number;
      }>();
    if (replay) {
      if (replay.status === "cancelled") {
        throw new EvaluationStateError(
          "A newer speaker invitation replaced this renewal. Refresh before continuing.",
        );
      }
      return {
        ...replay,
        status:
          replay.status === "completed"
            ? ("sent" as const)
            : ["queue_failed", "failed", "partially_failed"].includes(
                  replay.status,
                )
              ? ("queue_failed" as const)
              : ("queued" as const),
        replayed: true,
      };
    }
    throw new EvaluationStateError(
      "The speaker invitation changed after this page loaded. Refresh before renewing it.",
    );
  }
  const deliveryIssue = emailDeliveryIssue(speaker.email, env.APP_ENV);
  if (deliveryIssue) {
    throw new EvaluationStateError(
      `The accepted speaker must have a deliverable email address before renewing the invitation: ${deliveryIssue.toLowerCase()}.`,
    );
  }
  const readiness = await acceptedSpeakerInvitationReadiness({
    env,
    organisationId: viewer.organisationId,
    eventId: viewer.eventId,
    event: speaker,
  });
  const authenticationSecret = env.BETTER_AUTH_SECRET;
  if (!authenticationSecret || authenticationSecret.length < 32) {
    throw new EvaluationStateError(
      "Authentication must be configured before accepted-speaker invitations can be queued.",
    );
  }
  const identity = (
    await sha256Base64Url(
      JSON.stringify([
        "resend",
        speaker.decisionId,
        speaker.membershipId,
        speaker.expiresAt,
      ]),
    )
  ).slice(0, 32);
  const originalIdentity = (
    await sha256Base64Url(
      JSON.stringify([speaker.decisionId, speaker.personId]),
    )
  ).slice(0, 32);
  const operationId = `asi-ro:${identity}`;
  const communicationId = `asi-rc:${identity}`;
  const deliveryId = `asi-rd:${identity}`;
  const verificationId = `asi-v:${originalIdentity}`;
  const idempotencyKey = `accepted-speaker-resend:${identity}`;
  const token = await deterministicResendToken(
    authenticationSecret,
    operationId,
  );
  const tokenHash = await sha256Base64Url(token);
  const url = magicLink(readiness.baseUrl, token, viewer.eventId);
  const message: AcceptedSpeakerInvitationMessage = {
    type: "communication.send",
    operationId,
    communicationId,
    eventId: viewer.eventId,
    organisationId: viewer.organisationId,
    idempotencyKey,
  };
  const contentSnapshot = {
    schemaVersion: 1,
    category: "accepted_speaker_invitation",
    subjectTemplate: `You are speaking at ${speaker.name}`,
    content: {
      body: `Your proposal has been accepted. Use this new one-time link to sign in to Program Cue and complete your speaker onboarding:\n\n${url.toString()}\n\nThis invitation expires in seven days. Any earlier link is no longer valid.`,
      physicalAddress: readiness.physicalAddress,
      ...(url.protocol === "https:"
        ? { buttonText: "Open speaker portal", buttonUrl: url.toString() }
        : {}),
    },
    event: {
      eventName: speaker.name,
      brandAccent: speaker.brandAccent,
      startsAt: speaker.startsAt,
      endsAt: speaker.endsAt,
    },
  };
  const audience = {
    type: "accepted_speaker_invitation",
    decisionId: speaker.decisionId,
    sessionId: speaker.sessionId,
    membershipId: speaker.membershipId,
  };
  const membershipGuard = `EXISTS (
    SELECT 1 FROM memberships membership
     WHERE membership.id = ? AND membership.organisation_id = ?
       AND membership.event_id = ? AND membership.person_id = ?
       AND membership.role = 'speaker' AND membership.accepted_at IS NULL
       AND membership.revoked_at IS NULL
       AND membership.last_operation_id = ?
       AND EXISTS (
         SELECT 1 FROM session_speakers relationship
         JOIN sessions session
           ON session.id = relationship.session_id
          AND session.event_id = relationship.event_id
         JOIN submission_decisions decision
           ON decision.submission_id = session.source_submission_id
          AND decision.event_id = session.event_id
        WHERE relationship.event_id = membership.event_id
          AND relationship.person_id = membership.person_id
          AND decision.id = ? AND decision.status = 'published'
          AND decision.decision = 'accepted'
       )
  )`;
  const guardBindings = [
    speaker.membershipId,
    viewer.organisationId,
    viewer.eventId,
    speaker.personId,
    operationId,
    speaker.decisionId,
  ];
  const batch = await env.DB.batch([
    env.DB.prepare(
      `UPDATE memberships
          SET invited_at = unixepoch(), invitation_expires_at = unixepoch() + 604800,
              last_operation_id = ?
        WHERE id = ? AND organisation_id = ? AND event_id = ?
          AND person_id = ? AND role = 'speaker'
          AND accepted_at IS NULL AND revoked_at IS NULL
          AND invitation_expires_at = ?
          AND EXISTS (
            SELECT 1 FROM session_speakers relationship
            JOIN sessions session
              ON session.id = relationship.session_id
             AND session.event_id = relationship.event_id
            JOIN submission_decisions decision
              ON decision.submission_id = session.source_submission_id
             AND decision.event_id = session.event_id
           WHERE relationship.event_id = memberships.event_id
             AND relationship.person_id = memberships.person_id
             AND decision.id = ? AND decision.status = 'published'
             AND decision.decision = 'accepted'
          )`,
    ).bind(
      operationId,
      speaker.membershipId,
      viewer.organisationId,
      viewer.eventId,
      speaker.personId,
      speaker.expiresAt,
      speaker.decisionId,
    ),
    env.DB.prepare(
      `UPDATE communication_deliveries
          SET status = 'cancelled', next_attempt_at = NULL,
              failure_code = 'invitation_superseded',
              failure_message = 'A newer accepted-speaker invitation replaced this delivery.',
              updated_at = unixepoch()
        WHERE event_id = ? AND source_id = ?
          AND status IN ('queued','sending','failed')
          AND communication_id <> ? AND ${membershipGuard}`,
    ).bind(
      viewer.eventId,
      speaker.membershipId,
      communicationId,
      ...guardBindings,
    ),
    env.DB.prepare(
      `UPDATE communications
          SET status = 'cancelled', cancelled_at = unixepoch(), updated_at = unixepoch()
        WHERE event_id = ? AND id <> ?
          AND json_extract(audience_json, '$.type') = 'accepted_speaker_invitation'
          AND json_extract(audience_json, '$.membershipId') = ?
          AND status IN ('draft','scheduled','queued','sending','partially_failed','failed')
          AND ${membershipGuard}`,
    ).bind(
      viewer.eventId,
      communicationId,
      speaker.membershipId,
      ...guardBindings,
    ),
    env.DB.prepare(
      `UPDATE operation_items
          SET status = 'skipped',
              result_json = json_object('reason', 'invitation_superseded'),
              completed_at = unixepoch(), updated_at = unixepoch()
        WHERE operation_id IN (
          SELECT communication.operation_id FROM communications communication
           WHERE communication.event_id = ?
             AND json_extract(communication.audience_json, '$.type') = 'accepted_speaker_invitation'
             AND json_extract(communication.audience_json, '$.membershipId') = ?
             AND communication.id <> ?
        )
          AND status IN ('pending','running','failed')
          AND ${membershipGuard}`,
    ).bind(
      viewer.eventId,
      speaker.membershipId,
      communicationId,
      ...guardBindings,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'cancelled', claim_token = NULL, claim_expires_at = NULL,
              completed_at = unixepoch(), updated_at = unixepoch()
        WHERE event_id = ? AND organisation_id = ? AND id <> ?
          AND id IN (
            SELECT communication.operation_id FROM communications communication
             WHERE communication.event_id = ?
               AND json_extract(communication.audience_json, '$.type') = 'accepted_speaker_invitation'
               AND json_extract(communication.audience_json, '$.membershipId') = ?
          )
          AND status IN ('queued','queue_failed','received','running','retrying','partially_failed','failed')
          AND ${membershipGuard}`,
    ).bind(
      viewer.eventId,
      viewer.organisationId,
      operationId,
      viewer.eventId,
      speaker.membershipId,
      ...guardBindings,
    ),
    env.DB.prepare(
      `INSERT INTO verification_tokens (
         id, identifier, value, expires_at, created_at, updated_at
       ) SELECT ?, ?, ?, unixepoch() + 604800, unixepoch(), unixepoch()
          WHERE ${membershipGuard}
       ON CONFLICT(id) DO UPDATE SET
         identifier = excluded.identifier, value = excluded.value,
         expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
    ).bind(
      verificationId,
      tokenHash,
      JSON.stringify({ email: speaker.email }),
      ...guardBindings,
    ),
    env.DB.prepare(
      `INSERT INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed, cancellable,
         created_at, updated_at
       ) SELECT ?, ?, ?, ?, 'communication.send', ?, ?, 'queued', ?,
                1, 0, 0, 0, unixepoch(), unixepoch()
          WHERE ${membershipGuard}
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      operationId,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      idempotencyKey,
      operationId,
      JSON.stringify(message),
      ...guardBindings,
    ),
    env.DB.prepare(
      `INSERT INTO communications (
         id, event_id, sender_profile_id, operation_id, idempotency_key,
         kind, channel, status, audience_json, content_snapshot_json,
         recipient_count, queued_at, created_by_person_id, created_at, updated_at
       ) SELECT ?, ?, ?, ?, ?, 'transactional', 'email', 'queued', ?, ?, 1,
                unixepoch(), ?, unixepoch(), unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM operation_jobs operation
             WHERE operation.id = ? AND operation.event_id = ?
               AND operation.status = 'queued'
          ) AND ${membershipGuard}
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      communicationId,
      viewer.eventId,
      readiness.senderId,
      operationId,
      idempotencyKey,
      JSON.stringify(audience),
      JSON.stringify(contentSnapshot),
      viewer.personId,
      operationId,
      viewer.eventId,
      ...guardBindings,
    ),
    env.DB.prepare(
      `INSERT INTO communication_deliveries (
         id, event_id, communication_id, person_id, recipient_address,
         recipient_name, source_id, source_values_json, channel, provider,
         idempotency_key, status, created_at, updated_at
       ) SELECT ?, ?, ?, person.id, person.email, person.display_name,
                ?, '{}', 'email', ?, ?, 'queued', unixepoch(), unixepoch()
           FROM people person
          WHERE person.id = ? AND lower(person.email) = lower(?)
            AND EXISTS (
              SELECT 1 FROM communications communication
               WHERE communication.id = ? AND communication.event_id = ?
                 AND communication.operation_id = ?
            ) AND ${membershipGuard}
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      deliveryId,
      viewer.eventId,
      communicationId,
      speaker.membershipId,
      readiness.provider.provider,
      `${idempotencyKey}:${speaker.email.toLowerCase()}`,
      speaker.personId,
      speaker.email,
      communicationId,
      viewer.eventId,
      operationId,
      ...guardBindings,
    ),
    env.DB.prepare(
      `INSERT INTO operation_items (
         id, operation_id, item_key, entity_type, entity_id, status, updated_at
       ) SELECT ?, ?, ?, 'communication_delivery', ?, 'pending', unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM communication_deliveries delivery
             WHERE delivery.id = ? AND delivery.communication_id = ?
          ) AND ${membershipGuard}
       ON CONFLICT(operation_id, item_key) DO NOTHING`,
    ).bind(
      `asi-ri:${identity}`,
      operationId,
      `${idempotencyKey}:${speaker.email.toLowerCase()}`,
      deliveryId,
      deliveryId,
      communicationId,
      ...guardBindings,
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, correlation_id, metadata_json, created_at
       ) SELECT ?, ?, ?, ?, 'membership.speaker.invitation.renewed',
                'membership', ?, ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM operation_jobs operation
             WHERE operation.id = ? AND operation.event_id = ?
          ) AND ${membershipGuard}
       ON CONFLICT(id) DO NOTHING`,
    ).bind(
      `asi-ra:${identity}`,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      speaker.membershipId,
      operationId,
      JSON.stringify({
        decisionId: speaker.decisionId,
        sessionId: speaker.sessionId,
        communicationId,
        previousExpiresAt: speaker.expiresAt,
      }),
      operationId,
      viewer.eventId,
      ...guardBindings,
    ),
  ]);
  const renewed = batch[0]?.meta.changes ?? 0;
  const persisted = await env.DB.prepare(
    `SELECT operation.status, communication.id AS communicationId,
            membership.invitation_expires_at AS expiresAt
       FROM operation_jobs operation
       JOIN communications communication
         ON communication.operation_id = operation.id
        AND communication.event_id = operation.event_id
       JOIN memberships membership
         ON membership.id = ? AND membership.organisation_id = operation.organisation_id
        AND membership.event_id = operation.event_id
      WHERE operation.id = ? AND operation.organisation_id = ?
        AND operation.event_id = ? AND operation.type = 'communication.send'`,
  )
    .bind(
      speaker.membershipId,
      operationId,
      viewer.organisationId,
      viewer.eventId,
    )
    .first<{ status: string; communicationId: string; expiresAt: number }>();
  if (!persisted) {
    throw new EvaluationStateError(
      "The speaker invitation changed before its renewal could be recorded.",
    );
  }
  if (renewed !== 1) {
    return {
      operationId,
      communicationId: persisted.communicationId,
      expiresAt: persisted.expiresAt,
      status:
        persisted.status === "completed"
          ? ("sent" as const)
          : ["queue_failed", "failed", "partially_failed"].includes(
                persisted.status,
              )
            ? ("queue_failed" as const)
            : ("queued" as const),
      replayed: true,
    };
  }
  const plan: AcceptedSpeakerInvitationPlan = {
    personId: speaker.personId,
    operationId,
    communicationId,
    message,
    statements: [],
  };
  try {
    await env.OPERATIONS_QUEUE.send(message);
  } catch (error) {
    await persistAcceptedSpeakerQueueFailure(env, plan, error);
    return {
      operationId,
      communicationId,
      expiresAt: persisted.expiresAt,
      status: "queue_failed" as const,
      replayed: false,
    };
  }
  return {
    operationId,
    communicationId,
    expiresAt: persisted.expiresAt,
    status: "queued" as const,
    replayed: false,
  };
}

export async function persistAcceptedSpeakerQueueFailure(
  env: CloudflareEnvironment,
  plan: AcceptedSpeakerInvitationPlan,
  error: unknown,
) {
  const failure = (
    error instanceof Error ? error.message : String(error)
  ).slice(0, 2_000);
  const [operation, communication] = await env.DB.batch([
    env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND status = 'queued'`,
    ).bind(failure, plan.operationId, plan.message.eventId),
    env.DB.prepare(
      `UPDATE communications SET status = 'failed', updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND operation_id = ? AND status = 'queued'`,
    ).bind(plan.communicationId, plan.message.eventId, plan.operationId),
  ]);
  if (
    (operation.meta.changes ?? 0) !== 1 ||
    (communication.meta.changes ?? 0) !== 1
  ) {
    throw new Error(
      "The accepted-speaker Queue failure could not be recorded consistently.",
    );
  }
}
