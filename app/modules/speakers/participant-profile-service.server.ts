import type { Viewer } from "~/platform/auth/authorize.server";
import { notifyRouteChange } from "~/platform/realtime/route-realtime.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";

import {
  speakerProfileSchema,
  type SpeakerProfileInput,
} from "./speaker-schema";

export class ParticipantProfileConflictError extends Error {
  constructor(
    message = "Your profile changed after this page loaded. Refresh before saving again.",
  ) {
    super(message);
    this.name = "ParticipantProfileConflictError";
  }
}

export class ParticipantProfileIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParticipantProfileIntegrityError";
  }
}

type CurrentProfileRow = {
  name: string;
  biography: string | null;
  pronunciation: string | null;
  organisationName: string | null;
  jobTitle: string | null;
  linkedinUrl: string | null;
  xHandle: string | null;
  travelPreferences: string | null;
  profileStatus: "draft" | "published" | "archived";
  revision: number;
};

export type ParticipantProfilePatch = {
  revision: number;
  name?: string;
  biography?: string;
  pronunciation?: string;
  organisationName?: string;
  jobTitle?: string;
  linkedinUrl?: string;
  xHandle?: string;
  travelPreferences?: string;
  publish?: boolean | "true" | "false";
};

export type ParticipantProfileMutationOptions = {
  operationId?: string;
  correlationId?: string;
};

/**
 * The single participant-owned profile mutation. Transport layers may expose a
 * smaller patch, but validation, revision control, audit, webhooks and live
 * invalidation always pass through this workflow.
 */
export class ParticipantProfileService {
  constructor(private readonly env: CloudflareEnvironment) {}

