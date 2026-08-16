export async function validatePublishedSiteReferencesForSchedule(
  env: CloudflareEnvironment,
  input: {
    eventId: string;
    organisationId: string;
    scheduleVersionId: string;
  },
) {
  const invalid = await env.DB.prepare(
    `SELECT reference.kind, reference.record_id AS recordId,
            CASE reference.kind
              WHEN 'session' THEN (
                SELECT COALESCE(content.title, session.title)
                  FROM sessions session
                  LEFT JOIN schedule_session_contents content
                    ON content.event_id = session.event_id
                   AND content.session_id = session.id
                   AND content.schedule_version_id = ?
                 WHERE session.id = reference.record_id
                   AND session.event_id = reference.event_id
              )
              ELSE (
                SELECT display_name FROM people WHERE id = reference.record_id
              )
            END AS label
       FROM event_public_site_references reference
      WHERE reference.event_id = ? AND reference.organisation_id = ?
        AND (
          (
            reference.kind = 'session' AND NOT EXISTS (
              SELECT 1
                FROM schedule_entries entry
                JOIN sessions session
                  ON session.id = entry.session_id
                 AND session.event_id = entry.event_id
                JOIN schedule_session_contents content
                  ON content.event_id = entry.event_id
                 AND content.schedule_version_id = entry.schedule_version_id
                 AND content.session_id = entry.session_id
               WHERE entry.event_id = reference.event_id
                 AND entry.schedule_version_id = ?
                 AND entry.session_id = reference.record_id
                 AND session.visibility = 'public'
                 AND content.visibility = 'public'
                 AND content.content_status = 'approved'
            )
          )
          OR
          (
            reference.kind = 'speaker' AND NOT EXISTS (
              SELECT 1
                FROM schedule_entries entry
                JOIN sessions session
                  ON session.id = entry.session_id
                 AND session.event_id = entry.event_id
                JOIN schedule_session_contents content
                  ON content.event_id = entry.event_id
                 AND content.schedule_version_id = entry.schedule_version_id
                 AND content.session_id = entry.session_id
                JOIN session_speakers relation
                  ON relation.event_id = entry.event_id
                 AND relation.session_id = entry.session_id
                JOIN people person
                  ON person.id = relation.person_id
               WHERE entry.event_id = reference.event_id
                 AND entry.schedule_version_id = ?
                 AND relation.person_id = reference.record_id
                 AND session.visibility = 'public'
                 AND content.visibility = 'public'
                 AND content.content_status = 'approved'
                 AND relation.visibility = 'public'
                 AND relation.participation_status = 'confirmed'
                 AND person.profile_status = 'published'
            )
          )
        )
      ORDER BY reference.kind, reference.record_id
      LIMIT 1`,
  )
    .bind(
      input.scheduleVersionId,
      input.eventId,
      input.organisationId,
      input.scheduleVersionId,
      input.scheduleVersionId,
    )
    .first<{
      kind: "session" | "speaker";
      recordId: string;
      label: string | null;
    }>();
  if (invalid) {
    const label = invalid.label?.trim() || invalid.recordId;
    return `The public event home features ${invalid.kind} “${label}”, which is not eligible for this programme version. Update and publish the public site before publishing this schedule.`;
  }

  const invalidRecording = await env.DB.prepare(
    `SELECT recording.id, recording.published_title AS title,
            recording.session_id AS sessionId
       FROM event_session_recordings recording
      WHERE recording.event_id = ? AND recording.organisation_id = ?
        AND recording.published_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
            FROM schedule_entries entry
            JOIN sessions session
              ON session.id = entry.session_id
             AND session.event_id = entry.event_id
            JOIN schedule_session_contents content
              ON content.event_id = entry.event_id
             AND content.schedule_version_id = entry.schedule_version_id
             AND content.session_id = entry.session_id
           WHERE entry.event_id = recording.event_id
             AND entry.schedule_version_id = ?
             AND entry.session_id = recording.session_id
             AND session.visibility = 'public'
             AND content.visibility = 'public'
             AND content.content_status = 'approved'
        )
      ORDER BY recording.published_title, recording.id
      LIMIT 1`,
  )
    .bind(input.eventId, input.organisationId, input.scheduleVersionId)
    .first<{ id: string; title: string; sessionId: string }>();
  if (!invalidRecording) return null;
  return `Published recording “${invalidRecording.title}” belongs to a session that is not eligible for this programme version. Withdraw the recording before publishing this schedule.`;
}

export const PUBLIC_SITE_SCHEDULE_ATOMIC_GUARD = `
  AND NOT EXISTS (
    SELECT 1
      FROM event_public_site_references reference
     WHERE reference.event_id = ? AND reference.organisation_id = ?
       AND (
         (
           reference.kind = 'session' AND NOT EXISTS (
             SELECT 1
               FROM schedule_entries site_entry
               JOIN sessions site_session
                 ON site_session.id = site_entry.session_id
                AND site_session.event_id = site_entry.event_id
               JOIN schedule_session_contents site_content
                 ON site_content.event_id = site_entry.event_id
                AND site_content.schedule_version_id = site_entry.schedule_version_id
                AND site_content.session_id = site_entry.session_id
              WHERE site_entry.event_id = reference.event_id
                AND site_entry.schedule_version_id = ?
                AND site_entry.session_id = reference.record_id
                AND site_session.visibility = 'public'
                AND site_content.visibility = 'public'
                AND site_content.content_status = 'approved'
           )
         )
         OR
         (
           reference.kind = 'speaker' AND NOT EXISTS (
             SELECT 1
               FROM schedule_entries site_entry
               JOIN sessions site_session
                 ON site_session.id = site_entry.session_id
                AND site_session.event_id = site_entry.event_id
               JOIN schedule_session_contents site_content
                 ON site_content.event_id = site_entry.event_id
                AND site_content.schedule_version_id = site_entry.schedule_version_id
                AND site_content.session_id = site_entry.session_id
               JOIN session_speakers site_relation
                 ON site_relation.event_id = site_entry.event_id
                AND site_relation.session_id = site_entry.session_id
               JOIN people site_person ON site_person.id = site_relation.person_id
              WHERE site_entry.event_id = reference.event_id
                AND site_entry.schedule_version_id = ?
                AND site_relation.person_id = reference.record_id
                AND site_session.visibility = 'public'
                AND site_content.visibility = 'public'
                AND site_content.content_status = 'approved'
                AND site_relation.visibility = 'public'
                AND site_relation.participation_status = 'confirmed'
                AND site_person.profile_status = 'published'
           )
         )
       )
  )
  AND NOT EXISTS (
    SELECT 1
      FROM event_session_recordings site_recording
     WHERE site_recording.event_id = ?
       AND site_recording.organisation_id = ?
       AND site_recording.published_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1
           FROM schedule_entries site_recording_entry
           JOIN sessions site_recording_session
             ON site_recording_session.id = site_recording_entry.session_id
            AND site_recording_session.event_id = site_recording_entry.event_id
           JOIN schedule_session_contents site_recording_content
             ON site_recording_content.event_id = site_recording_entry.event_id
            AND site_recording_content.schedule_version_id = site_recording_entry.schedule_version_id
            AND site_recording_content.session_id = site_recording_entry.session_id
          WHERE site_recording_entry.event_id = site_recording.event_id
            AND site_recording_entry.schedule_version_id = ?
            AND site_recording_entry.session_id = site_recording.session_id
            AND site_recording_session.visibility = 'public'
            AND site_recording_content.visibility = 'public'
            AND site_recording_content.content_status = 'approved'
       )
  )`;
