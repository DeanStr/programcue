-- Evaluation round depth: round-owned blind settings and scorecard snapshots,
-- typed dropdown criteria, and explicit round reviewer pools.

ALTER TABLE evaluation_rounds
  ADD COLUMN blinded_reviewing INTEGER NOT NULL DEFAULT 0
    CHECK (blinded_reviewing IN (0,1));

ALTER TABLE evaluation_rounds
  ADD COLUMN scorecard_id TEXT NOT NULL DEFAULT '';

ALTER TABLE evaluation_rounds
  ADD COLUMN scorecard_version INTEGER NOT NULL DEFAULT 1
    CHECK (scorecard_version > 0);

ALTER TABLE evaluator_assignments
  ADD COLUMN cancellation_reason TEXT
    CHECK (
      cancellation_reason IS NULL
      OR cancellation_reason IN (
        'reviewer_removed',
        'submission_withdrawn',
        'decision_published'
      )
    );

UPDATE evaluation_rounds
   SET scorecard_id = id
 WHERE scorecard_id = '';

-- Preserve the pre-depth plan-wide anonymity setting when it is split into
-- round-owned settings. New writes can then diverge by round explicitly.
UPDATE evaluation_rounds
   SET blinded_reviewing = COALESCE((
     SELECT plan.blinded_reviewing
       FROM evaluation_plans plan
      WHERE plan.id = evaluation_rounds.plan_id
        AND plan.event_id = evaluation_rounds.event_id
   ), 0);

CREATE TRIGGER evaluation_rounds_scorecard_id_required_insert
BEFORE INSERT ON evaluation_rounds
WHEN trim(NEW.scorecard_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'evaluation round scorecard_id is required');
END;

CREATE TRIGGER evaluation_rounds_scorecard_id_required_update
BEFORE UPDATE OF scorecard_id ON evaluation_rounds
WHEN trim(NEW.scorecard_id) = ''
BEGIN
  SELECT RAISE(ABORT, 'evaluation round scorecard_id is required');
END;

-- The original criterion CHECK cannot be widened with ALTER TABLE. Rebuild the
-- small pre-release table so dropdown is a real persisted type and its ordered
-- options remain JSON data, not a free-text answer.
ALTER TABLE evaluation_criteria RENAME TO evaluation_criteria_legacy;

CREATE TABLE evaluation_criteria (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  input_type TEXT NOT NULL DEFAULT 'scale_5'
    CHECK (input_type IN ('scale_5','scale_10','yes_no','free_text','dropdown')),
  options_json TEXT NOT NULL DEFAULT '[]'
    CHECK (json_valid(options_json) AND json_type(options_json) = 'array'),
  weight_percent INTEGER NOT NULL DEFAULT 0 CHECK (weight_percent BETWEEN 0 AND 100),
  required INTEGER NOT NULL DEFAULT 1 CHECK (required IN (0,1)),
  position INTEGER NOT NULL CHECK (position >= 0),
  FOREIGN KEY (round_id, event_id) REFERENCES evaluation_rounds(id, event_id) ON DELETE CASCADE,
  UNIQUE(round_id, position),
  CHECK ((input_type IN ('free_text','yes_no','dropdown')) OR weight_percent > 0),
  CHECK (
    (input_type = 'dropdown' AND json_array_length(options_json) > 0)
    OR
    (input_type <> 'dropdown' AND json_array_length(options_json) = 0)
  )
);

INSERT INTO evaluation_criteria (
  id, event_id, round_id, name, description, input_type, options_json,
  weight_percent, required, position
)
SELECT id, event_id, round_id, name, description, input_type, '[]',
       weight_percent, required, position
  FROM evaluation_criteria_legacy;

DROP TABLE evaluation_criteria_legacy;

CREATE UNIQUE INDEX evaluation_criteria_position_unique
  ON evaluation_criteria(round_id, position);

CREATE TABLE evaluation_round_reviewers (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  person_id TEXT NOT NULL REFERENCES people(id) ON DELETE CASCADE,
  added_by_person_id TEXT REFERENCES people(id),
  revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(round_id, person_id),
  UNIQUE(id, event_id),
  FOREIGN KEY (round_id, event_id) REFERENCES evaluation_rounds(id, event_id) ON DELETE CASCADE
);

-- Preserve access for reviewers who already hold assignments when the
-- round-scoped pool is introduced. The pool is intentionally seeded from
-- assignments, not from every event evaluator, so newly added rounds remain
-- independently scoped.
INSERT INTO evaluation_round_reviewers (
  id, event_id, round_id, person_id, added_by_person_id,
  revision, created_at, updated_at
)
SELECT 'migration-round-reviewer:' || assignment.event_id || ':' ||
       assignment.round_id || ':' || assignment.evaluator_person_id,
       assignment.event_id, assignment.round_id, assignment.evaluator_person_id,
       NULL, 1, unixepoch(), unixepoch()
  FROM (
    SELECT DISTINCT event_id, round_id, evaluator_person_id
      FROM evaluator_assignments
  ) assignment;

CREATE INDEX idx_evaluation_round_reviewers_round
  ON evaluation_round_reviewers(event_id, round_id, person_id);
CREATE INDEX idx_evaluation_round_reviewers_person
  ON evaluation_round_reviewers(event_id, person_id, round_id);
CREATE INDEX idx_evaluation_rounds_schedule
  ON evaluation_rounds(event_id, opens_at, closes_at, status);
