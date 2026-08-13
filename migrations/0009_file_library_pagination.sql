-- The central file library is ordered and paged within one event. Keep that
-- read bounded without scanning and sorting the complete cross-event table.
CREATE INDEX idx_file_assets_event_updated
  ON file_assets(event_id, updated_at DESC, id);
