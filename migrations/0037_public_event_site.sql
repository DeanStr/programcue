-- Public event-site drafts, publication snapshots, sponsors and recordings.
CREATE TABLE event_public_sites (
  event_id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  draft_json TEXT NOT NULL CHECK (json_valid(draft_json)),
  draft_revision INTEGER NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  published_json TEXT CHECK (published_json IS NULL OR json_valid(published_json)),
  published_revision INTEGER CHECK (published_revision IS NULL OR published_revision > 0),
  published_at INTEGER,
  last_updated_by_person_id TEXT NOT NULL REFERENCES people(id),
  last_operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (event_id, organisation_id)
    REFERENCES events(id, organisation_id) ON DELETE CASCADE,
  CHECK (
    (published_json IS NULL AND published_revision IS NULL AND published_at IS NULL)
    OR
    (published_json IS NOT NULL AND published_revision IS NOT NULL AND published_at IS NOT NULL)
  )
);

CREATE TABLE event_public_site_references (
  event_id TEXT NOT NULL,
  organisation_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('session', 'speaker')),
  record_id TEXT NOT NULL,
  site_revision INTEGER NOT NULL CHECK (site_revision > 0),
  PRIMARY KEY (event_id, kind, record_id),
  FOREIGN KEY (event_id, organisation_id)
    REFERENCES events(id, organisation_id) ON DELETE CASCADE,
  FOREIGN KEY (event_id)
    REFERENCES event_public_sites(event_id) ON DELETE CASCADE
);

CREATE TABLE event_site_sponsors (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 120),
  tier TEXT NOT NULL CHECK (length(trim(tier)) BETWEEN 1 AND 80),
  website_url TEXT CHECK (website_url IS NULL OR length(website_url) <= 2048),
  logo_url TEXT CHECK (logo_url IS NULL OR length(logo_url) <= 2048),
  description TEXT CHECK (description IS NULL OR length(description) <= 1000),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_updated_by_person_id TEXT NOT NULL REFERENCES people(id),
  last_operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (id, event_id),
  FOREIGN KEY (event_id, organisation_id)
    REFERENCES events(id, organisation_id) ON DELETE CASCADE
);

CREATE INDEX idx_event_site_sponsors_order
  ON event_site_sponsors(event_id, tier, position, name, id);

CREATE TABLE event_session_recordings (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  draft_title TEXT NOT NULL CHECK (length(trim(draft_title)) BETWEEN 1 AND 160),
  draft_recording_url TEXT NOT NULL CHECK (length(draft_recording_url) <= 2048),
  draft_captions_url TEXT CHECK (draft_captions_url IS NULL OR length(draft_captions_url) <= 2048),
  draft_transcript_url TEXT CHECK (draft_transcript_url IS NULL OR length(draft_transcript_url) <= 2048),
  draft_revision INTEGER NOT NULL DEFAULT 1 CHECK (draft_revision > 0),
  published_title TEXT,
  published_recording_url TEXT,
  published_captions_url TEXT,
  published_transcript_url TEXT,
  published_revision INTEGER CHECK (published_revision IS NULL OR published_revision > 0),
  published_at INTEGER,
  last_updated_by_person_id TEXT NOT NULL REFERENCES people(id),
  last_operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (event_id, session_id),
  FOREIGN KEY (event_id, organisation_id)
    REFERENCES events(id, organisation_id) ON DELETE CASCADE,
  FOREIGN KEY (session_id, event_id)
    REFERENCES sessions(id, event_id) ON DELETE CASCADE,
  CHECK (
    (published_title IS NULL AND published_recording_url IS NULL
      AND published_captions_url IS NULL AND published_transcript_url IS NULL
      AND published_revision IS NULL AND published_at IS NULL)
    OR
    (published_title IS NOT NULL AND published_recording_url IS NOT NULL
      AND published_revision IS NOT NULL AND published_at IS NOT NULL)
  ),
  CHECK (published_title IS NULL OR length(trim(published_title)) BETWEEN 1 AND 160),
  CHECK (published_recording_url IS NULL OR length(published_recording_url) <= 2048),
  CHECK (published_captions_url IS NULL OR length(published_captions_url) <= 2048),
  CHECK (published_transcript_url IS NULL OR length(published_transcript_url) <= 2048)
);

CREATE INDEX idx_event_session_recordings_public
  ON event_session_recordings(event_id, published_at, session_id)
  WHERE published_at IS NOT NULL;

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
    WHERE reference.event_id = OLD.event_id
      AND reference.kind = 'speaker'
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
           AND content.content_status = 'approved'
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

CREATE TRIGGER prevent_referenced_public_speaker_profile_demotion
BEFORE UPDATE OF profile_status ON people
WHEN OLD.profile_status = 'published'
 AND NEW.profile_status <> 'published'
 AND EXISTS (
   SELECT 1 FROM event_public_site_references reference
    WHERE reference.kind = 'speaker'
      AND reference.record_id = OLD.id
 )
BEGIN
  SELECT RAISE(ABORT, 'Remove this featured speaker from published event sites before unpublishing their profile');
END;

-- Managed embeds predate the controlled theme selector. The new contract is
-- direct rather than dual-path: every persisted configuration now carries it.
UPDATE programme_embeds
   SET configuration_json = json_set(configuration_json, '$.theme', 'system')
 WHERE json_extract(configuration_json, '$.theme') IS NULL;
