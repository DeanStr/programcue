-- Featured-speaker eligibility is a public confirmed relationship plus a
-- published profile. The last such relationship cannot be hidden, deleted,
-- or moved off confirmed while the person remains featured.
CREATE TABLE migration_0042_featured_speaker_guard (
  published_featured_speakers_must_be_confirmed INTEGER NOT NULL
    CHECK (published_featured_speakers_must_be_confirmed = 1)
);

INSERT INTO migration_0042_featured_speaker_guard (
  published_featured_speakers_must_be_confirmed
)
SELECT 0
  FROM event_public_site_references reference
  JOIN event_public_sites site
    ON site.event_id = reference.event_id
   AND site.published_at IS NOT NULL
 WHERE reference.kind = 'speaker'
   AND NOT EXISTS (
     SELECT 1
       FROM session_speakers relation
       JOIN sessions session
         ON session.id = relation.session_id
        AND session.event_id = relation.event_id
       JOIN people person ON person.id = relation.person_id
       JOIN schedule_entries entry
         ON entry.event_id = relation.event_id
        AND entry.session_id = relation.session_id
       JOIN schedule_versions version
         ON version.id = entry.schedule_version_id
        AND version.event_id = entry.event_id
        AND version.status = 'published'
       JOIN schedule_session_contents content
         ON content.event_id = entry.event_id
        AND content.schedule_version_id = entry.schedule_version_id
        AND content.session_id = entry.session_id
        AND content.visibility = 'public'
      WHERE relation.event_id = reference.event_id
        AND relation.person_id = reference.record_id
        AND relation.visibility = 'public'
        AND relation.participation_status = 'confirmed'
        AND person.profile_status = 'published'
        AND session.status = 'published'
        AND session.visibility = 'public'
   )
 LIMIT 1;

DROP TABLE migration_0042_featured_speaker_guard;

INSERT INTO event_changes (
  event_id, entity_type, entity_id, change_type, correlation_id, created_at
)
SELECT DISTINCT event.id, 'event', event.id, 'updated',
       'migration-0042-public-speaker-eligibility', unixepoch()
  FROM events event
  JOIN schedule_versions version
    ON version.event_id = event.id
   AND version.status = 'published'
  JOIN schedule_entries entry
    ON entry.event_id = version.event_id
   AND entry.schedule_version_id = version.id
  JOIN sessions session
    ON session.id = entry.session_id
   AND session.event_id = entry.event_id
   AND session.status = 'published'
   AND session.visibility = 'public'
  JOIN schedule_session_contents content
    ON content.event_id = entry.event_id
   AND content.schedule_version_id = entry.schedule_version_id
   AND content.session_id = entry.session_id
   AND content.visibility = 'public'
  JOIN session_speakers relation
    ON relation.event_id = entry.event_id
   AND relation.session_id = entry.session_id
   AND relation.visibility = 'public'
   AND relation.participation_status = 'pending'
  JOIN people person
    ON person.id = relation.person_id
   AND person.profile_status = 'published'
 WHERE event.programme_published_at IS NOT NULL;

DROP TRIGGER IF EXISTS prevent_referenced_public_speaker_relationship_visibility_change;
DROP TRIGGER IF EXISTS prevent_referenced_public_speaker_relationship_delete;
DROP TRIGGER IF EXISTS prevent_referenced_public_session_eligibility_change;

CREATE TRIGGER prevent_referenced_public_speaker_relationship_visibility_change
BEFORE UPDATE OF visibility, participation_status ON session_speakers
WHEN OLD.visibility = 'public'
 AND OLD.participation_status = 'confirmed'
 AND (
   NEW.visibility <> 'public'
   OR NEW.participation_status <> 'confirmed'
 )
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
      AND alternative_relation.participation_status = 'confirmed'
 )
BEGIN
  SELECT RAISE(
    ABORT,
    'Remove this featured speaker from published event sites before hiding, unconfirming, or removing their final public confirmed session relationship'
  );
END;

CREATE TRIGGER prevent_referenced_public_speaker_relationship_delete
BEFORE DELETE ON session_speakers
WHEN OLD.visibility = 'public'
 AND OLD.participation_status = 'confirmed'
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
      AND alternative_relation.participation_status = 'confirmed'
 )
BEGIN
  SELECT RAISE(
    ABORT,
    'Remove this featured speaker from published event sites before hiding, unconfirming, or removing their final public confirmed session relationship'
  );
END;

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
      AND relation.participation_status = 'confirmed'
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
           AND alternative_relation.participation_status = 'confirmed'
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
