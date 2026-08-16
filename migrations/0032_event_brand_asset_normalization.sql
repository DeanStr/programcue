-- Existing branding objects were accepted using signature-prefix validation
-- only. Fail closed after this migration: retire them, clear their event
-- pointers and require fresh normalized uploads.
ALTER TABLE event_brand_assets ADD COLUMN width_px INTEGER
  CHECK (width_px IS NULL OR width_px > 0);
ALTER TABLE event_brand_assets ADD COLUMN height_px INTEGER
  CHECK (height_px IS NULL OR height_px > 0);
ALTER TABLE event_brand_assets ADD COLUMN normalizer_version TEXT;
ALTER TABLE event_brand_assets ADD COLUMN normalized_at INTEGER;
ALTER TABLE event_brand_assets ADD COLUMN cleanup_attempts INTEGER NOT NULL DEFAULT 0
  CHECK (cleanup_attempts >= 0);
ALTER TABLE event_brand_assets ADD COLUMN cleanup_last_attempt_at INTEGER;
ALTER TABLE event_brand_assets ADD COLUMN cleanup_last_error TEXT;

CREATE INDEX idx_event_brand_assets_cleanup
  ON event_brand_assets(cleanup_last_attempt_at, deleted_at, id)
  WHERE deleted_at IS NOT NULL;

UPDATE events
   SET brand_logo_asset_id = NULL,
       brand_banner_asset_id = NULL,
       brand_draft_logo_asset_id = NULL,
       brand_draft_banner_asset_id = NULL,
       brand_draft_revision = brand_draft_revision + 1,
       brand_published_revision = brand_draft_revision + 1,
       public_projection_revision = public_projection_revision + 1,
       revision = revision + 1,
       updated_at = unixepoch()
 WHERE brand_logo_asset_id IS NOT NULL
    OR brand_banner_asset_id IS NOT NULL
    OR brand_draft_logo_asset_id IS NOT NULL
    OR brand_draft_banner_asset_id IS NOT NULL;

UPDATE event_brand_assets
   SET deleted_at = COALESCE(deleted_at, unixepoch()),
       cleanup_last_error = 'Retired because the original bytes were not normalized.'
 WHERE normalized_at IS NULL;

CREATE TRIGGER event_brand_assets_ready_insert
BEFORE INSERT ON event_brand_assets
WHEN NEW.deleted_at IS NULL AND NOT (
  NEW.normalized_at > 0
  AND NEW.normalizer_version = 'cloudflare-images-webp-v1'
  AND NEW.content_type = 'image/webp'
  AND NEW.width_px IS NOT NULL AND NEW.height_px IS NOT NULL
  AND (
    (NEW.kind = 'logo'
      AND NEW.size_bytes <= 2097152
      AND NEW.width_px <= 2048 AND NEW.height_px <= 2048
      AND NEW.width_px * NEW.height_px <= 4194304)
    OR
    (NEW.kind = 'banner'
      AND NEW.width_px <= 4096 AND NEW.height_px <= 2160
      AND NEW.width_px * NEW.height_px <= 9000000)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'live event brand assets must contain normalized image evidence');
END;

CREATE TRIGGER event_brand_assets_ready_update
BEFORE UPDATE OF deleted_at, normalized_at, normalizer_version, width_px, height_px
ON event_brand_assets
WHEN NEW.deleted_at IS NULL AND NOT (
  NEW.normalized_at > 0
  AND NEW.normalizer_version = 'cloudflare-images-webp-v1'
  AND NEW.content_type = 'image/webp'
  AND NEW.width_px IS NOT NULL AND NEW.height_px IS NOT NULL
  AND (
    (NEW.kind = 'logo'
      AND NEW.size_bytes <= 2097152
      AND NEW.width_px <= 2048 AND NEW.height_px <= 2048
      AND NEW.width_px * NEW.height_px <= 4194304)
    OR
    (NEW.kind = 'banner'
      AND NEW.width_px <= 4096 AND NEW.height_px <= 2160
      AND NEW.width_px * NEW.height_px <= 9000000)
  )
)
BEGIN
  SELECT RAISE(ABORT, 'live event brand assets must contain normalized image evidence');
END;

CREATE TRIGGER event_brand_assets_identity_immutable
BEFORE UPDATE OF organisation_id, event_id, kind, object_key, object_etag,
  content_type, size_bytes, width_px, height_px, normalizer_version, normalized_at
ON event_brand_assets
BEGIN
  SELECT RAISE(ABORT, 'event brand asset identity is immutable');
END;

CREATE TRIGGER event_brand_assets_no_restore
BEFORE UPDATE OF deleted_at ON event_brand_assets
WHEN OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL
BEGIN
  SELECT RAISE(ABORT, 'retired event brand assets cannot be restored');
END;

CREATE TRIGGER event_brand_assets_no_retire_while_referenced
BEFORE UPDATE OF deleted_at ON event_brand_assets
WHEN OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL AND EXISTS (
  SELECT 1 FROM events event
   WHERE event.id = OLD.event_id AND event.organisation_id = OLD.organisation_id
     AND OLD.id IN (
       event.brand_logo_asset_id,
       event.brand_banner_asset_id,
       event.brand_draft_logo_asset_id,
       event.brand_draft_banner_asset_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'referenced event brand assets cannot be retired');
END;

CREATE TRIGGER event_brand_assets_no_delete_while_referenced
BEFORE DELETE ON event_brand_assets
WHEN EXISTS (
  SELECT 1 FROM events event
   WHERE event.id = OLD.event_id AND event.organisation_id = OLD.organisation_id
     AND OLD.id IN (
       event.brand_logo_asset_id,
       event.brand_banner_asset_id,
       event.brand_draft_logo_asset_id,
       event.brand_draft_banner_asset_id
     )
)
BEGIN
  SELECT RAISE(ABORT, 'referenced event brand assets cannot be deleted');
END;

-- R2 and D1 cannot participate in one transaction. Event deletion must first
-- retire and drain its durable asset records so cascading D1 deletion cannot
-- erase the only record of an R2 object that still needs cleanup.
CREATE TRIGGER events_no_delete_with_brand_assets
BEFORE DELETE ON events
WHEN EXISTS (
  SELECT 1 FROM event_brand_assets asset WHERE asset.event_id = OLD.id
)
BEGIN
  SELECT RAISE(ABORT, 'event brand assets must be cleaned before event deletion');
END;

CREATE TRIGGER events_brand_assets_ready_insert
BEFORE INSERT ON events
WHEN EXISTS (
  SELECT 1
   WHERE (NEW.brand_logo_asset_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM event_brand_assets asset
      WHERE asset.id = NEW.brand_logo_asset_id
        AND asset.event_id = NEW.id AND asset.organisation_id = NEW.organisation_id
        AND asset.kind = 'logo' AND asset.deleted_at IS NULL
        AND asset.normalized_at IS NOT NULL
   )) OR (NEW.brand_banner_asset_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM event_brand_assets asset
      WHERE asset.id = NEW.brand_banner_asset_id
        AND asset.event_id = NEW.id AND asset.organisation_id = NEW.organisation_id
        AND asset.kind = 'banner' AND asset.deleted_at IS NULL
        AND asset.normalized_at IS NOT NULL
   )) OR (NEW.brand_draft_logo_asset_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM event_brand_assets asset
      WHERE asset.id = NEW.brand_draft_logo_asset_id
        AND asset.event_id = NEW.id AND asset.organisation_id = NEW.organisation_id
        AND asset.kind = 'logo' AND asset.deleted_at IS NULL
        AND asset.normalized_at IS NOT NULL
   )) OR (NEW.brand_draft_banner_asset_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM event_brand_assets asset
      WHERE asset.id = NEW.brand_draft_banner_asset_id
        AND asset.event_id = NEW.id AND asset.organisation_id = NEW.organisation_id
        AND asset.kind = 'banner' AND asset.deleted_at IS NULL
        AND asset.normalized_at IS NOT NULL
   ))
)
BEGIN
  SELECT RAISE(ABORT, 'event branding pointers require matching normalized assets');
