import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import {
  AirtableProviderBoundary,
  airtableCommandKey,
  airtableIntentCommand,
} from "~/modules/airtable/airtable-provider-boundary.server";
import { ApiPersonIdempotencyService } from "~/platform/api/api-person-idempotency.server";
import { ApiError } from "~/platform/api/api.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  dispatchSpeakerInvitationsForCommand,
  prepareSpeakerInvitations,
  SpeakerInvitationDeliveryError,
  type SpeakerInvitationDelivery,
} from "./speaker-invitation.server";
import { speakerProfileSchema } from "./speaker-schema";

import {
  SpeakerPortalService,
  type FileRow,
  type ProfileRow,
  type SessionRow,
} from "./speaker-portal-service.server";
import {
  ParticipantProfileConflictError,
  ParticipantProfileService,
} from "./participant-profile-service.server";
export { ParticipantProfileConflictError as SpeakerProfileConflictError } from "./participant-profile-service.server";

export class SpeakerAdminStateError extends Error {
  readonly status: number;

  constructor(message: string, status = 409) {
    super(message);
    this.name = "SpeakerAdminStateError";
    this.status = status;
  }
}

export class SpeakerAdminIntegrityError extends SpeakerAdminStateError {
  constructor(message: string) {
    super(message, 500);
    this.name = "SpeakerAdminIntegrityError";
  }
}

const adminSpeakerProfileSchema = z.object({
  revision: z.coerce.number().int().positive(),
  name: z.string().trim().min(2, "Enter the speaker's name.").max(120),
  biography: z.string().trim().max(5_000),
  pronunciation: z.string().trim().max(160),
  organisationName: z.string().trim().max(160),
  jobTitle: z.string().trim().max(160),
  profileStatus: z.enum(["draft", "published", "archived"], {
    message: "Choose a valid profile status.",
  }),
});

const manualSpeakerSchema = z
  .object({
    idempotencyKey: z
      .string()
      .trim()
      .regex(/^[A-Za-z0-9._:-]{8,128}$/, "Refresh before adding this speaker."),
    name: z.string().trim().min(1).max(120),
    email: z.string().trim().toLowerCase().email().max(254),
  })
  .strict();

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

export type AdminSpeakerFilters = {
  personId?: string;
  query?: string;
  profileStatus?: "" | "draft" | "published" | "archived";
  readiness?: "" | "ready" | "needs_attention";
};

export type AdminSpeakerFileVersion = {
  id: string;
  assetId: string;
  versionNumber: number;
  filename: string;
  sizeBytes: number;
  uploadStatus: string;
  signatureStatus: string;
  scanStatus: string;
  createdAt: number;
  releasedAt: number | null;
};

export type AdminSpeakerListItem = {
  id: string;
  name: string;
  email: string;
  jobTitle: string | null;
  organisationName: string | null;
  profileStatus: string;
  sessionCount: number;
  outstandingTasks: number;
  completedTasks: number;
  quarantinedFiles: number;
};

