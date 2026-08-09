import type { Viewer } from "~/platform/auth/authorize.server";
import { z } from "zod";
import {
  queueCalendarLifecycleSchema,
  type CalendarQueueMessage,
  type CalendarProviderName,
  type QueueCalendarLifecycleInput,
} from "./calendar-schema";
import {
  hashCalendarLifecyclePayload,
  hashCalendarPayload,
  stableCalendarUid,
} from "./ics.server";

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
};

type InvitationRow = {
  id: string;
  icalUid: string;
  sequenceNumber: number;
  method: "REQUEST" | "CANCEL";
  status: "pending" | "queued" | "sent" | "confirmed" | "cancelled" | "failed";
  providerEventId: string | null;
  currentAttemptId: string | null;
  currentAttemptStatus:
    "queued" | "running" | "succeeded" | "failed" | "superseded" | null;
};

type SenderRow = {
  id: string;
  fromName: string;
  fromEmail: string;
  replyToEmail: string | null;
};

export async function publishedScheduleCalendarIdempotencyKey(input: {
  scheduleVersionId: string;
  method: "REQUEST" | "CANCEL";
  sessionId: string;
  personId: string;
  provider: CalendarProviderName;
}) {
  const digest = await hashCalendarPayload(
    JSON.stringify([
      input.scheduleVersionId,
      input.method,
      input.sessionId,
      input.personId,
      input.provider,
    ]),
  );
  return `schedule-calendar:${digest}`;
}

export type CalendarQueueActor = Pick<Viewer, "organisationId" | "eventId"> & {
  personId: string | null;
};

export type PublishedScheduleCalendarDispatch = {
  targetCount: number;
  processedCount: number;
  queuedCount: number;
  duplicateCount: number;
  nextTarget: string | null;
  dispatchError: string | null;
  failures: Array<{
    sessionId: string;
    personId: string;
    method: "REQUEST" | "CANCEL";
    provider: CalendarProviderName;
    message: string;
  }>;
};

export const SCHEDULE_CALENDAR_FANOUT_BATCH_SIZE = 10;

const SCHEDULE_CALENDAR_FANOUT_SNAPSHOT_KEY = "schedule-calendar-targets";
const SCHEDULE_CALENDAR_FANOUT_TARGET_TYPE = "schedule_calendar_target";

type PublishedScheduleCalendarTarget = {
  key: string;
  sessionId: string;
  personId: string;
  method: "REQUEST" | "CANCEL";
  provider: CalendarProviderName;
  connectionId: string | null;
};

const publishedScheduleCalendarTargetSchema = z.object({
  sessionId: z.string().min(1),
  personId: z.string().min(1),
  method: z.enum(["REQUEST", "CANCEL"]),
  provider: z.enum(["email_ics", "google", "microsoft"]),
  connectionId: z.string().min(1).nullable(),
});

/**
 * Captures the exact calendar work selected by a schedule publication. These
 * statements must run in the same D1 batch as the parent operation insert so
 * later Queue continuations never derive work from mutated invitation state.
 */
