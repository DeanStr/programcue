import { z } from "zod";
import { requireEmailProviderConfiguration } from "~/modules/communications/email-provider.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { requiresProductionSecurity } from "~/platform/runtime-environment.server";
import { EvaluationStateError } from "./evaluation-errors";

export type AcceptedSpeakerInvitationMessage = {
  type: "communication.send";
  operationId: string;
  communicationId: string;
  eventId: string;
  organisationId: string;
  idempotencyKey: string;
};

export type AcceptedSpeakerInvitationPlan = {
  personId: string;
  operationId: string;
  communicationId: string;
  message: AcceptedSpeakerInvitationMessage;
  statements: D1PreparedStatement[];
};

export type AcceptedSpeaker = {
  id: string;
  email: string;
  membershipId: string;
};

export type AcceptedEvent = {
  name: string;
  brandAccent: string;
  startsAt: number;
  endsAt: number;
  venueName: string | null;
  city: string | null;
};

export function base64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export async function sha256Base64Url(value: string) {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );
}

export function randomToken() {
  return base64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function deterministicResendToken(
  secret: string,
  operationId: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return base64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(
          `program-cue:accepted-speaker-resend:${operationId}`,
        ),
      ),
    ),
  );
}

export function authenticationBaseUrl(env: CloudflareEnvironment) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) {
    throw new EvaluationStateError(
      "Authentication must be configured before accepted-speaker invitations can be queued.",
    );
  }
  let baseUrl: URL;
  try {
    baseUrl = new URL(env.BETTER_AUTH_URL);
  } catch {
    throw new EvaluationStateError(
      "BETTER_AUTH_URL must be a valid absolute URL before accepted-speaker invitations can be queued.",
    );
  }
  if (
    requiresProductionSecurity(env.APP_ENV) &&
    baseUrl.protocol !== "https:"
  ) {
    throw new EvaluationStateError(
      "BETTER_AUTH_URL must use HTTPS before accepted-speaker invitations can be queued.",
    );
  }
  return baseUrl;
}

export function magicLink(baseUrl: URL, token: string, eventId: string) {
  const callback = new URL("/events/select", baseUrl);
  callback.searchParams.set("eventId", eventId);
  callback.searchParams.set("returnTo", "/participant/dashboard");
  const url = new URL("/api/auth/magic-link/verify", baseUrl);
  url.searchParams.set("token", token);
  url.searchParams.set("callbackURL", `${callback.pathname}${callback.search}`);
  return url;
}

export async function acceptedSpeakerInvitationReadiness(input: {
  env: CloudflareEnvironment;
  organisationId: string;
  eventId: string;
  event: AcceptedEvent;
}) {
  const { env, organisationId, eventId, event } = input;
  const provider = requireEmailProviderConfiguration(env);
  const baseUrl = authenticationBaseUrl(env);
  const physicalAddress = [event.venueName, event.city]
    .filter((value): value is string => Boolean(value?.trim()))
    .join(", ");
  if (!physicalAddress) {
    throw new EvaluationStateError(
      "Configure the event venue or mailing address before accepted-speaker invitations can be queued.",
    );
  }
  const sender = await env.DB.prepare(
    `SELECT sender.id
       FROM sender_profiles sender
       JOIN events event
         ON event.id = sender.event_id AND event.organisation_id = ?
      WHERE sender.event_id = ? AND sender.provider = ?
        AND sender.status = 'verified'
      ORDER BY sender.updated_at DESC LIMIT 1`,
  )
    .bind(organisationId, eventId, provider.provider)
    .first<{ id: string }>();
  if (!sender) {
    throw new EvaluationStateError(
      "A verified sender profile is required before accepted-speaker invitations can be queued.",
    );
  }
  return { provider, baseUrl, physicalAddress, senderId: sender.id };
}

