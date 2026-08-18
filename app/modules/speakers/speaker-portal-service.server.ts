import type { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";
import { parseEventFilePolicy } from "~/modules/files/file-policy";
import { PublishedHeadshotService } from "~/modules/programme/published-headshot-service.server";
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
  participationStatus: "pending" | "confirmed";
  participationConfirmedAt: number | null;
  startsAt: number | null;
  endsAt: number | null;
  roomName: string | null;
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
               ss.participation_status AS participationStatus,
               ss.participation_confirmed_at AS participationConfirmedAt,
               se.starts_at AS startsAt,
               se.ends_at AS endsAt, r.name AS roomName
          FROM session_speakers ss
          JOIN sessions s ON s.id = ss.session_id AND s.event_id = ss.event_id
          LEFT JOIN schedule_versions sv ON sv.event_id = s.event_id AND sv.status = 'published'
          LEFT JOIN schedule_entries se ON se.schedule_version_id = sv.id AND se.session_id = s.id
          LEFT JOIN rooms r ON r.id = se.room_id AND r.event_id = s.event_id
         WHERE ss.event_id = ? AND ss.person_id = ? AND s.status <> 'archived'
         ORDER BY se.starts_at IS NULL, se.starts_at, s.title
      `,
        )
          .bind(viewer.eventId, viewer.personId)
          .all<SessionRow>(),
        this.env.DB.prepare(
          `
        SELECT fa.id, fa.asset_kind AS kind,
               fa.target_type AS targetType, fa.target_id AS targetId,
               fa.status,
               fv.original_filename AS filename, fv.size_bytes AS sizeBytes,
               fv.upload_status AS uploadStatus, fv.signature_status AS signatureStatus,
               fv.scan_status AS scanStatus, fv.version_number AS versionNumber,
               fv.released_at AS releasedAt, fa.current_version_id AS currentVersionId,
               current.id AS resolvedCurrentVersionId,
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
          .bind(viewer.eventId, viewer.personId)
          .all<FileRow & { resolvedCurrentVersionId: string | null }>(),
        readSpeakerProfileHistory(this.env, {
          organisationId: viewer.organisationId,
          eventId: viewer.eventId,
          personId: viewer.personId,
        }),
      ],
    );
    if (!profile || !event)
      throw new Response("Speaker workspace not found.", { status: 404 });
    const fileWithUnavailableCurrentVersion = files.results.find(
      (file) =>
        file.currentVersionId !== null &&
        file.resolvedCurrentVersionId !== file.currentVersionId,
    );
    if (fileWithUnavailableCurrentVersion) {
      throw new Error(
        `File asset ${fileWithUnavailableCurrentVersion.id} references unavailable current version ${fileWithUnavailableCurrentVersion.currentVersionId}.`,
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
          SELECT id, asset_id AS assetId, version_number AS versionNumber,
                 original_filename AS filename, size_bytes AS sizeBytes,
                 upload_status AS uploadStatus, signature_status AS signatureStatus,
                 scan_status AS scanStatus, created_at AS createdAt, released_at AS releasedAt
            FROM file_versions
           WHERE asset_id IN (${assetIds.map(() => "?").join(",")}) AND deleted_at IS NULL
           ORDER BY asset_id, version_number DESC
        `,
        )
          .bind(...assetIds)
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
    const hasReleasedHeadshot = files.results.some(
      (file) => file.kind === "headshot" && file.releasedAt,
    );
    const programmePortraitUrl = hasReleasedHeadshot
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
      sessions: sessions.results,
      files: files.results.map(
        ({ resolvedCurrentVersionId: _resolvedCurrentVersionId, ...file }) => ({
          ...file,
          versions: versionRows.results.filter(
            (version) => version.assetId === file.id,
          ),
        }),
      ),
    };
  }
}