export function scheduleCalendarFanoutSnapshotStatements(
  env: CloudflareEnvironment,
  viewer: CalendarQueueActor,
  scheduleVersionId: string,
  operationId: string,
) {
  const operationGuard = `EXISTS (
    SELECT 1 FROM operation_jobs operation
     WHERE operation.id = ? AND operation.event_id = ?
       AND operation.organisation_id = ?
       AND operation.type = 'schedule.calendar_fanout'
  )`;
  return [
    env.DB.prepare(
      `
      WITH requested_targets AS (
        SELECT se.session_id AS session_id, ss.person_id AS person_id,
               COALESCE(
                 (SELECT csa.provider FROM calendar_sync_attempts csa
                   WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id),
                 (SELECT cc.provider FROM calendar_connections cc
                   WHERE cc.organisation_id = ? AND cc.person_id = ss.person_id
                     AND cc.status = 'connected' AND (cc.event_id IS NULL OR cc.event_id = ?)
                     AND (cc.expires_at IS NULL OR cc.expires_at > unixepoch())
                   ORDER BY CASE cc.provider WHEN 'google' THEN 0 ELSE 1 END,
                            cc.updated_at DESC LIMIT 1),
                 'email_ics'
               ) AS provider,
               COALESCE(
                 ci.connection_id,
                 (SELECT cc.id FROM calendar_connections cc
                   WHERE cc.organisation_id = ? AND cc.person_id = ss.person_id
                     AND cc.status = 'connected' AND (cc.event_id IS NULL OR cc.event_id = ?)
                     AND (cc.expires_at IS NULL OR cc.expires_at > unixepoch())
                   ORDER BY CASE cc.provider WHEN 'google' THEN 0 ELSE 1 END,
                            cc.updated_at DESC LIMIT 1)
               ) AS connection_id
          FROM schedule_entries se
          JOIN schedule_versions sv
            ON sv.id = se.schedule_version_id AND sv.event_id = se.event_id
          JOIN session_speakers ss
            ON ss.session_id = se.session_id AND ss.event_id = se.event_id
          LEFT JOIN calendar_invitations ci
            ON ci.event_id = se.event_id AND ci.session_id = se.session_id
           AND ci.person_id = ss.person_id
         WHERE se.event_id = ? AND sv.id = ? AND sv.status = 'published'
      )
      INSERT INTO operation_items (
        id, operation_id, item_key, entity_type, entity_id, status, result_json, updated_at
      )
      SELECT lower(hex(randomblob(16))), ?,
             json_array('REQUEST', session_id, person_id, provider),
             ?, session_id, 'pending',
             json_object(
               'sessionId', session_id, 'personId', person_id,
               'method', 'REQUEST', 'provider', provider,
               'connectionId', connection_id
             ), unixepoch()
        FROM requested_targets
       WHERE ${operationGuard}
    `,
    ).bind(
      viewer.organisationId,
      viewer.eventId,
      viewer.organisationId,
      viewer.eventId,
      viewer.eventId,
      scheduleVersionId,
      operationId,
      SCHEDULE_CALENDAR_FANOUT_TARGET_TYPE,
      operationId,
      viewer.eventId,
      viewer.organisationId,
    ),
    env.DB.prepare(
      `
      WITH cancelled_targets AS (
        SELECT ci.session_id AS session_id, ci.person_id AS person_id,
               ci.connection_id AS connection_id,
               COALESCE(
                 (SELECT csa.provider FROM calendar_sync_attempts csa
                   WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id),
                 'email_ics'
               ) AS provider
          FROM calendar_invitations ci
          JOIN events e ON e.id = ci.event_id AND e.organisation_id = ?
         WHERE ci.event_id = ?
           AND (
             ci.status IN ('queued','sent','confirmed')
             OR (
               ci.status = 'failed'
               AND EXISTS (
                 SELECT 1 FROM calendar_sync_attempts delivered_request
                  WHERE delivered_request.invitation_id = ci.id
                    AND delivered_request.method = 'REQUEST'
                    AND delivered_request.status = 'succeeded'
               )
             )
           )
           AND NOT EXISTS (
             SELECT 1
               FROM schedule_entries se
               JOIN schedule_versions sv
                 ON sv.id = se.schedule_version_id AND sv.event_id = se.event_id
               JOIN session_speakers ss
                 ON ss.session_id = se.session_id AND ss.event_id = se.event_id
              WHERE sv.id = ? AND sv.status = 'published'
                AND se.session_id = ci.session_id AND ss.person_id = ci.person_id
           )
      )
      INSERT INTO operation_items (
        id, operation_id, item_key, entity_type, entity_id, status, result_json, updated_at
      )
      SELECT lower(hex(randomblob(16))), ?,
             json_array('CANCEL', session_id, person_id, provider),
             ?, session_id, 'pending',
             json_object(
               'sessionId', session_id, 'personId', person_id,
               'method', 'CANCEL', 'provider', provider,
               'connectionId', connection_id
             ), unixepoch()
        FROM cancelled_targets
       WHERE ${operationGuard}
    `,
    ).bind(
      viewer.organisationId,
      viewer.eventId,
      scheduleVersionId,
      operationId,
      SCHEDULE_CALENDAR_FANOUT_TARGET_TYPE,
      operationId,
      viewer.eventId,
      viewer.organisationId,
    ),
    env.DB.prepare(
      `
      INSERT INTO operation_items (
        id, operation_id, item_key, entity_type, entity_id, status, result_json,
        completed_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), ?, ?, 'schedule_calendar_snapshot', ?,
             'completed', json_object('scheduleVersionId', ?), unixepoch(), unixepoch()
       WHERE ${operationGuard}
    `,
    ).bind(
      operationId,
      SCHEDULE_CALENDAR_FANOUT_SNAPSHOT_KEY,
      scheduleVersionId,
      scheduleVersionId,
      operationId,
      viewer.eventId,
      viewer.organisationId,
    ),
  ];
}

