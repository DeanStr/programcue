-- Event branding follows the deployed 0026-0028 migration sequence.
CREATE TABLE event_brand_assets (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('logo', 'banner')),
  object_key TEXT NOT NULL UNIQUE,
  object_etag TEXT NOT NULL,
  original_filename TEXT NOT NULL CHECK (length(original_filename) BETWEEN 1 AND 180),
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  size_bytes INTEGER NOT NULL CHECK (size_bytes BETWEEN 1 AND 5242880),
  created_by_person_id TEXT NOT NULL REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  deleted_at INTEGER,
  UNIQUE (id, event_id),
  FOREIGN KEY (event_id, organisation_id)
    REFERENCES events(id, organisation_id) ON DELETE CASCADE
);

CREATE INDEX idx_event_brand_assets_event_kind
  ON event_brand_assets(event_id, kind, created_at DESC)
  WHERE deleted_at IS NULL;

ALTER TABLE events ADD COLUMN brand_logo_asset_id TEXT;
ALTER TABLE events ADD COLUMN brand_banner_asset_id TEXT;
ALTER TABLE events ADD COLUMN brand_draft_accent TEXT NOT NULL DEFAULT '#4f46e5'
  CHECK (
    length(brand_draft_accent) = 7
    AND substr(brand_draft_accent, 1, 1) = '#'
    AND substr(brand_draft_accent, 2) NOT GLOB '*[^0-9A-Fa-f]*'
  );
ALTER TABLE events ADD COLUMN brand_draft_logo_asset_id TEXT;
ALTER TABLE events ADD COLUMN brand_draft_banner_asset_id TEXT;
ALTER TABLE events ADD COLUMN brand_draft_welcome_text TEXT
  CHECK (brand_draft_welcome_text IS NULL OR length(brand_draft_welcome_text) <= 500);
ALTER TABLE events ADD COLUMN brand_draft_support_url TEXT
  CHECK (
    brand_draft_support_url IS NULL
    OR (
      length(brand_draft_support_url) <= 2048
      AND substr(brand_draft_support_url, 1, 8) = 'https://'
    )
  );
ALTER TABLE events ADD COLUMN brand_draft_revision INTEGER NOT NULL DEFAULT 1
  CHECK (brand_draft_revision > 0);
ALTER TABLE events ADD COLUMN brand_published_revision INTEGER NOT NULL DEFAULT 1
  CHECK (brand_published_revision > 0);
ALTER TABLE events ADD COLUMN brand_published_at INTEGER;

UPDATE events
   SET brand_draft_accent = brand_accent,
       brand_draft_welcome_text = participant_welcome_text,
       brand_draft_support_url = participant_support_url,
       brand_published_at = updated_at;
