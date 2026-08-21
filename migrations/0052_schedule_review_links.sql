CREATE TABLE schedule_review_links (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  schedule_version_id TEXT NOT NULL,
  schedule_revision INTEGER NOT NULL CHECK (schedule_revision > 0),
  projection_json TEXT NOT NULL
    CHECK (
      json_valid(projection_json)
      AND json_type(projection_json) = 'object'
      AND length(projection_json) <= 1048576
    ),
  token_hash TEXT NOT NULL UNIQUE
    CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
  expires_at INTEGER NOT NULL,
  created_by_person_id TEXT NOT NULL REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  purpose TEXT NOT NULL CHECK (
    length(trim(purpose)) BETWEEN 1 AND 80
    AND purpose = trim(purpose)
    AND instr(purpose, char(10)) = 0
    AND instr(purpose, char(13)) = 0
  ),
  revoked_at INTEGER,
  revoked_by_person_id TEXT REFERENCES people(id),
  revocation_reason TEXT CHECK (
    revocation_reason IS NULL
    OR revocation_reason IN ('manual', 'published')
  ),
  UNIQUE (id, event_id),
  UNIQUE (id, organisation_id, event_id),
  FOREIGN KEY (event_id, organisation_id)
    REFERENCES events(id, organisation_id) ON DELETE CASCADE,
  FOREIGN KEY (schedule_version_id, event_id)
    REFERENCES schedule_versions(id, event_id) ON DELETE CASCADE,
  CHECK (expires_at > created_at AND expires_at <= created_at + 2592000),
  CHECK (
    (revoked_at IS NULL
      AND revoked_by_person_id IS NULL
      AND revocation_reason IS NULL)
    OR
    (revoked_at IS NOT NULL
      AND revocation_reason IS NOT NULL
      AND revocation_reason IN ('manual', 'published')
      AND (
        revocation_reason <> 'manual'
        OR (
          revoked_by_person_id IS NOT NULL
          AND trim(revoked_by_person_id) <> ''
        )
      ))
  )
);

CREATE INDEX idx_schedule_review_links_event
  ON schedule_review_links(organisation_id, event_id, created_at DESC, id DESC);

CREATE TRIGGER schedule_review_links_immutable_identity
BEFORE UPDATE OF id, organisation_id, event_id, schedule_version_id,
  schedule_revision, projection_json, token_hash, expires_at,
  created_by_person_id, created_at, purpose
ON schedule_review_links
BEGIN
  SELECT RAISE(ABORT, 'schedule review links are immutable after creation');
END;

