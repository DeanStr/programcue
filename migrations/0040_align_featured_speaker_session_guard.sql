-- Align session hide with 0039 and the current public speaker projection.
-- This is live-mutation consistency, not stronger publication protection.
DROP TRIGGER IF EXISTS prevent_referenced_public_session_eligibility_change;

CREATE TRIGGER prevent_referenced_public_session_eligibility_change
BEFORE UPDATE OF status, visibility ON sessions
WHEN OLD.status = 'published'
 AND (
   NEW.status <> 'published'
   OR (OLD.visibility = 'public' AND NEW.visibility <> 'public')
 )
 AND (
   EXISTS (
     SELECT 1 FROM event_public_site_references reference
      WHERE reference.event_id = OLD.event_id
        AND reference.kind = 'session'
        AND reference.record_id = OLD.id
   )
   OR EXISTS (
     SELECT 1 FROM event_public_site_references reference
     JOIN session_speakers relation
       ON relation.event_id = reference.event_id
      AND relation.person_id = reference.record_id
      AND relation.session_id = OLD.id
      AND relation.visibility = 'public'
     JOIN schedule_versions current_version
       ON current_version.event_id = OLD.event_id
      AND current_version.status = 'published'
     JOIN schedule_entries current_entry
       ON current_entry.event_id = OLD.event_id
      AND current_entry.schedule_version_id = current_version.id
      AND current_entry.session_id = OLD.id
     JOIN schedule_session_contents current_content
       ON current_content.event_id = current_entry.event_id
      AND current_content.schedule_version_id = current_entry.schedule_version_id
      AND current_content.session_id = current_entry.session_id
      AND current_content.visibility = 'public'
     JOIN people current_person
       ON current_person.id = relation.person_id
      AND current_person.profile_status = 'published'
    WHERE reference.event_id = OLD.event_id
      AND reference.kind = 'speaker'
      AND OLD.visibility = 'public'
      AND NOT EXISTS (
        SELECT 1
          FROM session_speakers alternative_relation
          JOIN sessions alternative_session
            ON alternative_session.id = alternative_relation.session_id
           AND alternative_session.event_id = alternative_relation.event_id
           AND alternative_session.status = 'published'
           AND alternative_session.visibility = 'public'
          JOIN schedule_versions version
            ON version.event_id = alternative_session.event_id
           AND version.status = 'published'
          JOIN schedule_entries entry
            ON entry.event_id = version.event_id
           AND entry.schedule_version_id = version.id
           AND entry.session_id = alternative_session.id
          JOIN schedule_session_contents content
            ON content.event_id = entry.event_id
           AND content.schedule_version_id = entry.schedule_version_id
           AND content.session_id = entry.session_id
           AND content.visibility = 'public'
          JOIN people person
            ON person.id = alternative_relation.person_id
           AND person.profile_status = 'published'
         WHERE alternative_relation.event_id = reference.event_id
           AND alternative_relation.person_id = reference.record_id
           AND alternative_relation.session_id <> OLD.id
           AND alternative_relation.visibility = 'public'
      )
   )
   OR EXISTS (
     SELECT 1 FROM event_session_recordings recording
      WHERE recording.event_id = OLD.event_id
        AND recording.session_id = OLD.id
        AND recording.published_at IS NOT NULL
   )
 )
BEGIN
  SELECT RAISE(ABORT, 'Withdraw public-site references and recordings before changing this published session eligibility');
END;
