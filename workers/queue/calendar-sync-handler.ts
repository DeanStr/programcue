import {
  calendarQueueMessageSchema,
  type CalendarQueueMessage,
} from "../../app/modules/calendars/calendar-schema";
import {
  decryptCalendarCredentials,
  GoogleCalendarProvider,
  MicrosoftCalendarProvider,
} from "../../app/modules/calendars/calendar-providers.server";
import { CalendarOAuthService } from "../../app/modules/calendars/calendar-oauth.server";
import {
  generateInvitationIcs,
  hashCalendarLifecyclePayload,
} from "../../app/modules/calendars/ics.server";
import { renderProgramCueEmail } from "../../app/modules/communications/email-templates/render-email.server";
import { createEmailProvider } from "../../app/modules/communications/email-provider.server";
import {
  assertOperationClaim,
  errorDetails,
  loadOperationClaim,
  notifyRealtimeAfterCommit,
  QUEUE_CLAIM_LEASE_SECONDS,
  QueueClaimLeaseBusyError,
  QueueClaimLeaseLostError,
  renewOperationClaim,
  returnedChangeSequence,
} from "./claim-infrastructure";
import type { QueueProviderDependencies } from "./handler-types";

type CalendarAttemptRow = {
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

async function loadCalendarAttempt(
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

function isExactCalendarAttempt(
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

async function finishSupersededCalendarAttempt(
  env: CloudflareEnvironment,
  message: CalendarQueueMessage,
  reason: string,
  providerEventId: string | null = null,
  claimToken?: string,
) {
  const claimGuard = claimToken
    ? `AND EXISTS (
    SELECT 1 FROM operation_jobs claimed_operation
     WHERE claimed_operation.id = ? AND claimed_operation.event_id = ?
       AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
  )`
    : "";
  const claimBindings = claimToken
    ? [message.operationId, message.eventId, claimToken]
    : [];
  const resultJson = JSON.stringify({
    invitationId: message.invitationId,
    attemptId: message.attemptId,
    sequence: message.payload.sequence,
    provider: message.provider,
    outcome: "superseded",
    providerApplied: providerEventId !== null,
    ...(providerEventId ? { providerEventId } : {}),
    reason,
  });
  const results = await env.DB.batch([
    env.DB.prepare(
      `UPDATE calendar_sync_attempts
      SET status = 'superseded', provider_event_id = COALESCE(?, provider_event_id),
          error_code = 'SUPERSEDED', error_message = ?, completed_at = unixepoch()
      WHERE id = ? AND invitation_id = ? AND sequence_number = ? AND method = ? AND provider = ?
        AND status IN ('queued','running','failed') ${claimGuard}`,
    ).bind(
      providerEventId,
      reason.slice(0, 2_000),
      message.attemptId,
      message.invitationId,
      message.payload.sequence,
      message.payload.method,
      message.provider,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communication_deliveries
      SET status = 'cancelled', failure_code = 'SUPERSEDED', failure_message = ?, updated_at = unixepoch()
      WHERE communication_id IN (SELECT id FROM communications WHERE operation_id = ? AND event_id = ?)
        AND status IN ('queued','sending','failed') ${claimGuard}`,
    ).bind(
      reason.slice(0, 2_000),
      message.operationId,
      message.eventId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communications
      SET status = 'cancelled', cancelled_at = unixepoch(), updated_at = unixepoch()
      WHERE operation_id = ? AND event_id = ? AND status IN ('queued','sending','failed','partially_failed')
        ${claimGuard}`,
    ).bind(message.operationId, message.eventId, ...claimBindings),
    env.DB.prepare(
      `UPDATE operation_items
      SET status = 'skipped', result_json = ?, error_code = 'SUPERSEDED', error_message = ?,
          completed_at = unixepoch(), updated_at = unixepoch()
      WHERE operation_id = ? AND status IN ('pending','running','failed') ${claimGuard}`,
    ).bind(
      resultJson,
      reason.slice(0, 2_000),
      message.operationId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
      SET status = 'cancelled', progress_total = 1, progress_completed = 1, progress_failed = 0,
          result_json = ?, last_error = NULL, completed_at = unixepoch(),
          claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND status NOT IN ('completed','cancelled')
        ${claimToken ? "AND status = 'running' AND claim_token = ?" : ""}`,
    ).bind(
      resultJson,
      message.operationId,
      message.eventId,
      ...(claimToken ? [claimToken] : []),
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
      id, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
    ) SELECT ?, ?, ?, 'calendar.lifecycle.superseded', 'calendar_invitation', ?, ?, unixepoch()
       WHERE changes() = 1
         AND EXISTS (SELECT 1 FROM operation_jobs WHERE id = ? AND event_id = ? AND status = 'cancelled')`,
    ).bind(
      crypto.randomUUID(),
      message.organisationId,
      message.eventId,
      message.invitationId,
      resultJson,
      message.operationId,
      message.eventId,
    ),
    env.DB.prepare(
      `INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
      SELECT event_id, 'calendar_invitation', ?, 'progress', correlation_id, unixepoch()
        FROM operation_jobs WHERE id = ? AND event_id = ? AND status = 'cancelled' AND changes() = 1
      RETURNING sequence`,
    ).bind(message.invitationId, message.operationId, message.eventId),
  ]);
  const operationFinished = (results[4]?.meta.changes ?? 0) === 1;
  if (!operationFinished) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (current?.status === "completed" || current?.status === "cancelled")
      return;
    if (current?.status === "running") {
      if (claimToken && current.claimToken !== claimToken)
        throw new QueueClaimLeaseLostError();
      throw new QueueClaimLeaseBusyError();
    }
  }
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(results.at(-1)),
    message.operationId,
  );
}

async function finishCalendarAttemptFailure(
  env: CloudflareEnvironment,
  message: CalendarQueueMessage,
  payloadHash: string,
  failure: { code: string; message: string },
  claimToken?: string,
) {
  const claimGuard = claimToken
    ? `AND EXISTS (
    SELECT 1 FROM operation_jobs claimed_operation
     WHERE claimed_operation.id = ? AND claimed_operation.event_id = ?
       AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
  )`
    : "";
  const claimBindings = claimToken
    ? [message.operationId, message.eventId, claimToken]
    : [];
  const failureResults = await env.DB.batch([
    env.DB.prepare(
      `UPDATE calendar_sync_attempts
      SET status = 'failed', error_code = ?, error_message = ?, completed_at = unixepoch()
      WHERE id = ? AND invitation_id = ? AND sequence_number = ? AND method = ? AND provider = ?
        AND status IN ('queued','running','failed') ${claimGuard}`,
    ).bind(
      failure.code,
      failure.message,
      message.attemptId,
      message.invitationId,
      message.payload.sequence,
      message.payload.method,
      message.provider,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE calendar_invitations SET status = 'failed', updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND current_attempt_id = ? AND sequence_number = ?
        AND method = ? AND last_payload_hash = ? ${claimGuard}`,
    ).bind(
      message.invitationId,
      message.eventId,
      message.attemptId,
      message.payload.sequence,
      message.payload.method,
      payloadHash,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE operation_items
      SET status = 'failed', error_code = ?, error_message = ?, completed_at = unixepoch(), updated_at = unixepoch()
      WHERE operation_id = ? AND status <> 'completed' ${claimGuard}`,
    ).bind(
      failure.code,
      failure.message,
      message.operationId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communication_deliveries
      SET status = 'failed', failure_code = ?, failure_message = ?, next_attempt_at = unixepoch() + 60,
          updated_at = unixepoch()
      WHERE communication_id IN (SELECT id FROM communications WHERE operation_id = ? AND event_id = ?)
        AND status IN ('queued','sending','failed') ${claimGuard}`,
    ).bind(
      failure.code,
      failure.message,
      message.operationId,
      message.eventId,
      ...claimBindings,
    ),
    env.DB.prepare(
      `UPDATE communications SET status = 'failed', updated_at = unixepoch()
      WHERE operation_id = ? AND event_id = ? AND status NOT IN ('sent','cancelled') ${claimGuard}`,
    ).bind(message.operationId, message.eventId, ...claimBindings),
    env.DB.prepare(
      `UPDATE operation_jobs
      SET status = 'failed', progress_total = 1, progress_completed = 1, progress_failed = 1,
          last_error = ?, completed_at = unixepoch(), claim_token = NULL,
          claim_expires_at = NULL, updated_at = unixepoch()
      WHERE id = ? AND event_id = ? AND status NOT IN ('completed','cancelled')
        ${claimToken ? "AND status = 'running' AND claim_token = ?" : ""}`,
    ).bind(
      failure.message,
      message.operationId,
      message.eventId,
      ...(claimToken ? [claimToken] : []),
    ),
    env.DB.prepare(
      `INSERT INTO audit_events (
      id, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
    ) SELECT ?, ?, ?, 'calendar.lifecycle.failed', 'calendar_invitation', ?, ?, unixepoch()
       WHERE changes() = 1`,
    ).bind(
      crypto.randomUUID(),
      message.organisationId,
      message.eventId,
      message.invitationId,
      JSON.stringify({
        attemptId: message.attemptId,
        provider: message.provider,
        method: message.payload.method,
        sequence: message.payload.sequence,
        errorCode: failure.code,
        errorMessage: failure.message,
      }),
    ),
    env.DB.prepare(
      `INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
      SELECT event_id, 'calendar_invitation', ?, 'progress', correlation_id, unixepoch()
        FROM operation_jobs WHERE id = ? AND event_id = ? AND status = 'failed' AND changes() = 1
      RETURNING sequence`,
    ).bind(message.invitationId, message.operationId, message.eventId),
  ]);
  const operationFinished = (failureResults[5]?.meta.changes ?? 0) === 1;
  if (!operationFinished) {
    const current = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (current?.status === "completed" || current?.status === "cancelled")
      return;
    if (current?.status === "running") {
      if (claimToken && current.claimToken !== claimToken)
        throw new QueueClaimLeaseLostError();
      throw new QueueClaimLeaseBusyError();
    }
  }
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(failureResults.at(-1)),
    message.operationId,
  );
}

async function deliverCalendarProvider(input: {
  env: CloudflareEnvironment;
  message: CalendarQueueMessage;
  invitation: CalendarAttemptRow;
  payloadHash: string;
  claimToken: string;
  dependencies: QueueProviderDependencies;
}): Promise<string | null> {
  const { env, message, payloadHash, claimToken, dependencies } = input;
  let { invitation } = input;
  let providerEventId: string;
  if (message.provider === "email_ics") {
    if (!invitation.deliveryId)
      throw new Error("Calendar email delivery record is missing.");
    const delivery = await env.DB.prepare(
      `
      SELECT d.id, d.recipient_address AS address, d.idempotency_key AS idempotencyKey,
             d.status, d.provider AS provider,
             d.provider_message_id AS providerMessageId,
             c.id AS communicationId, sp.from_name AS fromName, sp.from_email AS fromEmail,
             sp.reply_to_email AS replyToEmail, sp.provider AS senderProvider
        FROM communication_deliveries d
        JOIN communications c ON c.id = d.communication_id AND c.event_id = d.event_id
        JOIN sender_profiles sp ON sp.id = c.sender_profile_id AND sp.event_id = c.event_id
       WHERE d.id = ? AND d.event_id = ? AND c.operation_id = ?
         AND c.status <> 'cancelled' AND sp.status = 'verified'
    `,
    )
      .bind(invitation.deliveryId, message.eventId, message.operationId)
      .first<{
        id: string;
        address: string;
        idempotencyKey: string;
        status: string;
        provider: string | null;
        providerMessageId: string | null;
        senderProvider: string;
        communicationId: string;
        fromName: string;
        fromEmail: string;
        replyToEmail: string | null;
      }>();
    if (!delivery)
      throw new Error("Calendar email sender or delivery is unavailable.");
    if (delivery.status === "sent" && delivery.providerMessageId) {
      providerEventId = delivery.providerMessageId;
    } else {
      const emailProvider = dependencies.email ?? createEmailProvider(env);
      if (
        delivery.provider !== emailProvider.name ||
        delivery.senderProvider !== emailProvider.name
      )
        throw new Error(
          "The calendar email delivery provider does not match its durable intent.",
        );
      const methodLabel =
        message.payload.method === "CANCEL"
          ? "Cancelled"
          : "Calendar invitation";
      const subject = `${methodLabel}: ${message.payload.title}`;
      const rendered = await renderProgramCueEmail({
        preview: subject,
        heading: subject,
        body:
          message.payload.method === "CANCEL"
            ? "This session has been cancelled. The attached calendar update removes it from your calendar."
            : `Your session is scheduled at ${message.payload.location}. The invitation is attached for Gmail, Outlook and other iCalendar-compatible calendars.`,
        eventName: message.payload.organizerName,
        accent: message.payload.brandAccent,
        physicalAddress:
          "This operational calendar message was sent by the event organiser.",
      });
      await renewOperationClaim(
        env,
        { organisationId: message.organisationId, eventId: message.eventId },
        message.operationId,
        claimToken,
      );
      const deliveryClaim = await env.DB.prepare(
        `UPDATE communication_deliveries
        SET status = 'sending', attempt_count = attempt_count + 1,
            failure_code = NULL, failure_message = NULL, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND status IN ('queued','failed','sending')
          AND EXISTS (
            SELECT 1 FROM calendar_invitations ci
            JOIN calendar_sync_attempts csa ON csa.id = ? AND csa.invitation_id = ci.id
            JOIN operation_jobs claimed_operation ON claimed_operation.id = ? AND claimed_operation.event_id = ci.event_id
             WHERE ci.id = ? AND ci.event_id = ? AND ci.current_attempt_id = ?
               AND ci.sequence_number = ? AND ci.method = ? AND ci.last_payload_hash = ?
               AND csa.status = 'running' AND csa.sequence_number = ?
               AND csa.method = ? AND csa.provider = ?
               AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
          )`,
      )
        .bind(
          delivery.id,
          message.eventId,
          message.attemptId,
          message.operationId,
          message.invitationId,
          message.eventId,
          message.attemptId,
          message.payload.sequence,
          message.payload.method,
          payloadHash,
          message.payload.sequence,
          message.payload.method,
          message.provider,
          claimToken,
        )
        .run();
      if ((deliveryClaim.meta.changes ?? 0) !== 1)
        throw new Error("Calendar email delivery could not be claimed.");
      const result = await emailProvider.send({
        from: `${delivery.fromName} <${delivery.fromEmail}>`,
        replyTo: delivery.replyToEmail,
        to: delivery.address,
        subject,
        html: rendered.html,
        text: rendered.text,
        idempotencyKey: delivery.idempotencyKey,
        attachments: [
          {
            filename: "program-cue-invitation.ics",
            content: generateInvitationIcs(message.payload),
            contentType: `text/calendar; charset=utf-8; method=${message.payload.method}`,
          },
        ],
      });
      providerEventId = result.messageId;
      const emailCompletionResults = await env.DB.batch([
        env.DB.prepare(
          `UPDATE communication_deliveries
          SET status = 'sent', provider_message_id = ?,
              failure_code = NULL, failure_message = NULL, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?
            AND EXISTS (
              SELECT 1 FROM operation_jobs claimed_operation
               WHERE claimed_operation.id = ? AND claimed_operation.event_id = ?
                 AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
            )`,
        ).bind(
          providerEventId,
          delivery.id,
          message.eventId,
          message.operationId,
          message.eventId,
          claimToken,
        ),
        env.DB.prepare(
          `UPDATE communications SET status = 'sent', sent_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND operation_id = ?
            AND EXISTS (
              SELECT 1 FROM operation_jobs claimed_operation
               WHERE claimed_operation.id = communications.operation_id
                 AND claimed_operation.event_id = communications.event_id
                 AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
            )`,
        ).bind(
          delivery.communicationId,
          message.eventId,
          message.operationId,
          claimToken,
        ),
      ]);
      if (
        (emailCompletionResults[0].meta.changes ?? 0) !== 1 ||
        (emailCompletionResults[1].meta.changes ?? 0) !== 1
      ) {
        throw new QueueClaimLeaseLostError();
      }
    }
  } else {
    if (
      invitation.connectionId &&
      invitation.connectionPersonId &&
      (invitation.connectionStatus === "needs_attention" ||
        (invitation.connectionExpiresAt !== null &&
          invitation.connectionExpiresAt <=
            Math.floor(Date.now() / 1_000) + 300))
    ) {
      await renewOperationClaim(
        env,
        { organisationId: message.organisationId, eventId: message.eventId },
        message.operationId,
        claimToken,
      );
      await new CalendarOAuthService(env).refreshConnection(
        {
          organisationId: message.organisationId,
          eventId: message.eventId,
          personId: invitation.connectionPersonId,
        },
        invitation.connectionId,
      );
      await renewOperationClaim(
        env,
        { organisationId: message.organisationId, eventId: message.eventId },
        message.operationId,
        claimToken,
      );
      const refreshed = await loadCalendarAttempt(env, message);
      if (!refreshed)
        throw new Error(
          "The calendar attempt disappeared while its access token was refreshed.",
        );
      invitation = refreshed;
    }
    if (
      invitation.connectionProvider !== message.provider ||
      !invitation.encryptedCredentials ||
      invitation.connectionStatus !== "connected" ||
      !invitation.connectionPersonId ||
      invitation.connectionExpiresAt === null ||
      invitation.connectionExpiresAt <= Math.floor(Date.now() / 1_000)
    ) {
      throw new Error(
        `The ${message.provider} calendar connection is missing or no longer active.`,
      );
    }
    let provider = dependencies.directCalendar;
    if (!provider) {
      const credentials = await decryptCalendarCredentials(
        invitation.encryptedCredentials,
        env.CALENDAR_CREDENTIALS_KEY,
      );
      if (
        credentials.accessTokenExpiresAt !== invitation.connectionExpiresAt ||
        credentials.accessTokenExpiresAt <= Math.floor(Date.now() / 1_000)
      )
        throw new Error(
          "Connected calendar credential expiry does not match its durable connection state.",
        );
      provider =
        message.provider === "google"
          ? new GoogleCalendarProvider(
              credentials.accessToken,
              credentials.calendarId,
            )
          : new MicrosoftCalendarProvider(credentials.accessToken);
    }
    if (provider.name !== message.provider)
      throw new Error(
        `The injected ${provider.name} adapter cannot process a ${message.provider} operation.`,
      );
    await renewOperationClaim(
      env,
      { organisationId: message.organisationId, eventId: message.eventId },
      message.operationId,
      claimToken,
    );
    const beforeProvider = await loadCalendarAttempt(env, message);
    if (
      !isExactCalendarAttempt(beforeProvider, message, payloadHash) ||
      beforeProvider?.status !== "running"
    ) {
      await finishSupersededCalendarAttempt(
        env,
        message,
        "A newer calendar lifecycle attempt replaced this work before provider delivery.",
        null,
        claimToken,
      );
      return null;
    }
    const result = await provider.apply({
      uid: message.payload.uid,
      title: message.payload.title,
      description: message.payload.description,
      location: message.payload.location,
      startsAtIso: new Date(message.payload.startsAt * 1_000).toISOString(),
      endsAtIso: new Date(message.payload.endsAt * 1_000).toISOString(),
      timezone: message.payload.timezone,
      attendeeEmail: message.payload.attendeeEmail,
      attendeeName: message.payload.attendeeName,
      sequence: message.payload.sequence,
      method: message.payload.method,
      externalEventId: beforeProvider.providerEventId,
    });
    providerEventId = result.providerEventId;
  }

  return providerEventId;
}
export async function processCalendarSync(
  input: unknown,
  env: CloudflareEnvironment,
  dependencies: QueueProviderDependencies = {},
) {
  const message = calendarQueueMessageSchema.parse(input);
  const operation = await env.DB.prepare(
    `
    SELECT o.id, o.status, o.payload_json AS payloadJson
      FROM operation_jobs o
      JOIN events e ON e.id = o.event_id AND e.organisation_id = ?
     WHERE o.id = ? AND o.event_id = ? AND o.type = 'calendar.sync'
  `,
  )
    .bind(message.organisationId, message.operationId, message.eventId)
    .first<{
      id: string;
      status: string;
      payloadJson: string;
    }>();
  if (!operation)
    throw new Error(
      "Calendar operation does not exist in the authorised event.",
    );
  if (operation.status === "completed") return;

  const savedMessage = calendarQueueMessageSchema.safeParse(
    JSON.parse(operation.payloadJson),
  );
  if (!savedMessage.success) {
    const payloadHash = await hashCalendarLifecyclePayload(
      message.provider,
      message.payload,
    );
    await finishCalendarAttemptFailure(env, message, payloadHash, {
      code: "INVALID_SAVED_PAYLOAD",
      message: "The saved calendar operation payload is invalid.",
    });
    return;
  }
  const canonicalMessage = savedMessage.data;
  if (operation.status === "cancelled") {
    await finishSupersededCalendarAttempt(
      env,
      canonicalMessage,
      "The calendar operation was cancelled before delivery.",
    );
    return;
  }
  if (JSON.stringify(canonicalMessage) !== JSON.stringify(message)) {
    const payloadHash = await hashCalendarLifecyclePayload(
      canonicalMessage.provider,
      canonicalMessage.payload,
    );
    await finishCalendarAttemptFailure(env, canonicalMessage, payloadHash, {
      code: "QUEUE_PAYLOAD_MISMATCH",
      message:
        "The calendar Queue message did not match its durable operation payload.",
    });
    return;
  }
  if (["failed", "partially_failed"].includes(operation.status)) return;
  const payloadHash = await hashCalendarLifecyclePayload(
    message.provider,
    message.payload,
  );
  let invitation = await loadCalendarAttempt(env, message);
  if (!invitation || invitation.currentAttemptId !== message.attemptId) {
    await finishSupersededCalendarAttempt(
      env,
      message,
      "A newer calendar lifecycle attempt replaced this queued work.",
    );
    return;
  }
  if (!isExactCalendarAttempt(invitation, message, payloadHash)) {
    await finishCalendarAttemptFailure(env, message, payloadHash, {
      code: "CALENDAR_ATTEMPT_MISMATCH",
      message:
        "The current calendar attempt does not match its durable sequence, method, provider and payload hash.",
    });
    return;
  }
  if (invitation.status === "succeeded") return;
  if (invitation.status === "superseded") {
    await finishSupersededCalendarAttempt(
      env,
      message,
      "The calendar lifecycle attempt was already superseded.",
    );
    return;
  }

  const claimToken = crypto.randomUUID();
  const startResults = await env.DB.batch([
    env.DB.prepare(
      `UPDATE calendar_sync_attempts
      SET status = 'running', started_at = unixepoch(), completed_at = NULL,
          error_code = NULL, error_message = NULL
      WHERE id = ? AND invitation_id = ? AND sequence_number = ? AND method = ? AND provider = ?
        AND status IN ('queued','failed','running')
        AND EXISTS (
          SELECT 1 FROM calendar_invitations ci
           WHERE ci.id = ? AND ci.event_id = ? AND ci.current_attempt_id = ?
             AND ci.sequence_number = ? AND ci.method = ? AND ci.last_payload_hash = ?
        )
        AND EXISTS (
           SELECT 1 FROM operation_jobs o
           WHERE o.id = ? AND o.event_id = ?
             AND (
               o.status IN ('queued','received','retrying','queue_failed')
               OR (o.status = 'running' AND COALESCE(o.claim_expires_at, 0) <= unixepoch())
             )
        )`,
    ).bind(
      message.attemptId,
      message.invitationId,
      message.payload.sequence,
      message.payload.method,
      message.provider,
      message.invitationId,
      message.eventId,
      message.attemptId,
      message.payload.sequence,
      message.payload.method,
      payloadHash,
      message.operationId,
      message.eventId,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
      SET status = 'running', started_at = COALESCE(started_at, unixepoch()),
          attempt_count = attempt_count + 1, last_error = NULL, completed_at = NULL,
          claim_token = ?, claim_expires_at = unixepoch() + ?, updated_at = unixepoch()
      WHERE id = ? AND event_id = ?
        AND (
          status IN ('queued','received','retrying','queue_failed')
          OR (status = 'running' AND COALESCE(claim_expires_at, 0) <= unixepoch())
        )
        AND EXISTS (SELECT 1 FROM calendar_sync_attempts WHERE id = ? AND status = 'running')`,
    ).bind(
      claimToken,
      QUEUE_CLAIM_LEASE_SECONDS,
      message.operationId,
      message.eventId,
      message.attemptId,
    ),
    env.DB.prepare(
      `UPDATE operation_items
      SET status = 'running', attempt_count = attempt_count + 1,
          started_at = COALESCE(started_at, unixepoch()), completed_at = NULL,
          error_code = NULL, error_message = NULL, updated_at = unixepoch()
      WHERE operation_id = ? AND entity_id = ? AND status IN ('pending','failed','running')
        AND EXISTS (
          SELECT 1 FROM calendar_sync_attempts
          JOIN operation_jobs claimed_operation ON claimed_operation.id = operation_items.operation_id
           WHERE calendar_sync_attempts.id = ? AND calendar_sync_attempts.status = 'running'
             AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
        )`,
    ).bind(
      message.operationId,
      message.invitationId,
      message.attemptId,
      claimToken,
    ),
  ]);
  if (
    (startResults[0]?.meta.changes ?? 0) !== 1 ||
    (startResults[1]?.meta.changes ?? 0) !== 1
  ) {
    invitation = await loadCalendarAttempt(env, message);
    const currentOperation = await loadOperationClaim(
      env,
      message.operationId,
      message.eventId,
    );
    if (
      currentOperation?.status === "completed" ||
      currentOperation?.status === "cancelled" ||
      currentOperation?.status === "failed" ||
      currentOperation?.status === "partially_failed"
    )
      return;
    if (
      isExactCalendarAttempt(invitation, message, payloadHash) &&
      invitation?.status === "running" &&
      currentOperation?.status === "running" &&
      currentOperation.claimToken &&
      (currentOperation.claimExpiresAt ?? 0) > Math.floor(Date.now() / 1_000)
    ) {
      throw new QueueClaimLeaseBusyError();
    }
    if (!isExactCalendarAttempt(invitation, message, payloadHash)) {
      await finishSupersededCalendarAttempt(
        env,
        message,
        "A newer calendar lifecycle attempt replaced this queued work before provider delivery.",
      );
      return;
    }
    await finishCalendarAttemptFailure(env, message, payloadHash, {
      code: "CALENDAR_ATTEMPT_CLAIM_FAILED",
      message:
        "The exact calendar attempt could not be claimed for provider delivery.",
    });
    return;
  }

  invitation = await loadCalendarAttempt(env, message);
  if (
    !isExactCalendarAttempt(invitation, message, payloadHash) ||
    invitation?.status !== "running"
  ) {
    await finishSupersededCalendarAttempt(
      env,
      message,
      "A newer calendar lifecycle attempt replaced this work before provider delivery.",
      null,
      claimToken,
    );
    return;
  }
  await assertOperationClaim(
    env,
    message.operationId,
    message.eventId,
    claimToken,
  );

  let providerEventId: string | null;
  try {
    providerEventId = await deliverCalendarProvider({
      env,
      message,
      invitation,
      payloadHash,
      claimToken,
      dependencies,
    });
    if (providerEventId === null) return;
  } catch (error) {
    await assertOperationClaim(
      env,
      message.operationId,
      message.eventId,
      claimToken,
    );
    const current = await loadCalendarAttempt(env, message);
    if (!isExactCalendarAttempt(current, message, payloadHash)) {
      await finishSupersededCalendarAttempt(
        env,
        message,
        `The attempt was superseded while provider delivery was in progress: ${error instanceof Error ? error.message : String(error)}`,
        null,
        claimToken,
      );
      return;
    }
    await finishCalendarAttemptFailure(
      env,
      message,
      payloadHash,
      errorDetails(error),
      claimToken,
    );
    return;
  }

  const invitationStatus =
    message.payload.method === "CANCEL" ? "cancelled" : "sent";
  let completionResults: D1Result[];
  try {
    completionResults = await env.DB.batch([
      env.DB.prepare(
        `UPDATE calendar_invitations
        SET status = ?, provider_event_id = COALESCE(?, provider_event_id), updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND current_attempt_id = ? AND sequence_number = ?
          AND method = ? AND last_payload_hash = ?
          AND EXISTS (
            SELECT 1 FROM operation_jobs claimed_operation
             WHERE claimed_operation.id = ? AND claimed_operation.event_id = ?
               AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
          )`,
      ).bind(
        invitationStatus,
        message.provider === "email_ics" ? null : providerEventId,
        message.invitationId,
        message.eventId,
        message.attemptId,
        message.payload.sequence,
        message.payload.method,
        payloadHash,
        message.operationId,
        message.eventId,
        claimToken,
      ),
      env.DB.prepare(
        `UPDATE calendar_sync_attempts
        SET status = 'succeeded', provider_event_id = ?, error_code = NULL, error_message = NULL,
            completed_at = unixepoch()
        WHERE id = ? AND invitation_id = ? AND sequence_number = ? AND method = ? AND provider = ?
          AND status = 'running'
          AND EXISTS (
            SELECT 1 FROM calendar_invitations ci
            JOIN operation_jobs claimed_operation ON claimed_operation.id = ? AND claimed_operation.event_id = ci.event_id
             WHERE ci.id = ? AND ci.event_id = ? AND ci.current_attempt_id = ?
               AND ci.sequence_number = ? AND ci.method = ? AND ci.last_payload_hash = ?
               AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
          )`,
      ).bind(
        providerEventId,
        message.attemptId,
        message.invitationId,
        message.payload.sequence,
        message.payload.method,
        message.provider,
        message.operationId,
        message.invitationId,
        message.eventId,
        message.attemptId,
        message.payload.sequence,
        message.payload.method,
        payloadHash,
        claimToken,
      ),
      env.DB.prepare(
        `UPDATE calendar_connections
            SET last_synced_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ? AND status = 'connected'
            AND ? <> 'email_ics'
            AND EXISTS (
              SELECT 1 FROM calendar_invitations invitation
              JOIN operation_jobs claimed_operation
                ON claimed_operation.id = ? AND claimed_operation.event_id = invitation.event_id
               AND claimed_operation.status = 'running' AND claimed_operation.claim_token = ?
             WHERE invitation.id = ? AND invitation.event_id = ?
               AND invitation.current_attempt_id = ? AND invitation.sequence_number = ?
               AND invitation.method = ? AND invitation.last_payload_hash = ?
            )`,
      ).bind(
        message.connectionId,
        message.organisationId,
        message.provider,
        message.operationId,
        claimToken,
        message.invitationId,
        message.eventId,
        message.attemptId,
        message.payload.sequence,
        message.payload.method,
        payloadHash,
      ),
      env.DB.prepare(
        `UPDATE operation_items
        SET status = 'completed', result_json = ?, error_code = NULL, error_message = NULL,
            completed_at = unixepoch(), updated_at = unixepoch()
        WHERE operation_id = ? AND entity_id = ?
          AND EXISTS (
            SELECT 1 FROM operation_jobs claimed_operation
             WHERE claimed_operation.id = operation_items.operation_id
               AND claimed_operation.event_id = ? AND claimed_operation.status = 'running'
               AND claimed_operation.claim_token = ?
          )`,
      ).bind(
        JSON.stringify({
          provider: message.provider,
          providerEventId,
          sequence: message.payload.sequence,
        }),
        message.operationId,
        message.invitationId,
        message.eventId,
        claimToken,
      ),
      env.DB.prepare(
        `UPDATE operation_jobs
        SET status = 'completed', progress_total = 1, progress_completed = 1, progress_failed = 0,
            result_json = ?, last_error = NULL, completed_at = unixepoch(),
            claim_token = NULL, claim_expires_at = NULL, updated_at = unixepoch()
        WHERE id = ? AND event_id = ? AND status = 'running' AND claim_token = ?`,
      ).bind(
        JSON.stringify({
          invitationId: message.invitationId,
          provider: message.provider,
          providerEventId,
          sequence: message.payload.sequence,
        }),
        message.operationId,
        message.eventId,
        claimToken,
      ),
      // action is NOT NULL. If the invitation/attempt CAS above did not win,
      // this scalar subquery returns NULL and rolls the entire D1 batch back.
      env.DB.prepare(
        `INSERT INTO audit_events (
        id, organisation_id, event_id, action, entity_type, entity_id, metadata_json, created_at
      ) VALUES (?, ?, ?, (
        SELECT 'calendar.lifecycle.completed'
          FROM calendar_invitations ci
          JOIN calendar_sync_attempts csa ON csa.id = ? AND csa.invitation_id = ci.id
         WHERE ci.id = ? AND ci.event_id = ? AND ci.current_attempt_id = ?
           AND ci.sequence_number = ? AND ci.method = ? AND ci.last_payload_hash = ?
           AND csa.status = 'succeeded' AND csa.sequence_number = ?
           AND csa.method = ? AND csa.provider = ?
           AND changes() = 1
      ), 'calendar_invitation', ?, ?, unixepoch())`,
      ).bind(
        crypto.randomUUID(),
        message.organisationId,
        message.eventId,
        message.attemptId,
        message.invitationId,
        message.eventId,
        message.attemptId,
        message.payload.sequence,
        message.payload.method,
        payloadHash,
        message.payload.sequence,
        message.payload.method,
        message.provider,
        message.invitationId,
        JSON.stringify({
          attemptId: message.attemptId,
          provider: message.provider,
          method: message.payload.method,
          sequence: message.payload.sequence,
          providerEventId,
        }),
      ),
      env.DB.prepare(
        `INSERT INTO event_changes (event_id, entity_type, entity_id, change_type, correlation_id, created_at)
        SELECT event_id, 'calendar_invitation', ?, 'progress', correlation_id, unixepoch()
          FROM operation_jobs WHERE id = ? AND event_id = ? AND status = 'completed' AND changes() = 1
        RETURNING sequence`,
      ).bind(message.invitationId, message.operationId, message.eventId),
    ]);
  } catch (error) {
    await assertOperationClaim(
      env,
      message.operationId,
      message.eventId,
      claimToken,
    );
    const current = await loadCalendarAttempt(env, message);
    if (!isExactCalendarAttempt(current, message, payloadHash)) {
      await finishSupersededCalendarAttempt(
        env,
        message,
        "A newer calendar lifecycle attempt replaced this work before its provider result could be committed.",
        providerEventId,
        claimToken,
      );
      return;
    }
    await finishCalendarAttemptFailure(
      env,
      message,
      payloadHash,
      {
        code: "CALENDAR_RESULT_COMMIT_FAILED",
        message:
          `The provider result could not be committed: ${error instanceof Error ? error.message : String(error)}`.slice(
            0,
            2_000,
          ),
      },
      claimToken,
    );
    throw error;
  }
  await notifyRealtimeAfterCommit(
    env,
    { organisationId: message.organisationId, eventId: message.eventId },
    returnedChangeSequence(completionResults.at(-1)),
    message.operationId,
  );
}
