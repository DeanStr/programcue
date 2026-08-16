-- Decision drafts written before the contextual evaluation evidence release do
-- not contain the two fields now required to resume the exact saved draft.
-- Refuse structurally invalid evidence, then make that deployed legacy state
-- explicit rather than adding a silent read-time fallback.
CREATE TABLE migration_0032_decision_preview_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO migration_0032_decision_preview_guard (valid)
SELECT 0
  FROM submission_decisions
 WHERE json_type(effect_preview_json) <> 'object'
 LIMIT 1;

DROP TABLE migration_0032_decision_preview_guard;

UPDATE submission_decisions
   SET effect_preview_json = json_set(
     effect_preview_json,
     '$.includeReviewerFeedback',
     json('false')
   )
 WHERE json_type(effect_preview_json, '$.includeReviewerFeedback') IS NULL;

UPDATE submission_decisions
   SET effect_preview_json = json_set(
     effect_preview_json,
     '$.sessionDurationMinutes',
     json('null')
   )
 WHERE json_type(effect_preview_json, '$.sessionDurationMinutes') IS NULL;
