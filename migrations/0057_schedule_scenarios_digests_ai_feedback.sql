-- Private, non-authoritative schedule proposals. The active draft remains the
-- only schedule source of truth; a scenario stores the exact deterministic
-- auto-placement preview and the revisions it was computed against.
CREATE TABLE schedule_scenarios (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  schedule_version_id TEXT NOT NULL,
  created_by_person_id TEXT NOT NULL REFERENCES people(id),
  name TEXT NOT NULL CHECK (
    length(name) BETWEEN 1 AND 80 AND name = trim(name)
  ),
  base_schedule_revision INTEGER NOT NULL CHECK (base_schedule_revision > 0),
  event_revision INTEGER NOT NULL CHECK (event_revision > 0),
  policy_revision INTEGER NOT NULL CHECK (policy_revision > 0),
  preview_json TEXT NOT NULL CHECK (
    json_valid(preview_json)
    AND json_type(preview_json) = 'object'
    AND length(preview_json) <= 1048576
  ),
  creation_operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  discard_operation_id TEXT UNIQUE,
  discarded_at INTEGER,
  CHECK (
    (discarded_at IS NULL AND discard_operation_id IS NULL)
    OR (discarded_at >= created_at AND discard_operation_id IS NOT NULL)
  ),
  FOREIGN KEY (event_id, organisation_id)
    REFERENCES events(id, organisation_id) ON DELETE CASCADE,
  FOREIGN KEY (schedule_version_id, event_id)
    REFERENCES schedule_versions(id, event_id) ON DELETE CASCADE,
  UNIQUE(id, event_id),
  CHECK (
    instr(name, char(10)) = 0
    AND instr(name, char(13)) = 0
    AND instr(name, char(0)) = 0
  )
);

CREATE INDEX idx_schedule_scenarios_event_active
  ON schedule_scenarios(event_id, created_at DESC)
  WHERE discarded_at IS NULL;

CREATE UNIQUE INDEX ux_schedule_scenarios_active_name
  ON schedule_scenarios(event_id, lower(name))
  WHERE discarded_at IS NULL;

-- A bounded, durable summary of the exact publication preview. Counts remain
-- exact; highlights are deliberately capped by the service before storage.
CREATE TABLE schedule_publication_digests (
  schedule_version_id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  publication_operation_id TEXT NOT NULL,
  previous_version_number INTEGER CHECK (previous_version_number > 0),
  digest_json TEXT NOT NULL CHECK (
    json_valid(digest_json)
    AND json_type(digest_json) = 'object'
    AND length(digest_json) <= 1048576
  ),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (schedule_version_id, event_id)
    REFERENCES schedule_versions(id, event_id) ON DELETE CASCADE,
  UNIQUE(publication_operation_id, event_id)
);

CREATE INDEX idx_schedule_publication_digests_event_created
  ON schedule_publication_digests(event_id, created_at DESC);

-- Focused operator feedback is bound to an immutable AI operation. It is not
-- an analytics platform and contains no model prompt or response body.
CREATE TABLE ai_operation_feedback (
  id TEXT PRIMARY KEY,
  organisation_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id),
  rating TEXT NOT NULL CHECK (rating IN ('helpful','not_helpful')),
  reason TEXT CHECK (reason IS NULL OR reason IN (
    'incorrect','missing_evidence','wrong_record','unsafe','other'
  )),
  detail TEXT CHECK (
    detail IS NULL OR (
      length(detail) BETWEEN 1 AND 500 AND detail = trim(detail)
    )
  ),
  last_operation_id TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (event_id, organisation_id)
    REFERENCES events(id, organisation_id) ON DELETE CASCADE,
  FOREIGN KEY (operation_id, event_id)
    REFERENCES operation_jobs(id, event_id) ON DELETE CASCADE,
  UNIQUE(operation_id, person_id),
  CHECK (
    (rating = 'helpful' AND reason IS NULL)
    OR (rating = 'not_helpful' AND reason IS NOT NULL)
  )
);

CREATE INDEX idx_ai_operation_feedback_event_created
  ON ai_operation_feedback(event_id, created_at DESC);
