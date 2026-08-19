-- Keep the existing accepted-speaker audience tied to an accepted session
-- relationship. Confirmation-sensitive resources use a separate explicit
-- audience value so organisers choose that stricter policy deliberately.

CREATE TABLE migration_0045_resource_pages AS
SELECT * FROM resource_pages;

CREATE TABLE migration_0045_resource_page_versions AS
SELECT * FROM resource_page_versions;

CREATE TABLE migration_0045_resource_audiences AS
SELECT * FROM resource_audiences;

CREATE TABLE migration_0045_resource_attachments AS
SELECT * FROM resource_attachments;

CREATE TABLE migration_0045_resource_acknowledgements AS
SELECT * FROM resource_acknowledgements;

DROP TABLE resource_acknowledgements;
DROP TABLE resource_attachments;
DROP TABLE resource_audiences;
DROP TABLE resource_page_versions;
DROP TABLE resource_pages;

CREATE TABLE resource_pages (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  category TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','archived')),
  audience_scope TEXT NOT NULL DEFAULT 'all_speakers' CHECK (audience_scope IN ('all_speakers','accepted_speakers','confirmed_speakers','custom')),
  acknowledgement_required INTEGER NOT NULL DEFAULT 0 CHECK (acknowledgement_required IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT,
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  archived_at INTEGER,
  UNIQUE(event_id, slug),
  UNIQUE(id, event_id)
);

CREATE TABLE resource_page_versions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  resource_page_id TEXT NOT NULL,
  version_number INTEGER NOT NULL CHECK (version_number > 0),
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  category TEXT,
  audience_scope TEXT NOT NULL DEFAULT 'all_speakers' CHECK (audience_scope IN ('all_speakers','accepted_speakers','confirmed_speakers','custom')),
  acknowledgement_required INTEGER NOT NULL DEFAULT 0 CHECK (acknowledgement_required IN (0,1)),
  document_json TEXT NOT NULL CHECK (json_valid(document_json)),
  rendered_html TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','published','retired')),
  created_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  published_at INTEGER,
  UNIQUE(resource_page_id, version_number),
  UNIQUE(id, event_id),
  FOREIGN KEY (resource_page_id, event_id) REFERENCES resource_pages(id, event_id) ON DELETE CASCADE,
  CHECK ((status = 'published' AND published_at IS NOT NULL) OR status <> 'published')
);

CREATE TABLE resource_audiences (
  resource_page_version_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('role','team','person','session','track')),
  target_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (resource_page_version_id, target_type, target_id),
  FOREIGN KEY (resource_page_version_id, event_id) REFERENCES resource_page_versions(id, event_id) ON DELETE CASCADE
);

CREATE TABLE resource_attachments (
  resource_page_version_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  file_asset_id TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  label TEXT,
  PRIMARY KEY (resource_page_version_id, file_asset_id),
  FOREIGN KEY (resource_page_version_id, event_id) REFERENCES resource_page_versions(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (file_asset_id, event_id) REFERENCES file_assets(id, event_id)
);

CREATE TABLE resource_acknowledgements (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  resource_page_id TEXT NOT NULL,
  resource_page_version_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  acknowledged_at INTEGER NOT NULL DEFAULT (unixepoch()),
  user_agent TEXT,
  UNIQUE(resource_page_version_id, person_id),
  FOREIGN KEY (resource_page_id, event_id) REFERENCES resource_pages(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (resource_page_version_id, event_id) REFERENCES resource_page_versions(id, event_id)
);

INSERT INTO resource_pages SELECT * FROM migration_0045_resource_pages;
INSERT INTO resource_page_versions SELECT * FROM migration_0045_resource_page_versions;
INSERT INTO resource_audiences SELECT * FROM migration_0045_resource_audiences;
INSERT INTO resource_attachments SELECT * FROM migration_0045_resource_attachments;
INSERT INTO resource_acknowledgements SELECT * FROM migration_0045_resource_acknowledgements;

DROP TABLE migration_0045_resource_acknowledgements;
DROP TABLE migration_0045_resource_attachments;
DROP TABLE migration_0045_resource_audiences;
DROP TABLE migration_0045_resource_page_versions;
DROP TABLE migration_0045_resource_pages;

CREATE INDEX idx_resource_pages_audience ON resource_pages(event_id, status, audience_scope);
CREATE UNIQUE INDEX ux_resource_versions_one_published ON resource_page_versions(resource_page_id) WHERE status = 'published';
CREATE INDEX idx_resource_ack_person ON resource_acknowledgements(event_id, person_id, acknowledged_at DESC);

CREATE TRIGGER resource_audiences_participant_retention_no_pii_insert
BEFORE INSERT ON resource_audiences
WHEN NEW.target_type = 'person' AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER resource_audiences_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, target_type, target_id ON resource_audiences
WHEN (OLD.target_type = 'person' OR NEW.target_type = 'person')
AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER resource_acknowledgements_participant_retention_no_pii_insert
BEFORE INSERT ON resource_acknowledgements
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER resource_acknowledgements_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, resource_page_id, resource_page_version_id, person_id, user_agent ON resource_acknowledgements
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;
