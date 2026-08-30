-- Add the small, explicit data structures needed for independent participant
-- roles, submission admission controls and event-owned participant fields.

ALTER TABLE form_definitions ADD COLUMN opens_at INTEGER;
ALTER TABLE form_definitions ADD COLUMN per_person_submission_limit INTEGER
  CHECK (per_person_submission_limit IS NULL OR per_person_submission_limit > 0);

CREATE TABLE session_participant_roles (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('speaker','moderator','chair')),
  label TEXT NOT NULL CHECK (
    label = trim(label) AND length(label) BETWEEN 1 AND 80
  ),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  participation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (participation_status IN ('pending','confirmed','declined')),
  participation_revision INTEGER NOT NULL DEFAULT 1
    CHECK (participation_revision > 0),
  participation_confirmed_at INTEGER,
  participation_declined_at INTEGER,
  participation_decline_reason TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (session_id, person_id, role),
  FOREIGN KEY (session_id, person_id)
    REFERENCES session_speakers(session_id, person_id)
    ON UPDATE CASCADE ON DELETE CASCADE,
  CHECK (
    (participation_status = 'pending'
      AND participation_confirmed_at IS NULL
      AND participation_declined_at IS NULL
      AND participation_decline_reason IS NULL)
    OR
    (participation_status = 'confirmed'
      AND participation_confirmed_at IS NOT NULL
      AND participation_declined_at IS NULL
      AND participation_decline_reason IS NULL)
    OR
    (participation_status = 'declined'
      AND participation_confirmed_at IS NULL
      AND participation_declined_at IS NOT NULL
      AND (
        participation_decline_reason IS NULL
        OR (
          participation_decline_reason = trim(participation_decline_reason)
          AND length(participation_decline_reason) BETWEEN 1 AND 500
        )
      ))
  )
);

CREATE INDEX idx_session_participant_roles_person
  ON session_participant_roles(event_id, person_id, participation_status);
CREATE INDEX idx_session_participant_roles_session
  ON session_participant_roles(event_id, session_id, position, role);

INSERT INTO session_participant_roles (
  event_id, session_id, person_id, role, label, position,
  participation_status, participation_revision,
  participation_confirmed_at, participation_declined_at,
  participation_decline_reason, created_at, updated_at
)
SELECT relationship.event_id, relationship.session_id, relationship.person_id,
       CASE
         WHEN lower(trim(COALESCE(relationship.role_label, ''))) = 'moderator'
           THEN 'moderator'
         WHEN lower(trim(COALESCE(relationship.role_label, ''))) IN ('chair','chairperson')
           THEN 'chair'
         ELSE 'speaker'
       END,
       COALESCE(
         NULLIF(trim(substr(trim(COALESCE(relationship.role_label, '')), 1, 80)), ''),
         'Speaker'
       ),
       0, relationship.participation_status,
       relationship.participation_revision,
       relationship.participation_confirmed_at,
       relationship.participation_declined_at,
       relationship.participation_decline_reason,
       unixepoch(), unixepoch()
  FROM session_speakers relationship;

CREATE TRIGGER session_participant_roles_scope_insert
BEFORE INSERT ON session_participant_roles
WHEN NOT EXISTS (
  SELECT 1 FROM session_speakers relationship
   WHERE relationship.session_id = NEW.session_id
     AND relationship.person_id = NEW.person_id
     AND relationship.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'participant role must belong to its session relationship event');
END;

CREATE TRIGGER session_participant_roles_identity_immutable
BEFORE UPDATE OF event_id, session_id, person_id, role
ON session_participant_roles
WHEN OLD.event_id IS NOT NEW.event_id
  OR OLD.session_id IS NOT NEW.session_id
  OR (
    OLD.person_id IS NOT NEW.person_id
    AND NOT (
      OLD.event_id IS NEW.event_id
      AND OLD.session_id IS NEW.session_id
      AND NEW.person_id LIKE 'retained-participant-%'
      AND EXISTS (
        SELECT 1 FROM session_speakers relationship
         WHERE relationship.event_id = NEW.event_id
           AND relationship.session_id = NEW.session_id
           AND relationship.person_id = NEW.person_id
      )
    )
  )
  OR OLD.role IS NOT NEW.role
BEGIN
  SELECT RAISE(ABORT, 'participant role identity is immutable');
END;

CREATE TRIGGER session_participant_roles_participant_retention_no_pii_insert
BEFORE INSERT ON session_participant_roles
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
   WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER session_participant_roles_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, session_id, person_id, participation_status,
                 participation_confirmed_at, participation_declined_at,
                 participation_decline_reason
ON session_participant_roles
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
   WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER session_speakers_default_participant_role
