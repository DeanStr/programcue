-- Publication and public-site eligibility read the draft snapshot, not the
-- live session row. Live visibility is copied from the published snapshot
-- after the version crosses the publication boundary.
DROP TRIGGER IF EXISTS schedule_versions_public_content_approval_guard;
DROP TRIGGER IF EXISTS schedule_entries_public_content_approval_insert_guard;
DROP TRIGGER IF EXISTS schedule_entries_public_content_approval_update_guard;
DROP TRIGGER IF EXISTS schedule_session_contents_public_approval_update_guard;
DROP TRIGGER IF EXISTS schedule_session_contents_public_approval_delete_guard;
DROP TRIGGER IF EXISTS sessions_public_schedule_content_approval_guard;

-- The previous publication guard considered live session visibility. A private
-- live session could therefore have a public, unapproved snapshot in an
-- already-published version. The new snapshot-owned policy will make that
-- session public below, so preserve the historical publication as explicit
-- legacy approval before installing the stricter immutable-snapshot guards.
UPDATE schedule_session_contents
   SET content_status = 'approved',
       approved_by_person_id = NULL,
       approved_at = (
         SELECT version.published_at
           FROM schedule_versions version
          WHERE version.id = schedule_session_contents.schedule_version_id
            AND version.event_id = schedule_session_contents.event_id
       ),
       approval_source = 'legacy_publication'
 WHERE content_status <> 'approved'
   AND visibility = 'public'
   AND EXISTS (
     SELECT 1
       FROM schedule_versions version
       JOIN schedule_entries entry
         ON entry.schedule_version_id = version.id
        AND entry.event_id = version.event_id
        AND entry.session_id = schedule_session_contents.session_id
      WHERE version.id = schedule_session_contents.schedule_version_id
        AND version.event_id = schedule_session_contents.event_id
        AND version.status = 'published'
   );

CREATE TRIGGER schedule_versions_public_content_approval_guard
BEFORE UPDATE OF status ON schedule_versions
WHEN NEW.status = 'published'
 AND EXISTS (
   SELECT 1
     FROM schedule_entries entry
     LEFT JOIN schedule_session_contents content
       ON content.schedule_version_id = entry.schedule_version_id
      AND content.event_id = entry.event_id
      AND content.session_id = entry.session_id
    WHERE entry.schedule_version_id = NEW.id
      AND entry.event_id = NEW.event_id
      AND (
        content.session_id IS NULL
        OR (
          content.visibility = 'public'
          AND content.content_status <> 'approved'
        )
      )
 )
BEGIN
  SELECT RAISE(ABORT, 'public schedule content must be approved before publication');
END;