CREATE TRIGGER schedule_review_links_revoke_once
BEFORE UPDATE OF revoked_at, revoked_by_person_id, revocation_reason
ON schedule_review_links
WHEN OLD.revoked_at IS NOT NULL
  OR NEW.revoked_at IS NULL
  OR NEW.revocation_reason IS NULL
  OR NEW.revocation_reason NOT IN ('manual', 'published')
  OR (
    NEW.revocation_reason = 'manual'
    AND (
      NEW.revoked_by_person_id IS NULL
      OR trim(NEW.revoked_by_person_id) = ''
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'schedule review link revocation is one-way');
END;

CREATE TRIGGER schedule_review_links_participant_retention_no_pii_insert
BEFORE INSERT ON schedule_review_links
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER schedule_review_links_participant_retention_no_pii_update
BEFORE UPDATE ON schedule_review_links
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

DROP TRIGGER audit_events_display_metadata_insert;

CREATE TRIGGER audit_events_display_metadata_insert
BEFORE INSERT ON audit_events
WHEN NEW.metadata_version = 1 AND CASE NEW.action
  WHEN 'data.exported' THEN
    json_type(NEW.metadata_json, '$.resource') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.resource')) = ''
    OR json_type(NEW.metadata_json, '$.rowCount') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.rowCount') < 0
  WHEN 'decision.drafted' THEN
    json_type(NEW.metadata_json, '$.decision') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.decision')) = ''
  WHEN 'decision.published' THEN
    json_type(NEW.metadata_json, '$.decision') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.decision')) = ''
  WHEN 'decision.recorded' THEN
    json_type(NEW.metadata_json, '$.outcome') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.outcome')) = ''
  WHEN 'event.settings.updated' THEN
    json_type(NEW.metadata_json, '$.revision') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.revision') < 1
    OR json_type(NEW.metadata_json, '$.roomCount') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.roomCount') < 0
    OR json_type(NEW.metadata_json, '$.trackCount') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.trackCount') < 0
  WHEN 'integration.run.created' THEN
    json_type(NEW.metadata_json, '$.dryRun') IS NOT 'true'
    AND json_type(NEW.metadata_json, '$.dryRun') IS NOT 'false'
  WHEN 'membership.accepted' THEN
    json_type(NEW.metadata_json, '$.role') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.role')) = ''
  WHEN 'operation.failure_acknowledged' THEN
    json_type(NEW.metadata_json, '$.type') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.type')) = ''
    OR json_type(NEW.metadata_json, '$.status') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.status')) = ''
  WHEN 'participant.retention.completed' THEN
    json_type(NEW.metadata_json, '$.scope') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.scope')) = ''
    OR json_type(NEW.metadata_json, '$.repositoryProvider') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.repositoryProvider')) = ''
  WHEN 'programme_embed.created' THEN
    json_type(NEW.metadata_json, '$.status') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.status')) = ''
    OR json_type(NEW.metadata_json, '$.revision') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.revision') < 1
  WHEN 'programme_embed.updated' THEN
    json_type(NEW.metadata_json, '$.status') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.status')) = ''
    OR json_type(NEW.metadata_json, '$.revision') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.revision') < 1
  WHEN 'review.conflict.declared' THEN
    json_type(NEW.metadata_json, '$.roundId') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.roundId')) = ''
    OR json_type(NEW.metadata_json, '$.targetType') IS NOT 'text'
    OR json_extract(NEW.metadata_json, '$.targetType') NOT IN ('submission','session')
    OR json_type(NEW.metadata_json, '$.targetId') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.targetId')) = ''
  WHEN 'review.reopened' THEN
    json_type(NEW.metadata_json, '$.revision') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.revision') < 1
  WHEN 'schedule.published' THEN
    json_type(NEW.metadata_json, '$.entryCount') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.entryCount') < 0
  WHEN 'schedule.review_link.created' THEN
    json_type(NEW.metadata_json, '$.versionNumber') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.versionNumber') < 1
    OR json_type(NEW.metadata_json, '$.revision') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.revision') < 1
    OR json_type(NEW.metadata_json, '$.expiresAt') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.expiresAt') < 1
    OR json_type(NEW.metadata_json, '$.entryCount') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.entryCount') < 0
  WHEN 'schedule.review_link.revoked' THEN
    json_type(NEW.metadata_json, '$.reason') IS NOT 'text'
    OR json_extract(NEW.metadata_json, '$.reason') NOT IN ('manual','published')
    OR json_type(NEW.metadata_json, '$.versionNumber') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.versionNumber') < 1
    OR json_type(NEW.metadata_json, '$.revision') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.revision') < 1
  WHEN 'session.content.status_changed' THEN
    json_type(NEW.metadata_json, '$.from') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.from')) = ''
    OR json_type(NEW.metadata_json, '$.to') IS NOT 'text'
    OR trim(json_extract(NEW.metadata_json, '$.to')) = ''
    OR json_type(NEW.metadata_json, '$.contentRevision') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.contentRevision') < 1
  WHEN 'session.content.updated' THEN
    json_type(NEW.metadata_json, '$.revision') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.revision') < 1
    OR json_type(NEW.metadata_json, '$.contentRevision') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.contentRevision') < 1
  WHEN 'submission.revised' THEN
    json_type(NEW.metadata_json, '$.revision') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.revision') < 1
  WHEN 'submission.submitted' THEN
    json_type(NEW.metadata_json, '$.version') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.version') < 1
  WHEN 'submission.withdrawn' THEN
    json_type(NEW.metadata_json, '$.revision') IS NOT 'integer'
    OR json_extract(NEW.metadata_json, '$.revision') < 1
  ELSE 0
END
BEGIN
  SELECT RAISE(ABORT, 'audit metadata does not satisfy its action contract');
END;
