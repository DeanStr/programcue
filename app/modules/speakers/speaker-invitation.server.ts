import {
  acceptedSpeakerInvitationReadiness,
  magicLink,
  randomToken,
  sha256Base64Url,
  type AcceptedSpeakerInvitationMessage,
} from "~/modules/evaluations/accepted-speaker-invitation-plan.server";
import { emailDeliveryIssue } from "~/modules/communications/email-deliverability";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

export type SpeakerInvitationDelivery =
  | "not_required"
  | "queued"
  | "sent"
  | "queue_failed"
  | "failed"
  | "cancelled"
  | "demo_not_sent";

type SpeakerInvitationSource = "direct_session" | "speaker_network";

type SpeakerInvitationActor = {
  organisationId: string;
  eventId: string;
  personId: string | null;
  actorId?: string;
};

export type PreparedSpeakerInvitation = {
  email: string;
  operationId: string;
  communicationId: string;
  message: AcceptedSpeakerInvitationMessage;
  statements: D1PreparedStatement[];
};

export type SpeakerInvitationOutcome = {
  email: string;
  membershipId: string;
  operationId: string | null;
  communicationId: string | null;
  status: SpeakerInvitationDelivery;
};

export const existingPersonOrganisationRelationshipSql = `(
  EXISTS (
    SELECT 1 FROM memberships membership
     WHERE membership.organisation_id = ?
       AND membership.person_id = person.id
       AND membership.accepted_at IS NOT NULL
       AND membership.revoked_at IS NULL
  )
  OR EXISTS (
    SELECT 1 FROM submissions submission
    JOIN events event ON event.id = submission.event_id
     WHERE event.organisation_id = ?
       AND submission.submitter_person_id = person.id
  )
  OR EXISTS (
    SELECT 1 FROM submission_speakers speaker
    JOIN events event ON event.id = speaker.event_id
     WHERE event.organisation_id = ?
       AND speaker.person_id = person.id
       AND speaker.invitation_status = 'claimed'
  )
  OR EXISTS (
    SELECT 1 FROM session_speakers speaker
    JOIN events event ON event.id = speaker.event_id
     WHERE event.organisation_id = ?
       AND speaker.person_id = person.id
  )
)`;

export function organisationRelationshipBindings(organisationId: string) {
  return Array(4).fill(organisationId);
}

export class SpeakerInvitationDeliveryError extends Error {
  readonly committed = true;

  constructor(
    readonly membershipId: string,
    _cause?: unknown,
  ) {
    super(
      "The speaker invitation was saved, but its durable email operation needs attention. Retry that operation before publishing the schedule.",
    );
    this.name = "SpeakerInvitationDeliveryError";
  }
}

export class SpeakerInvitationAddressError extends Error {
  constructor(reason: string) {
    super(
      `The speaker invitation email address is not deliverable: ${reason.toLowerCase()}.`,
    );
    this.name = "SpeakerInvitationAddressError";
  }
}

