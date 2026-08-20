import { z } from "zod";

import {
  type AirtableProviderBoundary,
  airtableCommandKey,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { materializePublishedConfirmedSpeakerAcknowledgements } from "~/modules/resources/resource-service-shared";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import { ParticipantProfileService } from "./participant-profile-service.server";
import { SpeakerPortalService } from "./speaker-portal-service.server";
import { speakerProfileSchema } from "./speaker-schema";
import {
  SpeakerAdminIntegrityError,
  SpeakerAdminStateError,
} from "./speaker-service-errors";

const publicConfirmedSpeakerMembershipSql = `
  SELECT 1
    FROM session_speakers relation
    JOIN sessions session
      ON session.id = relation.session_id
     AND session.event_id = relation.event_id
    JOIN people person ON person.id = relation.person_id
    JOIN schedule_entries entry
      ON entry.event_id = relation.event_id
     AND entry.session_id = relation.session_id
    JOIN schedule_versions version
      ON version.id = entry.schedule_version_id
     AND version.event_id = entry.event_id
     AND version.status = 'published'
    JOIN schedule_session_contents content
      ON content.event_id = entry.event_id
     AND content.schedule_version_id = entry.schedule_version_id
     AND content.session_id = entry.session_id
     AND content.visibility = 'public'
   WHERE relation.event_id = ?
     AND relation.session_id = ?
     AND relation.person_id = ?
     AND relation.visibility = 'public'
     AND relation.participation_status = 'confirmed'
     AND person.profile_status = 'published'
     AND session.status = 'published'
     AND session.visibility = 'public'
`;

const speakerParticipationConfirmationSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    participationRevision: z.coerce.number().int().positive(),
    confirmation: z.literal("confirmed"),
  })
  .strict();

const externalParticipationConfirmationSchema =
  speakerParticipationConfirmationSchema.extend({
    externalConfirmation: z.literal("confirmed"),
  });

const speakerParticipationDeclineSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    participationRevision: z.coerce.number().int().positive(),
    declineConfirmation: z.literal("declined"),
    reason: z
      .string()
      .trim()
      .max(500, "A decline reason must be 500 characters or fewer.")
      .transform((value) => value || null),
  })
  .strict();

const participationResetSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    participationRevision: z.coerce.number().int().positive(),
    resetConfirmation: z.literal("pending"),
  })
  .strict();

