-- Featured speakers are stored as person IDs. Hiding or deleting the last
-- public published-programme relationship must fail before the live site 500s.
CREATE TRIGGER prevent_referenced_public_speaker_relationship_visibility_change
BEFORE UPDATE OF visibility ON session_speakers
WHEN OLD.visibility = 'public'
 AND NEW.visibility <> 'public'
 AND EXISTS (
   SELECT 1 FROM event_public_site_references reference
    WHERE reference.event_id = OLD.event_id
      AND reference.kind = 'speaker'
      AND reference.record_id = OLD.person_id
 )
 AND EXISTS (
   SELECT 1
     FROM sessions session
     JOIN schedule_versions version
       ON version.event_id = session.event_id
      AND version.status = 'published'
     JOIN schedule_entries entry
       ON entry.event_id = session.event_id
      AND entry.schedule_version_id = version.id
      AND entry.session_id = session.id
     JOIN schedule_session_contents content
       ON content.event_id = entry.event_id
      AND content.schedule_version_id = entry.schedule_version_id
      AND content.session_id = entry.session_id
      AND content.visibility = 'public'
     JOIN people person
       ON person.id = OLD.person_id
      AND person.profile_status = 'published'
    WHERE session.id = OLD.session_id
      AND session.event_id = OLD.event_id
      AND session.status = 'published'
      AND session.visibility = 'public'
 )
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
    WHERE alternative_relation.event_id = OLD.event_id
      AND alternative_relation.person_id = OLD.person_id
      AND alternative_relation.session_id <> OLD.session_id
      AND alternative_relation.visibility = 'public'
 )
BEGIN
  SELECT RAISE(
    ABORT,
    'Remove this featured speaker from published event sites before hiding or removing their final public session relationship'
  );
END;

CREATE TRIGGER prevent_referenced_public_speaker_relationship_delete
BEFORE DELETE ON session_speakers
WHEN OLD.visibility = 'public'
 AND EXISTS (
   SELECT 1 FROM event_public_site_references reference
    WHERE reference.event_id = OLD.event_id
      AND reference.kind = 'speaker'
      AND reference.record_id = OLD.person_id
 )
 AND EXISTS (
   SELECT 1
     FROM sessions session
     JOIN schedule_versions version
       ON version.event_id = session.event_id
      AND version.status = 'published'
     JOIN schedule_entries entry
       ON entry.event_id = session.event_id
      AND entry.schedule_version_id = version.id
      AND entry.session_id = session.id
     JOIN schedule_session_contents content
       ON content.event_id = entry.event_id
      AND content.schedule_version_id = entry.schedule_version_id
      AND content.session_id = entry.session_id
      AND content.visibility = 'public'
     JOIN people person
       ON person.id = OLD.person_id
      AND person.profile_status = 'published'
    WHERE session.id = OLD.session_id
      AND session.event_id = OLD.event_id
      AND session.status = 'published'
      AND session.visibility = 'public'
 )
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
    WHERE alternative_relation.event_id = OLD.event_id
      AND alternative_relation.person_id = OLD.person_id
      AND alternative_relation.session_id <> OLD.session_id
      AND alternative_relation.visibility = 'public'
 )
BEGIN
  SELECT RAISE(
    ABORT,
    'Remove this featured speaker from published event sites before hiding or removing their final public session relationship'
  );
END;
