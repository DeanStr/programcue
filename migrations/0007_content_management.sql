-- Session content approval and history remain schedule-version scoped. Existing
-- snapshots predate the approval workflow and are treated as approved so this
-- migration cannot silently remove an already-published programme.
ALTER TABLE schedule_session_contents
  ADD COLUMN content_status TEXT NOT NULL DEFAULT 'draft'
  CHECK (content_status IN ('draft','in_review','approved','changes_requested'));

ALTER TABLE schedule_session_contents
  ADD COLUMN content_revision INTEGER NOT NULL DEFAULT 1
  CHECK (content_revision > 0);

ALTER TABLE schedule_session_contents
  ADD COLUMN last_edited_by_person_id TEXT REFERENCES people(id);

ALTER TABLE schedule_session_contents
  ADD COLUMN approved_by_person_id TEXT REFERENCES people(id);

ALTER TABLE schedule_session_contents
  ADD COLUMN approved_at INTEGER;

UPDATE schedule_session_contents
   SET content_status = 'approved',
       approved_by_person_id = (
         SELECT version.created_by_person_id
           FROM schedule_versions version
          WHERE version.id = schedule_session_contents.schedule_version_id
            AND version.event_id = schedule_session_contents.event_id
       ),
       approved_at = COALESCE(
         (
           SELECT version.published_at
             FROM schedule_versions version
            WHERE version.id = schedule_session_contents.schedule_version_id
              AND version.event_id = schedule_session_contents.event_id
         ),
         updated_at
       )
 WHERE EXISTS (
   SELECT 1 FROM schedule_versions version
    WHERE version.id = schedule_session_contents.schedule_version_id
      AND version.event_id = schedule_session_contents.event_id
      AND version.status = 'published'
 );

CREATE TABLE session_content_revisions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  schedule_version_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  revision_number INTEGER NOT NULL CHECK (revision_number > 0),
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  description TEXT,
  track_id TEXT,
  format TEXT NOT NULL,
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  required_resources_json TEXT NOT NULL CHECK (json_valid(required_resources_json)),
  visibility TEXT NOT NULL CHECK (visibility IN ('public','private','hidden')),
  content_status TEXT NOT NULL
    CHECK (content_status IN ('draft','in_review','approved','changes_requested')),
  change_kind TEXT NOT NULL
    CHECK (change_kind IN ('baseline','edit','status','restore')),
  restored_from_revision_id TEXT REFERENCES session_content_revisions(id),
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(schedule_version_id, session_id, revision_number),
  UNIQUE(id, event_id, schedule_version_id, session_id),
  FOREIGN KEY (schedule_version_id, session_id, event_id)
    REFERENCES schedule_session_contents(schedule_version_id, session_id, event_id)
    ON DELETE CASCADE,
  FOREIGN KEY (track_id, event_id) REFERENCES tracks(id, event_id)
);

CREATE INDEX idx_session_content_revisions_history
  ON session_content_revisions(event_id, session_id, schedule_version_id, revision_number DESC);

