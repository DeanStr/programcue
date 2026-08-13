import {
  calendarQueueMessageSchema,
  queueCalendarLifecycleSchema,
  type CalendarQueueMessage,
  type QueueCalendarLifecycleInput,
} from "./calendar-schema";
import {
  CalendarQueueUnavailableError,
  CalendarStateError,
} from "./calendar-errors";
import type { CalendarQueueActor } from "./calendar-fanout";
import { hashCalendarLifecyclePayload, stableCalendarUid } from "./ics.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  requireEmailProviderConfiguration,
  type EmailProviderConfiguration,
} from "~/modules/communications/email-provider.server";

type SessionCalendarRow = {
  sessionId: string;
  title: string;
  description: string | null;
  startsAt: number;
  endsAt: number;
  roomName: string;
  timezone: string;
  attendeeName: string;
  attendeeEmail: string;
  brandAccent: string;
};

type InvitationRow = {
  id: string;
  icalUid: string;
  connectionId: string | null;
  sequenceNumber: number;
  method: "REQUEST" | "CANCEL";
  status: "pending" | "queued" | "sent" | "confirmed" | "cancelled" | "failed";
  providerEventId: string | null;
  currentAttemptId: string | null;
  currentAttemptStatus:
    "queued" | "running" | "succeeded" | "failed" | "superseded" | null;
  currentAttemptProvider: "email_ics" | "google" | "microsoft" | null;
};

type SenderRow = {
  id: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
};

type ClaimedCalendarLifecycle = {
  operationId: string;
  invitationId: string;
  attemptId: string;
  sequence: number;
  payloadHash: string;
  communicationId: string | null;
  deliveryId: string | null;
  queueMessage: CalendarQueueMessage;
};
type CalendarLifecycleClaimResult =
  | ClaimedCalendarLifecycle
  | { operationId: string; status: string; duplicate: true };

