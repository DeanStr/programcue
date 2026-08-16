-- 0034 is the reviewer-AI baseline and 0035 is already deployed. Both must
-- remain immutable. Upgrade databases that recorded the baseline, rejecting
-- contradictory provenance rather than carrying an invalid relationship into
-- the hardened schema.
CREATE TABLE reviewer_ai_hardening_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO reviewer_ai_hardening_guard (valid)
SELECT CASE WHEN EXISTS (
  SELECT 1
    FROM reviewer_ai_suggestions suggestion
   WHERE (
     suggestion.status = 'imported'
     AND NOT EXISTS (
       SELECT 1
         FROM reviews review
        WHERE review.id = suggestion.imported_review_id
          AND review.event_id = suggestion.event_id
          AND review.assignment_id = suggestion.assignment_id
          AND review.ai_suggestion_id = suggestion.id
     )
   ) OR EXISTS (
     SELECT 1
       FROM reviews review
       JOIN reviewer_ai_suggestions referenced
         ON referenced.id = review.ai_suggestion_id
      WHERE review.ai_suggestion_id IS NOT NULL
        AND (
          referenced.event_id <> review.event_id
          OR referenced.assignment_id <> review.assignment_id
          OR referenced.status <> 'imported'
        )
   ) OR EXISTS (
     SELECT 1
       FROM review_revisions revision
       JOIN reviews review
         ON review.id = revision.review_id
        AND review.event_id = revision.event_id
       JOIN reviewer_ai_suggestions referenced
         ON referenced.id = revision.ai_suggestion_id
      WHERE revision.ai_suggestion_id IS NOT NULL
        AND (
          review.ai_suggestion_id <> revision.ai_suggestion_id
          OR referenced.event_id <> review.event_id
          OR referenced.assignment_id <> review.assignment_id
          OR referenced.status <> 'imported'
        )
   )
) THEN 0 ELSE 1 END;

DROP TABLE reviewer_ai_hardening_guard;

-- Remove the redundant imported_review_id column and its table-level CHECK.
-- D1 keeps foreign keys enabled inside migrations. Preserve the nullable child
-- links explicitly, clear them for the parent replacement, then restore them.
-- The migration is atomic, so no writer can observe the temporary nulls.
CREATE TABLE reviewer_ai_review_links_before_hardening (
  review_id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL
);

INSERT INTO reviewer_ai_review_links_before_hardening (
  review_id, suggestion_id
)
SELECT id, ai_suggestion_id
  FROM reviews
 WHERE ai_suggestion_id IS NOT NULL;

CREATE TABLE reviewer_ai_revision_links_before_hardening (
  revision_id TEXT PRIMARY KEY,
  suggestion_id TEXT NOT NULL
);

INSERT INTO reviewer_ai_revision_links_before_hardening (
  revision_id, suggestion_id
)
SELECT id, ai_suggestion_id
  FROM review_revisions
 WHERE ai_suggestion_id IS NOT NULL;

UPDATE review_revisions SET ai_suggestion_id = NULL
 WHERE ai_suggestion_id IS NOT NULL;
UPDATE reviews SET ai_suggestion_id = NULL
 WHERE ai_suggestion_id IS NOT NULL;

CREATE TABLE reviewer_ai_suggestions_hardened (
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
  lifecycle_operation_id TEXT UNIQUE,
  last_operation_id TEXT NOT NULL UNIQUE,
  FOREIGN KEY (assignment_id, event_id)
    REFERENCES evaluator_assignments(id, event_id) ON DELETE CASCADE,
  FOREIGN KEY (round_id, event_id)
    REFERENCES evaluation_rounds(id, event_id) ON DELETE CASCADE,
  CHECK (
    (status = 'offered' AND dismissed_at IS NULL AND imported_at IS NULL
      AND lifecycle_operation_id IS NULL)
    OR (status = 'dismissed' AND dismissed_at IS NOT NULL AND imported_at IS NULL
      AND lifecycle_operation_id IS NOT NULL)
    OR (status = 'imported' AND dismissed_at IS NULL AND imported_at IS NOT NULL
      AND lifecycle_operation_id IS NOT NULL)
  )
);

INSERT INTO reviewer_ai_suggestions_hardened (
  id, event_id, assignment_id, evaluator_person_id, assignment_revision,
  round_id, target_type, target_id, source_snapshot_hash, scorecard_id,
  scorecard_version, suggestions_json, provider, model, provider_response_id,
  status, generated_at, dismissed_at, imported_at, lifecycle_operation_id,
  last_operation_id
)
SELECT
  id, event_id, assignment_id, evaluator_person_id, assignment_revision,
  round_id, target_type, target_id, source_snapshot_hash, scorecard_id,
  scorecard_version, suggestions_json, provider, model, provider_response_id,
  status, generated_at, dismissed_at, imported_at, lifecycle_operation_id,
  last_operation_id
FROM reviewer_ai_suggestions;

DROP TABLE reviewer_ai_suggestions;
ALTER TABLE reviewer_ai_suggestions_hardened RENAME TO reviewer_ai_suggestions;

UPDATE reviews
   SET ai_suggestion_id = (
     SELECT link.suggestion_id
       FROM reviewer_ai_review_links_before_hardening link
      WHERE link.review_id = reviews.id
   )
 WHERE id IN (
   SELECT review_id FROM reviewer_ai_review_links_before_hardening
 );

UPDATE review_revisions
   SET ai_suggestion_id = (
     SELECT link.suggestion_id
       FROM reviewer_ai_revision_links_before_hardening link
      WHERE link.revision_id = review_revisions.id
   )
 WHERE id IN (
   SELECT revision_id FROM reviewer_ai_revision_links_before_hardening
 );

DROP TABLE reviewer_ai_review_links_before_hardening;
DROP TABLE reviewer_ai_revision_links_before_hardening;

