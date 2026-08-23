-- Persist an exact-revision discard intent before private R2 erasure. The lock
-- prevents a concurrent save, submission, co-speaker change or new upload from
-- changing the draft while its external file state is being removed.
CREATE TABLE submission_draft_discards (
  submission_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  expected_revision INTEGER NOT NULL CHECK (expected_revision > 0),
  requested_by_person_id TEXT REFERENCES people(id),
  operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (submission_id, event_id)
    REFERENCES submissions(id, event_id) ON DELETE CASCADE
);

CREATE TRIGGER submissions_draft_discard_lock_update
BEFORE UPDATE ON submissions
WHEN EXISTS (
  SELECT 1 FROM submission_draft_discards discard
  WHERE discard.submission_id = OLD.id AND discard.event_id = OLD.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'application draft discard is in progress');
END;

CREATE TRIGGER submission_speakers_draft_discard_lock_insert
BEFORE INSERT ON submission_speakers
WHEN EXISTS (
  SELECT 1 FROM submission_draft_discards discard
  WHERE discard.submission_id = NEW.submission_id
    AND discard.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'application draft discard is in progress');
END;

CREATE TRIGGER submission_speakers_draft_discard_lock_update
BEFORE UPDATE ON submission_speakers
WHEN EXISTS (
  SELECT 1 FROM submission_draft_discards discard
  WHERE (discard.submission_id = OLD.submission_id
         AND discard.event_id = OLD.event_id)
     OR (discard.submission_id = NEW.submission_id
         AND discard.event_id = NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'application draft discard is in progress');
END;

CREATE TRIGGER file_assets_draft_discard_lock_insert
BEFORE INSERT ON file_assets
WHEN NEW.target_type = 'submission' AND EXISTS (
  SELECT 1 FROM submission_draft_discards discard
  WHERE discard.submission_id = NEW.target_id
    AND discard.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'application draft discard is in progress');
END;

CREATE TRIGGER file_versions_draft_discard_lock_insert
BEFORE INSERT ON file_versions
WHEN EXISTS (
  SELECT 1
    FROM file_assets asset
    JOIN submission_draft_discards discard
      ON discard.submission_id = asset.target_id
     AND discard.event_id = asset.event_id
   WHERE asset.id = NEW.asset_id AND asset.event_id = NEW.event_id
     AND asset.target_type = 'submission'
)
BEGIN
  SELECT RAISE(ABORT, 'application draft discard is in progress');
END;
