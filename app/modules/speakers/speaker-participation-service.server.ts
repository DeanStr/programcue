import { z } from "zod";

import {
  type AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { ParticipantProfileService } from "./participant-profile-service.server";
import { SpeakerPortalService } from "./speaker-portal-service.server";
import { speakerProfileSchema } from "./speaker-schema";
import {
  SpeakerAdminIntegrityError,
  SpeakerAdminStateError,
} from "./speaker-service-errors";

const speakerParticipationConfirmationSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    confirmation: z.literal("confirmed"),
  })
  .strict();

const externalParticipationConfirmationSchema =
  speakerParticipationConfirmationSchema.extend({
    externalConfirmation: z.literal("confirmed"),
  });

export class SpeakerParticipationService {
  private readonly portal: SpeakerPortalService;

  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly airtable: AirtableProviderBoundary,
  ) {
    this.portal = new SpeakerPortalService(env, airtable);
  }

  getPortal(viewer: Viewer) {
    return this.portal.getPortal(viewer);
  }

  async updateProfile(viewer: Viewer, rawInput: unknown) {
    const input = speakerProfileSchema.parse(rawInput);
    const idempotencyKey = await airtableCommandKey(
      "participant.profile.update",
      viewer,
      input,
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "participant.profile.update" },
      () => new ParticipantProfileService(this.env).update(viewer, input),
    );
  }

  async confirmOwnParticipation(viewer: Viewer, rawInput: unknown) {
    const input = speakerParticipationConfirmationSchema.parse(rawInput);
    const idempotencyKey = await airtableCommandKey(
      "speaker.participation.confirm",
      viewer,
      input,
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "speaker.participation.confirm" },
      () =>
        this.confirmParticipationD1(
          viewer,
          viewer.personId,
          input.sessionId,
          "speaker",
        ),
    );
  }

  async confirmExternalParticipation(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    if (viewer.role !== "owner" && viewer.role !== "administrator") {
      throw new Response(
        "Only an event administrator may record external participation confirmation.",
        { status: 403 },
      );
    }
    const personId = rawPersonId.trim();
    if (!personId || personId.length > 200)
      throw new Response("Speaker not found in this event.", { status: 404 });
    const input = externalParticipationConfirmationSchema.parse(rawInput);
    const idempotencyKey = await airtableCommandKey(
      "speaker.participation.confirm_external",
      viewer,
      { personId, ...input },
    );
    return this.airtable.executeIdempotent(
      viewer,
      {
        idempotencyKey,
        operation: "speaker.participation.confirm_external",
      },
      () =>
        this.confirmParticipationD1(
          viewer,
          personId,
          input.sessionId,
          "administrator_external",
        ),
    );
  }

  private async confirmParticipationD1(
    viewer: Viewer,
    personId: string,
    sessionId: string,
    source: "speaker" | "administrator_external",
  ) {
    const target = await this.env.DB.prepare(
      `SELECT session.title, relationship.participation_status AS participationStatus
         FROM session_speakers relationship
         JOIN sessions session
           ON session.id = relationship.session_id
          AND session.event_id = relationship.event_id
         JOIN events event ON event.id = relationship.event_id
        WHERE relationship.event_id = ? AND relationship.session_id = ?
          AND relationship.person_id = ? AND event.organisation_id = ?
          AND session.status NOT IN ('cancelled','archived')`,
    )
      .bind(viewer.eventId, sessionId, personId, viewer.organisationId)
      .first<{
        title: string;
        participationStatus: "pending" | "confirmed";
      }>();
    if (!target)
      throw new Response("Active speaker session not found in this event.", {
        status: 404,
      });
    if (target.participationStatus === "confirmed") {
      return {
        sessionId,
        title: target.title,
        participationStatus: "confirmed" as const,
        changed: false,
      };
    }

    const auditEventId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const [updated, audited] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE session_speakers
            SET participation_status = 'confirmed',
                participation_confirmed_at = unixepoch()
          WHERE event_id = ? AND session_id = ? AND person_id = ?
            AND participation_status = 'pending'
            AND EXISTS (
              SELECT 1 FROM sessions session
               WHERE session.id = session_speakers.session_id
                 AND session.event_id = session_speakers.event_id
                 AND session.status NOT IN ('cancelled','archived')
            )
          RETURNING session_id AS sessionId`,
      ).bind(viewer.eventId, sessionId, personId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'participant_ui', 1, ?, ?, ?, 'speaker.participation.confirmed',
                'session_speaker', ?, ?, ?, unixepoch()
          WHERE changes() = 1`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        `${sessionId}:${personId}`,
        operationId,
        JSON.stringify({ sessionId, personId, source }),
      ),
    ]);
    // D1's mutation metadata includes writes performed by SQLite triggers.
    // RETURNING identifies the row changed by this statement itself.
    const updatedCount = updated.results.length;
    const auditedCount = audited.meta.changes;
    if (
      !Number.isSafeInteger(updatedCount) ||
      !Number.isSafeInteger(auditedCount)
    ) {
      throw new SpeakerAdminIntegrityError(
        "Participation confirmation did not report complete mutation results.",
      );
    }
    if (updatedCount === 1) {
      if (auditedCount !== 1) {
        throw new SpeakerAdminIntegrityError(
          "Participation confirmation was not accompanied by its audit record.",
        );
      }
      return {
        sessionId,
        title: target.title,
        participationStatus: "confirmed" as const,
        changed: true,
      };
    }
    if (updatedCount !== 0 || auditedCount !== 0) {
      throw new SpeakerAdminIntegrityError(
        "Participation confirmation produced inconsistent mutation results.",
      );
    }
    const current = await this.env.DB.prepare(
      `SELECT participation_status AS participationStatus
         FROM session_speakers
        WHERE event_id = ? AND session_id = ? AND person_id = ?`,
    )
      .bind(viewer.eventId, sessionId, personId)
      .first<{ participationStatus: string }>();
    if (current?.participationStatus === "confirmed") {
      return {
        sessionId,
        title: target.title,
        participationStatus: "confirmed" as const,
        changed: false,
      };
    }
    throw new SpeakerAdminStateError(
      "Participation changed while confirmation was being recorded. Refresh before trying again.",
    );
  }

  /**
   * Adds an event-scoped roster record. This deliberately does not prepare a
   * communication, invitation token or delivery operation. Portal access is
   * a separate, explicit command.
   */
}
