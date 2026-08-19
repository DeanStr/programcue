type ScheduleEventScope = { eventId: string };
type ScheduleContentStatus =
  | "draft"
  | "in_review"
  | "approved"
  | "changes_requested";

export class SchedulePublicationReadiness {
  constructor(private readonly env: CloudflareEnvironment) {}

  async findUnconfirmedScheduledSpeaker(
    viewer: ScheduleEventScope,
    scheduleVersionId: string,
  ) {
    return this.env.DB.prepare(
      `SELECT session.title
         FROM schedule_entries entry
         JOIN sessions session
           ON session.id = entry.session_id AND session.event_id = entry.event_id
        WHERE entry.schedule_version_id = ? AND entry.event_id = ?
          AND (
            EXISTS (
              SELECT 1 FROM session_speakers relationship
               WHERE relationship.session_id = session.id
                 AND relationship.event_id = session.event_id
                 AND relationship.participation_status IS NOT 'confirmed'
            )
          )
        ORDER BY session.title COLLATE NOCASE, session.id
        LIMIT 1`,
    )
      .bind(scheduleVersionId, viewer.eventId)
      .first<{ title: string }>();
  }

  async hasMissingScheduledContentSnapshot(
    viewer: ScheduleEventScope,
    scheduleVersionId: string,
  ) {
    const missing = await this.env.DB.prepare(
      `SELECT 1 AS missing
         FROM schedule_entries entry
         LEFT JOIN schedule_session_contents content
           ON content.schedule_version_id = entry.schedule_version_id
          AND content.event_id = entry.event_id
          AND content.session_id = entry.session_id
        WHERE entry.schedule_version_id = ? AND entry.event_id = ?
          AND content.session_id IS NULL
        LIMIT 1`,
    )
      .bind(scheduleVersionId, viewer.eventId)
      .first<{ missing: number }>();
    return missing?.missing === 1;
  }

  async findUnpublishablePublicScheduledContent(
    viewer: ScheduleEventScope,
    scheduleVersionId: string,
  ) {
    return this.env.DB.prepare(
      `SELECT content.title, content.visibility,
              content.content_status AS contentStatus
         FROM schedule_entries entry
         JOIN schedule_session_contents content
           ON content.schedule_version_id = entry.schedule_version_id
          AND content.event_id = entry.event_id
          AND content.session_id = entry.session_id
        WHERE entry.schedule_version_id = ? AND entry.event_id = ?
          AND content.visibility = 'public'
          AND content.content_status <> 'approved'
        ORDER BY content.title COLLATE NOCASE, content.session_id
        LIMIT 1`,
    )
      .bind(scheduleVersionId, viewer.eventId)
      .first<{
        title: string;
        visibility: string;
        contentStatus: ScheduleContentStatus;
      }>();
  }

  publicationContentError(content: {
    title: string;
    visibility: string;
    contentStatus: ScheduleContentStatus;
  }) {
    if (content.visibility !== "public") {
      return `Every public snapshot requires public visibility before publishing. “${content.title}” is ${content.visibility}.`;
    }
    return `Every public snapshot requires an Approved content snapshot before publishing. “${content.title}” is ${content.contentStatus.replaceAll("_", " ")}.`;
  }
}
