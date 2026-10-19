-- Sponsor asset requests use the existing private resource-file lifecycle.
-- Their reserved target IDs distinguish them from published resource pages.
CREATE TABLE sponsor_asset_requests (
  id TEXT PRIMARY KEY CHECK (id GLOB 'sponsor-asset-*'),
  event_id TEXT NOT NULL,
  sponsor_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('logo','document')),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending','approved','changes_requested')),
  reviewed_version_id TEXT,
  review_note TEXT NOT NULL DEFAULT '',
  revision INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(id,event_id),
  FOREIGN KEY (sponsor_id,event_id) REFERENCES event_sponsorships(id,event_id) ON DELETE CASCADE,
  FOREIGN KEY (reviewed_version_id,event_id) REFERENCES file_versions(id,event_id)
);
CREATE INDEX sponsor_asset_requests_company ON sponsor_asset_requests(event_id,sponsor_id);
CREATE TRIGGER sponsor_asset_requests_retention_insert BEFORE INSERT ON sponsor_asset_requests
WHEN EXISTS (SELECT 1 FROM participant_retention_locked_events WHERE event_id=NEW.event_id)
BEGIN SELECT RAISE(ABORT,'event participant retention is complete'); END;
CREATE TRIGGER sponsor_asset_requests_retention_update BEFORE UPDATE ON sponsor_asset_requests
WHEN EXISTS (SELECT 1 FROM participant_retention_locked_events WHERE event_id IN (OLD.event_id,NEW.event_id))
BEGIN SELECT RAISE(ABORT,'event participant retention is complete'); END;
-- Existing event retention guards already cover all file assets and versions.
-- Publication revalidates pinned, approved, clean logos atomically. Other
-- sponsor fields retain the existing website draft/publication boundary.
CREATE TRIGGER event_site_sponsor_uploaded_logo_publish
BEFORE UPDATE OF published_json ON event_public_sites
WHEN NEW.published_json IS NOT NULL AND EXISTS (
  SELECT 1 FROM json_each(NEW.published_json,'$.sponsors') item
  WHERE json_extract(item.value,'$.logoUrl') LIKE '/public/sponsor-assets/%'
    AND NOT EXISTS (
      SELECT 1 FROM sponsor_asset_requests r
      JOIN file_assets a ON a.event_id=r.event_id AND a.target_type='resource' AND a.target_id=r.id
      JOIN file_versions v ON v.event_id=a.event_id AND v.asset_id=a.id
      WHERE r.event_id=NEW.event_id AND r.kind='logo' AND r.review_status='approved' AND r.reviewed_version_id=v.id
        AND json_extract(item.value,'$.logoUrl')='/public/sponsor-assets/'||r.event_id||'/'||r.id||'/'||v.id
        AND v.id=(SELECT latest.id FROM file_versions latest JOIN file_assets asset ON asset.id=latest.asset_id AND asset.event_id=latest.event_id
          WHERE asset.event_id=r.event_id AND asset.target_type='resource' AND asset.target_id=r.id AND asset.status<>'deleted' AND latest.deleted_at IS NULL
            AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='file-erasure:'||asset.id)
          ORDER BY latest.created_at DESC,latest.rowid DESC LIMIT 1)
        AND v.upload_status='uploaded' AND v.signature_status='valid' AND v.scan_status='clean' AND v.released_at IS NOT NULL
        AND v.detected_content_type IN ('image/png','image/jpeg','image/webp')
        AND v.deleted_at IS NULL AND a.status<>'deleted'
        AND NOT EXISTS (SELECT 1 FROM audit_events WHERE id='file-erasure:'||a.id)
    )
)
BEGIN SELECT RAISE(ABORT,'Selected sponsor logo is no longer approved and available. Review the website draft.'); END;