CREATE TRIGGER session_content_revisions_participant_retention_no_pii_insert
BEFORE INSERT ON session_content_revisions
WHEN NEW.description IS NOT NULL
AND EXISTS (
  SELECT 1
    FROM sessions session
    JOIN participant_retention_locked_events locked
      ON locked.event_id = session.event_id
   WHERE session.id = NEW.session_id
     AND session.event_id = NEW.event_id
     AND session.source_submission_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER session_content_revisions_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, session_id, description ON session_content_revisions
WHEN EXISTS (
  SELECT 1
    FROM sessions session
    JOIN participant_retention_locked_events locked
      ON locked.event_id = session.event_id
   WHERE session.id IN (OLD.session_id, NEW.session_id)
     AND session.event_id IN (OLD.event_id, NEW.event_id)
     AND session.source_submission_id IS NOT NULL
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

INSERT INTO session_content_revisions (
  id, event_id, schedule_version_id, session_id, revision_number, title, slug,
  description, track_id, format, duration_minutes, required_resources_json,
  visibility, content_status, change_kind, created_by_person_id, created_at
)
SELECT 'content-revision-baseline:' || content.schedule_version_id || ':' || content.session_id,
       content.event_id, content.schedule_version_id, content.session_id,
       content.content_revision, content.title, content.slug,
       CASE WHEN EXISTS (
         SELECT 1
           FROM sessions session
           JOIN participant_retention_locked_events locked
             ON locked.event_id = session.event_id
          WHERE session.id = content.session_id
            AND session.event_id = content.event_id
            AND session.source_submission_id IS NOT NULL
       ) THEN NULL ELSE content.description END,
       content.track_id, content.format,
       content.duration_minutes, content.required_resources_json,
       content.visibility, content.content_status, 'baseline',
       version.created_by_person_id, content.updated_at
  FROM schedule_session_contents content
  JOIN schedule_versions version
    ON version.id = content.schedule_version_id AND version.event_id = content.event_id;

-- A new draft inherits the latest published content and approval state. A
-- brand-new session still begins as draft through the separate session trigger.
DROP TRIGGER schedule_versions_seed_session_content;

CREATE TRIGGER schedule_versions_seed_session_content
AFTER INSERT ON schedule_versions
BEGIN
  INSERT INTO schedule_session_contents (
    schedule_version_id, event_id, session_id, title, slug, description,
    track_id, format, duration_minutes, required_resources_json, visibility,
    content_status, content_revision, last_edited_by_person_id,
    approved_by_person_id, approved_at, created_at, updated_at
  )
  SELECT NEW.id, session.event_id, session.id,
         COALESCE(previous.title, session.title),
         COALESCE(previous.slug, session.slug),
         CASE WHEN previous.session_id IS NULL THEN session.description ELSE previous.description END,
         CASE WHEN previous.session_id IS NULL THEN session.track_id ELSE previous.track_id END,
         COALESCE(previous.format, session.format),
         COALESCE(previous.duration_minutes, session.duration_minutes),
         COALESCE(previous.required_resources_json, session.required_resources_json),
         COALESCE(previous.visibility, session.visibility),
         COALESCE(previous.content_status, 'draft'), 1,
         previous.last_edited_by_person_id,
         previous.approved_by_person_id, previous.approved_at,
         unixepoch(), unixepoch()
    FROM sessions session
    LEFT JOIN schedule_session_contents previous
      ON previous.event_id = session.event_id
     AND previous.session_id = session.id
     AND previous.schedule_version_id = (
       SELECT published.id
         FROM schedule_versions published
        WHERE published.event_id = NEW.event_id
          AND published.status = 'published'
        ORDER BY published.published_at DESC, published.version_number DESC
        LIMIT 1
     )
   WHERE session.event_id = NEW.event_id;

  INSERT INTO session_content_revisions (
    id, event_id, schedule_version_id, session_id, revision_number, title, slug,
    description, track_id, format, duration_minutes, required_resources_json,
    visibility, content_status, change_kind, created_by_person_id, created_at
  )
  SELECT lower(hex(randomblob(16))), content.event_id,
         content.schedule_version_id, content.session_id,
         content.content_revision, content.title, content.slug,
         content.description, content.track_id, content.format,
         content.duration_minutes, content.required_resources_json,
         content.visibility, content.content_status, 'baseline',
         NEW.created_by_person_id, unixepoch()
    FROM schedule_session_contents content
   WHERE content.schedule_version_id = NEW.id AND content.event_id = NEW.event_id;
END;

-- Keep snapshot and baseline-history creation in one trigger; correctness must
-- not depend on SQLite's ordering of multiple AFTER INSERT triggers.
DROP TRIGGER sessions_seed_draft_schedule_content;

CREATE TRIGGER sessions_seed_draft_schedule_content
AFTER INSERT ON sessions
BEGIN
  INSERT INTO schedule_session_contents (
    schedule_version_id, event_id, session_id, title, slug, description,
    track_id, format, duration_minutes, required_resources_json, visibility,
    content_status, content_revision, created_at, updated_at
  )
  SELECT version.id, NEW.event_id, NEW.id, NEW.title, NEW.slug,
         NEW.description, NEW.track_id, NEW.format,
         NEW.duration_minutes, NEW.required_resources_json,
         NEW.visibility, 'draft', 1, unixepoch(), unixepoch()
    FROM schedule_versions version
   WHERE version.event_id = NEW.event_id AND version.status = 'draft';

  INSERT INTO session_content_revisions (
    id, event_id, schedule_version_id, session_id, revision_number, title, slug,
    description, track_id, format, duration_minutes, required_resources_json,
    visibility, content_status, change_kind, created_at
  )
  SELECT lower(hex(randomblob(16))), content.event_id,
         content.schedule_version_id, content.session_id,
         content.content_revision, content.title, content.slug,
         content.description, content.track_id, content.format,
         content.duration_minutes, content.required_resources_json,
         content.visibility, content.content_status, 'baseline', unixepoch()
    FROM schedule_session_contents content
    JOIN schedule_versions version
      ON version.id = content.schedule_version_id AND version.event_id = content.event_id
   WHERE content.event_id = NEW.event_id AND content.session_id = NEW.id
     AND version.status = 'draft';
END;