export class SpeakerService {
  private readonly airtable;
  private readonly portal: SpeakerPortalService;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
    this.portal = new SpeakerPortalService(env, this.airtable);
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
            )`,
      ).bind(viewer.eventId, sessionId, personId),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?, 'speaker.participation.confirmed',
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
    const updatedCount = updated.meta.changes;
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

  async createManualSpeaker(viewer: Viewer, rawInput: unknown) {
    const parsed = manualSpeakerSchema.parse(rawInput);
    const { idempotencyKey, ...input } = parsed;
    const command = await airtableIntentCommand(
      "speaker.admin.create",
      viewer,
      idempotencyKey,
      input,
    );
    const result = await this.airtable.executeIdempotent(
      viewer,
      command,
      async () => {
        try {
          const { result } = await new ApiPersonIdempotencyService(
            this.env,
          ).run({
            viewer,
            scope: "speaker.admin.create",
            idempotencyKey,
            input,
            execute: (commandId) =>
              this.createManualSpeakerD1(viewer, input, commandId),
            recover: (commandId) =>
              this.recoverManualSpeaker(viewer, commandId),
          });
          return result;
        } catch (error) {
          if (error instanceof ApiError) {
            throw new SpeakerAdminStateError(error.message, error.status);
          }
          throw error;
        }
      },
    );
    const invitationOutcomes = await dispatchSpeakerInvitationsForCommand({
      env: this.env,
      organisationId: viewer.organisationId,
      eventId: viewer.eventId,
      commandId: result.commandId,
    });
    const invitationOutcome = invitationOutcomes[0];
    const accepted =
      result.accepted || invitationOutcome?.status === "not_required";
    const delivery: SpeakerInvitationDelivery = accepted
      ? "not_required"
      : (invitationOutcome?.status ?? "not_required");
    if (!accepted && delivery === "not_required") {
      throw new Error(
        "The pending speaker invitation is missing its delivery outcome.",
      );
    }
    if (["queue_failed", "failed", "cancelled"].includes(delivery)) {
      throw new SpeakerInvitationDeliveryError(result.membershipId);
    }
    const { commandId: _commandId, ...publicResult } = result;
    return { ...publicResult, accepted, delivery };
  }

  private async createManualSpeakerD1(
    viewer: Viewer,
    input: Omit<z.infer<typeof manualSpeakerSchema>, "idempotencyKey">,
    commandId: string,
  ) {
    const event = await this.env.DB.prepare(
      "SELECT 1 FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!event) throw new Response("Event not found.", { status: 404 });

    const personId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();
    const invitationPlans = await prepareSpeakerInvitations({
      env: this.env,
      actor: {
        organisationId: viewer.organisationId,
        eventId: viewer.eventId,
        personId: viewer.personId,
      },
      commandId,
      source: "manual_speaker",
      emails: [input.email],
    });
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO people (
           id, email, display_name, email_verified, profile_status,
           last_operation_id, created_at, updated_at
         ) VALUES (?, ?, ?, 0, 'draft', ?, unixepoch(), unixepoch())
         ON CONFLICT(email) DO NOTHING`,
      ).bind(personId, input.email, input.name, commandId),
      this.env.DB.prepare(
        `INSERT INTO memberships (
           id, organisation_id, event_id, person_id, role,
           invited_at, invitation_expires_at, accepted_at, revoked_at,
           last_operation_id, created_at
         )
         SELECT ?, ?, ?, person.id, 'speaker', unixepoch(),
                unixepoch() + 604800, NULL, NULL, ?, unixepoch()
           FROM people person
          WHERE person.email = ? COLLATE NOCASE
            AND EXISTS (
              SELECT 1 FROM events
               WHERE id = ? AND organisation_id = ?
            )
         ON CONFLICT(event_id, person_id, role) WHERE event_id IS NOT NULL
         DO UPDATE SET
                       invited_at = CASE
                         WHEN memberships.accepted_at IS NOT NULL
                          AND memberships.revoked_at IS NULL
                         THEN memberships.invited_at ELSE unixepoch() END,
                       invitation_expires_at = CASE
                         WHEN memberships.accepted_at IS NOT NULL
                          AND memberships.revoked_at IS NULL
                         THEN memberships.invitation_expires_at
                         ELSE unixepoch() + 604800 END,
                       accepted_at = CASE
                         WHEN memberships.accepted_at IS NOT NULL
                          AND memberships.revoked_at IS NULL
                         THEN memberships.accepted_at ELSE NULL END,
                       revoked_at = NULL,
                       last_operation_id = excluded.last_operation_id
          WHERE memberships.organisation_id = excluded.organisation_id`,
      ).bind(
        membershipId,
        viewer.organisationId,
        viewer.eventId,
        commandId,
        input.email,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, ?, ?, ?,
                CASE WHEN membership.accepted_at IS NULL
                     THEN 'speaker.admin.invited'
                     ELSE 'speaker.admin.reused' END,
                'person', person.id, ?,
                json_object('enteredEmail', ?, 'createdIdentity',
                            person.last_operation_id = ?), unixepoch()
           FROM people person
          JOIN memberships membership
            ON membership.organisation_id = ?
           AND membership.event_id = ?
           AND membership.person_id = person.id
           AND membership.role = 'speaker'
           AND membership.last_operation_id = ?
          WHERE person.email = ? COLLATE NOCASE
            AND membership.revoked_at IS NULL`,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        commandId,
        input.email,
        commandId,
        viewer.organisationId,
        viewer.eventId,
        commandId,
        input.email,
      ),
      ...invitationPlans.flatMap((plan) => plan.statements),
    ]);
    const created = await this.recoverManualSpeaker(viewer, commandId);
    if (!created) {
      throw new Error(
        "The speaker identity was not linked to the authorised event.",
      );
    }
    return created;
  }

  private async recoverManualSpeaker(viewer: Viewer, commandId: string) {
    return this.env.DB.prepare(
      `SELECT audit.entity_id AS personId, person.email,
              membership.id AS membershipId,
              membership.accepted_at IS NOT NULL AS accepted,
              membership.invitation_expires_at AS invitationExpiresAt,
              json_extract(audit.metadata_json, '$.createdIdentity') AS createdIdentity
         FROM audit_events audit
         JOIN people person ON person.id = audit.entity_id
         JOIN memberships membership
           ON membership.person_id = audit.entity_id
          AND membership.organisation_id = audit.organisation_id
          AND membership.event_id = audit.event_id
          AND membership.role = 'speaker'
          AND membership.revoked_at IS NULL
        WHERE audit.organisation_id = ? AND audit.event_id = ?
          AND audit.actor_person_id = ?
          AND audit.action IN ('speaker.admin.invited','speaker.admin.reused')
          AND audit.entity_type = 'person'
          AND audit.correlation_id = ?
        LIMIT 1`,
    )
      .bind(viewer.organisationId, viewer.eventId, viewer.personId, commandId)
      .first<{
        personId: string;
        email: string;
        membershipId: string;
        accepted: number;
        invitationExpiresAt: number | null;
        createdIdentity: number;
      }>()
      .then((row) =>
        row
          ? {
              ...row,
              commandId,
              accepted: Boolean(row.accepted),
              createdIdentity: Boolean(row.createdIdentity),
            }
          : null,
      );
  }

  private adminSpeakerScopeSql(alias = "person.id") {
    return `EXISTS (
      SELECT 1 FROM events scope_event
       WHERE scope_event.id = ? AND scope_event.organisation_id = ?
         AND (
           EXISTS (
             SELECT 1 FROM session_speakers link
              WHERE link.event_id = scope_event.id AND link.person_id = ${alias}
           )
           OR EXISTS (
             SELECT 1 FROM memberships membership
              WHERE membership.event_id = scope_event.id
                AND membership.person_id = ${alias}
                AND membership.role = 'speaker'
                AND membership.accepted_at IS NOT NULL
                AND membership.revoked_at IS NULL
           )
         )
    )`;
  }

  /**
   * People are canonical identities rather than event-owned copies. An event
   * organiser may therefore edit the shared row only while every relevant event
   * association belongs to the current event. Once another event or an
   * organisation-wide membership shares the identity, the person must own
   * profile changes so one organiser cannot alter another event's records.
   */
  private async adminProfileIsShared(viewer: Viewer, personId: string) {
    const shared = await this.env.DB.prepare(
      `
      SELECT 1 AS shared
       WHERE EXISTS (
         SELECT 1
           FROM session_speakers link
           JOIN events linked_event ON linked_event.id = link.event_id
          WHERE link.person_id = ?
            AND (link.event_id <> ? OR linked_event.organisation_id <> ?)
       )
          OR EXISTS (
         SELECT 1
           FROM submissions submission
           JOIN events submission_event
             ON submission_event.id = submission.event_id
          WHERE submission.submitter_person_id = ?
            AND (submission.event_id <> ? OR submission_event.organisation_id <> ?)
       )
          OR EXISTS (
         SELECT 1
           FROM submission_speakers submission_speaker
           JOIN events submission_event
             ON submission_event.id = submission_speaker.event_id
          WHERE submission_speaker.person_id = ?
            AND (submission_speaker.event_id <> ? OR submission_event.organisation_id <> ?)
       )
          OR EXISTS (
         SELECT 1
           FROM memberships membership
          WHERE membership.person_id = ?
            AND membership.accepted_at IS NOT NULL
            AND membership.revoked_at IS NULL
            AND (
              membership.event_id IS NULL
              OR membership.event_id <> ?
              OR membership.organisation_id <> ?
            )
       )
      LIMIT 1
    `,
    )
      .bind(
        personId,
        viewer.eventId,
        viewer.organisationId,
        personId,
        viewer.eventId,
        viewer.organisationId,
        personId,
        viewer.eventId,
        viewer.organisationId,
        personId,
        viewer.eventId,
        viewer.organisationId,
      )
      .first<{ shared: number }>();
    return Boolean(shared);
  }

  private adminProfileExclusiveSql(alias = "people.id") {
    return `NOT EXISTS (
      SELECT 1
        FROM session_speakers other_link
        JOIN events other_event ON other_event.id = other_link.event_id
       WHERE other_link.person_id = ${alias}
         AND (other_link.event_id <> ? OR other_event.organisation_id <> ?)
    ) AND NOT EXISTS (
      SELECT 1
        FROM submissions other_submission
        JOIN events other_event ON other_event.id = other_submission.event_id
       WHERE other_submission.submitter_person_id = ${alias}
         AND (other_submission.event_id <> ? OR other_event.organisation_id <> ?)
    ) AND NOT EXISTS (
      SELECT 1
        FROM submission_speakers other_speaker
        JOIN events other_event ON other_event.id = other_speaker.event_id
       WHERE other_speaker.person_id = ${alias}
         AND (other_speaker.event_id <> ? OR other_event.organisation_id <> ?)
    ) AND NOT EXISTS (
      SELECT 1
        FROM memberships other_membership
       WHERE other_membership.person_id = ${alias}
         AND other_membership.accepted_at IS NOT NULL
         AND other_membership.revoked_at IS NULL
         AND (
           other_membership.event_id IS NULL
           OR other_membership.event_id <> ?
           OR other_membership.organisation_id <> ?
         )
    )`;
  }

  async getAdminSpeakerDetail(viewer: Viewer, rawPersonId: string) {
    await this.airtable.assertReadable(viewer);
    const personId = rawPersonId.trim();
    if (!personId || personId.length > 200)
      throw new Response("Speaker not found in this event.", { status: 404 });
    const profile = await this.env.DB.prepare(
      `
      SELECT person.id, person.email, person.display_name AS name,
             person.biography, person.pronunciation,
             person.organisation_name AS organisationName,
             person.job_title AS jobTitle,
             person.profile_status AS profileStatus,
             person.profile_revision AS revision,
             person.updated_at AS updatedAt
        FROM people person
       WHERE person.id = ? AND ${this.adminSpeakerScopeSql()}
    `,
    )
      .bind(personId, viewer.eventId, viewer.organisationId)
      .first<ProfileRow & { updatedAt: number }>();
    if (!profile)
      throw new Response("Speaker not found in this event.", { status: 404 });
    const [event, sessions, files, tasks, profileShared] = await Promise.all([
      this.env.DB.prepare(
        `SELECT name, timezone FROM events WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{ name: string; timezone: string }>(),
      this.env.DB.prepare(
        `
        SELECT s.id, s.title, s.description, s.format,
               s.duration_minutes AS durationMinutes, s.status,
               ss.role_label AS roleLabel,
               ss.participation_status AS participationStatus,
               ss.participation_confirmed_at AS participationConfirmedAt,
               se.starts_at AS startsAt,
               se.ends_at AS endsAt, r.name AS roomName
          FROM session_speakers ss
          JOIN sessions s ON s.id = ss.session_id AND s.event_id = ss.event_id
          LEFT JOIN schedule_versions sv
            ON sv.event_id = s.event_id AND sv.status = 'published'
          LEFT JOIN schedule_entries se
            ON se.schedule_version_id = sv.id AND se.session_id = s.id
          LEFT JOIN rooms r ON r.id = se.room_id AND r.event_id = s.event_id
         WHERE ss.event_id = ? AND ss.person_id = ? AND s.status <> 'archived'
         ORDER BY se.starts_at IS NULL, se.starts_at, s.title
      `,
      )
        .bind(viewer.eventId, personId)
        .all<SessionRow>(),
      this.env.DB.prepare(
        `
        SELECT fa.id, fa.asset_kind AS kind, fa.status,
               fa.current_version_id AS currentVersionId,
               fv.original_filename AS filename, fv.size_bytes AS sizeBytes,
               fv.upload_status AS uploadStatus,
               fv.signature_status AS signatureStatus,
               fv.scan_status AS scanStatus, fv.version_number AS versionNumber,
               fv.released_at AS releasedAt,
               current.original_filename AS downloadFilename,
               current.released_at AS downloadReleasedAt
          FROM file_assets fa
          LEFT JOIN file_versions fv ON fv.id = (
            SELECT id FROM file_versions candidate
             WHERE candidate.asset_id = fa.id AND candidate.deleted_at IS NULL
             ORDER BY candidate.version_number DESC LIMIT 1
          )
          LEFT JOIN file_versions current
            ON current.id = fa.current_version_id
           AND current.event_id = fa.event_id
           AND current.asset_id = fa.id
           AND current.deleted_at IS NULL
         WHERE fa.event_id = ? AND fa.owner_person_id = ? AND fa.status <> 'deleted'
         ORDER BY fa.updated_at DESC
      `,
      )
        .bind(viewer.eventId, personId)
        .all<FileRow>(),
      this.env.DB.prepare(
        `
        SELECT
          SUM(CASE WHEN task.status NOT IN ('completed','waived') THEN 1 ELSE 0 END) AS outstanding,
          SUM(CASE WHEN task.status IN ('completed','waived') THEN 1 ELSE 0 END) AS completed
          FROM task_instances task
         WHERE task.event_id = ?
           AND (
             (task.target_type = 'speaker' AND task.target_id = ?)
             OR task.owner_person_id = ?
           )
      `,
      )
        .bind(viewer.eventId, personId, personId)
        .first<{ outstanding: number; completed: number }>(),
      this.adminProfileIsShared(viewer, personId),
    ]);
    const assetIds = files.results.map((file) => file.id);
    const brokenCurrentVersion = files.results.find(
      (file) => file.currentVersionId && file.downloadFilename === null,
    );
    if (brokenCurrentVersion) {
      throw new SpeakerAdminIntegrityError(
        `File asset ${brokenCurrentVersion.id} references an unavailable current version.`,
      );
    }
    const versions = assetIds.length
      ? await this.env.DB.prepare(
          `
          SELECT id, asset_id AS assetId, version_number AS versionNumber,
                 original_filename AS filename, size_bytes AS sizeBytes,
                 upload_status AS uploadStatus,
                 signature_status AS signatureStatus, scan_status AS scanStatus,
                 created_at AS createdAt, released_at AS releasedAt
            FROM file_versions
           WHERE event_id = ?
             AND asset_id IN (${assetIds.map(() => "?").join(",")})
             AND deleted_at IS NULL
           ORDER BY asset_id, version_number DESC
        `,
        )
          .bind(viewer.eventId, ...assetIds)
          .all<AdminSpeakerFileVersion>()
      : { results: [] as AdminSpeakerFileVersion[] };
    if (!event) throw new Response("Event not found.", { status: 404 });
    return {
      profile,
      profileShared,
      event,
      sessions: sessions.results,
      files: files.results.map((file) => ({
        ...file,
        versions: versions.results.filter(
          (version) => version.assetId === file.id,
        ),
      })),
      tasks: {
        outstanding: Number(tasks?.outstanding ?? 0),
        completed: Number(tasks?.completed ?? 0),
      },
    };
  }

  async updateAdminSpeakerProfile(
    viewer: Viewer,
    personId: string,
    rawInput: unknown,
  ) {
    const idempotencyKey = await airtableCommandKey(
      "speaker.admin.profile.update",
      viewer,
      { personId, ...(rawInput as Record<string, unknown>) },
    );
    return this.airtable.executeIdempotent(
      viewer,
      { idempotencyKey, operation: "speaker.admin.profile.update" },
      () => this.updateAdminSpeakerProfileD1(viewer, personId, rawInput),
    );
  }

  private async updateAdminSpeakerProfileD1(
    viewer: Viewer,
    rawPersonId: string,
    rawInput: unknown,
  ) {
    const personId = rawPersonId.trim();
    const input = adminSpeakerProfileSchema.parse(rawInput);
    const inScope = personId
      ? await this.env.DB.prepare(
          `SELECT 1 AS allowed FROM people person
            WHERE person.id = ? AND ${this.adminSpeakerScopeSql()}`,
        )
          .bind(personId, viewer.eventId, viewer.organisationId)
          .first()
      : null;
    if (!inScope)
      throw new Response("Speaker not found in this event.", { status: 404 });
    if (await this.adminProfileIsShared(viewer, personId)) {
      throw new SpeakerAdminStateError(
        "This person is linked to another event or an organisation-wide role. Ask them to update their shared profile from their own speaker workspace.",
      );
    }
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const webhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "speaker.updated",
        entityType: "speaker",
        entityId: personId,
        idempotencyKey: `speaker.updated:${personId}:${operationId}`,
        correlationId: operationId,
        data: {
          revision: input.revision + 1,
          status: input.profileStatus,
        },
      },
      auditEventId,
    );
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE people
           SET display_name = ?, biography = ?, pronunciation = ?,
               organisation_name = ?, job_title = ?, profile_status = ?,
               profile_revision = profile_revision + 1,
               last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND profile_revision = ?
           AND ${this.adminSpeakerScopeSql("people.id")}
           AND ${this.adminProfileExclusiveSql("people.id")}
      `,
      ).bind(
        input.name,
        input.biography || null,
        input.pronunciation || null,
        input.organisationName || null,
        input.jobTitle || null,
        input.profileStatus,
        operationId,
        personId,
        input.revision,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'speaker.admin.profile.updated', 'person', ?, ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM people
              WHERE id = ? AND profile_revision = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        personId,
        operationId,
        JSON.stringify({
          profileStatus: input.profileStatus,
          revision: input.revision + 1,
        }),
        personId,
        input.revision + 1,
        operationId,
      ),
      ...webhook.statements,
    ]);
    if ((updated.meta.changes ?? 0) !== 1)
      throw new ParticipantProfileConflictError(
        "This speaker profile changed after the page loaded. Refresh before saving again.",
      );
    const deliveries = await webhookService.dispatchPreparedEvent(webhook);
    return {
      revision: input.revision + 1,
      profileStatus: input.profileStatus,
      webhookWarning: deliveries.some(
        (delivery) => delivery.status === "queue_failed",
      )
        ? "The profile was saved, but one or more outbound webhooks need a queue retry."
        : null,
    };
  }

  async listAdminSpeakerPage(
    viewer: Viewer,
    filters: AdminSpeakerFilters,
    page: number,
  ) {
    await this.airtable.assertReadable(viewer);
    if (!Number.isInteger(page) || page < 1) {
      throw new Response("Invalid speakers page", { status: 400 });
    }
    const queryValue = filters.query?.trim() ?? "";
    const personId = filters.personId?.trim() ?? "";
    if (personId.length > 200)
      throw new Response("Invalid speaker focus", { status: 400 });
    if (queryValue.length > 120) {
      throw new Response("Speaker search is limited to 120 characters.", {
        status: 400,
      });
    }
    const profileStatus = filters.profileStatus ?? "";
    if (
      profileStatus !== "" &&
      profileStatus !== "draft" &&
      profileStatus !== "published" &&
      profileStatus !== "archived"
    ) {
      throw new Response("Invalid speaker profile filter", { status: 400 });
    }
    const readiness = filters.readiness ?? "";
    if (
      readiness !== "" &&
      readiness !== "ready" &&
      readiness !== "needs_attention"
    ) {
      throw new Response("Invalid speaker readiness filter", { status: 400 });
    }
    const event = await this.env.DB.prepare(
      "SELECT timezone FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ timezone: string }>();
    if (!event) throw new Response("Event not found.", { status: 404 });
    const pageSize = 50;
    const query = `%${queryValue}%`;
    const speakers = await this.env.DB.prepare(
      `
      WITH event_speaker_ids(person_id) AS (
        SELECT person_id
          FROM session_speakers
         WHERE event_id = ?
        UNION
        SELECT person_id
          FROM memberships
         WHERE event_id = ? AND role = 'speaker'
           AND accepted_at IS NOT NULL AND revoked_at IS NULL
      ), page_people AS (
        SELECT p.id, COALESCE(contact_profile.display_name, p.display_name) AS name,
               p.email,
               COALESCE(contact_profile.job_title, p.job_title) AS jobTitle,
               COALESCE(contact_profile.organisation_name, p.organisation_name) AS organisationName,
               p.profile_status AS profileStatus
          FROM event_speaker_ids speaker
          JOIN people p ON p.id = speaker.person_id
          LEFT JOIN organisation_contact_profiles contact_profile
            ON contact_profile.organisation_id = ?
           AND contact_profile.person_id = p.id
         WHERE (? = '' OR p.profile_status = ?)
           AND (? = '%%' OR COALESCE(contact_profile.display_name, p.display_name) LIKE ? OR p.email LIKE ?)
           AND (? = '' OR p.id = ?)
           AND (
             ? = ''
             OR (
               ? = 'ready'
               AND NOT (
                 EXISTS (
                   SELECT 1 FROM task_instances task
                    WHERE task.event_id = ?
                      AND task.target_type = 'speaker'
                      AND task.target_id = p.id
                      AND task.status NOT IN ('completed','waived')
                 )
                 OR EXISTS (
                   SELECT 1 FROM task_instances task
                    WHERE task.event_id = ?
                      AND task.owner_person_id = p.id
                      AND task.status NOT IN ('completed','waived')
                 )
               )
             )
             OR (
               ? = 'needs_attention'
               AND (
                 EXISTS (
                   SELECT 1 FROM task_instances task
                    WHERE task.event_id = ?
                      AND task.target_type = 'speaker'
                      AND task.target_id = p.id
                      AND task.status NOT IN ('completed','waived')
                 )
                 OR EXISTS (
                   SELECT 1 FROM task_instances task
                    WHERE task.event_id = ?
                      AND task.owner_person_id = p.id
                      AND task.status NOT IN ('completed','waived')
                 )
               )
             )
           )
         ORDER BY COALESCE(contact_profile.display_name, p.display_name), p.id
         LIMIT ? OFFSET ?
      )
      SELECT person.*,
             (SELECT COUNT(*) FROM session_speakers speaker
               WHERE speaker.event_id = ? AND speaker.person_id = person.id) AS sessionCount,
             (SELECT COUNT(*) FROM task_instances task
               WHERE task.event_id = ?
                 AND task.status NOT IN ('completed','waived')
                 AND (
                   (task.target_type = 'speaker' AND task.target_id = person.id)
                   OR task.owner_person_id = person.id
                 )) AS outstandingTasks,
             (SELECT COUNT(*) FROM task_instances task
               WHERE task.event_id = ?
                 AND task.status IN ('completed','waived')
                 AND (
                   (task.target_type = 'speaker' AND task.target_id = person.id)
                   OR task.owner_person_id = person.id
                 )) AS completedTasks,
             (SELECT COUNT(*)
                FROM file_assets asset
                JOIN file_versions version ON version.id = (
                  SELECT latest.id FROM file_versions latest
                   WHERE latest.asset_id = asset.id AND latest.deleted_at IS NULL
                   ORDER BY latest.version_number DESC LIMIT 1
                )
               WHERE asset.event_id = ? AND asset.owner_person_id = person.id
                 AND asset.status <> 'deleted'
                 AND version.upload_status = 'uploaded'
                 AND version.signature_status = 'valid'
                 AND version.scan_status = 'pending') AS quarantinedFiles
        FROM page_people person
       ORDER BY person.name, person.id
    `,
    )
      .bind(
        viewer.eventId,
        viewer.eventId,
        viewer.organisationId,
        profileStatus,
        profileStatus,
        query,
        query,
        query,
        personId,
        personId,
        readiness,
        readiness,
        viewer.eventId,
        viewer.eventId,
        readiness,
        viewer.eventId,
        viewer.eventId,
        pageSize + 1,
        (page - 1) * pageSize,
        viewer.eventId,
        viewer.eventId,
        viewer.eventId,
        viewer.eventId,
      )
      .all<AdminSpeakerListItem>();
    const [summary, pendingInvitations] = await Promise.all([
      this.env.DB.prepare(
        `
      WITH event_speaker_ids(person_id) AS (
        SELECT person_id FROM session_speakers WHERE event_id = ?
        UNION
        SELECT person_id FROM memberships
         WHERE event_id = ? AND role = 'speaker'
           AND accepted_at IS NOT NULL AND revoked_at IS NULL
      )
      SELECT COUNT(*) AS knownSpeakers,
             SUM(CASE WHEN NOT (
               EXISTS (
                 SELECT 1 FROM task_instances task
                  WHERE task.event_id = ?
                    AND task.target_type = 'speaker'
                    AND task.target_id = speaker.person_id
                    AND task.status NOT IN ('completed','waived')
               )
               OR EXISTS (
                 SELECT 1 FROM task_instances task
                  WHERE task.event_id = ?
                    AND task.owner_person_id = speaker.person_id
                    AND task.status NOT IN ('completed','waived')
               )
             ) THEN 1 ELSE 0 END) AS readySpeakers,
             (SELECT COUNT(DISTINCT task.id)
                FROM task_instances task
               WHERE task.event_id = ?
                 AND task.status NOT IN ('completed','waived')
                 AND (
                   (task.target_type = 'speaker' AND task.target_id IN (SELECT person_id FROM event_speaker_ids))
                   OR task.owner_person_id IN (SELECT person_id FROM event_speaker_ids)
                 )) AS outstandingTasks,
             (SELECT COUNT(*)
                FROM file_assets asset
                JOIN file_versions version ON version.id = (
                  SELECT latest.id FROM file_versions latest
                   WHERE latest.asset_id = asset.id AND latest.deleted_at IS NULL
                   ORDER BY latest.version_number DESC LIMIT 1
                )
               WHERE asset.event_id = ?
                 AND asset.owner_person_id IN (SELECT person_id FROM event_speaker_ids)
                 AND asset.status <> 'deleted'
                 AND version.upload_status = 'uploaded'
                 AND version.signature_status = 'valid'
                 AND version.scan_status = 'pending') AS quarantinedFiles
        FROM event_speaker_ids speaker
    `,
      )
        .bind(
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
          viewer.eventId,
        )
        .first<{
          knownSpeakers: number;
          readySpeakers: number;
          outstandingTasks: number;
          quarantinedFiles: number;
        }>(),
      this.env.DB.prepare(
        `SELECT membership.id, person.email,
                membership.invited_at AS invitedAt,
                membership.invitation_expires_at AS expiresAt,
                membership.invitation_expires_at <= unixepoch() AS expired
           FROM memberships membership
           JOIN people person ON person.id = membership.person_id
          WHERE membership.organisation_id = ? AND membership.event_id = ?
            AND membership.role = 'speaker'
            AND membership.accepted_at IS NULL
            AND membership.revoked_at IS NULL
          ORDER BY membership.invited_at DESC, membership.id`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<{
          id: string;
          email: string;
          invitedAt: number;
          expiresAt: number | null;
          expired: number;
        }>(),
    ]);
    if (!summary) {
      throw new Error("Speaker readiness summary could not be read.");
    }
    const malformedInvitation = pendingInvitations.results.find(
      (invitation) => invitation.expiresAt === null,
    );
    if (malformedInvitation) {
      throw new Error(
        `Pending speaker invitation ${malformedInvitation.id} is missing its required expiry.`,
      );
    }
    return {
      speakers: speakers.results.slice(0, pageSize),
      eventTimezone: event.timezone,
      page,
      hasNext: speakers.results.length > pageSize,
      pendingInvitations: pendingInvitations.results.map((invitation) => ({
        ...invitation,
        expiresAt: invitation.expiresAt!,
        expired: Boolean(invitation.expired),
      })),
      summary: {
        knownSpeakers: Number(summary.knownSpeakers),
        readySpeakers: Number(summary.readySpeakers),
        outstandingTasks: Number(summary.outstandingTasks),
        quarantinedFiles: Number(summary.quarantinedFiles),
      },
    };
  }

  static parseProfileForm(form: FormData) {
    return z
      .object({
        revision: z.coerce.number(),
        name: z.string(),
        biography: z.string(),
        pronunciation: z.string(),
        organisationName: z.string(),
        jobTitle: z.string(),
        publish: z.string(),
      })
      .parse(Object.fromEntries(form));
  }
}
