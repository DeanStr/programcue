-- Participation is invitation-cycle state, not event-wide speaker workflow
-- state. Rebuild the deployed constrained table so a participant can decline
-- one exact session without affecting their other event work.
DROP TRIGGER IF EXISTS session_speakers_participant_retention_no_pii_insert;
DROP TRIGGER IF EXISTS session_speakers_participant_retention_no_pii_update;
DROP TRIGGER IF EXISTS event_speaker_workflow_session_insert;
DROP TRIGGER IF EXISTS event_speaker_workflow_session_participation_update;
DROP TRIGGER IF EXISTS prevent_referenced_public_speaker_relationship_visibility_change;
DROP TRIGGER IF EXISTS prevent_referenced_public_speaker_relationship_delete;
DROP TRIGGER IF EXISTS session_speakers_identity_immutable;

-- Keep cross-table triggers that query session_speakers valid. With legacy
-- rename behavior they continue to target the canonical name while the old
-- table is temporarily moved aside and replaced in this transaction.
PRAGMA legacy_alter_table = ON;
ALTER TABLE session_speakers RENAME TO session_speakers_before_decision;

CREATE TABLE session_speakers (
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  role_label TEXT,
  participation_status TEXT NOT NULL
    CHECK (participation_status IN ('pending','confirmed','declined')),
  participation_revision INTEGER NOT NULL DEFAULT 1
    CHECK (participation_revision > 0),
  participation_confirmed_at INTEGER,
  participation_declined_at INTEGER,
  participation_decline_reason TEXT,
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public','private','hidden')),
  PRIMARY KEY (session_id, person_id),
  UNIQUE(session_id, position),
  FOREIGN KEY (session_id, event_id)
    REFERENCES sessions(id, event_id) ON DELETE CASCADE,
  CHECK (
    (participation_status = 'pending'
      AND participation_confirmed_at IS NULL
      AND participation_declined_at IS NULL
      AND participation_decline_reason IS NULL)
    OR
    (participation_status = 'confirmed'
      AND participation_confirmed_at IS NOT NULL
      AND participation_declined_at IS NULL
      AND participation_decline_reason IS NULL)
    OR
    (participation_status = 'declined'
      AND participation_confirmed_at IS NULL
      AND participation_declined_at IS NOT NULL
      AND (
        participation_decline_reason IS NULL
        OR (
          length(participation_decline_reason) BETWEEN 1 AND 500
          AND participation_decline_reason = trim(participation_decline_reason)
        )
      ))
  )
);

INSERT INTO session_speakers (
  session_id, event_id, person_id, position, role_label,
  participation_status, participation_revision,
  participation_confirmed_at, participation_declined_at,
  participation_decline_reason, visibility
)
SELECT session_id, event_id, person_id, position, role_label,
       participation_status, 1, participation_confirmed_at, NULL, NULL,
       visibility
  FROM session_speakers_before_decision;

DROP TABLE session_speakers_before_decision;
PRAGMA legacy_alter_table = OFF;

CREATE INDEX idx_session_speakers_person
  ON session_speakers(event_id, person_id);

CREATE TRIGGER session_speakers_participant_retention_no_pii_insert
BEFORE INSERT ON session_speakers
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER session_speakers_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, session_id, person_id, participation_decline_reason
ON session_speakers
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER event_speaker_workflow_session_insert
AFTER INSERT ON session_speakers
BEGIN
  INSERT INTO event_speaker_workflows (
    event_id, person_id, status, source, last_operation_id,
    updated_by_person_id, created_at, updated_at
  ) VALUES (
    NEW.event_id,
    NEW.person_id,
    CASE WHEN NEW.participation_status = 'confirmed'
         THEN 'confirmed' ELSE 'invited' END,
    'session',
    'speaker-workflow-session:' || NEW.event_id || ':' || NEW.person_id,
    NULL,
    (SELECT session.created_at FROM sessions session
      WHERE session.id = NEW.session_id AND session.event_id = NEW.event_id),
    unixepoch()
  ) ON CONFLICT(event_id, person_id) DO UPDATE SET
    status = 'confirmed',
    source = 'session',
    revision = event_speaker_workflows.revision + 1,
    last_operation_id = excluded.last_operation_id,
    updated_at = unixepoch()
  WHERE excluded.status = 'confirmed'
    AND event_speaker_workflows.status <> 'confirmed'
    AND event_speaker_workflows.source IN ('session','membership','backfill')
    AND event_speaker_workflows.updated_by_person_id IS NULL;
END;

CREATE TRIGGER event_speaker_workflow_session_participation_update
AFTER UPDATE OF participation_status, participation_confirmed_at
ON session_speakers
WHEN NEW.participation_status = 'confirmed'
 AND OLD.participation_status <> 'confirmed'
BEGIN
  UPDATE event_speaker_workflows
     SET status = 'confirmed',
         source = 'session',
         revision = revision + 1,
         last_operation_id =
           'speaker-workflow-session:' || NEW.event_id || ':' || NEW.person_id,
         updated_at = unixepoch()
   WHERE event_id = NEW.event_id
     AND person_id = NEW.person_id
     AND status <> 'confirmed'
     AND source IN ('session','membership','backfill')
     AND updated_by_person_id IS NULL;

  SELECT RAISE(
    ABORT,
    'confirmed session speaker is missing event workflow state'
  ) WHERE NOT EXISTS (
    SELECT 1 FROM event_speaker_workflows
     WHERE event_id = NEW.event_id AND person_id = NEW.person_id
  );
END;

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