export async function prepareSpeakerInvitations(input: {
  env: CloudflareEnvironment;
  actor: SpeakerInvitationActor;
  commandId: string;
  source: SpeakerInvitationSource;
  emails: string[];
}): Promise<PreparedSpeakerInvitation[]> {
  const runtime = requireRuntimeMode(input.env);
  if (runtime.appEnvironment === "demo" || runtime.appEnvironment === "test") {
    return [];
  }
  const requestedEmails = [
    ...new Set(input.emails.map((email) => email.toLowerCase())),
  ];
  if (!requestedEmails.length) return [];
  const accepted = await input.env.DB.prepare(
    `SELECT lower(person.email) AS email
       FROM people person
       JOIN memberships membership ON membership.person_id = person.id
      WHERE membership.organisation_id = ? AND membership.event_id = ?
        AND membership.role = 'speaker'
        AND membership.accepted_at IS NOT NULL
        AND membership.revoked_at IS NULL
        AND lower(person.email) IN (
          SELECT lower(CAST(value AS TEXT)) FROM json_each(?)
        )`,
  )
    .bind(
      input.actor.organisationId,
      input.actor.eventId,
      JSON.stringify(requestedEmails),
    )
    .all<{ email: string }>();
  const acceptedEmails = new Set(accepted.results.map((row) => row.email));
  const emails = requestedEmails.filter((email) => !acceptedEmails.has(email));
  if (!emails.length) return [];
  for (const email of emails) {
    const deliveryIssue = emailDeliveryIssue(email, input.env.APP_ENV);
    if (deliveryIssue) {
      throw new SpeakerInvitationAddressError(deliveryIssue);
    }
  }
  if (!input.env.OPERATIONS_QUEUE) {
    throw new Error(
      "Required OPERATIONS_QUEUE binding is unavailable; no speaker invitation was saved.",
    );
  }
  const event = await input.env.DB.prepare(
    `SELECT name, brand_accent AS brandAccent, starts_at AS startsAt,
            ends_at AS endsAt, venue_name AS venueName, city
       FROM events WHERE id = ? AND organisation_id = ?`,
  )
    .bind(input.actor.eventId, input.actor.organisationId)
    .first<{
      name: string;
      brandAccent: string;
      startsAt: number;
      endsAt: number;
      venueName: string | null;
      city: string | null;
    }>();
  if (!event) throw new Error("The speaker invitation event is unavailable.");
  const readiness = await acceptedSpeakerInvitationReadiness({
    env: input.env,
    organisationId: input.actor.organisationId,
    eventId: input.actor.eventId,
    event,
  });
  return Promise.all(
    emails.map(async (email) => {
      const identity = (
        await sha256Base64Url(
          JSON.stringify(["speaker-invitation", input.commandId, email]),
        )
      ).slice(0, 32);
      const operationId = `spi-o:${identity}`;
      const communicationId = `spi-c:${identity}`;
      const deliveryId = `spi-d:${identity}`;
      const verificationId = `spi-v:${identity}`;
      const auditId = `spi-a:${identity}`;
      const itemId = `spi-i:${identity}`;
      const idempotencyKey = `speaker-invitation:${identity}`;
      const token = randomToken();
      const tokenHash = await sha256Base64Url(token);
      const url = magicLink(readiness.baseUrl, token, input.actor.eventId);
      const message: AcceptedSpeakerInvitationMessage = {
        type: "communication.send",
        operationId,
        communicationId,
        eventId: input.actor.eventId,
        organisationId: input.actor.organisationId,
        idempotencyKey,
      };
      const contentSnapshot = {
        schemaVersion: 1,
        category: "speaker_invitation",
        subjectTemplate: `You are invited to speak at ${event.name}`,
        content: {
          body: `You have been invited to participate as a speaker at ${event.name}. Use this one-time link to sign in to Program Cue and accept the invitation:\n\n${url.toString()}\n\nThis invitation expires in seven days.`,
          physicalAddress: readiness.physicalAddress,
          ...(url.protocol === "https:"
            ? {
                buttonText: "Accept speaker invitation",
                buttonUrl: url.toString(),
              }
            : {}),
        },
        event: {
          eventName: event.name,
          brandAccent: event.brandAccent,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
        },
      };
      const audience = {
        type: "speaker_invitation",
        source: input.source,
        commandId: input.commandId,
        email,
      };
      const membershipGuard = `EXISTS (
        SELECT 1 FROM memberships invitation_membership
        JOIN people invitation_person
          ON invitation_person.id = invitation_membership.person_id
       WHERE invitation_membership.organisation_id = ?
         AND invitation_membership.event_id = ?
         AND invitation_membership.role = 'speaker'
         AND invitation_membership.accepted_at IS NULL
         AND invitation_membership.revoked_at IS NULL
         AND invitation_membership.invitation_expires_at > unixepoch()
         AND invitation_membership.last_operation_id = ?
         AND lower(invitation_person.email) = lower(?)
      )`;
      const guardBindings = [
        input.actor.organisationId,
        input.actor.eventId,
        input.commandId,
        email,
      ];
      const statements = [
        input.env.DB.prepare(
          `INSERT INTO verification_tokens (
             id, identifier, value, expires_at, created_at, updated_at
           ) SELECT ?, ?, ?, unixepoch() + 604800, unixepoch(), unixepoch()
              WHERE ${membershipGuard}
           ON CONFLICT(id) DO NOTHING`,
        ).bind(
          verificationId,
          tokenHash,
          JSON.stringify({ email }),
          ...guardBindings,
        ),
        input.env.DB.prepare(
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
          input.actor.organisationId,
          input.actor.eventId,
          input.actor.personId,
          idempotencyKey,
          operationId,
          JSON.stringify(message),
          ...guardBindings,
        ),
        input.env.DB.prepare(
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
          input.actor.eventId,
          readiness.senderId,
          operationId,
          idempotencyKey,
          JSON.stringify(audience),
          JSON.stringify(contentSnapshot),
          input.actor.personId,
          operationId,
          input.actor.eventId,
          ...guardBindings,
        ),
        input.env.DB.prepare(
          `INSERT INTO communication_deliveries (
             id, event_id, communication_id, person_id, recipient_address,
             recipient_name, source_id, source_values_json, channel, provider,
             idempotency_key, status, created_at, updated_at
           ) SELECT ?, ?, ?, person.id, person.email, person.display_name,
                    membership.id, '{}', 'email', ?, ?, 'queued',
                    unixepoch(), unixepoch()
               FROM memberships membership
               JOIN people person ON person.id = membership.person_id
              WHERE membership.organisation_id = ? AND membership.event_id = ?
                AND membership.role = 'speaker'
                AND membership.accepted_at IS NULL
                AND membership.revoked_at IS NULL
                AND membership.invitation_expires_at > unixepoch()
                AND membership.last_operation_id = ?
                AND lower(person.email) = lower(?)
                AND EXISTS (
                  SELECT 1 FROM communications communication
                   WHERE communication.id = ? AND communication.event_id = ?
                     AND communication.operation_id = ?
                )
           ON CONFLICT(id) DO NOTHING`,
        ).bind(
          deliveryId,
          input.actor.eventId,
          communicationId,
          readiness.provider.provider,
          `${idempotencyKey}:${email}`,
          ...guardBindings,
          communicationId,
          input.actor.eventId,
          operationId,
        ),
        input.env.DB.prepare(
          `INSERT INTO operation_items (
             id, operation_id, item_key, entity_type, entity_id, status, updated_at
           ) SELECT ?, ?, ?, 'communication_delivery', ?, 'pending', unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM communication_deliveries delivery
                 WHERE delivery.id = ? AND delivery.communication_id = ?
              )
           ON CONFLICT(operation_id, item_key) DO NOTHING`,
        ).bind(
          itemId,
          operationId,
          `${idempotencyKey}:${email}`,
          deliveryId,
          deliveryId,
          communicationId,
        ),
        input.env.DB.prepare(
          `INSERT INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           ) SELECT ?, CASE WHEN ? IS NULL THEN 'api_key' ELSE 'person' END,
                    CASE WHEN ? IS NULL THEN 'api' ELSE 'admin_ui' END,
                    1, ?, ?, ?, ?, 'membership.speaker.invitation.queued',
                    'membership', membership.id, ?, ?, unixepoch()
               FROM memberships membership
               JOIN people person ON person.id = membership.person_id
              WHERE membership.organisation_id = ? AND membership.event_id = ?
                AND membership.role = 'speaker'
                AND membership.accepted_at IS NULL
                AND membership.revoked_at IS NULL
                AND membership.invitation_expires_at > unixepoch()
                AND membership.last_operation_id = ?
                AND lower(person.email) = lower(?)
                AND EXISTS (
                  SELECT 1 FROM operation_jobs operation
                   WHERE operation.id = ? AND operation.event_id = ?
                )
           ON CONFLICT(id) DO NOTHING`,
        ).bind(
          auditId,
          input.actor.personId,
          input.actor.personId,
          input.actor.organisationId,
          input.actor.eventId,
          input.actor.personId,
          input.actor.actorId ?? null,
          operationId,
          JSON.stringify({
            source: input.source,
            commandId: input.commandId,
            communicationId,
          }),
          ...guardBindings,
          operationId,
          input.actor.eventId,
        ),
      ];
      return { email, operationId, communicationId, message, statements };
    }),
  );
}