AFTER INSERT ON session_speakers
BEGIN
  INSERT INTO session_participant_roles (
    event_id, session_id, person_id, role, label, position,
    participation_status, participation_revision,
    participation_confirmed_at, participation_declined_at,
    participation_decline_reason, created_at, updated_at
  ) VALUES (
    NEW.event_id, NEW.session_id, NEW.person_id,
    CASE
      WHEN lower(trim(COALESCE(NEW.role_label, ''))) = 'moderator'
        THEN 'moderator'
      WHEN lower(trim(COALESCE(NEW.role_label, ''))) IN ('chair','chairperson')
        THEN 'chair'
      ELSE 'speaker'
    END,
    COALESCE(
      NULLIF(trim(substr(trim(COALESCE(NEW.role_label, '')), 1, 80)), ''),
      'Speaker'
    ), 0,
    NEW.participation_status, NEW.participation_revision,
    NEW.participation_confirmed_at, NEW.participation_declined_at,
    NEW.participation_decline_reason, unixepoch(), unixepoch()
  );
END;

CREATE TABLE event_participant_field_policies (
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  field_key TEXT NOT NULL CHECK (field_key IN (
    'name','biography','pronunciation','organisation_name','job_title',
    'linkedin_url','x_handle','travel_preferences'
  )),
  participant_access TEXT NOT NULL DEFAULT 'editable'
    CHECK (participant_access IN ('hidden','read_only','editable')),
  updated_by_person_id TEXT NOT NULL REFERENCES people(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (event_id, field_key)
);

CREATE TABLE event_field_definitions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('person','session')),
  field_key TEXT NOT NULL CHECK (
    length(field_key) BETWEEN 2 AND 40
    AND field_key NOT GLOB '*[^a-z0-9_]*'
    AND field_key GLOB '[a-z]*'
  ),
  label TEXT NOT NULL CHECK (
    label = trim(label) AND length(label) BETWEEN 1 AND 120
  ),
  field_type TEXT NOT NULL CHECK (field_type IN (
    'short_text','long_text','number','boolean','date','single_choice','multiple_choice'
  )),
  options_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(options_json)),
  participant_access TEXT NOT NULL DEFAULT 'read_only'
    CHECK (participant_access IN ('hidden','read_only','editable')),
  required INTEGER NOT NULL DEFAULT 0 CHECK (required IN (0,1)),
  position INTEGER NOT NULL DEFAULT 0 CHECK (position >= 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_by_person_id TEXT NOT NULL REFERENCES people(id),
  updated_by_person_id TEXT NOT NULL REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (event_id, owner_type, field_key),
  UNIQUE (id, event_id),
  CHECK (
    (field_type IN ('single_choice','multiple_choice')
      AND json_type(options_json) = 'array'
      AND json_array_length(options_json) BETWEEN 1 AND 50)
    OR
    (field_type NOT IN ('single_choice','multiple_choice')
      AND options_json = '[]')
  )
);

CREATE INDEX idx_event_field_definitions_owner
  ON event_field_definitions(event_id, owner_type, status, position, label);

CREATE TABLE event_field_values (
  definition_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  person_id TEXT REFERENCES people(id),
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_person_id TEXT NOT NULL REFERENCES people(id),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (definition_id, event_id)
    REFERENCES event_field_definitions(id, event_id) ON DELETE CASCADE,
  CHECK ((person_id IS NOT NULL) <> (session_id IS NOT NULL))
);

CREATE UNIQUE INDEX ux_event_field_values_person
  ON event_field_values(definition_id, person_id)
  WHERE person_id IS NOT NULL;
CREATE UNIQUE INDEX ux_event_field_values_session
  ON event_field_values(definition_id, session_id)
  WHERE session_id IS NOT NULL;
CREATE INDEX idx_event_field_values_event_person
  ON event_field_values(event_id, person_id, definition_id)
  WHERE person_id IS NOT NULL;
CREATE INDEX idx_event_field_values_event_session
  ON event_field_values(event_id, session_id, definition_id)
  WHERE session_id IS NOT NULL;

