-- Speaker profile depth added after the production baseline was deployed.
-- Public identity fields remain canonical on people. Private travel preferences
-- are event-scoped so a participant or organiser in one tenant cannot read or
-- overwrite another event's logistics data.

ALTER TABLE people ADD COLUMN linkedin_url TEXT
  CHECK (
    linkedin_url IS NULL
    OR length(linkedin_url) BETWEEN 1 AND 500
  );

ALTER TABLE people ADD COLUMN x_handle TEXT
  CHECK (
    x_handle IS NULL
    OR (
      length(x_handle) BETWEEN 1 AND 15
      AND x_handle NOT GLOB '*[^A-Za-z0-9_]*'
    )
  );

CREATE TABLE event_participant_profiles (
  event_id TEXT NOT NULL,
  organisation_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  travel_preferences TEXT
    CHECK (
      travel_preferences IS NULL
      OR length(trim(travel_preferences)) BETWEEN 1 AND 2000
    ),
  last_operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (event_id, person_id),
  FOREIGN KEY (event_id, organisation_id)
    REFERENCES events(id, organisation_id) ON DELETE CASCADE
);

CREATE INDEX idx_event_participant_profiles_person
  ON event_participant_profiles(person_id, event_id);

CREATE TRIGGER event_participant_profiles_retention_no_pii_insert
BEFORE INSERT ON event_participant_profiles
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
   WHERE locked.event_id = NEW.event_id
     AND locked.organisation_id = NEW.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER event_participant_profiles_retention_no_pii_update
BEFORE UPDATE OF event_id, organisation_id, person_id, travel_preferences
ON event_participant_profiles
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
   WHERE (locked.event_id = OLD.event_id AND locked.organisation_id = OLD.organisation_id)
      OR (locked.event_id = NEW.event_id AND locked.organisation_id = NEW.organisation_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER event_participant_profiles_retention_no_pii_delete
BEFORE DELETE ON event_participant_profiles
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
   WHERE locked.event_id = OLD.event_id
     AND locked.organisation_id = OLD.organisation_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

-- The baseline guard predates these canonical public profile columns. Recreate
-- it so a completed retention tombstone also prevents reintroducing social PII.
DROP TRIGGER people_participant_retention_no_pii_update;

CREATE TRIGGER people_participant_retention_no_pii_update
BEFORE UPDATE OF id, email, display_name, email_verified, image_url, biography,
  pronunciation, organisation_name, job_title, linkedin_url, x_handle,
  profile_status, last_operation_id ON people
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_identities locked
  WHERE locked.person_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;