  async update(
    viewer: Viewer,
    patch: ParticipantProfilePatch,
    options: ParticipantProfileMutationOptions = {},
  ) {
    const current = await this.currentProfile(viewer);
    const publishWasSupplied = patch.publish !== undefined;
    const merged = speakerProfileSchema.parse({
      revision: patch.revision,
      name: patch.name ?? current.name,
      biography: patch.biography ?? current.biography ?? "",
      pronunciation: patch.pronunciation ?? current.pronunciation ?? "",
      organisationName:
        patch.organisationName ?? current.organisationName ?? "",
      jobTitle: patch.jobTitle ?? current.jobTitle ?? "",
      linkedinUrl: patch.linkedinUrl ?? current.linkedinUrl ?? "",
      xHandle: patch.xHandle ?? current.xHandle ?? "",
      travelPreferences:
        patch.travelPreferences ?? current.travelPreferences ?? "",
      publish:
        patch.publish ?? (current.profileStatus === "published" ? true : false),
    });
    const nextStatus = publishWasSupplied
      ? merged.publish
        ? "published"
        : "draft"
      : current.profileStatus;
    const operationId = options.operationId ?? crypto.randomUUID();
    const correlationId = options.correlationId ?? operationId;
    const auditEventId = `participant-profile:${operationId}`;
    const webhookService = new WebhookService(this.env);
    const webhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "speaker.updated",
        entityType: "speaker",
        entityId: viewer.personId,
        idempotencyKey: `speaker.updated:${viewer.personId}:${operationId}`,
        correlationId,
        data: {
          revision: merged.revision + 1,
          status: nextStatus,
        },
      },
      auditEventId,
    );

    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE people
            SET display_name = ?, biography = ?, pronunciation = ?,
                organisation_name = ?, job_title = ?, linkedin_url = ?,
                x_handle = ?, profile_status = ?,
                profile_revision = profile_revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND profile_revision = ?
            AND EXISTS (
              SELECT 1 FROM memberships membership
              JOIN events event
                ON event.id = membership.event_id
               AND event.organisation_id = membership.organisation_id
               WHERE membership.event_id = ?
                 AND membership.organisation_id = ?
                 AND membership.person_id = people.id
                 AND membership.role IN ('speaker', 'submitter')
                 AND membership.accepted_at IS NOT NULL
                 AND membership.revoked_at IS NULL
            )`,
      ).bind(
        merged.name,
        merged.biography,
        merged.pronunciation || null,
        merged.organisationName || null,
        merged.jobTitle || null,
        merged.linkedinUrl || null,
        merged.xHandle || null,
        nextStatus,
        operationId,
        viewer.personId,
        merged.revision,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_participant_profiles (
           event_id, organisation_id, person_id, travel_preferences,
           last_operation_id, created_at, updated_at
         )
         SELECT event.id, event.organisation_id, person.id, ?, ?,
                unixepoch(), unixepoch()
           FROM events event
           JOIN people person ON person.id = ?
          WHERE event.id = ? AND event.organisation_id = ?
            AND person.profile_revision = ? AND person.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM memberships membership
               WHERE membership.event_id = event.id
                 AND membership.organisation_id = event.organisation_id
                 AND membership.person_id = person.id
                 AND membership.role IN ('speaker', 'submitter')
                 AND membership.accepted_at IS NOT NULL
                 AND membership.revoked_at IS NULL
            )
         ON CONFLICT(event_id, person_id) DO UPDATE SET
           travel_preferences = excluded.travel_preferences,
           last_operation_id = excluded.last_operation_id,
           updated_at = unixepoch()
         WHERE event_participant_profiles.organisation_id = excluded.organisation_id`,
      ).bind(
        merged.travelPreferences || null,
        operationId,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        merged.revision + 1,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE submission_speakers
            SET display_name = ?, updated_at = unixepoch()
          WHERE event_id = ? AND person_id = ?
            AND invitation_status = 'claimed'
            AND EXISTS (
              SELECT 1 FROM people
               WHERE id = ? AND profile_revision = ? AND last_operation_id = ?
            )`,
      ).bind(
        merged.name,
        viewer.eventId,
        viewer.personId,
        viewer.personId,
        merged.revision + 1,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         ) SELECT ?, ?, ?, ?, 'participant.profile.updated', 'person', ?, ?, ?,
                  unixepoch()
            WHERE EXISTS (
              SELECT 1 FROM people
               WHERE id = ? AND profile_revision = ? AND last_operation_id = ?
            )`,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.personId,
        operationId,
        JSON.stringify({
          published: nextStatus === "published",
          revision: merged.revision + 1,
        }),
        viewer.personId,
        merged.revision + 1,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO event_changes (
           event_id, entity_type, entity_id, change_type, correlation_id, created_at
         )
         SELECT ?, 'person', ?, 'updated', ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM people
             WHERE id = ? AND profile_revision = ? AND last_operation_id = ?
          )
         RETURNING sequence`,
      ).bind(
        viewer.eventId,
        viewer.personId,
        operationId,
        viewer.personId,
        merged.revision + 1,
        operationId,
      ),
      ...webhook.statements,
    ]);

    if ((results[0]?.meta.changes ?? 0) !== 1) {
      throw new ParticipantProfileConflictError();
    }
    if ((results[1]?.meta.changes ?? 0) !== 1) {
      throw new Error(
        "The event-scoped travel preferences were not committed with the profile.",
      );
    }
    const change = results[4]?.results?.[0] as { sequence: number } | undefined;
    if (!change) {
      throw new Error("The committed profile change cursor was not recorded.");
    }

    const deliveries = await webhookService.dispatchPreparedEvent(webhook);
    const realtimeFailure = await notifyRouteChange(
      this.env,
      viewer,
      Number(change.sequence),
      viewer.personId,
    );
    return {
      revision: merged.revision + 1,
      webhookWarning: deliveries.some(
        (delivery) => delivery.status === "queue_failed",
      )
        ? "The profile was saved, but one or more outbound webhooks need a queue retry."
        : null,
      changeCursor: Number(change.sequence),
      realtimeWarning: realtimeFailure?.message ?? null,
    };
  }

  private async currentProfile(viewer: Viewer) {
    const profile = await this.env.DB.prepare(
      `SELECT person.display_name AS name, person.biography,
              person.pronunciation,
              person.organisation_name AS organisationName,
              person.job_title AS jobTitle,
              person.linkedin_url AS linkedinUrl,
              person.x_handle AS xHandle,
              event_profile.travel_preferences AS travelPreferences,
              person.profile_status AS profileStatus,
              person.profile_revision AS revision
         FROM people person
         JOIN events event ON event.id = ? AND event.organisation_id = ?
         LEFT JOIN event_participant_profiles event_profile
           ON event_profile.event_id = event.id
          AND event_profile.organisation_id = event.organisation_id
          AND event_profile.person_id = person.id
        WHERE person.id = ?
          AND EXISTS (
            SELECT 1 FROM memberships membership
             WHERE membership.event_id = event.id
               AND membership.organisation_id = event.organisation_id
               AND membership.person_id = person.id
               AND membership.role IN ('speaker', 'submitter')
               AND membership.accepted_at IS NOT NULL
               AND membership.revoked_at IS NULL
          )`,
    )
      .bind(viewer.eventId, viewer.organisationId, viewer.personId)
      .first<CurrentProfileRow>();
    if (!profile) {
      throw new Response("A current participant membership is required.", {
        status: 403,
      });
    }
    return profile;
  }
}

export type CanonicalParticipantProfileInput = SpeakerProfileInput;