CREATE TRIGGER schedule_entries_public_content_approval_insert_guard
BEFORE INSERT ON schedule_entries
WHEN EXISTS (
  SELECT 1
    FROM schedule_versions version
    LEFT JOIN schedule_session_contents content
      ON content.schedule_version_id = NEW.schedule_version_id
     AND content.event_id = NEW.event_id
     AND content.session_id = NEW.session_id
   WHERE version.id = NEW.schedule_version_id
     AND version.event_id = NEW.event_id
     AND version.status = 'published'
     AND (
       content.session_id IS NULL
       OR (
         content.visibility = 'public'
         AND content.content_status <> 'approved'
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'public schedule content must be approved before publication');
END;

CREATE TRIGGER schedule_entries_public_content_approval_update_guard
BEFORE UPDATE OF schedule_version_id, event_id, session_id ON schedule_entries
WHEN EXISTS (
  SELECT 1
    FROM schedule_versions version
    LEFT JOIN schedule_session_contents content
      ON content.schedule_version_id = NEW.schedule_version_id
     AND content.event_id = NEW.event_id
     AND content.session_id = NEW.session_id
   WHERE version.id = NEW.schedule_version_id
     AND version.event_id = NEW.event_id
     AND version.status = 'published'
     AND (
       content.session_id IS NULL
       OR (
         content.visibility = 'public'
         AND content.content_status <> 'approved'
       )
     )
)
BEGIN
  SELECT RAISE(ABORT, 'public schedule content must be approved before publication');
END;

CREATE TRIGGER schedule_session_contents_public_approval_update_guard
BEFORE UPDATE OF content_status, visibility ON schedule_session_contents
WHEN (NEW.content_status IS NOT OLD.content_status
      OR NEW.visibility IS NOT OLD.visibility)
 AND EXISTS (
   SELECT 1
     FROM schedule_versions version
     JOIN schedule_entries entry
       ON entry.schedule_version_id = version.id
      AND entry.event_id = version.event_id
      AND entry.session_id = NEW.session_id
    WHERE version.id = NEW.schedule_version_id
      AND version.event_id = NEW.event_id
      AND version.status = 'published'
 )
BEGIN
  SELECT RAISE(ABORT, 'published schedule snapshot approval and visibility are immutable');
END;

CREATE TRIGGER schedule_session_contents_public_approval_delete_guard
BEFORE DELETE ON schedule_session_contents
WHEN EXISTS (
   SELECT 1
     FROM schedule_versions version
     JOIN schedule_entries entry
       ON entry.schedule_version_id = version.id
      AND entry.event_id = version.event_id
      AND entry.session_id = OLD.session_id
    WHERE version.id = OLD.schedule_version_id
      AND version.event_id = OLD.event_id
      AND version.status = 'published'
 )
BEGIN
  SELECT RAISE(ABORT, 'published schedule snapshots cannot be deleted');
END;

CREATE TRIGGER sessions_public_schedule_content_approval_guard
BEFORE UPDATE OF visibility ON sessions
WHEN NEW.visibility = 'public'
 AND EXISTS (
   SELECT 1
     FROM schedule_entries entry
     JOIN schedule_versions version
       ON version.id = entry.schedule_version_id
      AND version.event_id = entry.event_id
      AND version.status = 'published'
     LEFT JOIN schedule_session_contents content
       ON content.schedule_version_id = entry.schedule_version_id
      AND content.event_id = entry.event_id
      AND content.session_id = NEW.id
    WHERE entry.event_id = NEW.event_id
      AND entry.session_id = NEW.id
      AND (
        content.session_id IS NULL
        OR content.visibility <> 'public'
        OR content.content_status <> 'approved'
      )
 )
BEGIN
  SELECT RAISE(ABORT, 'public schedule content must be approved before publication');
END;

-- Restore live session visibility from the current published snapshot. Draft
-- edits previously wrote visibility onto sessions.visibility immediately; after
-- this change that write stops and public readers still require both live and
-- snapshot visibility. Repair the upgrade hole before the next publish.
INSERT INTO event_changes (
  event_id, entity_type, entity_id, change_type, correlation_id, created_at
)
SELECT DISTINCT session.event_id, 'event', session.event_id, 'updated',
       'migration-0044-snapshot-visibility', unixepoch()
  FROM sessions session
  JOIN schedule_versions version
    ON version.event_id = session.event_id
   AND version.status = 'published'
  JOIN schedule_entries entry
    ON entry.event_id = session.event_id
   AND entry.schedule_version_id = version.id
   AND entry.session_id = session.id
  JOIN schedule_session_contents content
    ON content.event_id = session.event_id
   AND content.schedule_version_id = version.id
   AND content.session_id = session.id
 WHERE session.visibility <> content.visibility;

UPDATE sessions
   SET visibility = (
         SELECT content.visibility
           FROM schedule_versions version
           JOIN schedule_entries entry
             ON entry.event_id = sessions.event_id
            AND entry.schedule_version_id = version.id
            AND entry.session_id = sessions.id
           JOIN schedule_session_contents content
             ON content.event_id = sessions.event_id
            AND content.schedule_version_id = version.id
            AND content.session_id = sessions.id
          WHERE version.event_id = sessions.event_id
            AND version.status = 'published'
       ),
       revision = revision + 1,
       updated_at = unixepoch()
 WHERE EXISTS (
   SELECT 1
     FROM schedule_versions version
     JOIN schedule_entries entry
       ON entry.event_id = sessions.event_id
      AND entry.schedule_version_id = version.id
      AND entry.session_id = sessions.id
     JOIN schedule_session_contents content
       ON content.event_id = sessions.event_id
      AND content.schedule_version_id = version.id
      AND content.session_id = sessions.id
    WHERE version.event_id = sessions.event_id
      AND version.status = 'published'
      AND content.visibility <> sessions.visibility
 );
