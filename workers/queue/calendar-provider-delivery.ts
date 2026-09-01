import { CalendarOAuthService } from "../../app/modules/calendars/calendar-oauth.server";
import {
  decryptCalendarCredentials,
  GoogleCalendarProvider,
  MicrosoftCalendarProvider,
} from "../../app/modules/calendars/calendar-providers.server";
import type { CalendarQueueMessage } from "../../app/modules/calendars/calendar-schema";
import { generateInvitationIcs } from "../../app/modules/calendars/ics.server";
import { emailDeliveryIssue } from "../../app/modules/communications/email-deliverability";
import { TRACKED_DELIVERY_EMAIL_TAG } from "../../app/modules/communications/email-provider";
import { createEmailProvider } from "../../app/modules/communications/email-provider.server";
import { renderProgramCueEmail } from "../../app/modules/communications/email-templates/render-email.server";
import {
  QueueClaimLeaseLostError,
  renewOperationClaim,
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

export async function deliverCalendarProvider(input: {
  env: CloudflareEnvironment;
  message: CalendarQueueMessage;
  invitation: CalendarAttemptRow;
  payloadHash: string;
  claimToken: string;
  dependencies: QueueProviderDependencies;
  loadCalendarAttempt(
    env: CloudflareEnvironment,
    message: CalendarQueueMessage,
  ): Promise<CalendarAttemptRow | null>;
  isExactCalendarAttempt(
    row: CalendarAttemptRow | null,
    message: CalendarQueueMessage,
    payloadHash: string,
  ): boolean;
  finishSupersededCalendarAttempt(
    env: CloudflareEnvironment,
    message: CalendarQueueMessage,
    reason: string,
    providerEventId?: string | null,
    claimToken?: string,
  ): Promise<void>;
}): Promise<string | null> {
  const {
    env,
    message,
    payloadHash,
    claimToken,
    dependencies,
    loadCalendarAttempt,
    isExactCalendarAttempt,
    finishSupersededCalendarAttempt,
  } = input;
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
    const recipientIssue = emailDeliveryIssue(delivery.address, env.APP_ENV);
    if (recipientIssue) {
      throw new Error(
        `Calendar email cannot be delivered to this speaker: ${recipientIssue}.`,
      );
    }
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
        tags: [TRACKED_DELIVERY_EMAIL_TAG],
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
      !invitation.connectionId ||
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
        {
          connectionId: invitation.connectionId,
          organisationId: message.organisationId,
          provider: message.provider,
        },
        env.CALENDAR_CREDENTIALS_PREVIOUS_KEY,
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
