ALTER TABLE events
ADD COLUMN public_projection_revision INTEGER NOT NULL DEFAULT 0
CHECK (public_projection_revision >= 0);

-- Public collection cursors must not rescan the event's complete change
-- history. Seed the counter once from already-recorded public changes, then
-- advance it in the same transaction as each future event_changes insert.
UPDATE events
   SET public_projection_revision = COALESCE((
     SELECT MAX(change.sequence)
       FROM event_changes change
      WHERE change.event_id = events.id
        AND (
          change.entity_type = 'event'
          OR (
            change.entity_type = 'schedule_version'
            AND EXISTS (
              SELECT 1 FROM schedule_versions version
               WHERE version.id = change.entity_id
                 AND version.event_id = change.event_id
                 AND version.status = 'published'
            )
          )
          OR (
            change.entity_type = 'session'
            AND EXISTS (
              SELECT 1
                FROM schedule_entries entry
                JOIN schedule_versions version
                  ON version.id = entry.schedule_version_id
                 AND version.event_id = entry.event_id
               WHERE entry.event_id = change.event_id
                 AND entry.session_id = change.entity_id
                 AND version.status = 'published'
            )
          )
          OR (
            change.entity_type = 'person'
            AND EXISTS (
              SELECT 1
                FROM session_speakers relation
                JOIN schedule_entries entry
                  ON entry.event_id = relation.event_id
                 AND entry.session_id = relation.session_id
                JOIN schedule_versions version
                  ON version.id = entry.schedule_version_id
                 AND version.event_id = entry.event_id
               WHERE relation.event_id = change.event_id
                 AND relation.person_id = change.entity_id
                 AND version.status = 'published'
            )
          )
          OR (
            change.entity_type = 'file_version'
            AND EXISTS (
              SELECT 1
                FROM file_versions file_version
                JOIN file_assets asset
                  ON asset.id = file_version.asset_id
                 AND asset.event_id = file_version.event_id
                JOIN session_speakers relation
                  ON relation.event_id = asset.event_id
                 AND relation.person_id = asset.target_id
                JOIN schedule_entries entry
                  ON entry.event_id = relation.event_id
                 AND entry.session_id = relation.session_id
                JOIN schedule_versions version
                  ON version.id = entry.schedule_version_id
                 AND version.event_id = entry.event_id
               WHERE file_version.id = change.entity_id
                 AND file_version.event_id = change.event_id
                 AND asset.target_type = 'person'
                 AND asset.asset_kind = 'headshot'
                 AND version.status = 'published'
            )
          )
          OR (
            change.entity_type = 'file_asset'
            AND EXISTS (
              SELECT 1
                FROM file_assets asset
                JOIN session_speakers relation
                  ON relation.event_id = asset.event_id
                 AND relation.person_id = asset.target_id
                JOIN schedule_entries entry
                  ON entry.event_id = relation.event_id
                 AND entry.session_id = relation.session_id
                JOIN schedule_versions version
                  ON version.id = entry.schedule_version_id
                 AND version.event_id = entry.event_id
               WHERE asset.id = change.entity_id
                 AND asset.event_id = change.event_id
                 AND asset.target_type = 'person'
                 AND asset.asset_kind = 'headshot'
                 AND version.status = 'published'
            )
          )
        )
   ), 0);

CREATE TRIGGER event_changes_advance_public_projection_revision
AFTER INSERT ON event_changes
WHEN NEW.entity_type = 'event'
  OR (
    NEW.entity_type = 'schedule_version'
    AND EXISTS (
      SELECT 1 FROM schedule_versions version
       WHERE version.id = NEW.entity_id
         AND version.event_id = NEW.event_id
         AND version.status = 'published'
    )
  )
  OR (
    NEW.entity_type = 'session'
    AND EXISTS (
      SELECT 1
        FROM schedule_entries entry
        JOIN schedule_versions version
          ON version.id = entry.schedule_version_id
         AND version.event_id = entry.event_id
       WHERE entry.event_id = NEW.event_id
         AND entry.session_id = NEW.entity_id
         AND version.status = 'published'
    )
  )
  OR (
    NEW.entity_type = 'person'
    AND EXISTS (
      SELECT 1
        FROM session_speakers relation
        JOIN schedule_entries entry
          ON entry.event_id = relation.event_id
         AND entry.session_id = relation.session_id
        JOIN schedule_versions version
          ON version.id = entry.schedule_version_id
         AND version.event_id = entry.event_id
       WHERE relation.event_id = NEW.event_id
         AND relation.person_id = NEW.entity_id
         AND version.status = 'published'
    )
  )
  OR (
    NEW.entity_type = 'file_version'
    AND EXISTS (
      SELECT 1
        FROM file_versions file_version
        JOIN file_assets asset
          ON asset.id = file_version.asset_id
         AND asset.event_id = file_version.event_id
        JOIN session_speakers relation
          ON relation.event_id = asset.event_id
         AND relation.person_id = asset.target_id
        JOIN schedule_entries entry
          ON entry.event_id = relation.event_id
         AND entry.session_id = relation.session_id
        JOIN schedule_versions version
          ON version.id = entry.schedule_version_id
         AND version.event_id = entry.event_id
       WHERE file_version.id = NEW.entity_id
         AND file_version.event_id = NEW.event_id
         AND asset.target_type = 'person'
         AND asset.asset_kind = 'headshot'
         AND version.status = 'published'
    )
  )
  OR (
    NEW.entity_type = 'file_asset'
    AND EXISTS (
      SELECT 1
        FROM file_assets asset
        JOIN session_speakers relation
          ON relation.event_id = asset.event_id
         AND relation.person_id = asset.target_id
        JOIN schedule_entries entry
          ON entry.event_id = relation.event_id
         AND entry.session_id = relation.session_id
        JOIN schedule_versions version
          ON version.id = entry.schedule_version_id
         AND version.event_id = entry.event_id
       WHERE asset.id = NEW.entity_id
         AND asset.event_id = NEW.event_id
         AND asset.target_type = 'person'
         AND asset.asset_kind = 'headshot'
         AND version.status = 'published'
    )
  )
BEGIN
  UPDATE events
     SET public_projection_revision = NEW.sequence
   WHERE id = NEW.event_id
     AND public_projection_revision < NEW.sequence;
END;
