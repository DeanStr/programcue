import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { parseEventFilePolicy } from "~/modules/files/file-policy";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  adminProfileIsShared,
  adminSpeakerScopeSql,
} from "./speaker-admin-scope.server";
import type {
  AdminSpeakerFileVersion,
  AdminSpeakerFilters,
  AdminSpeakerListItem,
} from "./speaker-administration-contracts.server";
import type {
  FileRow,
  ProfileRow,
  SessionRow,
} from "./speaker-portal-service.server";
import { readSpeakerProfileHistory } from "./speaker-profile-revision.server";
import { SpeakerAdminIntegrityError } from "./speaker-service-errors";

export class SpeakerAdminQueryService {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly airtable: AirtableProviderBoundary,
  ) {}

  async getAdminSpeakerDetail(viewer: Viewer, rawPersonId: string) {
    await this.airtable.assertReadable(viewer);
    const personId = rawPersonId.trim();
    if (!personId || personId.length > 200)
      throw new Response("Speaker not found in this event.", { status: 404 });
    const profile = await this.env.DB.prepare(
      `
      SELECT person.id, person.email,
             COALESCE(contact_profile.display_name, person.display_name) AS name,
             COALESCE(contact_profile.biography, person.biography) AS biography,
             person.pronunciation,
             COALESCE(contact_profile.organisation_name, person.organisation_name) AS organisationName,
             COALESCE(contact_profile.job_title, person.job_title) AS jobTitle,
             person.linkedin_url AS linkedinUrl,
             person.x_handle AS xHandle,
             event_profile.travel_preferences AS travelPreferences,
             contact_profile.person_id IS NOT NULL AS hasOrganisationProfile,
             COALESCE(contact_profile.last_operation_id, '') AS organisationProfileOperationId,
             COALESCE(event_profile.last_operation_id, '') AS travelProfileOperationId,
             person.profile_status AS profileStatus,
             person.profile_revision AS revision,
             person.updated_at AS updatedAt
        FROM people person
        LEFT JOIN organisation_contacts contact
          ON contact.organisation_id = ? AND contact.person_id = person.id
        LEFT JOIN organisation_contact_profiles contact_profile
          ON contact_profile.organisation_id = contact.organisation_id
         AND contact_profile.person_id = contact.person_id
        LEFT JOIN event_participant_profiles event_profile
          ON event_profile.event_id = ?
         AND event_profile.organisation_id = ?
         AND event_profile.person_id = person.id
       WHERE person.id = ? AND ${adminSpeakerScopeSql()}
    `,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.organisationId,
        personId,
        viewer.eventId,
        viewer.organisationId,
      )
      .first<
        ProfileRow & {
          updatedAt: number;
          hasOrganisationProfile: number;
          organisationProfileOperationId: string;
          travelProfileOperationId: string;
        }
      >();
    if (!profile)
      throw new Response("Speaker not found in this event.", { status: 404 });
    const [event, sessions, files, tasks, profileShared, profileHistory] =
      await Promise.all([
        this.env.DB.prepare(
          `SELECT name, timezone, file_policy_json AS filePolicyJson
           FROM events WHERE id = ? AND organisation_id = ?`,
        )
          .bind(viewer.eventId, viewer.organisationId)
          .first<{ name: string; timezone: string; filePolicyJson: string }>(),
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
        SELECT fa.id, fa.asset_kind AS kind,
               fa.target_type AS targetType, fa.target_id AS targetId,
               fa.status,
               fa.current_version_id AS currentVersionId,
               fv.original_filename AS filename, fv.size_bytes AS sizeBytes,
               fv.upload_status AS uploadStatus,
               fv.signature_status AS signatureStatus,
               fv.scan_status AS scanStatus, fv.version_number AS versionNumber,
               fv.released_at AS releasedAt,
               current.original_filename AS downloadFilename,
               current.released_at AS downloadReleasedAt,
               current.uploaded_at AS downloadUploadedAt,
               NULLIF(TRIM(uploader.display_name), '') AS downloadUploaderName
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
          LEFT JOIN people uploader ON uploader.id = current.created_by_person_id
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
        adminProfileIsShared(this.env, viewer, personId),
        readSpeakerProfileHistory(this.env, {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          personId,
        }),
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
    const releasedFileWithoutProvenance = files.results.find(
      (file) =>
        file.currentVersionId !== null &&
        file.downloadReleasedAt !== null &&
        (file.downloadUploadedAt === null ||
          file.downloadUploaderName === null),
    );
    if (releasedFileWithoutProvenance) {
      throw new SpeakerAdminIntegrityError(
        `Released file ${releasedFileWithoutProvenance.id} is missing upload provenance.`,
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
    if (!event)
      throw new Response("This event could not be found.", { status: 404 });
    return {
      profile,
      profileHistory,
      profileShared,
      profileScoped: profileShared || Boolean(profile.hasOrganisationProfile),
      event: {
        name: event.name,
        timezone: event.timezone,
        filePolicy: parseEventFilePolicy(event.filePolicyJson),
      },
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
    const workflowStatus = filters.workflowStatus ?? "";
    if (
      workflowStatus !== "" &&
      workflowStatus !== "prospect" &&
      workflowStatus !== "invited" &&
      workflowStatus !== "confirmed" &&
      workflowStatus !== "declined" &&
      workflowStatus !== "withdrawn"
    ) {
      throw new Response("Invalid speaker workflow filter", { status: 400 });
    }
    const event = await this.env.DB.prepare(
      "SELECT timezone FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first<{ timezone: string }>();
    if (!event)
      throw new Response("This event could not be found.", { status: 404 });
    const missingWorkflow = await this.env.DB.prepare(
      `WITH expected(person_id) AS (
         SELECT person_id FROM session_speakers WHERE event_id = ?
         UNION
         SELECT person_id FROM memberships
          WHERE event_id = ? AND role = 'speaker'
            AND accepted_at IS NOT NULL AND revoked_at IS NULL
       )
       SELECT expected.person_id AS personId
         FROM expected
         LEFT JOIN event_speaker_workflows workflow
           ON workflow.event_id = ? AND workflow.person_id = expected.person_id
        WHERE workflow.person_id IS NULL
        ORDER BY expected.person_id
        LIMIT 1`,
    )
      .bind(viewer.eventId, viewer.eventId, viewer.eventId)
      .first<{ personId: string }>();
    if (missingWorkflow) {
      throw new Error(
        `Speaker ${missingWorkflow.personId} has no event workflow state.`,
      );
    }
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
        UNION
        SELECT person_id FROM event_speaker_workflows WHERE event_id = ?
      ), page_people AS (
        SELECT p.id, COALESCE(contact_profile.display_name, p.display_name) AS name,
               p.email,
               COALESCE(contact_profile.job_title, p.job_title) AS jobTitle,
               COALESCE(contact_profile.organisation_name, p.organisation_name) AS organisationName,
               p.profile_status AS profileStatus,
               workflow.status AS workflowStatus
          FROM event_speaker_ids speaker
          JOIN people p ON p.id = speaker.person_id
          JOIN event_speaker_workflows workflow
            ON workflow.event_id = ? AND workflow.person_id = p.id
          LEFT JOIN organisation_contact_profiles contact_profile
            ON contact_profile.organisation_id = ?
           AND contact_profile.person_id = p.id
         WHERE (? = '' OR p.profile_status = ?)
           AND (? = '' OR workflow.status = ?)
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
             EXISTS (
               SELECT 1 FROM memberships membership
                WHERE membership.event_id = ?
                  AND membership.person_id = person.id
                  AND membership.role = 'speaker'
                  AND membership.accepted_at IS NOT NULL
                  AND membership.revoked_at IS NULL
             ) AS portalAccessAccepted,
             EXISTS (
               SELECT 1 FROM memberships membership
                WHERE membership.event_id = ?
                  AND membership.person_id = person.id
                  AND membership.role = 'speaker'
                  AND membership.accepted_at IS NULL
                  AND membership.invited_at IS NOT NULL
                  AND membership.revoked_at IS NULL
             ) AS portalInvitationPending,
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
        viewer.eventId,
        viewer.eventId,
        viewer.organisationId,
        profileStatus,
        profileStatus,
        workflowStatus,
        workflowStatus,
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
        UNION
        SELECT person_id FROM event_speaker_workflows WHERE event_id = ?
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
            AND membership.invited_at IS NOT NULL
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
    return {
      speakers: speakers.results.slice(0, pageSize),
      eventTimezone: event.timezone,
      page,
      hasNext: speakers.results.length > pageSize,
      pendingInvitations: pendingInvitations.results.map((invitation) => {
        if (invitation.expiresAt === null) {
          throw new Error(
            `Pending speaker invitation ${invitation.id} is missing its required expiry.`,
          );
        }
        return {
          ...invitation,
          expiresAt: invitation.expiresAt,
          expired: Boolean(invitation.expired),
        };
      }),
      summary: {
        knownSpeakers: Number(summary.knownSpeakers),
        readySpeakers: Number(summary.readySpeakers),
        outstandingTasks: Number(summary.outstandingTasks),
        quarantinedFiles: Number(summary.quarantinedFiles),
      },
    };
  }
}
