import type { CalendarQueueMessage } from "../../app/modules/calendars/calendar-schema";

export type CalendarAttemptRow = {
  id: string;
  sessionId: string;
  personId: string;
  sequenceNumber: number;
  method: "REQUEST" | "CANCEL";
  status: "queued" | "running" | "succeeded" | "failed" | "superseded" | null;
  attemptSequence: number | null;
  attemptMethod: "REQUEST" | "CANCEL" | null;
  attemptProvider: "email_ics" | "google" | "microsoft" | null;
  currentAttemptId: string | null;
  lastPayloadHash: string | null;
  providerEventId: string | null;
  deliveryId: string | null;
  communicationId: string | null;
  connectionId: string | null;
  encryptedCredentials: string | null;
  connectionProvider: "google" | "microsoft" | null;
  connectionStatus: string | null;
  connectionExpiresAt: number | null;
  connectionPersonId: string | null;
};

export async function loadCalendarAttempt(
  env: CloudflareEnvironment,
  message: CalendarQueueMessage,
) {
  return env.DB.prepare(
    `
    SELECT ci.id, ci.session_id AS sessionId, ci.person_id AS personId,
           ci.sequence_number AS sequenceNumber, ci.method,
           ci.current_attempt_id AS currentAttemptId, ci.last_payload_hash AS lastPayloadHash,
           ci.provider_event_id AS providerEventId, ci.delivery_id AS deliveryId,
           d.communication_id AS communicationId, ci.connection_id AS connectionId,
           cc.encrypted_credentials AS encryptedCredentials, cc.provider AS connectionProvider,
           cc.status AS connectionStatus, cc.expires_at AS connectionExpiresAt,
           cc.person_id AS connectionPersonId,
           csa.status, csa.sequence_number AS attemptSequence,
           csa.method AS attemptMethod, csa.provider AS attemptProvider
      FROM calendar_invitations ci
      LEFT JOIN calendar_sync_attempts csa
        ON csa.id = ? AND csa.invitation_id = ci.id
      LEFT JOIN communication_deliveries d
        ON d.id = ci.delivery_id AND d.event_id = ci.event_id
      LEFT JOIN calendar_connections cc
        ON cc.id = ci.connection_id
       AND cc.organisation_id = ?
       AND cc.person_id = ?
       AND cc.provider = ?
       AND (cc.event_id IS NULL OR cc.event_id = ci.event_id)
     WHERE ci.id = ? AND ci.event_id = ?
  `,
  )
    .bind(
      message.attemptId,
      message.organisationId,
      message.personId,
      message.provider,
      message.invitationId,
      message.eventId,
    )
    .first<CalendarAttemptRow>();
}

export function isExactCalendarAttempt(
  row: CalendarAttemptRow | null,
  message: CalendarQueueMessage,
  payloadHash: string,
) {
  return (
    row?.currentAttemptId === message.attemptId &&
    row.sessionId === message.sessionId &&
    row.personId === message.personId &&
    row.connectionId === message.connectionId &&
    row.sequenceNumber === message.payload.sequence &&
    row.method === message.payload.method &&
    row.lastPayloadHash === payloadHash &&
    row.attemptSequence === message.payload.sequence &&
    row.attemptMethod === message.payload.method &&
    row.attemptProvider === message.provider
  );
}
