-- Editorial review is advisory metadata, not a schedule-publication gate.
-- Preserve honest provenance for approval labels created by deployed legacy
-- backfills, and remove pre-release anonymous identifiers that correlated one
-- browser across unrelated events and cannot be transformed without raw tokens.
-- Roster imports also receive an exact per-row operation marker on their
-- organisation-scoped profile write.

ALTER TABLE organisation_contact_profiles ADD COLUMN last_operation_id TEXT;

ALTER TABLE schedule_session_contents ADD COLUMN approval_source TEXT
  CHECK (approval_source IN ('editorial', 'legacy_publication'));

-- Status changes wrote the content row and immutable revision in adjacent D1
-- batch statements, so their independent unixepoch() values may straddle one
-- second. Matching the actor and complete snapshot prevents an older approval
-- from being mistaken for review of the current published content.
UPDATE schedule_session_contents
   SET approval_source = CASE
         WHEN EXISTS (
           SELECT 1 FROM session_content_revisions revision
            WHERE revision.event_id = schedule_session_contents.event_id
              AND revision.schedule_version_id = schedule_session_contents.schedule_version_id
              AND revision.session_id = schedule_session_contents.session_id
              AND revision.revision_number = schedule_session_contents.content_revision
              AND revision.change_kind = 'status'
              AND revision.content_status = 'approved'
              AND revision.created_by_person_id = schedule_session_contents.approved_by_person_id
              AND abs(revision.created_at - schedule_session_contents.approved_at) <= 1
              AND revision.title = schedule_session_contents.title
              AND revision.slug = schedule_session_contents.slug
              AND revision.description IS schedule_session_contents.description
              AND revision.track_id IS schedule_session_contents.track_id
              AND revision.format = schedule_session_contents.format
              AND revision.duration_minutes = schedule_session_contents.duration_minutes
              AND revision.required_resources_json = schedule_session_contents.required_resources_json
              AND revision.visibility = schedule_session_contents.visibility
         ) THEN 'editorial'
         ELSE 'legacy_publication'
       END
 WHERE content_status = 'approved';

UPDATE schedule_session_contents
   SET approved_by_person_id = NULL
 WHERE approval_source = 'legacy_publication';

-- Approval provenance is one atomic state, not four independently optional
-- fields. Reject partial or fabricated audit state regardless of which writer
-- (D1 service or provider projection) reaches the table.
CREATE TRIGGER schedule_session_contents_approval_provenance_insert
BEFORE INSERT ON schedule_session_contents
WHEN (
  NEW.content_status IS 'approved'
  AND (
    NEW.approved_at IS NULL
    OR (
      NEW.approval_source IS NOT 'editorial'
      AND NEW.approval_source IS NOT 'legacy_publication'
    )
    OR (
      NEW.approval_source IS 'editorial'
      AND NEW.approved_by_person_id IS NULL
    )
    OR (
      NEW.approval_source IS 'legacy_publication'
      AND NEW.approved_by_person_id IS NOT NULL
    )
  )
) OR (
  NEW.content_status IS NOT 'approved'
  AND (
    NEW.approved_by_person_id IS NOT NULL
    OR NEW.approved_at IS NOT NULL
    OR NEW.approval_source IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'schedule content approval provenance is inconsistent');
END;

CREATE TRIGGER schedule_session_contents_approval_provenance_update
BEFORE UPDATE OF content_status, approved_by_person_id, approved_at, approval_source
ON schedule_session_contents
WHEN (
  NEW.content_status IS 'approved'
  AND (
    NEW.approved_at IS NULL
    OR (
      NEW.approval_source IS NOT 'editorial'
      AND NEW.approval_source IS NOT 'legacy_publication'
    )
    OR (
      NEW.approval_source IS 'editorial'
      AND NEW.approved_by_person_id IS NULL
    )
    OR (
      NEW.approval_source IS 'legacy_publication'
      AND NEW.approved_by_person_id IS NOT NULL
    )
  )
) OR (
  NEW.content_status IS NOT 'approved'
  AND (
    NEW.approved_by_person_id IS NOT NULL
    OR NEW.approved_at IS NOT NULL
    OR NEW.approval_source IS NOT NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'schedule content approval provenance is inconsistent');
END;

-- Force every migrated row through the new invariant so a historical state we
-- did not account for aborts this migration instead of surviving silently.
UPDATE schedule_session_contents
   SET approval_source = approval_source;

DROP TRIGGER schedule_versions_seed_session_content;

CREATE TRIGGER schedule_versions_seed_session_content
AFTER INSERT ON schedule_versions
BEGIN
  INSERT INTO schedule_session_contents (
    schedule_version_id, event_id, session_id, title, slug, description,
    track_id, format, duration_minutes, required_resources_json, visibility,
    content_status, content_revision, last_edited_by_person_id,
    approved_by_person_id, approved_at, approval_source, created_at, updated_at
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
         previous.approval_source, unixepoch(), unixepoch()
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

DELETE FROM public_itineraries WHERE person_id IS NULL;
