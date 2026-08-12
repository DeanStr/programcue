import type { Viewer } from "~/platform/auth/authorize.server";
import { AirtableProviderBoundary } from "~/modules/airtable/airtable-provider-boundary.server";

export type AdminProgrammeRow = {
  id: string;
  title: string;
  status: string;
  visibility: string;
  track: string | null;
  format: string;
  room: string | null;
  startsAt: number | null;
};

type AdminProgrammeQueryRow = AdminProgrammeRow & {
  publishedContentSessionId: string | null;
};

export class ProgrammeAdminService {
  private readonly airtable: AirtableProviderBoundary;

  constructor(
    private readonly env: CloudflareEnvironment,
    dependencies: { airtable?: AirtableProviderBoundary } = {},
  ) {
    this.airtable =
      dependencies.airtable ?? new AirtableProviderBoundary(this.env);
  }

  async getOverview(viewer: Viewer) {
    await this.airtable.assertReadable(viewer);
    const [sessions, version, event, speakerCount] = await Promise.all([
      this.env.DB.prepare(
        `SELECT s.id,
                CASE WHEN se.id IS NULL THEN s.title ELSE content.title END AS title,
                s.status,
                CASE WHEN se.id IS NULL THEN s.visibility ELSE content.visibility END AS visibility,
                CASE WHEN se.id IS NULL THEN source_track.name ELSE published_track.name END AS track,
                CASE WHEN se.id IS NULL THEN s.format ELSE content.format END AS format,
                r.name AS room, se.starts_at AS startsAt,
                content.session_id AS publishedContentSessionId
           FROM sessions s
           JOIN events e ON e.id = s.event_id AND e.organisation_id = ?
           LEFT JOIN schedule_versions sv
             ON sv.event_id = s.event_id AND sv.status = 'published'
            AND sv.version_number = (
              SELECT MAX(current.version_number)
                FROM schedule_versions current
               WHERE current.event_id = s.event_id
                 AND current.status = 'published'
            )
           LEFT JOIN schedule_entries se
             ON se.schedule_version_id = sv.id AND se.session_id = s.id
           LEFT JOIN schedule_session_contents content
             ON content.schedule_version_id = se.schedule_version_id
            AND content.event_id = se.event_id
            AND content.session_id = se.session_id
           LEFT JOIN rooms r ON r.id = se.room_id AND r.event_id = s.event_id
           LEFT JOIN tracks source_track
             ON source_track.id = s.track_id AND source_track.event_id = s.event_id
           LEFT JOIN tracks published_track
             ON published_track.id = content.track_id
            AND published_track.event_id = content.event_id
            AND published_track.is_public = 1
          WHERE s.event_id = ? AND s.status NOT IN ('archived','cancelled')
          ORDER BY se.starts_at IS NULL, se.starts_at, s.title`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .all<AdminProgrammeQueryRow>(),
      this.env.DB.prepare(
        `SELECT version_number AS versionNumber, status,
                published_at AS publishedAt
           FROM schedule_versions
          WHERE event_id = ? AND status = 'published'
          ORDER BY version_number DESC LIMIT 1`,
      )
        .bind(viewer.eventId)
        .first<{
          versionNumber: number;
          status: string;
          publishedAt: number | null;
        }>(),
      this.env.DB.prepare(
        `SELECT name, timezone, slug, brand_accent AS brandAccent FROM events
          WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{
          name: string;
          timezone: string;
          slug: string;
          brandAccent: string;
        }>(),
      this.env.DB.prepare(
        `SELECT COUNT(DISTINCT person.id) AS total
           FROM people person
           JOIN session_speakers speaker ON speaker.person_id = person.id
           JOIN sessions session
             ON session.id = speaker.session_id
            AND session.event_id = speaker.event_id
           JOIN events event
             ON event.id = session.event_id AND event.organisation_id = ?
           JOIN schedule_versions version
             ON version.event_id = session.event_id
            AND version.status = 'published'
            AND version.version_number = (
              SELECT MAX(current.version_number)
                FROM schedule_versions current
               WHERE current.event_id = session.event_id
                 AND current.status = 'published'
            )
           JOIN schedule_entries entry
             ON entry.schedule_version_id = version.id
            AND entry.session_id = session.id
           JOIN schedule_session_contents content
             ON content.schedule_version_id = entry.schedule_version_id
            AND content.event_id = entry.event_id
            AND content.session_id = entry.session_id
          WHERE session.event_id = ? AND person.profile_status = 'published'
            AND session.status = 'published'
            AND content.visibility = 'public'
            AND content.content_status = 'approved'
            AND speaker.visibility = 'public'`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .first<{ total: number }>(),
    ]);
    if (!event) throw new Response("Event not found", { status: 404 });
    const missingPublishedContent = sessions.results.find(
      (session) =>
        session.startsAt !== null && session.publishedContentSessionId === null,
    );
    if (missingPublishedContent) {
      throw new Error(
        `Published session ${missingPublishedContent.id} is missing its immutable content snapshot.`,
      );
    }
    return {
      sessions: sessions.results.map(
        ({
          publishedContentSessionId: _publishedContentSessionId,
          ...session
        }) => session,
      ),
      version,
      timezone: event.timezone,
      eventName: event.name,
      brandAccent: event.brandAccent,
      publicSlug: event.slug,
      speakerCount: Number(speakerCount?.total ?? 0),
    };
  }
}
