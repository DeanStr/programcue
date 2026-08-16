CREATE TABLE event_ai_review_settings (
  event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0,1)),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_person_id TEXT NOT NULL REFERENCES people(id),
  last_operation_id TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE reviewer_ai_suggestions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  assignment_id TEXT NOT NULL,
  evaluator_person_id TEXT NOT NULL REFERENCES people(id),
  assignment_revision INTEGER NOT NULL CHECK (assignment_revision > 0),
  round_id TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('submission','session')),
  target_id TEXT NOT NULL,
  source_snapshot_hash TEXT NOT NULL CHECK (length(source_snapshot_hash) = 64),
  scorecard_id TEXT NOT NULL CHECK (length(trim(scorecard_id)) > 0),
  scorecard_version INTEGER NOT NULL CHECK (scorecard_version > 0),
  suggestions_json TEXT NOT NULL CHECK (json_valid(suggestions_json)),
  provider TEXT NOT NULL CHECK (provider IN ('workers_ai','openai','anthropic')),
  model TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 200),
  provider_response_id TEXT NOT NULL CHECK (length(trim(provider_response_id)) BETWEEN 1 AND 200),
  status TEXT NOT NULL DEFAULT 'offered' CHECK (status IN ('offered','dismissed','imported')),
  generated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  dismissed_at INTEGER,
  imported_at INTEGER,
  imported_review_id TEXT,
  lifecycle_operation_id TEXT UNIQUE,
  last_operation_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (assignment_id, event_id)
    REFERENCES evaluator_assignments(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (round_id, event_id)
    REFERENCES evaluation_rounds(id, event_id) ON DELETE CASCADE,
  CHECK (
    (status = 'offered' AND dismissed_at IS NULL AND imported_at IS NULL
      AND imported_review_id IS NULL AND lifecycle_operation_id IS NULL)
    OR (status = 'dismissed' AND dismissed_at IS NOT NULL AND imported_at IS NULL
      AND imported_review_id IS NULL AND lifecycle_operation_id IS NOT NULL)
    OR (status = 'imported' AND dismissed_at IS NULL AND imported_at IS NOT NULL
      AND imported_review_id IS NOT NULL AND lifecycle_operation_id IS NOT NULL)
  )
);

CREATE INDEX idx_reviewer_ai_suggestions_assignment
  ON reviewer_ai_suggestions(event_id, assignment_id, evaluator_person_id, generated_at DESC);

CREATE UNIQUE INDEX ux_reviewer_ai_suggestions_active
  ON reviewer_ai_suggestions(event_id, assignment_id, evaluator_person_id)
  WHERE status IN ('offered','imported');

CREATE TRIGGER reviewer_ai_suggestions_generated_fields_immutable
BEFORE UPDATE OF event_id, assignment_id, evaluator_person_id,
  assignment_revision, round_id, target_type, target_id, source_snapshot_hash,
  scorecard_id, scorecard_version, suggestions_json,
  provider, model, provider_response_id, generated_at, last_operation_id
ON reviewer_ai_suggestions
BEGIN
  SELECT RAISE(ABORT, 'reviewer AI suggestion generated fields are immutable');
END;

CREATE TRIGGER reviewer_ai_suggestions_lifecycle
BEFORE UPDATE OF status, dismissed_at, imported_at, imported_review_id,
  lifecycle_operation_id
ON reviewer_ai_suggestions
WHEN NOT (
  OLD.status = 'offered'
  AND NEW.status IN ('dismissed','imported')
)
BEGIN
  SELECT RAISE(ABORT, 'reviewer AI suggestion lifecycle is immutable');
END;

CREATE TRIGGER reviewer_ai_suggestions_participant_retention_no_pii_insert
BEFORE INSERT ON reviewer_ai_suggestions
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
   WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

ALTER TABLE reviews ADD COLUMN ai_suggestion_id TEXT REFERENCES reviewer_ai_suggestions(id);
ALTER TABLE reviews ADD COLUMN imported_criterion_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(imported_criterion_ids_json));
ALTER TABLE reviews ADD COLUMN confirmed_ai_criterion_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(confirmed_ai_criterion_ids_json));

ALTER TABLE review_revisions ADD COLUMN ai_suggestion_id TEXT REFERENCES reviewer_ai_suggestions(id);
ALTER TABLE review_revisions ADD COLUMN imported_criterion_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(imported_criterion_ids_json));
ALTER TABLE review_revisions ADD COLUMN confirmed_ai_criterion_ids_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(confirmed_ai_criterion_ids_json));
