-- Contextual revision evidence follows the audit-contract migration.
ALTER TABLE review_revisions ADD COLUMN scorecard_id TEXT;
ALTER TABLE review_revisions ADD COLUMN scorecard_version INTEGER;
ALTER TABLE review_revisions ADD COLUMN criteria_snapshot_json TEXT
  CHECK (criteria_snapshot_json IS NULL OR (
    json_valid(criteria_snapshot_json) AND json_type(criteria_snapshot_json) = 'array'
  ));

CREATE TRIGGER review_revisions_scorecard_evidence_insert
BEFORE INSERT ON review_revisions
WHEN NEW.scorecard_id IS NULL OR trim(NEW.scorecard_id) = ''
  OR NEW.scorecard_version IS NULL OR NEW.scorecard_version < 1
  OR NEW.criteria_snapshot_json IS NULL
BEGIN
  SELECT RAISE(ABORT, 'review revision requires an exact scorecard snapshot');
END;

CREATE TABLE speaker_profile_revisions (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  source TEXT NOT NULL
    CHECK (source IN ('canonical_person','organisation_profile')),
  profile_revision INTEGER NOT NULL CHECK (profile_revision > 0),
  display_name TEXT NOT NULL,
  biography TEXT,
  pronunciation TEXT,
  organisation_name TEXT,
  job_title TEXT,
  publication_status TEXT NOT NULL
    CHECK (publication_status IN ('draft','published','archived')),
  headshot_file_version_id TEXT,
  recorded_by_person_id TEXT,
  correlation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(source, organisation_id, event_id, person_id, correlation_id)
);

CREATE INDEX idx_speaker_profile_revisions_person_created
  ON speaker_profile_revisions(person_id, created_at DESC, id DESC);

CREATE INDEX idx_speaker_profile_revisions_event_person_created
  ON speaker_profile_revisions(event_id, person_id, created_at DESC, id DESC);

CREATE TRIGGER speaker_profile_revisions_no_update
BEFORE UPDATE ON speaker_profile_revisions
BEGIN
  SELECT RAISE(ABORT, 'speaker profile revisions are append-only');
END;

CREATE TRIGGER speaker_profile_revisions_participant_retention_no_pii_insert
BEFORE INSERT ON speaker_profile_revisions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
   WHERE locked.event_id = NEW.event_id
     AND locked.organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;