function invitationOperationStatus(status: string): SpeakerInvitationDelivery {
  if (status === "completed") return "sent";
  if (status === "queue_failed") return "queue_failed";
  if (status === "failed" || status === "partially_failed") return "failed";
  if (status === "cancelled") return "cancelled";
  if (["queued", "received", "running", "retrying"].includes(status)) {
    return "queued";
  }
  throw new Error(
    `Speaker invitation operation has unsupported status ${JSON.stringify(status)}.`,
  );
}

export async function dispatchSpeakerInvitationsForCommand(input: {
  env: CloudflareEnvironment;
  organisationId: string;
  eventId: string;
  commandId: string;
}): Promise<SpeakerInvitationOutcome[]> {
  const memberships = await input.env.DB.prepare(
    `SELECT membership.id AS membershipId, person.email,
            membership.accepted_at AS acceptedAt
       FROM memberships membership
       JOIN people person ON person.id = membership.person_id
      WHERE membership.organisation_id = ? AND membership.event_id = ?
        AND membership.role = 'speaker' AND membership.revoked_at IS NULL
        AND membership.last_operation_id = ?
      ORDER BY person.email COLLATE NOCASE`,
  )
    .bind(input.organisationId, input.eventId, input.commandId)
    .all<{ membershipId: string; email: string; acceptedAt: number | null }>();
  if (!memberships.results.length) return [];
  const pending = memberships.results.filter((row) => row.acceptedAt === null);
  const runtime = requireRuntimeMode(input.env);
  if (runtime.appEnvironment === "demo" || runtime.appEnvironment === "test") {
    return memberships.results.map(({ acceptedAt, ...row }) => ({
      ...row,
      operationId: null,
      communicationId: null,
      status: acceptedAt === null ? "demo_not_sent" : "not_required",
    }));
  }
  if (!pending.length) {
    return memberships.results.map(({ acceptedAt: _acceptedAt, ...row }) => ({
      ...row,
      operationId: null,
      communicationId: null,
      status: "not_required" as const,
    }));
  }
  const operations = await input.env.DB.prepare(
    `SELECT operation.id AS operationId, operation.status,
            operation.payload_json AS payloadJson,
            operation.dispatched_at AS dispatchedAt,
            communication.id AS communicationId,
            delivery.source_id AS membershipId, delivery.recipient_address AS email
       FROM operation_jobs operation
       JOIN communications communication
         ON communication.operation_id = operation.id
        AND communication.event_id = operation.event_id
       JOIN communication_deliveries delivery
         ON delivery.communication_id = communication.id
        AND delivery.event_id = communication.event_id
       JOIN memberships membership
         ON membership.id = delivery.source_id
        AND membership.organisation_id = operation.organisation_id
        AND membership.event_id = operation.event_id
        AND membership.role = 'speaker'
        AND membership.accepted_at IS NULL
        AND membership.revoked_at IS NULL
        AND membership.last_operation_id = ?
      WHERE operation.organisation_id = ? AND operation.event_id = ?
        AND operation.type = 'communication.send'
        AND json_extract(communication.audience_json, '$.type') = 'speaker_invitation'
        AND json_extract(communication.audience_json, '$.commandId') = ?
      ORDER BY delivery.recipient_address COLLATE NOCASE`,
  )
    .bind(input.commandId, input.organisationId, input.eventId, input.commandId)
    .all<{
      operationId: string;
      status: string;
      payloadJson: string;
      dispatchedAt: number | null;
      communicationId: string;
      membershipId: string;
      email: string;
    }>();
  if (operations.results.length !== pending.length) {
    throw new Error(
      "A committed speaker invitation is missing its durable delivery operation.",
    );
  }
  const queue = input.env.OPERATIONS_QUEUE;
  if (!queue) {
    throw new Error(
      "A committed speaker invitation cannot be dispatched because OPERATIONS_QUEUE is unavailable.",
    );
  }
  const outcomes = new Map<string, SpeakerInvitationOutcome>();
  for (const operation of operations.results) {
    let status = invitationOperationStatus(operation.status);
    if (
      status === "queued" &&
      operation.status === "queued" &&
      !operation.dispatchedAt
    ) {
      try {
        const message = JSON.parse(
          operation.payloadJson,
        ) as AcceptedSpeakerInvitationMessage;
        await queue.send(message);
        const dispatched = await input.env.DB.prepare(
          `UPDATE operation_jobs
              SET dispatched_at = COALESCE(dispatched_at, unixepoch()),
                  updated_at = unixepoch()
            WHERE id = ? AND organisation_id = ? AND event_id = ?
              AND type = 'communication.send'`,
        )
          .bind(operation.operationId, input.organisationId, input.eventId)
          .run();
        if ((dispatched.meta.changes ?? 0) !== 1) {
          throw new Error(
            "The speaker invitation dispatch could not be recorded consistently.",
          );
        }
      } catch (error) {
        const failure = (
          error instanceof Error ? error.message : String(error)
        ).slice(0, 2_000);
        const [job, communication] = await input.env.DB.batch([
          input.env.DB.prepare(
            `UPDATE operation_jobs
                SET status = 'queue_failed', last_error = ?, updated_at = unixepoch()
              WHERE id = ? AND organisation_id = ? AND event_id = ?
                AND status = 'queued'`,
          ).bind(
            failure,
            operation.operationId,
            input.organisationId,
            input.eventId,
          ),
          input.env.DB.prepare(
            `UPDATE communications SET status = 'failed', updated_at = unixepoch()
              WHERE id = ? AND event_id = ? AND operation_id = ?
                AND status = 'queued'`,
          ).bind(
            operation.communicationId,
            input.eventId,
            operation.operationId,
          ),
        ]);
        if (
          (job.meta.changes ?? 0) !== 1 ||
          (communication.meta.changes ?? 0) !== 1
        ) {
          throw new Error(
            "The speaker invitation Queue failure could not be recorded consistently.",
          );
        }
        status = "queue_failed";
      }
    }
    outcomes.set(operation.membershipId, {
      email: operation.email,
      membershipId: operation.membershipId,
      operationId: operation.operationId,
      communicationId: operation.communicationId,
      status,
    });
  }
  return memberships.results.map(({ acceptedAt, ...membership }) => {
    if (acceptedAt !== null) {
      return {
        ...membership,
        operationId: null,
        communicationId: null,
        status: "not_required" as const,
      };
    }
    const outcome = outcomes.get(membership.membershipId);
    if (!outcome) {
      throw new Error(
        "A pending speaker invitation is missing its durable delivery outcome.",
      );
    }
    return outcome;
  });
}

