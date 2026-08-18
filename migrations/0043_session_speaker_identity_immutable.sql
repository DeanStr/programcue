-- Session, event and person identity cannot be rewritten in place. The only
-- permitted person_id change is a participant-retention remap onto an
-- archived retained-participant identity after featured-speaker references
-- have been withdrawn.
CREATE TRIGGER session_speakers_identity_immutable
BEFORE UPDATE OF event_id, session_id, person_id ON session_speakers
WHEN NEW.event_id <> OLD.event_id
  OR NEW.session_id <> OLD.session_id
  OR (
    NEW.person_id <> OLD.person_id
    AND NOT (
    NEW.person_id LIKE 'retained-participant-%'
    AND EXISTS (
      SELECT 1 FROM events event
      JOIN people retained
        ON retained.id = NEW.person_id
       AND retained.profile_status = 'archived'
       AND retained.last_operation_id IS NOT NULL
       AND retained.last_operation_id = event.last_operation_id
       WHERE event.id = OLD.event_id
         AND event.participant_retention_completed_at IS NULL
    )
    AND NOT EXISTS (
      SELECT 1 FROM event_public_site_references reference
       WHERE reference.event_id = OLD.event_id
         AND reference.kind = 'speaker'
         AND reference.record_id = OLD.person_id
    )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Session speaker relationship identity is immutable');
END;