END;

CREATE TRIGGER events_brand_assets_ready_update
BEFORE UPDATE OF brand_logo_asset_id, brand_banner_asset_id,
  brand_draft_logo_asset_id, brand_draft_banner_asset_id ON events
WHEN EXISTS (
  SELECT 1
   WHERE (NEW.brand_logo_asset_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM event_brand_assets asset
      WHERE asset.id = NEW.brand_logo_asset_id
        AND asset.event_id = NEW.id AND asset.organisation_id = NEW.organisation_id
        AND asset.kind = 'logo' AND asset.deleted_at IS NULL
        AND asset.normalized_at IS NOT NULL
   )) OR (NEW.brand_banner_asset_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM event_brand_assets asset
      WHERE asset.id = NEW.brand_banner_asset_id
        AND asset.event_id = NEW.id AND asset.organisation_id = NEW.organisation_id
        AND asset.kind = 'banner' AND asset.deleted_at IS NULL
        AND asset.normalized_at IS NOT NULL
   )) OR (NEW.brand_draft_logo_asset_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM event_brand_assets asset
      WHERE asset.id = NEW.brand_draft_logo_asset_id
        AND asset.event_id = NEW.id AND asset.organisation_id = NEW.organisation_id
        AND asset.kind = 'logo' AND asset.deleted_at IS NULL
        AND asset.normalized_at IS NOT NULL
   )) OR (NEW.brand_draft_banner_asset_id IS NOT NULL AND NOT EXISTS (
     SELECT 1 FROM event_brand_assets asset
      WHERE asset.id = NEW.brand_draft_banner_asset_id
        AND asset.event_id = NEW.id AND asset.organisation_id = NEW.organisation_id
        AND asset.kind = 'banner' AND asset.deleted_at IS NULL
        AND asset.normalized_at IS NOT NULL
   ))
)
BEGIN
  SELECT RAISE(ABORT, 'event branding pointers require matching normalized assets');
END;

CREATE TRIGGER events_retire_unreferenced_brand_assets
AFTER UPDATE OF brand_logo_asset_id, brand_banner_asset_id,
  brand_draft_logo_asset_id, brand_draft_banner_asset_id ON events
BEGIN
  UPDATE event_brand_assets
     SET deleted_at = unixepoch(), cleanup_last_error = NULL
   WHERE event_id = NEW.id AND organisation_id = NEW.organisation_id
     AND deleted_at IS NULL
     AND id IS NOT NEW.brand_logo_asset_id
     AND id IS NOT NEW.brand_banner_asset_id
     AND id IS NOT NEW.brand_draft_logo_asset_id
     AND id IS NOT NEW.brand_draft_banner_asset_id;
END;