export async function unavailableDirectSessionSpeakerEmails(input: {
  env: CloudflareEnvironment;
  organisationId: string;
  emails: string[];
}) {
  if (!input.emails.length) return [];
  const emails = [...new Set(input.emails.map((email) => email.toLowerCase()))];
  const placeholders = emails.map(() => "?").join(",");
  const rows = await input.env.DB.prepare(
    `SELECT lower(person.email) AS email
       FROM people person
      WHERE lower(person.email) IN (${placeholders})
        AND NOT ${existingPersonOrganisationRelationshipSql}`,
  )
    .bind(...emails, ...organisationRelationshipBindings(input.organisationId))
    .all<{ email: string }>();
  return rows.results.map((row) => row.email);
}

export async function unacceptedEventParticipantEmails(input: {
  env: CloudflareEnvironment;
  eventId: string;
  emails: string[];
}) {
  const emails = [...new Set(input.emails.map((email) => email.toLowerCase()))];
  if (!emails.length) return [];
  const rows = await input.env.DB.prepare(
    `SELECT requested.value AS email
       FROM json_each(?) requested
      WHERE NOT EXISTS (
        SELECT 1 FROM people person
        JOIN memberships membership
          ON membership.person_id = person.id
         AND membership.event_id = ?
         AND membership.role IN ('speaker', 'submitter')
         AND membership.accepted_at IS NOT NULL
         AND membership.revoked_at IS NULL
        WHERE lower(person.email) = lower(CAST(requested.value AS TEXT))
      )`,
  )
    .bind(JSON.stringify(emails), input.eventId)
    .all<{ email: string }>();
  return rows.results.map((row) => row.email);
}
