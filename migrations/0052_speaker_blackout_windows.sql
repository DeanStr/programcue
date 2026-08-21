-- SQLite cannot extend a CHECK enum in place, so schedule_conflicts is rebuilt
-- to accept speaker_unavailable. Blackout windows and the unavailability
-- policy column are added in the same migration.

CREATE TABLE speaker_blackout_windows (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES people(id),
  starts_at INTEGER NOT NULL,
  ends_at INTEGER NOT NULL CHECK (ends_at > starts_at),
  note TEXT CHECK (
    note IS NULL
    OR (
      length(note) BETWEEN 1 AND 500
      AND note = trim(note)
    )
  ),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id, event_id)
);

CREATE INDEX idx_speaker_blackout_windows_person
  ON speaker_blackout_windows(event_id, person_id, starts_at);

CREATE INDEX idx_speaker_blackout_windows_event
  ON speaker_blackout_windows(event_id, starts_at, ends_at);

CREATE TRIGGER speaker_blackout_windows_participant_retention_no_pii_insert
BEFORE INSERT ON speaker_blackout_windows
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER speaker_blackout_windows_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, person_id, note
ON speaker_blackout_windows
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

ALTER TABLE schedule_policies
  ADD COLUMN speaker_unavailable_action TEXT NOT NULL DEFAULT 'block'
    CHECK (speaker_unavailable_action IN ('warn','block'));

PRAGMA legacy_alter_table = ON;
ALTER TABLE schedule_conflicts RENAME TO schedule_conflicts_before_unavailable;

CREATE TABLE schedule_conflicts (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  schedule_version_id TEXT NOT NULL,
  conflict_type TEXT NOT NULL CHECK (conflict_type IN (
    'room','speaker','track','event_boundary','capacity','required_resource',
    'resource_configuration','room_resource','turnaround','speaker_unavailable'
  )),
  severity TEXT NOT NULL CHECK (severity IN ('warning','blocking')),
  fingerprint TEXT NOT NULL,
  primary_entry_id TEXT,
  conflicting_entry_id TEXT,
  details_json TEXT NOT NULL CHECK (json_valid(details_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  resolved_by_person_id TEXT REFERENCES people(id),
  resolved_at INTEGER,
  resolution_json TEXT CHECK (resolution_json IS NULL OR json_valid(resolution_json)),
  UNIQUE(schedule_version_id, fingerprint),
  FOREIGN KEY (schedule_version_id, event_id)
    REFERENCES schedule_versions(id, event_id) ON DELETE CASCADE
);

INSERT INTO schedule_conflicts (
  id, event_id, schedule_version_id, conflict_type, severity, fingerprint,
  primary_entry_id, conflicting_entry_id, details_json, created_at,
  resolved_by_person_id, resolved_at, resolution_json
)
SELECT
  id, event_id, schedule_version_id, conflict_type, severity, fingerprint,
  primary_entry_id, conflicting_entry_id, details_json, created_at,
  resolved_by_person_id, resolved_at, resolution_json
  FROM schedule_conflicts_before_unavailable;

DROP TABLE schedule_conflicts_before_unavailable;
PRAGMA legacy_alter_table = OFF;

CREATE INDEX idx_schedule_conflicts_open
  ON schedule_conflicts(event_id, schedule_version_id, resolved_at, severity);

CREATE TRIGGER audit_events_speaker_blackout_display_metadata_insert
BEFORE INSERT ON audit_events
WHEN NEW.metadata_version = 1
 AND NEW.action IN (
   'speaker.blackout.created',
   'speaker.blackout.deleted',
   'speaker.blackout.deleted_by_organiser'
 )
 AND (
   json_type(NEW.metadata_json, '$.windowId') IS NOT 'text'
   OR trim(json_extract(NEW.metadata_json, '$.windowId')) = ''
   OR json_type(NEW.metadata_json, '$.personId') IS NOT 'text'
   OR trim(json_extract(NEW.metadata_json, '$.personId')) = ''
   OR json_type(NEW.metadata_json, '$.startsAt') IS NOT 'integer'
   OR json_extract(NEW.metadata_json, '$.startsAt') < 0
   OR json_type(NEW.metadata_json, '$.endsAt') IS NOT 'integer'
   OR json_extract(NEW.metadata_json, '$.endsAt') < 1
   OR json_extract(NEW.metadata_json, '$.endsAt')
        <= json_extract(NEW.metadata_json, '$.startsAt')
   OR json_extract(NEW.metadata_json, '$.note') IS NOT NULL
 )
BEGIN
  SELECT RAISE(ABORT, 'audit metadata does not satisfy the display contract');
END;
