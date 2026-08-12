-- Portal membership acceptance was previously used as the only available
-- publication signal. It is not evidence that a person agreed to a particular
-- session, so every existing relationship begins pending rather than receiving
-- fabricated confirmation.
CREATE TABLE session_speakers_with_participation (
  session_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id),
  position INTEGER NOT NULL CHECK (position >= 0),
  role_label TEXT,
  participation_status TEXT NOT NULL
    CHECK (participation_status IN ('pending','confirmed')),
  participation_confirmed_at INTEGER,
  visibility TEXT NOT NULL DEFAULT 'public'
    CHECK (visibility IN ('public','private','hidden')),
  PRIMARY KEY (session_id, person_id),
  UNIQUE(session_id, position),
  FOREIGN KEY (session_id, event_id)
    REFERENCES sessions(id, event_id) ON DELETE CASCADE,
  CHECK (
    (participation_status = 'pending'
      AND participation_confirmed_at IS NULL)
    OR
    (participation_status = 'confirmed'
      AND participation_confirmed_at IS NOT NULL)
  )
);

INSERT INTO session_speakers_with_participation (
  session_id, event_id, person_id, position, role_label,
  participation_status, participation_confirmed_at, visibility
)
SELECT session_id, event_id, person_id, position, role_label,
       'pending', NULL, visibility
  FROM session_speakers;

DROP TABLE session_speakers;
ALTER TABLE session_speakers_with_participation RENAME TO session_speakers;

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
BEFORE UPDATE OF event_id, session_id, person_id ON session_speakers
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;
