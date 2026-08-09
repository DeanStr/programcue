import { z } from "zod";

import type { Viewer } from "~/platform/auth/authorize.server";
import { speakerProfileSchema } from "./speaker-schema";

export class SpeakerProfileConflictError extends Error {
  constructor() {
    super(
      "Your profile changed after this page loaded. Refresh before saving again.",
    );
    this.name = "SpeakerProfileConflictError";
  }
}

type ProfileRow = {
  id: string;
  email: string;
  name: string;
  biography: string | null;
  pronunciation: string | null;
  organisationName: string | null;
  jobTitle: string | null;
  profileStatus: "draft" | "published" | "archived";
  revision: number;
};

type SessionRow = {
  id: string;
  title: string;
  description: string | null;
  format: string;
  durationMinutes: number;
  status: string;
  roleLabel: string | null;
  startsAt: number | null;
  endsAt: number | null;
  roomName: string | null;
};

type FileRow = {
  id: string;
  kind: string;
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
};

export class SpeakerService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async assertSpeaker(viewer: Viewer) {
    const membership = await this.env.DB.prepare(
      `
      SELECT 1 AS allowed
        FROM memberships
       WHERE event_id = ? AND person_id = ? AND role = 'speaker'
         AND accepted_at IS NOT NULL AND revoked_at IS NULL
       LIMIT 1
    `,
    )
      .bind(viewer.eventId, viewer.personId)
      .first();
    if (!membership)
      throw new Response("A current speaker membership is required.", {
        status: 403,
      });
  }

  async getPortal(viewer: Viewer) {
    await this.assertSpeaker(viewer);
    const [profile, event, sessions, files] = await Promise.all([
      this.env.DB.prepare(
        `
        SELECT id, email, display_name AS name, biography, pronunciation,
               organisation_name AS organisationName, job_title AS jobTitle,
               profile_status AS profileStatus, profile_revision AS revision
          FROM people WHERE id = ?
      `,
      )
        .bind(viewer.personId)
        .first<ProfileRow>(),
      this.env.DB.prepare(
        `
        SELECT name, timezone, starts_at AS startsAt, ends_at AS endsAt, venue_name AS venue, city
          FROM events WHERE id = ? AND organisation_id = ?
      `,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{
          name: string;
          timezone: string;
          startsAt: number;
          endsAt: number;
          venue: string | null;
          city: string | null;
        }>(),
      this.env.DB.prepare(
        `
        SELECT s.id, s.title, s.description, s.format, s.duration_minutes AS durationMinutes,
               s.status, ss.role_label AS roleLabel, se.starts_at AS startsAt,
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
        SELECT fa.id, fa.asset_kind AS kind, fa.status,
               fv.original_filename AS filename, fv.size_bytes AS sizeBytes,
               fv.upload_status AS uploadStatus, fv.signature_status AS signatureStatus,
               fv.scan_status AS scanStatus, fv.version_number AS versionNumber,
               fv.released_at AS releasedAt, fa.current_version_id AS currentVersionId,
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
           AND current.deleted_at IS NULL
         WHERE fa.event_id = ? AND fa.owner_person_id = ? AND fa.status <> 'deleted'
         ORDER BY fa.updated_at DESC
      `,
      )
        .bind(viewer.eventId, viewer.personId)
        .all<FileRow>(),
    ]);
    if (!profile || !event)
      throw new Response("Speaker workspace not found.", { status: 404 });
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
    return {
      profile,
      event,
      sessions: sessions.results,
      files: files.results.map((file) => ({
        ...file,
        versions: versionRows.results.filter(
          (version) => version.assetId === file.id,
        ),
      })),
    };
  }

  async updateProfile(viewer: Viewer, rawInput: unknown) {
    await this.assertSpeaker(viewer);
    const input = speakerProfileSchema.parse(rawInput);
    const operationId = crypto.randomUUID();
    const [updated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE people
           SET display_name = ?, biography = ?, pronunciation = ?, organisation_name = ?, job_title = ?,
               profile_status = ?, profile_revision = profile_revision + 1,
               last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND profile_revision = ?
           AND EXISTS (
             SELECT 1 FROM memberships
              WHERE event_id = ? AND person_id = people.id AND role = 'speaker'
                AND accepted_at IS NOT NULL AND revoked_at IS NULL
           )
      `,
      ).bind(
        input.name,
        input.biography,
        input.pronunciation || null,
        input.organisationName || null,
        input.jobTitle || null,
        input.publish ? "published" : "draft",
        operationId,
        viewer.personId,
        input.revision,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at
        ) SELECT ?, ?, ?, ?, 'speaker.profile.updated', 'person', ?, ?, ?, unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM people
              WHERE id = ? AND profile_revision = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        viewer.personId,
        operationId,
        JSON.stringify({
          published: input.publish,
          revision: input.revision + 1,
        }),
        viewer.personId,
        input.revision + 1,
        operationId,
      ),
    ]);
    if ((updated.meta.changes ?? 0) !== 1)
      throw new SpeakerProfileConflictError();
  }

  async listAdminSpeakers(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      "SELECT 1 FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!event) throw new Response("Event not found.", { status: 404 });
    const speakers = await this.env.DB.prepare(
      `
      WITH event_speakers AS (
        SELECT DISTINCT p.id, p.display_name, p.email, p.job_title, p.organisation_name,
               p.profile_status, p.profile_revision
          FROM people p
          JOIN session_speakers ss ON ss.person_id = p.id AND ss.event_id = ?
        UNION
        SELECT DISTINCT p.id, p.display_name, p.email, p.job_title, p.organisation_name,
               p.profile_status, p.profile_revision
          FROM people p
          JOIN memberships m ON m.person_id = p.id
         WHERE m.event_id = ? AND m.role = 'speaker' AND m.accepted_at IS NOT NULL AND m.revoked_at IS NULL
      )
      SELECT es.id, es.display_name AS name, es.email, es.job_title AS jobTitle,
             es.organisation_name AS organisationName, es.profile_status AS profileStatus,
             COUNT(DISTINCT ss.session_id) AS sessionCount,
             COUNT(DISTINCT CASE WHEN ti.status NOT IN ('completed','waived') THEN ti.id END) AS outstandingTasks,
             COUNT(DISTINCT CASE WHEN ti.status IN ('completed','waived') THEN ti.id END) AS completedTasks,
             COUNT(DISTINCT CASE
               WHEN fv.upload_status = 'uploaded'
                AND fv.signature_status = 'valid'
                AND fv.scan_status = 'pending'
               THEN fa.id END) AS quarantinedFiles
        FROM event_speakers es
        LEFT JOIN session_speakers ss ON ss.person_id = es.id AND ss.event_id = ?
        LEFT JOIN task_instances ti ON ti.event_id = ? AND (
          (ti.target_type = 'speaker' AND ti.target_id = es.id) OR ti.owner_person_id = es.id
        )
        LEFT JOIN file_assets fa ON fa.event_id = ? AND fa.owner_person_id = es.id AND fa.status <> 'deleted'
        LEFT JOIN file_versions fv ON fv.id = (
          SELECT id FROM file_versions latest WHERE latest.asset_id = fa.id ORDER BY version_number DESC LIMIT 1
        )
       GROUP BY es.id
       ORDER BY outstandingTasks DESC, es.display_name
    `,
    )
      .bind(
        viewer.eventId,
        viewer.eventId,
        viewer.eventId,
        viewer.eventId,
        viewer.eventId,
      )
      .all<{
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
      }>();
    return speakers.results;
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
