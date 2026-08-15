-- Existing deployments have already applied the baseline migration. Keep this
-- forward migration idempotent so the same canonical table definition can also
-- remain in 0001 for new databases that subsequently apply every migration.
CREATE TABLE IF NOT EXISTS evaluation_discussion_messages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  submission_id TEXT,
  session_id TEXT,
  author_person_id TEXT NOT NULL REFERENCES people(id),
  body TEXT,
  idempotency_key TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (round_id, event_id) REFERENCES evaluation_rounds(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id, event_id) REFERENCES submissions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, event_id) REFERENCES sessions(id, event_id) ON DELETE CASCADE,
  UNIQUE(event_id, author_person_id, idempotency_key),
  CHECK (
    (submission_id IS NOT NULL AND session_id IS NULL)
    OR (submission_id IS NULL AND session_id IS NOT NULL)
  ),
  CHECK (body IS NULL OR (length(trim(body)) BETWEEN 1 AND 2000))
);

CREATE INDEX IF NOT EXISTS idx_evaluation_discussion_submission
  ON evaluation_discussion_messages(event_id, round_id, submission_id, created_at, id);

CREATE INDEX IF NOT EXISTS idx_evaluation_discussion_session
  ON evaluation_discussion_messages(event_id, round_id, session_id, created_at, id);

CREATE TRIGGER IF NOT EXISTS evaluation_discussion_messages_participant_retention_no_pii_insert
BEFORE INSERT ON evaluation_discussion_messages
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER IF NOT EXISTS evaluation_discussion_messages_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, round_id, submission_id, session_id, author_person_id, body ON evaluation_discussion_messages
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;
