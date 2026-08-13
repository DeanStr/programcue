-- Persisted AI first-pass assessments remain distinct from human reviews and
-- from subsequent administrator overrides.

CREATE TABLE ai_review_assessments (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  submission_id TEXT NOT NULL,
  scorecard_id TEXT NOT NULL CHECK (length(trim(scorecard_id)) > 0),
  scorecard_version INTEGER NOT NULL CHECK (scorecard_version > 0),
  round_revision INTEGER NOT NULL CHECK (round_revision > 0),
  score REAL NOT NULL CHECK (score BETWEEN 1 AND 5),
  rationale TEXT NOT NULL CHECK (
    length(trim(rationale)) BETWEEN 40 AND 6000
  ),
  provider TEXT NOT NULL CHECK (
    provider IN ('workers_ai','openai','anthropic')
  ),
  model TEXT NOT NULL CHECK (length(trim(model)) BETWEEN 1 AND 200),
  provider_response_id TEXT NOT NULL CHECK (
    length(trim(provider_response_id)) BETWEEN 1 AND 200
  ),
  generated_by_person_id TEXT NOT NULL REFERENCES people(id),
  generated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  override_score REAL CHECK (
    override_score IS NULL OR override_score BETWEEN 1 AND 5
  ),
  override_rationale TEXT CHECK (
    override_rationale IS NULL
    OR length(trim(override_rationale)) BETWEEN 10 AND 2000
  ),
  override_by_person_id TEXT REFERENCES people(id),
  override_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  last_operation_id TEXT NOT NULL UNIQUE,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(event_id, round_id, submission_id),
  FOREIGN KEY (round_id, event_id)
    REFERENCES evaluation_rounds(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (submission_id, event_id)
    REFERENCES submissions(id, event_id) ON DELETE CASCADE,
  CHECK (
    (
      override_score IS NULL
      AND override_rationale IS NULL
      AND override_by_person_id IS NULL
      AND override_at IS NULL
    )
    OR
    (
      override_score IS NOT NULL
      AND override_rationale IS NOT NULL
      AND override_by_person_id IS NOT NULL
      AND override_at IS NOT NULL
    )
  )
);

CREATE INDEX idx_ai_review_assessments_round
  ON ai_review_assessments(event_id, round_id, submission_id);

CREATE INDEX idx_ai_review_assessments_submission
  ON ai_review_assessments(event_id, submission_id, round_id);

CREATE TRIGGER ai_review_assessments_participant_retention_no_pii_insert
BEFORE INSERT ON ai_review_assessments
WHEN EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
   WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER ai_review_assessments_generated_fields_immutable
BEFORE UPDATE OF
  event_id,
  round_id,
  submission_id,
  scorecard_id,
  scorecard_version,
  round_revision,
  score,
  rationale,
  provider,
  model,
  provider_response_id,
  generated_by_person_id,
  generated_at
ON ai_review_assessments
BEGIN
  SELECT RAISE(ABORT, 'AI first-pass assessment fields are immutable');
END;