export async function prepareAcceptedSpeakerInvitationPlans(input: {
  env: CloudflareEnvironment;
  viewer: Viewer;
  decisionId: string;
  sessionId: string;
  event: AcceptedEvent;
  speakers: AcceptedSpeaker[];
}): Promise<AcceptedSpeakerInvitationPlan[]> {
  const { env, viewer, decisionId, sessionId, event, speakers } = input;
  if (speakers.length === 0 || String(env.DEMO_MODE) === "true") return [];
  const { provider, baseUrl, physicalAddress, senderId } =
    await acceptedSpeakerInvitationReadiness({
      env,
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      event,
    });

  return Promise.all(
    speakers.map(async (speaker) => {
      if (!z.email().safeParse(speaker.email).success) {
        throw new EvaluationStateError(
          "Every accepted speaker must have a valid email address before invitations can be queued.",
        );
      }
      const identity = (
        await sha256Base64Url(JSON.stringify([decisionId, speaker.id]))
      ).slice(0, 32);
      const token = randomToken();
      const tokenHash = await sha256Base64Url(token);
      const verificationId = `asi-v:${identity}`;
      const operationId = `asi-o:${identity}`;
      const communicationId = `asi-c:${identity}`;
      const deliveryId = `asi-d:${identity}`;
      const idempotencyKey = `accepted-speaker:${identity}`;
      const url = magicLink(baseUrl, token, viewer.eventId);
      const message: AcceptedSpeakerInvitationMessage = {
        type: "communication.send",
        operationId,
        communicationId,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        idempotencyKey,
      };
      const audience = {
        type: "accepted_speaker_invitation",
        decisionId,
        sessionId,
        membershipId: speaker.membershipId,
      };
      const contentSnapshot = {
        schemaVersion: 1,
        category: "accepted_speaker_invitation",
        subjectTemplate: `You are speaking at ${event.name}`,
        content: {
          body: `Your proposal has been accepted. Use this one-time link to sign in to Program Cue and complete your speaker onboarding:\n\n${url.toString()}\n\nThis invitation expires in seven days.`,
          physicalAddress,
          ...(url.protocol === "https:"
            ? { buttonText: "Open speaker portal", buttonUrl: url.toString() }
            : {}),
        },
        event: {
          eventName: event.name,
          brandAccent: event.brandAccent,
          startsAt: event.startsAt,
          endsAt: event.endsAt,
        },
      };
      const membershipGuard = `EXISTS (
        SELECT 1 FROM memberships membership
         WHERE membership.id = ? AND membership.organisation_id = ?
           AND membership.event_id = ? AND membership.person_id = ?
           AND membership.role = 'speaker' AND membership.accepted_at IS NULL
           AND membership.revoked_at IS NULL
           AND membership.invitation_expires_at > unixepoch()
           AND EXISTS (
             SELECT 1 FROM submission_decisions decision
              WHERE decision.id = ? AND decision.event_id = membership.event_id
                AND decision.status = 'published' AND decision.decision = 'accepted'
           )
      )`;
      const guardBindings = [
        speaker.membershipId,
        viewer.organisationId,
        viewer.eventId,
        speaker.id,
        decisionId,
      ];
      const statements = [
        env.DB.prepare(
          `INSERT INTO verification_tokens (
             id, identifier, value, expires_at, created_at, updated_at
           ) SELECT ?, ?, ?, unixepoch() + 604800, unixepoch(), unixepoch()
              WHERE ${membershipGuard}
           ON CONFLICT(id) DO NOTHING`,
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
              )
           ON CONFLICT(id) DO NOTHING`,
        ).bind(
          communicationId,
          viewer.eventId,
          senderId,
          operationId,
          idempotencyKey,
          JSON.stringify(audience),
          JSON.stringify(contentSnapshot),
          viewer.personId,
          operationId,
          viewer.eventId,
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
                )
           ON CONFLICT(id) DO NOTHING`,
        ).bind(
          deliveryId,
          viewer.eventId,
          communicationId,
          speaker.membershipId,
          provider.provider,
          `${idempotencyKey}:${speaker.email.toLowerCase()}`,
          speaker.id,
          speaker.email,
          communicationId,
          viewer.eventId,
          operationId,
        ),
        env.DB.prepare(
          `INSERT INTO operation_items (
             id, operation_id, item_key, entity_type, entity_id, status, updated_at
           ) SELECT ?, ?, ?, 'communication_delivery', ?, 'pending', unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM communication_deliveries delivery
                 WHERE delivery.id = ? AND delivery.communication_id = ?
              )
           ON CONFLICT(operation_id, item_key) DO NOTHING`,
        ).bind(
          `asi-i:${identity}`,
          operationId,
          `${idempotencyKey}:${speaker.email.toLowerCase()}`,
          deliveryId,
          deliveryId,
          communicationId,
        ),
        env.DB.prepare(
          `INSERT INTO audit_events (
             id, organisation_id, event_id, actor_person_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           ) SELECT ?, ?, ?, ?, 'membership.speaker.invitation.queued',
                    'membership', ?, ?, ?, unixepoch()
              WHERE EXISTS (
                SELECT 1 FROM operation_jobs operation
                 WHERE operation.id = ? AND operation.event_id = ?
              )
                AND NOT EXISTS (
                  SELECT 1 FROM audit_events audit
                   WHERE audit.id = ?
                )`,
        ).bind(
          `asi-a:${identity}`,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          speaker.membershipId,
          operationId,
          JSON.stringify({ decisionId, sessionId, communicationId }),
          operationId,
          viewer.eventId,
          `asi-a:${identity}`,
        ),
      ];
      return {
        personId: speaker.id,
        operationId,
        communicationId,
        message,
        statements,
      };
    }),
  );
}