function requireParticipationBatchResult(
  result: D1Result | undefined,
  message: string,
) {
  if (!result) throw new SpeakerAdminIntegrityError(message);
  return result;
}

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
          input.participationRevision,
          "speaker",
        ),
    );
  }

  async declineOwnParticipation(viewer: Viewer, rawInput: unknown) {
    const input = speakerParticipationDeclineSchema.parse(rawInput);
    const idempotencyKey = await airtableCommandKey(
      "speaker.participation.decline",
      viewer,
      input,
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "speaker.participation.decline" },
      () =>
        this.declineParticipationD1(
          viewer,
          input.sessionId,
          input.participationRevision,
          input.reason,
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
          input.participationRevision,
          "administrator_external",
        ),
    );
  }

  async resetDeclinedParticipation(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    if (viewer.role !== "owner" && viewer.role !== "administrator") {
      throw new Response(
        "Only an event administrator may reset session participation.",
        { status: 403 },
      );
    }
    const personId = rawPersonId.trim();
    if (!personId || personId.length > 200)
      throw new Response("Speaker not found in this event.", { status: 404 });
    const input = participationResetSchema.parse(rawInput);
    const idempotencyKey = await airtableCommandKey(
      "speaker.participation.reset",
      viewer,
      { personId, ...input },
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "speaker.participation.reset" },
      () =>
        this.resetParticipationD1(
          viewer,
          personId,
          input.sessionId,
          input.participationRevision,
        ),
    );
  }

  private async confirmParticipationD1(
    viewer: Viewer,
    personId: string,
    sessionId: string,
    participationRevision: number,
    source: "speaker" | "administrator_external",
  ) {
    const target = await this.env.DB.prepare(
      `SELECT session.title, relationship.participation_status AS participationStatus,
              relationship.participation_revision AS participationRevision
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
        participationStatus: "pending" | "confirmed" | "declined";
        participationRevision: number;
      }>();
    if (!target)
      throw new Response("Active speaker session not found in this event.", {
        status: 404,
      });
    if (
      target.participationStatus === "confirmed" &&
      target.participationRevision === participationRevision + 1 &&
      (await this.participationTransitionConverged(
        viewer,
        personId,
        sessionId,
        {
          status: "confirmed",
          revision: participationRevision + 1,
          declineReason: null,
          action: "speaker.participation.confirmed",
          source,
          from: "pending",
          to: "confirmed",
          inputRevision: participationRevision,
        },
      ))
    )
      return {
        sessionId,
        title: target.title,
        participationStatus: "confirmed" as const,
        participationRevision: target.participationRevision,
        changed: false,
        changeSequence: null,
      };
    if (
      target.participationStatus !== "pending" ||
      target.participationRevision !== participationRevision
    )
      throw new SpeakerAdminStateError(
        "Participation changed after this page loaded. Refresh before responding.",
        409,
      );

    const auditEventId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const origin =
      source === "administrator_external" ? "admin_ui" : "participant_ui";
    const acknowledgementStatements =
      materializePublishedConfirmedSpeakerAcknowledgements(
        this.env,
        viewer.eventId,
        personId,
        auditEventId,
      );
    let results: D1Result[];
    try {
      results = await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'person', ?, 1, ?, ?, ?, 'speaker.participation.confirmed',
                'session_speaker', ?, ?, ?, unixepoch()
           FROM session_speakers relationship
           JOIN sessions session
             ON session.id = relationship.session_id
            AND session.event_id = relationship.event_id
           JOIN events event ON event.id = relationship.event_id
          WHERE relationship.event_id = ? AND relationship.session_id = ?
            AND relationship.person_id = ? AND event.organisation_id = ?
            AND relationship.participation_status = 'pending'
            AND relationship.participation_revision = ?
            AND session.status NOT IN ('cancelled','archived')`,
        ).bind(
          auditEventId,
          origin,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          `${sessionId}:${personId}`,
          operationId,
          JSON.stringify({
            sessionId,
            personId,
            source,
            from: "pending",
            to: "confirmed",
            participationRevision,
          }),
          viewer.eventId,
          sessionId,
          personId,
          viewer.organisationId,
          participationRevision,
        ),
        this.env.DB.prepare(
          `UPDATE session_speakers
            SET participation_status = 'confirmed',
                participation_revision = participation_revision + 1,
                participation_confirmed_at = unixepoch(),
                participation_declined_at = NULL,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = ? AND person_id = ?
            AND participation_status = 'pending'
            AND participation_revision = ?
            AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.organisation_id = ?
                 AND audit.event_id = session_speakers.event_id
            )
            AND EXISTS (
              SELECT 1 FROM sessions session
               WHERE session.id = session_speakers.session_id
                 AND session.event_id = session_speakers.event_id
                 AND session.status NOT IN ('cancelled','archived')
            )
          RETURNING session_id AS sessionId`,
        ).bind(
          viewer.eventId,
          sessionId,
          personId,
          participationRevision,
          auditEventId,
          viewer.organisationId,
        ),
        ...acknowledgementStatements,
        this.env.DB.prepare(
          `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id,
           created_at
         )
         SELECT ?, 'person', ?, 'updated', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM audit_events audit WHERE audit.id = ?
          )
          AND EXISTS (${publicConfirmedSpeakerMembershipSql})
         RETURNING sequence`,
        ).bind(
          viewer.eventId,
          personId,
          operationId,
          auditEventId,
          viewer.eventId,
          sessionId,
          personId,
        ),
        atomicBatchGuardStatement(
          this.env,
          `EXISTS (
            SELECT 1 FROM audit_events audit WHERE audit.id = ?
          ) AND NOT (
            EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.organisation_id = ?
                 AND audit.event_id = ? AND audit.actor_person_id = ?
                 AND audit.origin = ? AND audit.action = 'speaker.participation.confirmed'
                 AND audit.entity_type = 'session_speaker'
                 AND audit.entity_id = ? AND audit.correlation_id = ?
            ) AND EXISTS (
              SELECT 1 FROM session_speakers relationship
               WHERE relationship.event_id = ? AND relationship.session_id = ?
                AND relationship.person_id = ?
                AND relationship.participation_status = 'confirmed'
                AND relationship.participation_revision = ?
            ) AND (
              EXISTS (
                SELECT 1 FROM event_changes change
                 WHERE change.event_id = ? AND change.entity_type = 'person'
                   AND change.entity_id = ? AND change.change_type = 'updated'
                   AND change.correlation_id = ?
              ) OR NOT EXISTS (${publicConfirmedSpeakerMembershipSql})
            )
          )`,
          [
            auditEventId,
            auditEventId,
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            origin,
            `${sessionId}:${personId}`,
            operationId,
            viewer.eventId,
            sessionId,
            personId,
            participationRevision + 1,
            viewer.eventId,
            personId,
            operationId,
            viewer.eventId,
            sessionId,
            personId,
          ],
        ),
      ]);
    } catch (error: unknown) {
      if (isAtomicBatchGuardError(error)) {
        throw new SpeakerAdminIntegrityError(
          "Participation confirmation was not accompanied by its audit record and public change.",
        );
      }
      throw error;
    }
    const audited = requireParticipationBatchResult(
      results[0],
      "Participation confirmation is missing its audit result.",
    );
    const updated = requireParticipationBatchResult(
      results[1],
      "Participation confirmation is missing its relationship result.",
    );
    const changed = requireParticipationBatchResult(
      results[results.length - 2],
      "Participation confirmation is missing its change-cursor result.",
    );
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
      const change = changed.results[0] as { sequence: number } | undefined;
      return {
        sessionId,
        title: target.title,
        participationStatus: "confirmed" as const,
        participationRevision: participationRevision + 1,
        changed: true,
        changeSequence:
          change && Number.isSafeInteger(Number(change.sequence))
            ? Number(change.sequence)
            : null,
      };
    }
    if (updatedCount !== 0 || auditedCount !== 0) {
      throw new SpeakerAdminIntegrityError(
        "Participation confirmation produced inconsistent mutation results.",
      );
    }
    if (
      await this.participationTransitionConverged(viewer, personId, sessionId, {
        status: "confirmed",
        revision: participationRevision + 1,
        declineReason: null,
        action: "speaker.participation.confirmed",
        source,
        from: "pending",
        to: "confirmed",
        inputRevision: participationRevision,
      })
    ) {
      return {
        sessionId,
        title: target.title,
        participationStatus: "confirmed" as const,
        participationRevision: participationRevision + 1,
        changed: false,
        changeSequence: null,
      };
    }
    throw new SpeakerAdminStateError(
      "Participation changed while confirmation was being recorded. Refresh before trying again.",
    );
  }

  private async declineParticipationD1(
    viewer: Viewer,
    sessionId: string,
    participationRevision: number,
    reason: string | null,
  ) {
    const target = await this.participationTarget(
      viewer,
      viewer.personId,
      sessionId,
    );
    if (
      target.participationStatus === "declined" &&
      target.participationRevision === participationRevision + 1 &&
      target.participationDeclineReason === reason &&
      (await this.participationTransitionConverged(
        viewer,
        viewer.personId,
        sessionId,
        {
          status: "declined",
          revision: participationRevision + 1,
          declineReason: reason,
          action: "speaker.participation.declined",
          source: "speaker",
          from: "pending",
          to: "declined",
          inputRevision: participationRevision,
        },
      ))
    )
      return {
        sessionId,
        title: target.title,
        participationStatus: "declined" as const,
        participationRevision: target.participationRevision,
        changed: false,
        changeSequence: null,
      };
    if (
      target.participationStatus !== "pending" ||
      target.participationRevision !== participationRevision
    )
      throw new SpeakerAdminStateError(
        "Participation changed after this page loaded. Refresh before responding.",
        409,
      );
    const auditEventId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    let results: D1Result[];
    try {
      results = await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, correlation_id,
           metadata_json, created_at
         )
         SELECT ?, 'person', 'participant_ui', 1, ?, ?, ?,
                'speaker.participation.declined', 'session_speaker', ?, ?, ?,
                unixepoch()
           FROM session_speakers relationship
           JOIN sessions session
             ON session.id = relationship.session_id
            AND session.event_id = relationship.event_id
           JOIN events event ON event.id = relationship.event_id
          WHERE relationship.event_id = ? AND relationship.session_id = ?
            AND relationship.person_id = ? AND event.organisation_id = ?
            AND relationship.participation_status = 'pending'
            AND relationship.participation_revision = ?
            AND session.status NOT IN ('cancelled','archived')`,
        ).bind(
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          `${sessionId}:${viewer.personId}`,
          operationId,
          JSON.stringify({
            sessionId,
            personId: viewer.personId,
            source: "speaker",
            from: "pending",
            to: "declined",
            participationRevision,
          }),
          viewer.eventId,
          sessionId,
          viewer.personId,
          viewer.organisationId,
          participationRevision,
        ),
        this.env.DB.prepare(
          `UPDATE session_speakers
            SET participation_status = 'declined',
                participation_revision = participation_revision + 1,
                participation_confirmed_at = NULL,
                participation_declined_at = unixepoch(),
                participation_decline_reason = ?
          WHERE event_id = ? AND session_id = ? AND person_id = ?
            AND participation_status = 'pending'
            AND participation_revision = ?
            AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.organisation_id = ?
                 AND audit.event_id = session_speakers.event_id
            )
          RETURNING session_id AS sessionId`,
        ).bind(
          reason,
          viewer.eventId,
          sessionId,
          viewer.personId,
          participationRevision,
          auditEventId,
          viewer.organisationId,
        ),
        atomicBatchGuardStatement(
          this.env,
          `EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM session_speakers relationship
            WHERE relationship.event_id = ?
              AND relationship.session_id = ?
              AND relationship.person_id = ?
              AND relationship.participation_status = 'declined'
              AND relationship.participation_revision = ?
              AND relationship.participation_confirmed_at IS NULL
              AND relationship.participation_declined_at IS NOT NULL
              AND relationship.participation_decline_reason IS ?
         )`,
          [
            auditEventId,
            viewer.eventId,
            sessionId,
            viewer.personId,
            participationRevision + 1,
            reason,
          ],
        ),
      ]);
    } catch (error: unknown) {
      if (isAtomicBatchGuardError(error)) {
        throw new SpeakerAdminIntegrityError(
          "Participation decline was not accompanied by its audit record.",
        );
      }
      throw error;
    }
    const audited = requireParticipationBatchResult(
      results[0],
      "Participation decline is missing its audit result.",
    );
    const updated = requireParticipationBatchResult(
      results[1],
      "Participation decline is missing its relationship result.",
    );
    const auditedCount = audited.meta.changes;
    const updatedCount = updated.results.length;
    if (
      !Number.isSafeInteger(auditedCount) ||
      !Number.isSafeInteger(updatedCount)
    )
      throw new SpeakerAdminIntegrityError(
        "Participation decline did not report complete mutation results.",
      );
    if (auditedCount === 0 && updatedCount === 0) {
      if (
        await this.participationTransitionConverged(
          viewer,
          viewer.personId,
          sessionId,
          {
            status: "declined",
            revision: participationRevision + 1,
            declineReason: reason,
            action: "speaker.participation.declined",
            source: "speaker",
            from: "pending",
            to: "declined",
            inputRevision: participationRevision,
          },
        )
      ) {
        return {
          sessionId,
          title: target.title,
          participationStatus: "declined" as const,
          participationRevision: participationRevision + 1,
          changed: false,
          changeSequence: null,
        };
      }
      throw new SpeakerAdminStateError(
        "Participation changed while the decline was being recorded. Refresh before trying again.",
        409,
      );
    }
    if (auditedCount !== 1 || updatedCount !== 1)
      throw new SpeakerAdminIntegrityError(
        "Participation decline produced inconsistent mutation results.",
      );
    return {
      sessionId,
      title: target.title,
      participationStatus: "declined" as const,
      participationRevision: participationRevision + 1,
      changed: true,
      changeSequence: null,
    };
  }

  private async resetParticipationD1(
    viewer: Viewer,
    personId: string,
    sessionId: string,
    participationRevision: number,
  ) {
    const target = await this.participationTarget(viewer, personId, sessionId);
    if (
      target.participationStatus === "pending" &&
      target.participationRevision === participationRevision + 1 &&
      (await this.participationTransitionConverged(
        viewer,
        personId,
        sessionId,
        {
          status: "pending",
          revision: participationRevision + 1,
          declineReason: null,
          action: "speaker.participation.reset",
          source: "administrator",
          from: "declined",
          to: "pending",
          inputRevision: participationRevision,
        },
      ))
    )
      return {
        sessionId,
        title: target.title,
        participationStatus: "pending" as const,
        participationRevision: target.participationRevision,
        changed: false,
        changeSequence: null,
      };
    if (
      target.participationStatus !== "declined" ||
      target.participationRevision !== participationRevision
    )
      throw new SpeakerAdminStateError(
        "Participation changed after this page loaded. Refresh before resetting it.",
        409,
      );
    const auditEventId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    let results: D1Result[];
    try {
      results = await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, correlation_id,
           metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?,
                'speaker.participation.reset', 'session_speaker', ?, ?, ?,
                unixepoch()
           FROM session_speakers relationship
           JOIN sessions session
             ON session.id = relationship.session_id
            AND session.event_id = relationship.event_id
           JOIN events event ON event.id = relationship.event_id
          WHERE relationship.event_id = ? AND relationship.session_id = ?
            AND relationship.person_id = ? AND event.organisation_id = ?
            AND relationship.participation_status = 'declined'
            AND relationship.participation_revision = ?
            AND session.status NOT IN ('cancelled','archived')`,
        ).bind(
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          `${sessionId}:${personId}`,
          operationId,
          JSON.stringify({
            sessionId,
            personId,
            source: "administrator",
            from: "declined",
            to: "pending",
            participationRevision,
          }),
          viewer.eventId,
          sessionId,
          personId,
          viewer.organisationId,
          participationRevision,
        ),
        this.env.DB.prepare(
          `UPDATE session_speakers
            SET participation_status = 'pending',
                participation_revision = participation_revision + 1,
                participation_confirmed_at = NULL,
                participation_declined_at = NULL,
                participation_decline_reason = NULL
          WHERE event_id = ? AND session_id = ? AND person_id = ?
            AND participation_status = 'declined'
            AND participation_revision = ?
            AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.organisation_id = ?
                 AND audit.event_id = session_speakers.event_id
            )
          RETURNING session_id AS sessionId`,
        ).bind(
          viewer.eventId,
          sessionId,
          personId,
          participationRevision,
          auditEventId,
          viewer.organisationId,
        ),
        atomicBatchGuardStatement(
          this.env,
          `EXISTS (SELECT 1 FROM audit_events WHERE id = ?)
         AND NOT EXISTS (
           SELECT 1 FROM session_speakers relationship
            WHERE relationship.event_id = ?
              AND relationship.session_id = ?
              AND relationship.person_id = ?
              AND relationship.participation_status = 'pending'
              AND relationship.participation_revision = ?
              AND relationship.participation_confirmed_at IS NULL
              AND relationship.participation_declined_at IS NULL
              AND relationship.participation_decline_reason IS NULL
         )`,
          [
            auditEventId,
            viewer.eventId,
            sessionId,
            personId,
            participationRevision + 1,
          ],
        ),
      ]);
    } catch (error: unknown) {
      if (isAtomicBatchGuardError(error)) {
        throw new SpeakerAdminIntegrityError(
          "Participation reset was not accompanied by its audit record.",
        );
      }
      throw error;
    }
    const audited = requireParticipationBatchResult(
      results[0],
      "Participation reset is missing its audit result.",
    );
    const updated = requireParticipationBatchResult(
      results[1],
      "Participation reset is missing its relationship result.",
    );
    const auditedCount = audited.meta.changes;
    const updatedCount = updated.results.length;
    if (
      !Number.isSafeInteger(auditedCount) ||
      !Number.isSafeInteger(updatedCount)
    )
      throw new SpeakerAdminIntegrityError(
        "Participation reset did not report complete mutation results.",
      );
    if (auditedCount === 0 && updatedCount === 0) {
      if (
        await this.participationTransitionConverged(
          viewer,
          personId,
          sessionId,
          {
            status: "pending",
            revision: participationRevision + 1,
            declineReason: null,
            action: "speaker.participation.reset",
            source: "administrator",
            from: "declined",
            to: "pending",
            inputRevision: participationRevision,
          },
        )
      ) {
        return {
          sessionId,
          title: target.title,
          participationStatus: "pending" as const,
          participationRevision: participationRevision + 1,
          changed: false,
          changeSequence: null,
        };
      }
      throw new SpeakerAdminStateError(
        "Participation changed while it was being reset. Refresh before trying again.",
        409,
      );
    }
    if (auditedCount !== 1 || updatedCount !== 1)
      throw new SpeakerAdminIntegrityError(
        "Participation reset produced inconsistent mutation results.",
      );
    return {
      sessionId,
      title: target.title,
      participationStatus: "pending" as const,
      participationRevision: participationRevision + 1,
      changed: true,
      changeSequence: null,
    };
  }

  private async participationTarget(
    viewer: Viewer,
    personId: string,
    sessionId: string,
  ) {
    const target = await this.env.DB.prepare(
      `SELECT session.title,
              relationship.participation_status AS participationStatus,
              relationship.participation_revision AS participationRevision,
              relationship.participation_decline_reason AS participationDeclineReason
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
        participationStatus: "pending" | "confirmed" | "declined";
        participationRevision: number;
        participationDeclineReason: string | null;
      }>();
    if (!target)
      throw new Response("Active speaker session not found in this event.", {
        status: 404,
      });
    return target;
  }

  private async participationTransitionConverged(
    viewer: Viewer,
    personId: string,
    sessionId: string,
    expected: {
      status: "pending" | "confirmed" | "declined";
      revision: number;
      declineReason: string | null;
      action:
        | "speaker.participation.confirmed"
        | "speaker.participation.declined"
        | "speaker.participation.reset";
      source: "speaker" | "administrator" | "administrator_external";
      from: "pending" | "declined";
      to: "pending" | "confirmed" | "declined";
      inputRevision: number;
    },
  ) {
    const match = await this.env.DB.prepare(
      `SELECT 1 AS matched
         FROM session_speakers relationship
         JOIN events event ON event.id = relationship.event_id
        WHERE relationship.event_id = ? AND relationship.session_id = ?
          AND relationship.person_id = ? AND event.organisation_id = ?
          AND relationship.participation_status = ?
          AND relationship.participation_revision = ?
          AND relationship.participation_decline_reason IS ?
          AND EXISTS (
            SELECT 1 FROM audit_events audit
             WHERE audit.organisation_id = ? AND audit.event_id = ?
               AND audit.actor_person_id = ? AND audit.action = ?
               AND audit.entity_type = 'session_speaker'
               AND audit.entity_id = ?
               AND json_valid(audit.metadata_json)
               AND json_extract(audit.metadata_json, '$.source') = ?
               AND json_extract(audit.metadata_json, '$.from') = ?
               AND json_extract(audit.metadata_json, '$.to') = ?
               AND json_extract(audit.metadata_json, '$.participationRevision') = ?
          )`,
    )
      .bind(
        viewer.eventId,
        sessionId,
        personId,
        viewer.organisationId,
        expected.status,
        expected.revision,
        expected.declineReason,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        expected.action,
        `${sessionId}:${personId}`,
        expected.source,
        expected.from,
        expected.to,
        expected.inputRevision,
      )
      .first<{ matched: 1 }>();
    return match?.matched === 1;
  }
}
