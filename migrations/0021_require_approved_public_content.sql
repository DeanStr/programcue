-- Schedule publication previously treated editorial approval as advisory. Preserve
-- content that was already made public under that policy as an explicit legacy
-- approval, then require every future public schedule snapshot to be approved
-- at the database publication boundary.
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
       JOIN sessions session
         ON session.id = entry.session_id
        AND session.event_id = entry.event_id
        AND session.visibility = 'public'
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
     JOIN sessions session
       ON session.id = entry.session_id
      AND session.event_id = entry.event_id
      AND session.visibility = 'public'
     LEFT JOIN schedule_session_contents content
       ON content.schedule_version_id = entry.schedule_version_id
      AND content.event_id = entry.event_id
      AND content.session_id = entry.session_id
    WHERE entry.schedule_version_id = NEW.id
      AND entry.event_id = NEW.event_id
      AND (
        content.session_id IS NULL
        OR content.visibility <> 'public'
        OR content.content_status <> 'approved'
      )
 )
BEGIN
  SELECT RAISE(ABORT, 'public schedule content must be approved before publication');
END;

-- Recovery/import writers may restore a version in its published state before
-- restoring its entries. The empty version exposes no programme rows, so guard
-- every entry as it enters a published version rather than silently trusting
-- that write order.
CREATE TRIGGER schedule_entries_public_content_approval_insert_guard
BEFORE INSERT ON schedule_entries
WHEN EXISTS (
  SELECT 1
    FROM schedule_versions version
    JOIN sessions session
      ON session.id = NEW.session_id
     AND session.event_id = NEW.event_id
     AND session.visibility = 'public'
    LEFT JOIN schedule_session_contents content
      ON content.schedule_version_id = NEW.schedule_version_id
     AND content.event_id = NEW.event_id
     AND content.session_id = NEW.session_id
   WHERE version.id = NEW.schedule_version_id
     AND version.event_id = NEW.event_id
     AND version.status = 'published'
     AND (
       content.session_id IS NULL
       OR content.visibility <> 'public'
       OR content.content_status <> 'approved'
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
    JOIN sessions session
      ON session.id = NEW.session_id
     AND session.event_id = NEW.event_id
     AND session.visibility = 'public'
    LEFT JOIN schedule_session_contents content
      ON content.schedule_version_id = NEW.schedule_version_id
     AND content.event_id = NEW.event_id
     AND content.session_id = NEW.session_id
   WHERE version.id = NEW.schedule_version_id
     AND version.event_id = NEW.event_id
     AND version.status = 'published'
     AND (
       content.session_id IS NULL
       OR content.visibility <> 'public'
       OR content.content_status <> 'approved'
     )
)
BEGIN
  SELECT RAISE(ABORT, 'public schedule content must be approved before publication');
END;

-- Published content remains version-owned. Retention may redact descriptive
-- fields, but no writer may demote or hide a scheduled public snapshot after
-- it has crossed the publication boundary.
CREATE TRIGGER schedule_session_contents_public_approval_update_guard
BEFORE UPDATE OF content_status, visibility ON schedule_session_contents
WHEN (NEW.content_status <> 'approved' OR NEW.visibility <> 'public')
 AND EXISTS (
   SELECT 1
     FROM schedule_versions version
     JOIN schedule_entries entry
       ON entry.schedule_version_id = version.id
      AND entry.event_id = version.event_id
      AND entry.session_id = NEW.session_id
     JOIN sessions session
       ON session.id = entry.session_id
      AND session.event_id = entry.event_id
      AND session.visibility = 'public'
    WHERE version.id = NEW.schedule_version_id
      AND version.event_id = NEW.event_id
      AND version.status = 'published'
 )
BEGIN
  SELECT RAISE(ABORT, 'published public schedule content cannot lose approval');
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
    JOIN sessions session
      ON session.id = entry.session_id
     AND session.event_id = entry.event_id
     AND session.visibility = 'public'
   WHERE version.id = OLD.schedule_version_id
     AND version.event_id = OLD.event_id
     AND version.status = 'published'
)
BEGIN
  SELECT RAISE(ABORT, 'published public schedule content cannot be deleted');
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
