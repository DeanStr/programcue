-- Audit evidence outlives the mutable records it describes. Rebuild the table
-- without parent foreign keys so an explicit retention workflow can archive or
-- remove an organisation/event without an implicit audit cascade.
DROP TRIGGER audit_events_no_update;
DROP TRIGGER audit_events_no_delete;
DROP INDEX idx_audit_event_created;

-- Preserve references in views owned by other domains. Modern SQLite rewrites
-- those references to the temporary table name during ALTER TABLE unless the
-- legacy rename behaviour is enabled for this rebuild.
PRAGMA legacy_alter_table = ON;
ALTER TABLE audit_events RENAME TO audit_events_before_contract;

CREATE TABLE audit_events (
  id TEXT PRIMARY KEY,
  organisation_id TEXT,
  event_id TEXT,
  actor_person_id TEXT,
  actor_id TEXT,
  actor_kind TEXT NOT NULL
    CHECK (actor_kind IN ('historical','person','api_key','agent','provider','system')),
  origin TEXT NOT NULL
    CHECK (origin IN (
      'historical','admin_ui','participant_ui','public_form','api',
      'provider_webhook','queue','scheduled','internal'
    )),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  correlation_id TEXT,
  metadata_version INTEGER NOT NULL CHECK (metadata_version IN (0,1)),
  metadata_json TEXT NOT NULL DEFAULT '{}'
    CHECK (json_valid(metadata_json)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT INTO audit_events (
  id, organisation_id, event_id, actor_person_id, actor_id,
  actor_kind, origin, action, entity_type, entity_id, correlation_id,
  metadata_version, metadata_json, created_at
)
SELECT
  id, organisation_id, event_id, actor_person_id, actor_id,
  'historical', 'historical', action, entity_type, entity_id, correlation_id,
  0, metadata_json, created_at
FROM audit_events_before_contract;

DROP TABLE audit_events_before_contract;
PRAGMA legacy_alter_table = OFF;

CREATE INDEX idx_audit_events_event_created_id
  ON audit_events(event_id, created_at DESC, id DESC);

CREATE INDEX idx_audit_events_organisation_created_id
  ON audit_events(organisation_id, created_at DESC, id DESC);

CREATE INDEX idx_audit_events_event_actor_created_id
  ON audit_events(event_id, actor_person_id, created_at DESC, id DESC);

CREATE TRIGGER audit_events_contract_insert
BEFORE INSERT ON audit_events
WHEN NEW.actor_kind = 'historical'
  OR NEW.origin = 'historical'
  OR NEW.organisation_id IS NULL
  OR trim(NEW.organisation_id) = ''
  OR NEW.metadata_version <> 1
  OR json_type(NEW.metadata_json) IS NOT 'object'
  OR length(NEW.metadata_json) > 32768
  OR (NEW.actor_kind = 'person' AND (
    NEW.actor_person_id IS NULL OR trim(NEW.actor_person_id) = ''
  ))
  OR (NEW.actor_kind IN ('api_key','agent','provider') AND (
    NEW.actor_id IS NULL OR trim(NEW.actor_id) = ''
  ))
BEGIN
  SELECT RAISE(ABORT, 'audit event does not satisfy the provenance contract');
END;

-- Actions rendered in administrator timelines have a closed version-1 display
-- contract. Reject malformed facts at the write boundary instead of silently
-- hiding them when the history is read.
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

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;

CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events BEGIN
  SELECT RAISE(ABORT, 'audit events are append-only');
END;