async function claimCalendarLifecycle(input: {
  env: CloudflareEnvironment;
  viewer: CalendarQueueActor;
  parsed: QueueCalendarLifecycleInput;
  session: SessionCalendarRow;
  existing: InvitationRow | null;
  sender: SenderRow | null;
  emailProvider: EmailProviderConfiguration | null;
  connectionId: string | null;
  organizerName: string;
  organizerEmail: string;
  findDuplicate: () => Promise<{ id: string; status: string } | null>;
  getInvitation: () => Promise<InvitationRow | null>;
}): Promise<CalendarLifecycleClaimResult> {
  const {
    env,
    viewer,
    parsed,
    session,
    existing,
    sender,
    emailProvider,
    connectionId,
    organizerName,
    organizerEmail,
    findDuplicate,
    getInvitation,
  } = input;
  let claimed: ClaimedCalendarLifecycle | null = null;
  let claimError: unknown;
  let snapshot = existing;

  // D1 serialises writes, but the sequence snapshot is necessarily read before
  // the payload is built. The conditional update plus the NOT NULL attempt
  // guard make the whole batch fail and roll back when another caller wins.
  for (let claimNumber = 0; claimNumber < 12 && !claimed; claimNumber += 1) {
    const duplicateAfterRace = await findDuplicate();
    if (duplicateAfterRace)
      return {
        operationId: duplicateAfterRace.id,
        status: duplicateAfterRace.status,
        duplicate: true,
      };
    if (claimNumber > 0) snapshot = await getInvitation();
    if (parsed.method === "CANCEL" && !snapshot) {
      throw new CalendarStateError(
        "A calendar invitation must exist before it can be cancelled.",
      );
    }
    if (snapshot?.currentAttemptStatus === "running") {
      throw new CalendarStateError(
        "This calendar invitation is currently being delivered. Retry the newer lifecycle change after the active provider attempt finishes.",
      );
    }
    if (
      snapshot?.currentAttemptProvider &&
      (snapshot.method !== "CANCEL" || snapshot.status !== "cancelled") &&
      (snapshot.currentAttemptProvider !== parsed.provider ||
        snapshot.connectionId !== connectionId)
    ) {
      throw new CalendarStateError(
        "Cancel and complete the existing calendar invitation before changing its provider or connected account.",
      );
    }

    const invitationId = snapshot?.id ?? crypto.randomUUID();
    const attemptId = crypto.randomUUID();
    const sequence = snapshot ? snapshot.sequenceNumber + 1 : 0;
    const resetProviderEvent =
      parsed.method === "REQUEST" &&
      snapshot?.method === "CANCEL" &&
      snapshot.status === "cancelled";
    const payload = {
      uid:
        snapshot?.icalUid ??
        stableCalendarUid(viewer.eventId, parsed.sessionId, parsed.personId),
      sequence,
      method: parsed.method,
      title: session.title,
      description: session.description ?? "",
      location: session.roomName,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
      timezone: session.timezone,
      attendeeName: session.attendeeName,
      attendeeEmail: session.attendeeEmail,
      organizerName,
      organizerEmail,
      brandAccent: session.brandAccent,
    };
    const payloadHash = await hashCalendarLifecyclePayload(
      parsed.provider,
      payload,
    );
    const operationId = crypto.randomUUID();
    const correlationId = crypto.randomUUID();
    const communicationId =
      parsed.provider === "email_ics" ? crypto.randomUUID() : null;
    const deliveryId =
      parsed.provider === "email_ics" ? crypto.randomUUID() : null;
    const queueMessage: CalendarQueueMessage = {
      type: "calendar.sync",
      operationId,
      invitationId,
      attemptId,
      eventId: viewer.eventId,
      organisationId: viewer.organisationId,
      sessionId: parsed.sessionId,
      personId: parsed.personId,
      provider: parsed.provider,
      connectionId,
      idempotencyKey: parsed.idempotencyKey,
      payload,
    };
    const statements: D1PreparedStatement[] = [];
    if (
      parsed.provider === "email_ics" &&
      sender &&
      communicationId &&
      deliveryId
    ) {
      if (!emailProvider)
        throw new CalendarStateError(
          "Calendar email delivery requires a configured email provider.",
        );
      statements.push(
        env.DB.prepare(
          `
            INSERT INTO communications (
              id, event_id, sender_profile_id, operation_id, idempotency_key, kind, channel,
              status, audience_json, content_snapshot_json, recipient_count, queued_at,
              created_by_person_id, created_at, updated_at
            )
            SELECT ?, ?, exact_sender.id, ?, ?, 'transactional', 'calendar',
                   'queued', ?, ?, 1, unixepoch(), ?, unixepoch(), unixepoch()
              FROM sender_profiles exact_sender
             WHERE exact_sender.id = ? AND exact_sender.event_id = ?
               AND exact_sender.status = 'verified'
               AND exact_sender.provider = ?
               AND exact_sender.from_name = ? AND exact_sender.from_email = ?
               AND exact_sender.reply_to_email IS ?
          `,
        ).bind(
          communicationId,
          viewer.eventId,
          operationId,
          `communication:${parsed.idempotencyKey}`,
          JSON.stringify({ type: "calendar", personIds: [parsed.personId] }),
          JSON.stringify({ schemaVersion: 1, calendar: payload }),
          viewer.personId,
          sender.id,
          viewer.eventId,
          emailProvider.provider,
          sender.fromName,
          sender.fromEmail,
          sender.replyToEmail,
        ),
        env.DB.prepare(
          `
            INSERT INTO communication_deliveries (
              id, event_id, communication_id, person_id, recipient_address, recipient_name,
              channel, provider, idempotency_key, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'calendar', ?, ?, 'queued', unixepoch(), unixepoch())
          `,
        ).bind(
          deliveryId,
          viewer.eventId,
          communicationId,
          parsed.personId,
          session.attendeeEmail,
          session.attendeeName,
          emailProvider.provider,
          `delivery:${parsed.idempotencyKey}`,
        ),
      );
    }
    if (snapshot) {
      statements.push(
        env.DB.prepare(
          `
          UPDATE calendar_invitations
             SET connection_id = ?, delivery_id = ?, sequence_number = ?, method = ?,
                 provider_event_id = CASE WHEN ? THEN NULL ELSE provider_event_id END,
                 status = 'queued', last_payload_hash = ?, current_attempt_id = ?, updated_at = unixepoch()
           WHERE id = ? AND event_id = ? AND sequence_number = ? AND current_attempt_id IS ?
             AND NOT EXISTS (
               SELECT 1 FROM calendar_sync_attempts csa
                WHERE csa.id = calendar_invitations.current_attempt_id
                  AND csa.invitation_id = calendar_invitations.id AND csa.status = 'running'
             )
             AND (
               ? IS NULL OR EXISTS (
                 SELECT 1 FROM calendar_connections cc
                  WHERE cc.id = ? AND cc.organisation_id = ? AND cc.person_id = ?
                    AND cc.provider = ? AND cc.status = 'connected'
                    AND (cc.event_id IS NULL OR cc.event_id = ?)
               )
             )
        `,
        ).bind(
          connectionId,
          deliveryId,
          sequence,
          parsed.method,
          resetProviderEvent ? 1 : 0,
          payloadHash,
          attemptId,
          snapshot.id,
          viewer.eventId,
          snapshot.sequenceNumber,
          snapshot.currentAttemptId,
          connectionId,
          connectionId,
          viewer.organisationId,
          parsed.personId,
          parsed.provider,
          viewer.eventId,
        ),
      );
    } else {
      statements.push(
        env.DB.prepare(
          `
          INSERT INTO calendar_invitations (
            id, event_id, session_id, person_id, connection_id, delivery_id, ical_uid,
            sequence_number, method, provider_event_id, status, last_payload_hash,
            current_attempt_id, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, 'queued', ?, ?, unixepoch(), unixepoch()
           WHERE ? IS NULL OR EXISTS (
             SELECT 1 FROM calendar_connections cc
              WHERE cc.id = ? AND cc.organisation_id = ? AND cc.person_id = ?
                AND cc.provider = ? AND cc.status = 'connected'
                AND (cc.event_id IS NULL OR cc.event_id = ?)
           )
        `,
        ).bind(
          invitationId,
          viewer.eventId,
          parsed.sessionId,
          parsed.personId,
          connectionId,
          deliveryId,
          payload.uid,
          parsed.method,
          payloadHash,
          attemptId,
          connectionId,
          connectionId,
          viewer.organisationId,
          parsed.personId,
          parsed.provider,
          viewer.eventId,
        ),
      );
    }
    statements.push(
      env.DB.prepare(
        `
          INSERT INTO calendar_sync_attempts (
            id, invitation_id, sequence_number, method, provider, status, created_at
          ) VALUES (?, (
            SELECT ci.id FROM calendar_invitations ci
             WHERE ci.id = ? AND ci.event_id = ? AND ci.sequence_number = ?
               AND ci.method = ? AND ci.last_payload_hash = ? AND ci.current_attempt_id = ?
               AND ci.connection_id IS ? AND ci.delivery_id IS ?
          ), ?, ?, ?, 'queued', unixepoch())
        `,
      ).bind(
        attemptId,
        invitationId,
        viewer.eventId,
        sequence,
        parsed.method,
        payloadHash,
        attemptId,
        connectionId,
        deliveryId,
        sequence,
        parsed.method,
        parsed.provider,
      ),
      env.DB.prepare(
        `
          INSERT INTO operation_jobs (
            id, organisation_id, event_id, requested_by_person_id, type, idempotency_key,
            correlation_id, status, payload_json, progress_total, progress_completed,
            progress_failed, cancellable, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'calendar.sync', ?, ?, 'queued', ?, 1, 0, 0, 0, unixepoch(), unixepoch())
        `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.idempotencyKey,
        correlationId,
        JSON.stringify(queueMessage),
      ),
      env.DB.prepare(
        `
          INSERT INTO operation_items (id, operation_id, item_key, entity_type, entity_id, status, updated_at)
          VALUES (?, ?, ?, 'calendar_invitation', ?, 'pending', unixepoch())
        `,
      ).bind(
        crypto.randomUUID(),
        operationId,
        `${invitationId}:${sequence}:${parsed.provider}`,
        invitationId,
      ),
      env.DB.prepare(
        `
          INSERT INTO audit_events (
            id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, metadata_json, created_at
          ) VALUES (?, ?, ?, ?, 'calendar.lifecycle.queued', 'calendar_invitation', ?, ?, unixepoch())
        `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        invitationId,
        JSON.stringify({
          attemptId,
          method: parsed.method,
          sequence,
          provider: parsed.provider,
          operationId,
        }),
      ),
    );
    try {
      await env.DB.batch(statements);
      claimed = {
        operationId,
        invitationId,
        attemptId,
        sequence,
        payloadHash,
        communicationId,
        deliveryId,
        queueMessage,
      };
    } catch (error) {
      claimError = error;
      const racedDuplicate = await findDuplicate();
      if (racedDuplicate)
        return {
          operationId: racedDuplicate.id,
          status: racedDuplicate.status,
          duplicate: true,
        };
      const latest = await getInvitation();
      const lostClaim =
        latest?.id !== snapshot?.id ||
        latest?.sequenceNumber !== snapshot?.sequenceNumber ||
        latest?.currentAttemptId !== snapshot?.currentAttemptId ||
        latest?.currentAttemptStatus !== snapshot?.currentAttemptStatus;
      if (!lostClaim) throw error;
      snapshot = latest;
    }
  }
  if (!claimed)
    throw (
      claimError ??
      new CalendarStateError(
        "The calendar invitation changed repeatedly before its sequence could be claimed.",
      )
    );

  return claimed;
}