CREATE INDEX idx_reviewer_ai_suggestions_assignment
  ON reviewer_ai_suggestions(event_id, assignment_id, evaluator_person_id, generated_at DESC);

CREATE UNIQUE INDEX ux_reviewer_ai_suggestions_active
  ON reviewer_ai_suggestions(event_id, assignment_id, evaluator_person_id)
  WHERE status IN ('offered','imported');

CREATE INDEX idx_reviewer_ai_operations_organisation_usage
  ON operation_jobs(organisation_id, type, created_at DESC);

CREATE INDEX idx_reviewer_ai_operations_assignment_usage
  ON operation_jobs(event_id, json_extract(payload_json, '$.assignmentId'), created_at DESC)
  WHERE type = 'ai.reviewer_suggestion.generate';

CREATE TRIGGER reviewer_ai_suggestions_assignment_provenance_insert
BEFORE INSERT ON reviewer_ai_suggestions
WHEN NOT EXISTS (
  SELECT 1
    FROM evaluator_assignments assignment
    JOIN evaluation_rounds round
      ON round.id = assignment.round_id
     AND round.event_id = assignment.event_id
   WHERE assignment.id = NEW.assignment_id
     AND assignment.event_id = NEW.event_id
     AND assignment.evaluator_person_id = NEW.evaluator_person_id
     AND assignment.revision = NEW.assignment_revision
     AND assignment.round_id = NEW.round_id
     AND round.scorecard_id = NEW.scorecard_id
     AND round.scorecard_version = NEW.scorecard_version
     AND (
       (NEW.target_type = 'submission'
        AND assignment.submission_id = NEW.target_id
        AND assignment.session_id IS NULL)
       OR
       (NEW.target_type = 'session'
        AND assignment.session_id = NEW.target_id
        AND assignment.submission_id IS NULL)
     )
)
BEGIN
  SELECT RAISE(ABORT, 'reviewer AI suggestion assignment provenance is inconsistent');
END;

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
BEFORE UPDATE OF status, dismissed_at, imported_at, lifecycle_operation_id
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

CREATE TRIGGER reviews_ai_suggestion_provenance_insert
BEFORE INSERT ON reviews
WHEN NEW.ai_suggestion_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM reviewer_ai_suggestions suggestion
   WHERE suggestion.id = NEW.ai_suggestion_id
     AND suggestion.event_id = NEW.event_id
     AND suggestion.assignment_id = NEW.assignment_id
     AND suggestion.status IN ('offered','imported')
)
BEGIN
  SELECT RAISE(ABORT, 'review AI suggestion provenance is inconsistent');
END;

CREATE TRIGGER reviews_ai_suggestion_provenance_update
BEFORE UPDATE OF event_id, assignment_id, ai_suggestion_id ON reviews
WHEN NEW.ai_suggestion_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM reviewer_ai_suggestions suggestion
   WHERE suggestion.id = NEW.ai_suggestion_id
     AND suggestion.event_id = NEW.event_id
     AND suggestion.assignment_id = NEW.assignment_id
     AND suggestion.status IN ('offered','imported')
)
BEGIN
  SELECT RAISE(ABORT, 'review AI suggestion provenance is inconsistent');
END;

CREATE TRIGGER reviewer_ai_suggestions_import_requires_review
BEFORE UPDATE OF status, imported_at, lifecycle_operation_id
ON reviewer_ai_suggestions
WHEN NEW.status = 'imported' AND NOT EXISTS (
  SELECT 1
    FROM reviews review
   WHERE review.event_id = NEW.event_id
     AND review.assignment_id = NEW.assignment_id
     AND review.ai_suggestion_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'imported reviewer AI suggestion requires its review');
END;

CREATE TRIGGER reviewer_ai_suggestions_dismiss_requires_unreferenced
BEFORE UPDATE OF status, dismissed_at, lifecycle_operation_id
ON reviewer_ai_suggestions
WHEN NEW.status = 'dismissed' AND EXISTS (
  SELECT 1 FROM reviews review WHERE review.ai_suggestion_id = NEW.id
)
BEGIN
  SELECT RAISE(ABORT, 'referenced reviewer AI suggestion cannot be dismissed');
END;

CREATE TRIGGER review_revisions_ai_suggestion_provenance_insert
BEFORE INSERT ON review_revisions
WHEN NEW.ai_suggestion_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM reviews review
    JOIN reviewer_ai_suggestions suggestion
      ON suggestion.id = NEW.ai_suggestion_id
     AND suggestion.event_id = review.event_id
     AND suggestion.assignment_id = review.assignment_id
     AND suggestion.status = 'imported'
   WHERE review.id = NEW.review_id
     AND review.event_id = NEW.event_id
     AND review.ai_suggestion_id = NEW.ai_suggestion_id
)
BEGIN
  SELECT RAISE(ABORT, 'review revision AI suggestion provenance is inconsistent');
END;

CREATE TRIGGER review_revisions_ai_suggestion_provenance_update
BEFORE UPDATE OF event_id, review_id, ai_suggestion_id ON review_revisions
WHEN NEW.ai_suggestion_id IS NOT NULL AND NOT EXISTS (
  SELECT 1
    FROM reviews review
    JOIN reviewer_ai_suggestions suggestion
      ON suggestion.id = NEW.ai_suggestion_id
     AND suggestion.event_id = review.event_id
     AND suggestion.assignment_id = review.assignment_id
     AND suggestion.status = 'imported'
   WHERE review.id = NEW.review_id
     AND review.event_id = NEW.event_id
     AND review.ai_suggestion_id = NEW.ai_suggestion_id
)
BEGIN
  SELECT RAISE(ABORT, 'review revision AI suggestion provenance is inconsistent');
END;
