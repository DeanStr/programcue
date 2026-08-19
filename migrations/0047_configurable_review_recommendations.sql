-- Reviewer recommendations are configured per round. The ordered JSON array
-- contains stable choice IDs and editable labels. Existing rounds and review
-- history retain the former five choices exactly.
ALTER TABLE evaluation_rounds
  ADD COLUMN recommendation_choices_json TEXT NOT NULL
  DEFAULT '[{"id":"accept","label":"Accept"},{"id":"minor_changes","label":"Minor"},{"id":"conditional_accept","label":"Conditional"},{"id":"waitlist","label":"Waitlist"},{"id":"reject","label":"Reject"}]'
  CHECK (
    json_valid(recommendation_choices_json)
    AND json_type(recommendation_choices_json) = 'array'
    AND json_array_length(recommendation_choices_json) BETWEEN 2 AND 7
  );

ALTER TABLE reviews
  ADD COLUMN recommendation_choices_snapshot_json TEXT NOT NULL
  DEFAULT '[{"id":"accept","label":"Accept"},{"id":"minor_changes","label":"Minor"},{"id":"conditional_accept","label":"Conditional"},{"id":"waitlist","label":"Waitlist"},{"id":"reject","label":"Reject"}]'
  CHECK (
    json_valid(recommendation_choices_snapshot_json)
    AND json_type(recommendation_choices_snapshot_json) = 'array'
    AND json_array_length(recommendation_choices_snapshot_json) BETWEEN 2 AND 7
  );

-- SQLite cannot remove only the old column-level enum constraint. Copy the
-- selected stable IDs through a temporary column, then replace the constrained
-- column without changing any historical value.
ALTER TABLE reviews ADD COLUMN recommendation_choice_id TEXT;
UPDATE reviews SET recommendation_choice_id = recommendation;
ALTER TABLE reviews DROP COLUMN recommendation;
ALTER TABLE reviews RENAME COLUMN recommendation_choice_id TO recommendation;

ALTER TABLE review_revisions
  ADD COLUMN recommendation_choices_snapshot_json TEXT NOT NULL
  DEFAULT '[{"id":"accept","label":"Accept"},{"id":"minor_changes","label":"Minor"},{"id":"conditional_accept","label":"Conditional"},{"id":"waitlist","label":"Waitlist"},{"id":"reject","label":"Reject"}]'
  CHECK (
    json_valid(recommendation_choices_snapshot_json)
    AND json_type(recommendation_choices_snapshot_json) = 'array'
    AND json_array_length(recommendation_choices_snapshot_json) BETWEEN 2 AND 7
  );

CREATE TRIGGER evaluation_round_recommendation_choices_valid_insert
BEFORE INSERT ON evaluation_rounds
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.recommendation_choices_json) choice
   WHERE choice.type <> 'object'
      OR json_type(choice.value, '$.id') <> 'text'
      OR length(trim(json_extract(choice.value, '$.id'))) NOT BETWEEN 1 AND 80
      OR json_extract(choice.value, '$.id') <> trim(json_extract(choice.value, '$.id'))
      OR json_extract(choice.value, '$.id') = 'mixed'
      OR json_type(choice.value, '$.label') <> 'text'
      OR length(trim(json_extract(choice.value, '$.label'))) NOT BETWEEN 1 AND 120
      OR json_extract(choice.value, '$.label') <> trim(json_extract(choice.value, '$.label'))
)
OR EXISTS (
  SELECT 1
    FROM json_each(NEW.recommendation_choices_json) choice,
         json_each(choice.value) field
   WHERE field.key NOT IN ('id', 'label')
      OR (SELECT COUNT(*) FROM json_each(choice.value)) <> 2
)
OR (
  SELECT COUNT(DISTINCT json_extract(choice.value, '$.id'))
    FROM json_each(NEW.recommendation_choices_json) choice
) <> json_array_length(NEW.recommendation_choices_json)
OR (
  SELECT COUNT(DISTINCT lower(trim(json_extract(choice.value, '$.label'))))
    FROM json_each(NEW.recommendation_choices_json) choice
) <> json_array_length(NEW.recommendation_choices_json)
BEGIN
  SELECT RAISE(ABORT, 'evaluation round recommendation choices are invalid');
END;