export class CalendarLifecycleService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async queueLifecycle(
    viewer: CalendarQueueActor,
    input: QueueCalendarLifecycleInput,
  ) {
    const parsed = queueCalendarLifecycleSchema.parse(input);
    const findDuplicate = async () => {
      const duplicate = await this.env.DB.prepare(
        `
        SELECT id, status, payload_json AS payloadJson FROM operation_jobs
         WHERE event_id = ? AND idempotency_key = ?
           AND EXISTS (SELECT 1 FROM events WHERE id = ? AND organisation_id = ?)
      `,
      )
        .bind(
          viewer.eventId,
          parsed.idempotencyKey,
          viewer.eventId,
          viewer.organisationId,
        )
        .first<{ id: string; status: string; payloadJson: string }>();
      if (!duplicate) return null;
      let payload: unknown;
      try {
        payload = JSON.parse(duplicate.payloadJson);
      } catch {
        throw new Error(
          "The saved calendar idempotency record contains invalid JSON.",
        );
      }
      const saved = calendarQueueMessageSchema.safeParse(payload);
      if (!saved.success)
        throw new Error(
          "The saved calendar idempotency record contains an invalid durable payload.",
        );
      if (
        saved.data.sessionId !== parsed.sessionId ||
        saved.data.personId !== parsed.personId ||
        saved.data.payload.method !== parsed.method ||
        saved.data.provider !== parsed.provider ||
        saved.data.connectionId !== (parsed.connectionId ?? null)
      )
        throw new CalendarStateError(
          "This idempotency key is already associated with a different calendar lifecycle request.",
        );
      return { id: duplicate.id, status: duplicate.status };
    };
    const getInvitation = () =>
      this.env.DB.prepare(
        `
        SELECT ci.id, ci.ical_uid AS icalUid, ci.connection_id AS connectionId,
               ci.sequence_number AS sequenceNumber,
               ci.method, ci.status,
               ci.provider_event_id AS providerEventId, ci.current_attempt_id AS currentAttemptId,
               (SELECT csa.status FROM calendar_sync_attempts csa
                 WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id) AS currentAttemptStatus,
               (SELECT csa.provider FROM calendar_sync_attempts csa
                 WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id) AS currentAttemptProvider
          FROM calendar_invitations ci
          JOIN events e ON e.id = ci.event_id AND e.organisation_id = ?
         WHERE ci.event_id = ? AND ci.session_id = ? AND ci.person_id = ?
      `,
      )
        .bind(
          viewer.organisationId,
          viewer.eventId,
          parsed.sessionId,
          parsed.personId,
        )
        .first<InvitationRow>();

    const duplicate = await findDuplicate();
    if (duplicate)
      return {
        operationId: duplicate.id,
        status: duplicate.status,
        duplicate: true,
      };
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (!operationsQueue) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }

    const [session, existing] = await Promise.all([
      this.getSession(viewer, parsed.sessionId, parsed.personId, parsed.method),
      getInvitation(),
    ]);
    if (!session)
      throw new CalendarStateError(
        "The speaker must be assigned to a session in the published schedule before a calendar invitation can be sent.",
      );
    if (parsed.method === "CANCEL" && !existing)
      throw new CalendarStateError(
        "A calendar invitation must exist before it can be cancelled.",
      );
    let emailProvider: EmailProviderConfiguration | null = null;
    let sender: SenderRow | null = null;
    if (parsed.provider === "email_ics") {
      try {
        emailProvider = requireEmailProviderConfiguration(this.env);
      } catch (error) {
        throw new CalendarStateError(
          error instanceof Error
            ? error.message
            : "Email provider configuration is invalid.",
        );
      }
      sender = await this.getVerifiedSender(viewer, emailProvider.provider);
      if (!sender)
        throw new CalendarStateError(
          "A verified sender profile is required for calendar email delivery.",
        );
    }

    let connectionId: string | null = null;
    if (parsed.provider !== "email_ics") {
      if (!parsed.connectionId)
        throw new CalendarStateError(
          `${parsed.provider === "google" ? "Google" : "Microsoft 365"} calendar delivery requires a connected account.`,
        );
      const connection = await this.env.DB.prepare(
        `
        SELECT cc.id, cc.expires_at AS expiresAt
          FROM calendar_connections cc
          JOIN events e ON e.organisation_id = cc.organisation_id
         WHERE cc.id = ? AND e.id = ? AND e.organisation_id = ?
           AND cc.person_id = ? AND cc.provider = ? AND cc.status = 'connected'
           AND (cc.event_id IS NULL OR cc.event_id = e.id)
      `,
      )
        .bind(
          parsed.connectionId,
          viewer.eventId,
          viewer.organisationId,
          parsed.personId,
          parsed.provider,
        )
        .first<{ id: string; expiresAt: number | null }>();
      if (!connection)
        throw new CalendarStateError(
          "The selected connected calendar is unavailable or belongs to another event participant.",
        );
      if (connection.expiresAt === null)
        throw new CalendarStateError(
          "The selected calendar connection is missing OAuth token expiry and must be connected again.",
        );
      // Token refresh is provider work. The Queue consumer refreshes an
      // expiring token only after this exact lifecycle attempt and operation
      // have been committed, so a refresh failure remains durably retryable.
      connectionId = connection.id;
    }

    const organizerName = sender?.fromName ?? session.attendeeName;
    const organizerEmail = sender?.fromEmail ?? session.attendeeEmail;
    const claim = await claimCalendarLifecycle({
      env: this.env,
      viewer,
      parsed,
      session,
      existing,
      sender,
      emailProvider,
      connectionId,
      organizerName,
      organizerEmail,
      findDuplicate,
      getInvitation,
    });
    if ("duplicate" in claim) return claim;
    const claimed = claim;

    const {
      operationId,
      invitationId,
      attemptId,
      sequence,
      payloadHash,
      communicationId,
      deliveryId,
      queueMessage,
    } = claimed;

    try {
      await operationsQueue.send(queueMessage);
    } catch (error) {
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
          `UPDATE calendar_invitations SET status = 'failed', updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND current_attempt_id = ? AND sequence_number = ? AND last_payload_hash = ?`,
        ).bind(invitationId, viewer.eventId, attemptId, sequence, payloadHash),
        this.env.DB.prepare(
          `UPDATE calendar_sync_attempts
          SET status = 'failed', error_code = 'QUEUE_UNAVAILABLE', error_message = ?, completed_at = unixepoch()
          WHERE id = ? AND invitation_id = ? AND status = 'queued'`,
        ).bind(
          error instanceof Error
            ? error.message.slice(0, 2_000)
            : String(error).slice(0, 2_000),
          attemptId,
          invitationId,
        ),
        ...(deliveryId
          ? [
              this.env.DB.prepare(
                `UPDATE communication_deliveries
          SET status = 'failed', failure_code = 'QUEUE_UNAVAILABLE', failure_message = ?, updated_at = unixepoch()
          WHERE id = ? AND status = 'queued'`,
              ).bind(
                error instanceof Error
                  ? error.message.slice(0, 2_000)
                  : String(error).slice(0, 2_000),
                deliveryId,
              ),
            ]
          : []),
        ...(communicationId
          ? [
              this.env.DB.prepare(
                "UPDATE communications SET status = 'failed', updated_at = unixepoch() WHERE id = ?",
              ).bind(communicationId),
            ]
          : []),
      ]);
      throw new CalendarQueueUnavailableError(operationId, error);
    }
    return {
      operationId,
      invitationId,
      sequence,
      status: "queued",
      duplicate: false,
    };
  }
  private async getSession(
    viewer: CalendarQueueActor,
    sessionId: string,
    personId: string,
    method: "REQUEST" | "CANCEL",
  ) {
    const current = await this.env.DB.prepare(
      `
      SELECT s.id AS sessionId, content.title, content.description,
             se.starts_at AS startsAt, se.ends_at AS endsAt, r.name AS roomName,
             e.timezone, e.brand_accent AS brandAccent,
             p.display_name AS attendeeName, p.email AS attendeeEmail
        FROM sessions s
        JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        JOIN session_speakers ss ON ss.session_id = s.id AND ss.event_id = s.event_id AND ss.person_id = ?
        JOIN people p ON p.id = ss.person_id
        JOIN schedule_entries se ON se.session_id = s.id AND se.event_id = s.event_id
        JOIN schedule_versions sv ON sv.id = se.schedule_version_id AND sv.event_id = s.event_id AND sv.status = 'published'
        JOIN schedule_session_contents content
          ON content.schedule_version_id = sv.id AND content.event_id = sv.event_id
         AND content.session_id = s.id
        JOIN rooms r ON r.id = se.room_id AND r.event_id = s.event_id
       WHERE s.id = ? AND s.event_id = ?
       LIMIT 1
    `,
    )
      .bind(viewer.organisationId, personId, sessionId, viewer.eventId)
      .first<SessionCalendarRow>();
    if (current || method === "REQUEST") return current;
    return this.env.DB.prepare(
      `
      SELECT s.id AS sessionId, content.title, content.description,
             se.starts_at AS startsAt, se.ends_at AS endsAt, r.name AS roomName,
             e.timezone, e.brand_accent AS brandAccent,
             p.display_name AS attendeeName, p.email AS attendeeEmail
        FROM calendar_invitations ci
        JOIN events e ON e.id = ci.event_id AND e.organisation_id = ?
        JOIN sessions s ON s.id = ci.session_id AND s.event_id = ci.event_id
        JOIN people p ON p.id = ci.person_id
        JOIN schedule_entries se ON se.session_id = ci.session_id AND se.event_id = ci.event_id
        JOIN schedule_versions sv ON sv.id = se.schedule_version_id AND sv.event_id = ci.event_id
        JOIN schedule_session_contents content
          ON content.schedule_version_id = sv.id AND content.event_id = sv.event_id
         AND content.session_id = s.id
        JOIN rooms r ON r.id = se.room_id AND r.event_id = ci.event_id
       WHERE ci.event_id = ? AND ci.session_id = ? AND ci.person_id = ?
         AND sv.status IN ('published','archived')
       ORDER BY CASE sv.status WHEN 'published' THEN 0 ELSE 1 END, sv.version_number DESC
       LIMIT 1
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, sessionId, personId)
      .first<SessionCalendarRow>();
  }

  private async getVerifiedSender(
    viewer: Pick<Viewer, "organisationId" | "eventId">,
    provider: "resend" | "mailpit",
  ) {
    return this.env.DB.prepare(
      `
      SELECT sp.id, sp.from_name AS fromName, sp.from_email AS fromEmail,
             sp.reply_to_email AS replyToEmail
        FROM sender_profiles sp
        JOIN events e ON e.id = sp.event_id AND e.organisation_id = ?
       WHERE sp.event_id = ? AND sp.status = 'verified' AND sp.provider = ?
       ORDER BY sp.updated_at DESC LIMIT 1
    `,
    )
      .bind(viewer.organisationId, viewer.eventId, provider)
      .first<SenderRow>();
  }
}