CREATE TRIGGER event_field_values_scope_insert
BEFORE INSERT ON event_field_values
WHEN NOT EXISTS (
  SELECT 1 FROM event_field_definitions definition
   WHERE definition.id = NEW.definition_id
     AND definition.event_id = NEW.event_id
     AND (
       (definition.owner_type = 'person' AND NEW.person_id IS NOT NULL)
       OR (definition.owner_type = 'session' AND NEW.session_id IS NOT NULL)
     )
)
OR (
  NEW.session_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sessions session
     WHERE session.id = NEW.session_id AND session.event_id = NEW.event_id
  )
)
OR (
  NEW.person_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
      FROM event_speaker_workflows workflow
     WHERE workflow.event_id = NEW.event_id
       AND workflow.person_id = NEW.person_id
    UNION ALL
    SELECT 1
      FROM session_speakers relationship
     WHERE relationship.event_id = NEW.event_id
       AND relationship.person_id = NEW.person_id
    UNION ALL
    SELECT 1
      FROM submissions submission
     WHERE submission.event_id = NEW.event_id
       AND submission.submitter_person_id = NEW.person_id
    UNION ALL
    SELECT 1
      FROM memberships membership
     WHERE membership.event_id = NEW.event_id
       AND membership.person_id = NEW.person_id
       AND membership.role IN ('speaker', 'submitter')
       AND membership.accepted_at IS NOT NULL
       AND membership.revoked_at IS NULL
  )
)
BEGIN
  SELECT RAISE(ABORT, 'event field value owner is outside its definition scope');
END;

CREATE TRIGGER event_field_values_identity_immutable
BEFORE UPDATE OF definition_id, event_id, person_id, session_id
ON event_field_values
WHEN OLD.definition_id IS NOT NEW.definition_id
  OR OLD.event_id IS NOT NEW.event_id
  OR (
    OLD.person_id IS NOT NEW.person_id
    AND NOT (
      OLD.person_id IS NOT NULL
      AND NEW.person_id LIKE 'retained-participant-%'
      AND EXISTS (
        SELECT 1 FROM events event
        JOIN people retained
          ON retained.id = NEW.person_id
         AND retained.profile_status = 'archived'
         AND retained.last_operation_id IS NOT NULL
         AND retained.last_operation_id = event.last_operation_id
         WHERE event.id = OLD.event_id
           AND event.participant_retention_completed_at IS NULL
      )
    )
  )
  OR OLD.session_id IS NOT NEW.session_id
BEGIN
  SELECT RAISE(ABORT, 'event field value identity is immutable');
END;

CREATE TRIGGER event_field_values_revision_insert
BEFORE INSERT ON event_field_values
WHEN NEW.revision <> 1
BEGIN
  SELECT RAISE(ABORT, 'event field value revision conflict');
END;

-- The upsert carries the form's expected revision in updated_at because
-- SQLite does not expose an extra excluded-only value to conflict triggers.
-- The AFTER triggers immediately restore updated_at to an actual timestamp.
CREATE TRIGGER event_field_values_revision_update
BEFORE UPDATE OF revision ON event_field_values
WHEN NEW.revision <> OLD.revision + 1 OR NEW.updated_at <> OLD.revision
BEGIN
  SELECT RAISE(ABORT, 'event field value revision conflict');
END;

CREATE TRIGGER event_field_values_revision_insert_timestamp
AFTER INSERT ON event_field_values
BEGIN
  UPDATE event_field_values
     SET updated_at = unixepoch()
   WHERE definition_id = NEW.definition_id
     AND person_id IS NEW.person_id
     AND session_id IS NEW.session_id;
END;

CREATE TRIGGER event_field_values_revision_update_timestamp
AFTER UPDATE OF revision ON event_field_values
WHEN NEW.updated_at = OLD.revision
BEGIN
  UPDATE event_field_values
     SET updated_at = unixepoch()
   WHERE definition_id = NEW.definition_id
     AND person_id IS NEW.person_id
     AND session_id IS NEW.session_id;
END;

CREATE TRIGGER event_field_values_participant_retention_no_pii_insert
BEFORE INSERT ON event_field_values
WHEN NEW.person_id IS NOT NULL
AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
   WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER event_field_values_participant_retention_no_pii_update
BEFORE UPDATE OF definition_id, event_id, person_id, value_json,
                 updated_by_person_id
ON event_field_values
WHEN (OLD.person_id IS NOT NULL OR NEW.person_id IS NOT NULL)
AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
   WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

-- SQLite cannot widen a CHECK constraint in place. No table references
-- communication_triggers, so rebuild it while preserving every existing row.
ALTER TABLE communication_triggers
  RENAME TO communication_triggers_before_participant_operations;

CREATE TABLE communication_triggers (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  template_id TEXT NOT NULL REFERENCES communication_templates(id) ON DELETE CASCADE,
  trigger_type TEXT NOT NULL CHECK (trigger_type IN (
    'submission_confirmed','decision_published','task_due','task_overdue',
    'application_draft','participation_pending','schedule_published','manual'
  )),
  configuration_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(configuration_json)),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, trigger_type, template_id)
);

INSERT INTO communication_triggers (
  id, event_id, template_id, trigger_type, configuration_json,
  enabled, created_at, updated_at
)
SELECT id, event_id, template_id, trigger_type, configuration_json,
       enabled, created_at, updated_at
  FROM communication_triggers_before_participant_operations;

DROP TABLE communication_triggers_before_participant_operations;