CREATE TRIGGER evaluation_round_recommendation_choices_valid_update
BEFORE UPDATE OF recommendation_choices_json ON evaluation_rounds
WHEN EXISTS (
  SELECT 1 FROM json_each(NEW.recommendation_choices_json) choice
   WHERE choice.type <> 'object'
      OR json_type(choice.value, '$.id') <> 'text'
      OR length(trim(json_extract(choice.value, '$.id'))) NOT BETWEEN 1 AND 80
      OR json_extract(choice.value, '$.id') <> trim(json_extract(choice.value, '$.id'))
      OR json_extract(choice.value, '$.id') = 'mixed'
      OR json_type(choice.value, '$.label') <> 'text'
      OR length(trim(json_extract(choice.value, '$.label'))) NOT BETWEEN 1 AND 120
      OR json_extract(choice.value, '$.label') <> trim(json_extract(choice.value, '$.label'))
)
OR EXISTS (
  SELECT 1
    FROM json_each(NEW.recommendation_choices_json) choice,
         json_each(choice.value) field
   WHERE field.key NOT IN ('id', 'label')
      OR (SELECT COUNT(*) FROM json_each(choice.value)) <> 2
)
OR (
  SELECT COUNT(DISTINCT json_extract(choice.value, '$.id'))
    FROM json_each(NEW.recommendation_choices_json) choice
) <> json_array_length(NEW.recommendation_choices_json)
OR (
  SELECT COUNT(DISTINCT lower(trim(json_extract(choice.value, '$.label'))))
    FROM json_each(NEW.recommendation_choices_json) choice
) <> json_array_length(NEW.recommendation_choices_json)
BEGIN
  SELECT RAISE(ABORT, 'evaluation round recommendation choices are invalid');
END;

CREATE TRIGGER evaluation_round_recommendation_choices_immutable
BEFORE UPDATE OF recommendation_choices_json ON evaluation_rounds
WHEN NEW.recommendation_choices_json <> OLD.recommendation_choices_json
 AND EXISTS (
   SELECT 1 FROM evaluator_assignments assignment
    WHERE assignment.event_id = OLD.event_id
      AND assignment.round_id = OLD.id
 )
BEGIN
  SELECT RAISE(ABORT, 'assigned round recommendation choices are immutable');
END;

CREATE TRIGGER reviews_recommendation_choice_insert
BEFORE INSERT ON reviews
WHEN NEW.recommendation_choices_snapshot_json <> (
  SELECT round.recommendation_choices_json
    FROM evaluator_assignments assignment
    JOIN evaluation_rounds round
      ON round.id = assignment.round_id AND round.event_id = assignment.event_id
   WHERE assignment.id = NEW.assignment_id AND assignment.event_id = NEW.event_id
)
OR (
  NEW.recommendation IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.recommendation_choices_snapshot_json) choice
     WHERE json_extract(choice.value, '$.id') = NEW.recommendation
  )
)
BEGIN
  SELECT RAISE(ABORT, 'review recommendation is not in its round choice snapshot');
END;

CREATE TRIGGER reviews_recommendation_choice_update
BEFORE UPDATE OF event_id, assignment_id, recommendation,
                 recommendation_choices_snapshot_json ON reviews
WHEN NEW.recommendation_choices_snapshot_json <> OLD.recommendation_choices_snapshot_json
OR NEW.recommendation_choices_snapshot_json <> (
  SELECT round.recommendation_choices_json
    FROM evaluator_assignments assignment
    JOIN evaluation_rounds round
      ON round.id = assignment.round_id AND round.event_id = assignment.event_id
   WHERE assignment.id = NEW.assignment_id AND assignment.event_id = NEW.event_id
)
OR (
  NEW.recommendation IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.recommendation_choices_snapshot_json) choice
     WHERE json_extract(choice.value, '$.id') = NEW.recommendation
  )
)
BEGIN
  SELECT RAISE(ABORT, 'review recommendation is not in its immutable choice snapshot');
END;

CREATE TRIGGER review_revisions_recommendation_snapshot_insert
BEFORE INSERT ON review_revisions
WHEN NEW.recommendation_choices_snapshot_json <> (
  SELECT review.recommendation_choices_snapshot_json
    FROM reviews review
   WHERE review.id = NEW.review_id AND review.event_id = NEW.event_id
)
OR (
  json_extract(NEW.content_json, '$.recommendation') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.recommendation_choices_snapshot_json) choice
     WHERE json_extract(choice.value, '$.id') =
           json_extract(NEW.content_json, '$.recommendation')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'review revision recommendation snapshot is inconsistent');
END;

CREATE TRIGGER review_revisions_recommendation_snapshot_update
BEFORE UPDATE OF event_id, review_id, content_json,
                 recommendation_choices_snapshot_json ON review_revisions
WHEN NEW.recommendation_choices_snapshot_json <> OLD.recommendation_choices_snapshot_json
OR (
  json_extract(NEW.content_json, '$.recommendation') IS NOT
  json_extract(OLD.content_json, '$.recommendation')
  AND NOT (
    COALESCE(json_extract(NEW.content_json, '$.redacted'), 0) = 1
    AND json_extract(NEW.content_json, '$.recommendation') IS NULL
  )
)
OR NEW.recommendation_choices_snapshot_json <> (
  SELECT review.recommendation_choices_snapshot_json
    FROM reviews review
   WHERE review.id = NEW.review_id AND review.event_id = NEW.event_id
)
OR (
  json_extract(NEW.content_json, '$.recommendation') IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM json_each(NEW.recommendation_choices_snapshot_json) choice
     WHERE json_extract(choice.value, '$.id') =
           json_extract(NEW.content_json, '$.recommendation')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'review revision recommendation snapshot is immutable and must remain consistent');
END;