export class CalendarStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CalendarStateError";
  }
}

export class CalendarQueueUnavailableError extends Error {
  constructor(
    readonly operationId: string,
    cause?: unknown,
  ) {
    super(
      `Calendar intent was saved, but operation ${operationId} could not be queued. Retry it from the Operation Centre.${cause ? ` ${cause instanceof Error ? cause.message : String(cause)}` : ""}`,
    );
    this.name = "CalendarQueueUnavailableError";
  }
}

export class CalendarService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async list(viewer: Viewer) {
    const result = await this.env.DB.prepare(
      `
      SELECT ci.id, ci.session_id AS sessionId, s.title AS sessionTitle,
             ci.person_id AS personId, p.display_name AS personName, p.email,
             ci.ical_uid AS icalUid, ci.sequence_number AS sequenceNumber,
             ci.method, ci.status, ci.provider_event_id AS providerEventId,
             ci.updated_at AS updatedAt,
             (SELECT csa.provider FROM calendar_sync_attempts csa
               WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id) AS provider
        FROM calendar_invitations ci
        JOIN events e ON e.id = ci.event_id AND e.organisation_id = ?
        JOIN sessions s ON s.id = ci.session_id AND s.event_id = ci.event_id
        JOIN people p ON p.id = ci.person_id
       WHERE ci.event_id = ?
       ORDER BY ci.updated_at DESC
       LIMIT 50
    `,
    )
      .bind(viewer.organisationId, viewer.eventId)
      .all<{
        id: string;
        sessionId: string;
        sessionTitle: string;
        personId: string;
        personName: string;
        email: string;
        icalUid: string;
        sequenceNumber: number;
        method: string;
        status: string;
        providerEventId: string | null;
        updatedAt: number;
        provider: CalendarProviderName | null;
      }>();
    return result.results;
  }

  async queueLifecycle(
    viewer: CalendarQueueActor,
    input: QueueCalendarLifecycleInput,
  ) {
    const parsed = queueCalendarLifecycleSchema.parse(input);
    const findDuplicate = () =>
      this.env.DB.prepare(
        `
        SELECT id, status FROM operation_jobs
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
        .first<{ id: string; status: string }>();
    const getInvitation = () =>
      this.env.DB.prepare(
        `
        SELECT ci.id, ci.ical_uid AS icalUid, ci.sequence_number AS sequenceNumber,
               ci.method, ci.status,
               ci.provider_event_id AS providerEventId, ci.current_attempt_id AS currentAttemptId,
               (SELECT csa.status FROM calendar_sync_attempts csa
                 WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id) AS currentAttemptStatus
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

    const [session, existing, sender] = await Promise.all([
      this.getSession(viewer, parsed.sessionId, parsed.personId, parsed.method),
      getInvitation(),
      this.getVerifiedSender(viewer),
    ]);
    if (!session)
      throw new CalendarStateError(
        "The speaker must be assigned to a session in the published schedule before a calendar invitation can be sent.",
      );
    if (parsed.method === "CANCEL" && !existing)
      throw new CalendarStateError(
        "A calendar invitation must exist before it can be cancelled.",
      );
    if (parsed.provider === "email_ics") {
      if (!sender)
        throw new CalendarStateError(
          "A verified Resend sender profile is required for calendar email delivery.",
        );
      if (!this.env.RESEND_API_KEY?.trim())
        throw new CalendarStateError(
          "RESEND_API_KEY is required for calendar email delivery.",
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
        SELECT cc.id
          FROM calendar_connections cc
          JOIN events e ON e.organisation_id = cc.organisation_id
         WHERE cc.id = ? AND e.id = ? AND e.organisation_id = ?
           AND cc.person_id = ? AND cc.provider = ? AND cc.status = 'connected'
           AND (cc.expires_at IS NULL OR cc.expires_at > unixepoch())
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
        .first<{ id: string }>();
      if (!connection)
        throw new CalendarStateError(
          "The selected connected calendar is unavailable or belongs to another event participant.",
        );
      connectionId = connection.id;
    }

    const organizerName = sender?.fromName ?? session.attendeeName;
    const organizerEmail = sender?.fromEmail ?? session.attendeeEmail;
    let claimed: {
      operationId: string;
      invitationId: string;
      attemptId: string;
      sequence: number;
      payloadHash: string;
      communicationId: string | null;
      deliveryId: string | null;
      queueMessage: CalendarQueueMessage;
    } | null = null;
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

      const invitationId = snapshot?.id ?? crypto.randomUUID();
      const attemptId = crypto.randomUUID();
      const sequence = snapshot ? snapshot.sequenceNumber + 1 : 0;
      const recreateDirectProviderEvent =
        parsed.provider !== "email_ics" &&
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
        provider: parsed.provider,
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
        statements.push(
          this.env.DB.prepare(
            `
            INSERT INTO communications (
              id, event_id, sender_profile_id, operation_id, idempotency_key, kind, channel,
              status, audience_json, content_snapshot_json, recipient_count, queued_at,
              created_by_person_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'transactional', 'calendar', 'queued', ?, ?, 1, unixepoch(), ?, unixepoch(), unixepoch())
          `,
          ).bind(
            communicationId,
            viewer.eventId,
            sender.id,
            operationId,
            `communication:${parsed.idempotencyKey}`,
            JSON.stringify({ type: "calendar", personIds: [parsed.personId] }),
            JSON.stringify({ schemaVersion: 1, calendar: payload }),
            viewer.personId,
          ),
          this.env.DB.prepare(
            `
            INSERT INTO communication_deliveries (
              id, event_id, communication_id, person_id, recipient_address, recipient_name,
              channel, provider, idempotency_key, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, 'calendar', 'resend', ?, 'queued', unixepoch(), unixepoch())
          `,
          ).bind(
            deliveryId,
            viewer.eventId,
            communicationId,
            parsed.personId,
            session.attendeeEmail,
            session.attendeeName,
            `delivery:${parsed.idempotencyKey}`,
          ),
        );
      }
      if (snapshot) {
        statements.push(
          this.env.DB.prepare(
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
        `,
          ).bind(
            connectionId,
            deliveryId,
            sequence,
            parsed.method,
            recreateDirectProviderEvent ? 1 : 0,
            payloadHash,
            attemptId,
            snapshot.id,
            viewer.eventId,
            snapshot.sequenceNumber,
            snapshot.currentAttemptId,
          ),
        );
      } else {
        statements.push(
          this.env.DB.prepare(
            `
          INSERT INTO calendar_invitations (
            id, event_id, session_id, person_id, connection_id, delivery_id, ical_uid,
            sequence_number, method, provider_event_id, status, last_payload_hash,
            current_attempt_id, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, NULL, 'queued', ?, ?, unixepoch(), unixepoch())
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
          ),
        );
      }
      statements.push(
        this.env.DB.prepare(
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
        this.env.DB.prepare(
          `
          INSERT INTO operation_jobs (
            id, organisation_id, event_id, requested_by_person_id, type, idempotency_key,
            correlation_id, status, payload_json, progress_total, progress_completed,
            progress_failed, cancellable, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'calendar.sync', ?, ?, 'queued', ?, 1, 0, 0, 1, unixepoch(), unixepoch())
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
        this.env.DB.prepare(
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
        this.env.DB.prepare(
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
        await this.env.DB.batch(statements);
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
      if (!this.env.OPERATIONS_QUEUE)
        throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
      await this.env.OPERATIONS_QUEUE.send(queueMessage);
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

  /**
   * Fans out calendar lifecycle work only after a schedule version is durably
   * published. Existing invitations retain their provider; new invitations
   * prefer an active direct connection and otherwise use universal email ICS.
   */
  async queuePublishedSchedule(
    viewer: CalendarQueueActor,
    scheduleVersionId: string,
    options: {
      beforeTarget?: () => Promise<void>;
      afterTarget?: string;
      operationId?: string;
    } = {},
  ): Promise<PublishedScheduleCalendarDispatch> {
    let snapshotTargets: PublishedScheduleCalendarTarget[] | null = null;
    if (options.operationId) {
      const marker = await this.env.DB.prepare(
        `
        SELECT 1
          FROM operation_items marker
          JOIN operation_jobs operation ON operation.id = marker.operation_id
         WHERE marker.operation_id = ? AND marker.item_key = ?
           AND marker.entity_type = 'schedule_calendar_snapshot'
           AND marker.entity_id = ? AND marker.status = 'completed'
           AND operation.event_id = ? AND operation.organisation_id = ?
           AND operation.type = 'schedule.calendar_fanout'
      `,
      )
        .bind(
          options.operationId,
          SCHEDULE_CALENDAR_FANOUT_SNAPSHOT_KEY,
          scheduleVersionId,
          viewer.eventId,
          viewer.organisationId,
        )
        .first();
      if (!marker)
        throw new CalendarStateError(
          "The durable calendar fan-out target snapshot is missing.",
        );
      const snapshot = await this.env.DB.prepare(
        `
        SELECT item_key AS itemKey, result_json AS resultJson
          FROM operation_items
         WHERE operation_id = ? AND entity_type = ?
         ORDER BY item_key
      `,
      )
        .bind(options.operationId, SCHEDULE_CALENDAR_FANOUT_TARGET_TYPE)
        .all<{ itemKey: string; resultJson: string }>();
      snapshotTargets = snapshot.results.map((row) => ({
        key: row.itemKey,
        ...publishedScheduleCalendarTargetSchema.parse(
          JSON.parse(row.resultJson),
        ),
      }));
    } else {
      const published = await this.env.DB.prepare(
        `
        SELECT sv.id
          FROM schedule_versions sv
          JOIN events e ON e.id = sv.event_id AND e.organisation_id = ?
         WHERE sv.id = ? AND sv.event_id = ? AND sv.status = 'published'
      `,
      )
        .bind(viewer.organisationId, scheduleVersionId, viewer.eventId)
        .first<{ id: string }>();
      if (!published)
        throw new CalendarStateError(
          "Calendar dispatch requires the committed published schedule version.",
        );
    }

    const requested = snapshotTargets
      ? { results: [] }
      : await this.env.DB.prepare(
          `
      SELECT se.session_id AS sessionId, ss.person_id AS personId,
             ci.connection_id AS existingConnectionId,
             (SELECT csa.provider FROM calendar_sync_attempts csa
               WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id) AS existingProvider,
             (SELECT cc.id FROM calendar_connections cc
               WHERE cc.organisation_id = ? AND cc.person_id = ss.person_id
                 AND cc.status = 'connected' AND (cc.event_id IS NULL OR cc.event_id = ?)
                 AND (cc.expires_at IS NULL OR cc.expires_at > unixepoch())
               ORDER BY CASE cc.provider WHEN 'google' THEN 0 ELSE 1 END, cc.updated_at DESC LIMIT 1) AS activeConnectionId,
             (SELECT cc.provider FROM calendar_connections cc
               WHERE cc.organisation_id = ? AND cc.person_id = ss.person_id
                 AND cc.status = 'connected' AND (cc.event_id IS NULL OR cc.event_id = ?)
                 AND (cc.expires_at IS NULL OR cc.expires_at > unixepoch())
               ORDER BY CASE cc.provider WHEN 'google' THEN 0 ELSE 1 END, cc.updated_at DESC LIMIT 1) AS activeProvider
        FROM schedule_entries se
        JOIN schedule_versions sv ON sv.id = se.schedule_version_id AND sv.event_id = se.event_id
        JOIN session_speakers ss ON ss.session_id = se.session_id AND ss.event_id = se.event_id
        LEFT JOIN calendar_invitations ci
          ON ci.event_id = se.event_id AND ci.session_id = se.session_id AND ci.person_id = ss.person_id
       WHERE se.event_id = ? AND sv.id = ? AND sv.status = 'published'
       ORDER BY se.starts_at, se.session_id, ss.position
    `,
        )
          .bind(
            viewer.organisationId,
            viewer.eventId,
            viewer.organisationId,
            viewer.eventId,
            viewer.eventId,
            scheduleVersionId,
          )
          .all<{
            sessionId: string;
            personId: string;
            existingConnectionId: string | null;
            existingProvider: CalendarProviderName | null;
            activeConnectionId: string | null;
            activeProvider: Exclude<CalendarProviderName, "email_ics"> | null;
          }>();
    const cancelled = snapshotTargets
      ? { results: [] }
      : await this.env.DB.prepare(
          `
      SELECT ci.session_id AS sessionId, ci.person_id AS personId,
             ci.connection_id AS existingConnectionId,
             COALESCE((SELECT csa.provider FROM calendar_sync_attempts csa
               WHERE csa.id = ci.current_attempt_id AND csa.invitation_id = ci.id), 'email_ics') AS existingProvider
        FROM calendar_invitations ci
        JOIN events e ON e.id = ci.event_id AND e.organisation_id = ?
       WHERE ci.event_id = ?
         AND (
           ci.status IN ('queued','sent','confirmed')
           OR (
             ci.status = 'failed'
             AND EXISTS (
               SELECT 1 FROM calendar_sync_attempts delivered_request
                WHERE delivered_request.invitation_id = ci.id
                  AND delivered_request.method = 'REQUEST'
                  AND delivered_request.status = 'succeeded'
             )
           )
         )
         AND NOT EXISTS (
           SELECT 1
             FROM schedule_entries se
             JOIN schedule_versions sv ON sv.id = se.schedule_version_id AND sv.event_id = se.event_id
             JOIN session_speakers ss ON ss.session_id = se.session_id AND ss.event_id = se.event_id
            WHERE sv.id = ? AND sv.status = 'published'
              AND se.session_id = ci.session_id AND ss.person_id = ci.person_id
         )
       ORDER BY ci.updated_at
    `,
        )
          .bind(viewer.organisationId, viewer.eventId, scheduleVersionId)
          .all<{
            sessionId: string;
            personId: string;
            existingConnectionId: string | null;
            existingProvider: CalendarProviderName;
          }>();

    const targets =
      snapshotTargets ??
      [
        ...requested.results.map((target) => ({
          sessionId: target.sessionId,
          personId: target.personId,
          method: "REQUEST" as const,
          provider:
            target.existingProvider ??
            target.activeProvider ??
            ("email_ics" as CalendarProviderName),
          connectionId:
            target.existingConnectionId ?? target.activeConnectionId,
        })),
        ...cancelled.results.map((target) => ({
          sessionId: target.sessionId,
          personId: target.personId,
          method: "CANCEL" as const,
          provider: target.existingProvider,
          connectionId: target.existingConnectionId,
        })),
      ]
        .map((target) => ({
          ...target,
          key: JSON.stringify([
            target.method,
            target.sessionId,
            target.personId,
            target.provider,
          ]),
        }))
        .sort((left, right) =>
          left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
        );
    const remainingTargets = options.afterTarget
      ? targets.filter((target) => target.key > options.afterTarget!)
      : targets;
    const batchTargets = remainingTargets.slice(
      0,
      SCHEDULE_CALENDAR_FANOUT_BATCH_SIZE,
    );
    const result: PublishedScheduleCalendarDispatch = {
      targetCount: targets.length,
      processedCount: batchTargets.length,
      queuedCount: 0,
      duplicateCount: 0,
      nextTarget:
        remainingTargets.length > batchTargets.length
          ? (batchTargets.at(-1)?.key ?? null)
          : null,
      dispatchError: null,
      failures: [],
    };
    for (const target of batchTargets) {
      await options.beforeTarget?.();
      try {
        const idempotencyKey = await publishedScheduleCalendarIdempotencyKey({
          scheduleVersionId,
          method: target.method,
          sessionId: target.sessionId,
          personId: target.personId,
          provider: target.provider,
        });
        const queued = await this.queueLifecycle(viewer, {
          sessionId: target.sessionId,
          personId: target.personId,
          method: target.method,
          provider: target.provider,
          ...(target.provider !== "email_ics" && target.connectionId
            ? { connectionId: target.connectionId }
            : {}),
          idempotencyKey,
        });
        if (
          queued.duplicate &&
          ["queue_failed", "failed", "partially_failed", "cancelled"].includes(
            queued.status,
          )
        ) {
          result.failures.push({
            sessionId: target.sessionId,
            personId: target.personId,
            method: target.method,
            provider: target.provider,
            message: `Existing calendar operation ${queued.operationId} is ${queued.status} and must be retried from the Operation Centre.`,
          });
        } else if (queued.duplicate) result.duplicateCount += 1;
        else result.queuedCount += 1;
      } catch (error) {
        result.failures.push({
          sessionId: target.sessionId,
          personId: target.personId,
          method: target.method,
          provider: target.provider,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return result;
  }

  private async getSession(
    viewer: CalendarQueueActor,
    sessionId: string,
    personId: string,
    method: "REQUEST" | "CANCEL",
  ) {
    const current = await this.env.DB.prepare(
      `
      SELECT s.id AS sessionId, s.title, s.description,
             se.starts_at AS startsAt, se.ends_at AS endsAt, r.name AS roomName,
             e.timezone, p.display_name AS attendeeName, p.email AS attendeeEmail
        FROM sessions s
        JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
        JOIN session_speakers ss ON ss.session_id = s.id AND ss.event_id = s.event_id AND ss.person_id = ?
        JOIN people p ON p.id = ss.person_id
        JOIN schedule_entries se ON se.session_id = s.id AND se.event_id = s.event_id
        JOIN schedule_versions sv ON sv.id = se.schedule_version_id AND sv.event_id = s.event_id AND sv.status = 'published'
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
      SELECT s.id AS sessionId, s.title, s.description,
             se.starts_at AS startsAt, se.ends_at AS endsAt, r.name AS roomName,
             e.timezone, p.display_name AS attendeeName, p.email AS attendeeEmail
        FROM calendar_invitations ci
        JOIN events e ON e.id = ci.event_id AND e.organisation_id = ?
        JOIN sessions s ON s.id = ci.session_id AND s.event_id = ci.event_id
        JOIN people p ON p.id = ci.person_id
        JOIN schedule_entries se ON se.session_id = ci.session_id AND se.event_id = ci.event_id
        JOIN schedule_versions sv ON sv.id = se.schedule_version_id AND sv.event_id = ci.event_id
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
  ) {
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
