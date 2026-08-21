import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { parseEventFilePolicy } from "~/modules/files/file-policy";
import { PublishedHeadshotService } from "~/modules/programme/published-headshot-service.server";
import { canonicalSessionDetailsReviewTaskSql } from "~/modules/tasks/session-details-review.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { readSpeakerProfileHistory } from "./speaker-profile-revision.server";

export type ProfileRow = {
  id: string;
  email: string;
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

export type SessionRow = {
  id: string;
  title: string;
  description: string | null;
  format: string;
  durationMinutes: number;
  status: string;
  roleLabel: string | null;
  trackName: string | null;
  participationStatus: "pending" | "confirmed" | "declined";
  participationRevision: number;
  participationConfirmedAt: number | null;
  participationDeclinedAt: number | null;
  participationDeclineReason: string | null;
  startsAt: number | null;
  endsAt: number | null;
  roomName: string | null;
  sessionDetailsReviewTaskId: string | null;
};

export type FileRow = {
  id: string;
  kind: string;
  targetType: string;
  targetId: string;
  status: string;
  currentVersionId: string | null;
  filename: string | null;
  sizeBytes: number | null;
  uploadStatus: string | null;
  signatureStatus: string | null;
  scanStatus: string | null;
  versionNumber: number | null;
  releasedAt: number | null;
  downloadFilename: string | null;
  downloadReleasedAt: number | null;
  downloadUploadedAt: number | null;
  downloadUploaderName: string | null;
  taskTitle: string | null;
  sessionTitle: string | null;
};

export class SpeakerPortalService {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly airtable: AirtableProviderBoundary,
  ) {}

  private async assertParticipant(viewer: Viewer) {
    const membership = await this.env.DB.prepare(
      `
      SELECT 1 AS allowed
        FROM memberships membership
        JOIN events event
          ON event.id = membership.event_id
         AND event.organisation_id = membership.organisation_id
       WHERE membership.event_id = ? AND membership.organisation_id = ?
         AND membership.person_id = ?
         AND membership.role IN ('speaker', 'submitter')
         AND membership.accepted_at IS NOT NULL
         AND membership.revoked_at IS NULL
       LIMIT 1
    `,
    )
      .bind(viewer.eventId, viewer.organisationId, viewer.personId)
      .first();
    if (!membership)
      throw new Response("A current participant membership is required.", {
        status: 403,
      });
  }

  async getPortal(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    await this.assertParticipant(viewer);
    const [profile, event, sessions, files, profileHistory] = await Promise.all(
      [
        this.env.DB.prepare(
          `
        SELECT id, email, display_name AS name, biography, pronunciation,
               organisation_name AS organisationName, job_title AS jobTitle,
               linkedin_url AS linkedinUrl, x_handle AS xHandle,
               event_profile.travel_preferences AS travelPreferences,
               profile_status AS profileStatus, profile_revision AS revision
          FROM people person
          LEFT JOIN event_participant_profiles event_profile
            ON event_profile.event_id = ?
           AND event_profile.organisation_id = ?
           AND event_profile.person_id = person.id
         WHERE person.id = ?
      `,
        )
          .bind(viewer.eventId, viewer.organisationId, viewer.personId)
          .first<ProfileRow>(),
        this.env.DB.prepare(
          `
        SELECT name, slug, timezone, starts_at AS startsAt, ends_at AS endsAt,
               revision,
               venue_name AS venue, city, brand_accent AS brandAccent,
               CASE WHEN brand_logo_asset_id IS NOT NULL
                 THEN '/public/brand/' || slug || '/logo'
                 ELSE participant_logo_url
               END AS participantLogoUrl,
               participant_welcome_text AS participantWelcomeText,
               participant_support_url AS participantSupportUrl,
               file_policy_json AS filePolicyJson
          FROM events WHERE id = ? AND organisation_id = ?
      `,
        )
          .bind(viewer.eventId, viewer.organisationId)
          .first<{
            name: string;
            slug: string;
            timezone: string;
            startsAt: number;
            endsAt: number;
            revision: number;
            venue: string | null;
            city: string | null;
            brandAccent: string;
            participantLogoUrl: string | null;
            participantWelcomeText: string | null;
            participantSupportUrl: string | null;
            filePolicyJson: string;
          }>(),
        this.env.DB.prepare(
          `
        SELECT s.id, s.title, s.description, s.format, s.duration_minutes AS durationMinutes,
               s.status, ss.role_label AS roleLabel,
               track.name AS trackName,
               ss.participation_status AS participationStatus,
               ss.participation_revision AS participationRevision,
               ss.participation_confirmed_at AS participationConfirmedAt,
               ss.participation_declined_at AS participationDeclinedAt,
               ss.participation_decline_reason AS participationDeclineReason,
               se.starts_at AS startsAt,
               se.ends_at AS endsAt, r.name AS roomName,
               (SELECT task.id
                 FROM task_instances task
                 WHERE task.event_id = s.event_id
                   AND task.target_type = 'session'
                   AND task.target_id = s.id
                   AND ${canonicalSessionDetailsReviewTaskSql("task")}
                   AND s.status NOT IN ('cancelled','archived')
                 ORDER BY task.created_at DESC, task.id DESC LIMIT 1
               ) AS sessionDetailsReviewTaskId,
               (SELECT COUNT(*)
                  FROM task_instances task
                 WHERE task.event_id = s.event_id
                   AND task.target_type = 'session'
                   AND task.target_id = s.id
                   AND json_extract(task.configuration_json, '$.preset') = 'session_details_review_v1'
                   AND s.status NOT IN ('cancelled','archived')
               ) AS sessionDetailsReviewTaskCount
          FROM session_speakers ss
          JOIN sessions s ON s.id = ss.session_id AND s.event_id = ss.event_id
          LEFT JOIN tracks track ON track.id = s.track_id AND track.event_id = s.event_id
          LEFT JOIN schedule_versions sv ON sv.event_id = s.event_id AND sv.status = 'published'
          LEFT JOIN schedule_entries se ON se.schedule_version_id = sv.id AND se.session_id = s.id
          LEFT JOIN rooms r ON r.id = se.room_id AND r.event_id = s.event_id
         WHERE ss.event_id = ? AND ss.person_id = ? AND s.status <> 'archived'
         ORDER BY se.starts_at IS NULL, se.starts_at, s.title
      `,
        )
          .bind(viewer.eventId, viewer.personId)
          .all<SessionRow & { sessionDetailsReviewTaskCount: number }>(),
        this.env.DB.prepare(
          `
        SELECT fa.id, fa.asset_kind AS kind,
               fa.target_type AS targetType, fa.target_id AS targetId,
               fa.status,
               fv.original_filename AS filename, fv.size_bytes AS sizeBytes,
               fv.upload_status AS uploadStatus, fv.signature_status AS signatureStatus,
               fv.scan_status AS scanStatus, fv.version_number AS versionNumber,
               fv.released_at AS releasedAt,
               fa.current_version_id AS assetCurrentVersionId,
               asset_current.id AS resolvedCurrentVersionId,
               download.id AS currentVersionId,
               download.original_filename AS downloadFilename,
               download.released_at AS downloadReleasedAt,
               download.uploaded_at AS downloadUploadedAt,
               NULLIF(TRIM(uploader.display_name), '') AS downloadUploaderName,
               task.title AS taskTitle,
               task_session.title AS sessionTitle
          FROM file_assets fa
          LEFT JOIN task_instances task
            ON fa.target_type = 'task'
           AND task.id = fa.target_id
           AND task.event_id = fa.event_id
          LEFT JOIN sessions task_session
            ON task.target_type = 'session'
           AND task_session.id = task.target_id
           AND task_session.event_id = task.event_id
          LEFT JOIN file_versions fv ON fv.id = (
            SELECT id FROM file_versions candidate
             WHERE candidate.asset_id = fa.id
               AND candidate.event_id = fa.event_id
               AND candidate.deleted_at IS NULL
               AND (
                 candidate.created_by_person_id = ?
                 OR NOT (
                   fa.target_type = 'task'
                   AND fa.asset_kind = 'task_evidence'
                   AND task.task_type = 'file_upload'
                   AND task.target_type = 'session'
                   AND json_valid(task.configuration_json)
                   AND json_extract(task.configuration_json, '$.fileScope') = 'session_deliverable'
                 )
                 OR EXISTS (
                   SELECT 1 FROM task_evidence attached
                    WHERE attached.event_id = fa.event_id
                      AND attached.task_id = fa.target_id
                      AND attached.file_asset_id = fa.id
                      AND attached.status IN ('submitted','approved','superseded')
                      AND CASE WHEN json_valid(attached.evidence_json)
                            THEN json_extract(attached.evidence_json, '$.fileVersionId')
                          END = candidate.id
                 )
               )
               ORDER BY candidate.version_number DESC LIMIT 1
          )
          LEFT JOIN file_versions asset_current
            ON asset_current.id = fa.current_version_id
           AND asset_current.event_id = fa.event_id
           AND asset_current.asset_id = fa.id
           AND asset_current.deleted_at IS NULL
          LEFT JOIN file_versions download ON download.id = (
            SELECT id FROM file_versions candidate
             WHERE candidate.asset_id = fa.id
               AND candidate.event_id = fa.event_id
               AND candidate.deleted_at IS NULL
               AND candidate.upload_status = 'uploaded'
               AND candidate.signature_status = 'valid'
               AND candidate.scan_status = 'clean'
               AND candidate.released_at IS NOT NULL
               AND (
                 (
                   fa.target_type = 'person'
                   AND fa.asset_kind = 'headshot'
                   AND fa.owner_person_id = ?
                   AND candidate.id = fa.current_version_id
                 )
                 OR (
                   fa.target_type = 'submission'
                   AND fa.owner_person_id = ?
                   AND candidate.id = fa.current_version_id
                   AND EXISTS (
                     SELECT 1 FROM submissions submission
                      WHERE submission.id = fa.target_id
                        AND submission.event_id = fa.event_id
                        AND submission.submitter_person_id = ?
                   )
                 )
                 OR (
                   fa.target_type = 'task'
                   AND fa.asset_kind = 'task_evidence'
                   AND EXISTS (
                     SELECT 1 FROM task_evidence attached
                      WHERE attached.event_id = fa.event_id
                        AND attached.task_id = fa.target_id
                        AND attached.file_asset_id = fa.id
                        AND attached.status IN ('submitted','approved','superseded')
                        AND CASE WHEN json_valid(attached.evidence_json)
                              THEN json_extract(attached.evidence_json, '$.fileVersionId')
                            END = candidate.id
                   )
                 )
               )
             ORDER BY candidate.version_number DESC LIMIT 1
          )
          LEFT JOIN people uploader ON uploader.id = download.created_by_person_id
         WHERE fa.event_id = ? AND fa.status <> 'deleted'
           AND (
             (
               fa.owner_person_id = ?
               AND NOT (
                 fa.target_type = 'task'
                 AND fa.asset_kind = 'task_evidence'
                 AND task.task_type = 'file_upload'
                 AND task.target_type = 'session'
                 AND json_valid(task.configuration_json)
                 AND json_extract(task.configuration_json, '$.fileScope') = 'session_deliverable'
               )
             )
             OR (
               fa.target_type = 'task'
               AND fa.asset_kind = 'task_evidence'
               AND task.task_type = 'file_upload'
               AND task.target_type = 'session'
               AND json_valid(task.configuration_json)
               AND json_extract(task.configuration_json, '$.fileScope') = 'session_deliverable'
               AND (fv.id IS NOT NULL OR fa.owner_person_id = ?)
               AND EXISTS (
                 SELECT 1
                   FROM session_speakers relation
                  WHERE relation.event_id = task.event_id
                    AND relation.session_id = task.target_id
                    AND relation.person_id = ?
                    AND relation.participation_status IN ('pending','confirmed')
               )
             )
           )
         ORDER BY fa.updated_at DESC
      `,
        )
          .bind(
            viewer.personId,
            viewer.personId,
            viewer.personId,
            viewer.personId,
            viewer.eventId,
            viewer.personId,
            viewer.personId,
            viewer.personId,
          )
          .all<
            FileRow & {
              assetCurrentVersionId: string | null;
              resolvedCurrentVersionId: string | null;
            }
          >(),
        readSpeakerProfileHistory(this.env, {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          personId: viewer.personId,
        }),
      ],
    );
    if (!profile || !event)
      throw new Response("Speaker workspace not found.", { status: 404 });
    const duplicateSessionReview = sessions.results.find(
      (session) => session.sessionDetailsReviewTaskCount > 1,
    );
    if (duplicateSessionReview) {
      throw new Error(
        `Session ${duplicateSessionReview.id} has duplicate session-details review tasks.`,
      );
    }
    const driftedSessionReview = sessions.results.find(
      (session) =>
        session.sessionDetailsReviewTaskCount === 1 &&
        session.sessionDetailsReviewTaskId === null,
    );
    if (driftedSessionReview) {
      throw new Error(
        `Session ${driftedSessionReview.id} has a session-details review task that differs from the required shared acknowledgement.`,
      );
    }
    const fileWithUnavailableCurrentVersion = files.results.find(
      (file) =>
        file.assetCurrentVersionId !== null &&
        file.resolvedCurrentVersionId !== file.assetCurrentVersionId,
    );
    if (fileWithUnavailableCurrentVersion) {
      throw new Error(
        `File asset ${fileWithUnavailableCurrentVersion.id} references unavailable current version ${fileWithUnavailableCurrentVersion.assetCurrentVersionId}.`,
      );
    }
    const releasedFileWithoutProvenance = files.results.find(
      (file) =>
        file.currentVersionId !== null &&
        file.downloadReleasedAt !== null &&
        (file.downloadFilename === null ||
          file.downloadUploadedAt === null ||
          file.downloadUploaderName === null),
    );
    if (releasedFileWithoutProvenance) {
      throw new Error(
        `Released file ${releasedFileWithoutProvenance.id} is missing upload provenance.`,
      );
    }
    const assetIds = files.results.map((file) => file.id);
    const versionRows = assetIds.length
      ? await this.env.DB.prepare(
          `
          SELECT version.id, version.asset_id AS assetId,
                 version.version_number AS versionNumber,
                 version.original_filename AS filename,
                 version.size_bytes AS sizeBytes,
                 version.upload_status AS uploadStatus,
                 version.signature_status AS signatureStatus,
                 version.scan_status AS scanStatus,
                 version.created_at AS createdAt,
                 version.released_at AS releasedAt
            FROM file_versions version
            JOIN file_assets asset
              ON asset.id = version.asset_id AND asset.event_id = version.event_id
            LEFT JOIN task_instances task
              ON asset.target_type = 'task'
             AND task.id = asset.target_id AND task.event_id = asset.event_id
           WHERE version.asset_id IN (${assetIds.map(() => "?").join(",")})
             AND asset.event_id = ? AND version.deleted_at IS NULL
             AND (
               (
                 asset.owner_person_id = ?
                 AND NOT (
                   asset.target_type = 'task'
                   AND asset.asset_kind = 'task_evidence'
                   AND task.task_type = 'file_upload'
                   AND task.target_type = 'session'
                   AND json_valid(task.configuration_json)
                   AND json_extract(task.configuration_json, '$.fileScope') = 'session_deliverable'
                 )
               )
               OR (
                 asset.target_type = 'task'
                 AND asset.asset_kind = 'task_evidence'
                 AND task.task_type = 'file_upload'
                 AND task.target_type = 'session'
                 AND json_valid(task.configuration_json)
                 AND json_extract(task.configuration_json, '$.fileScope') = 'session_deliverable'
                 AND EXISTS (
                   SELECT 1 FROM session_speakers relation
                   WHERE relation.event_id = task.event_id
                      AND relation.session_id = task.target_id
                      AND relation.person_id = ?
                      AND relation.participation_status IN ('pending','confirmed')
                 )
                 AND (
                   version.created_by_person_id = ?
                   OR EXISTS (
                     SELECT 1 FROM task_evidence attached
                      WHERE attached.event_id = asset.event_id
                        AND attached.task_id = asset.target_id
                        AND attached.file_asset_id = asset.id
                        AND attached.status IN ('submitted','approved','superseded')
                        AND CASE WHEN json_valid(attached.evidence_json)
                              THEN json_extract(attached.evidence_json, '$.fileVersionId')
                            END = version.id
                   )
                 )
               )
             )
           ORDER BY version.asset_id, version.version_number DESC
        `,
        )
          .bind(
            ...assetIds,
            viewer.eventId,
            viewer.personId,
            viewer.personId,
            viewer.personId,
          )
          .all<{
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
          }>()
      : { results: [] };
    const { filePolicyJson, slug: _eventSlug, ...eventSummary } = event;
    const hasRealHeadshotAsset = files.results.some(
      (file) =>
        file.kind === "headshot" &&
        file.targetType === "person" &&
        file.targetId === profile.id &&
        file.status !== "deleted",
    );
    const programmePortraitUrl = hasRealHeadshotAsset
      ? null
      : new PublishedHeadshotService(this.env).bundledFixtureHeadshot(
          { id: viewer.eventId },
          viewer.personId,
        );
    return {
      profile: {
        ...profile,
        programmePortraitUrl,
      },
      profileHistory,
      event: {
        ...eventSummary,
        filePolicy: parseEventFilePolicy(filePolicyJson),
      },
      sessions: sessions.results.map(
        ({ sessionDetailsReviewTaskCount: _taskCount, ...session }) => session,
      ),
      files: files.results.map(
        ({
          assetCurrentVersionId: _assetCurrentVersionId,
          resolvedCurrentVersionId: _resolvedCurrentVersionId,
          ...file
        }) => ({
          ...file,
          versions: versionRows.results.filter(
            (version) => version.assetId === file.id,
          ),
        }),
      ),
    };
  }
}
