-- Distinguish reviewer conflicts from non-conflict inability to review while
-- preserving the existing recused terminal assignment lifecycle.
ALTER TABLE evaluator_assignments
  ADD COLUMN abstention_reason TEXT
  CHECK (abstention_reason IS NULL OR abstention_reason IN (
    'conflict','insufficient_expertise','unavailable','other'
  ));

ALTER TABLE evaluator_assignments
  ADD COLUMN abstention_note TEXT
  CHECK (
    abstention_note IS NULL
    OR (
      length(abstention_note) BETWEEN 1 AND 2000
      AND abstention_note = trim(abstention_note)
    )
  );

ALTER TABLE evaluator_assignments
  ADD COLUMN abstained_at INTEGER;

UPDATE evaluator_assignments
   SET abstention_reason = CASE
         WHEN conflict_declared_at IS NOT NULL OR EXISTS (
           SELECT 1 FROM evaluator_conflicts conflict
            WHERE conflict.event_id = evaluator_assignments.event_id
              AND conflict.round_id = evaluator_assignments.round_id
              AND conflict.evaluator_person_id = evaluator_assignments.evaluator_person_id
              AND conflict.submission_id IS evaluator_assignments.submission_id
              AND conflict.session_id IS evaluator_assignments.session_id
         ) THEN 'conflict'
         ELSE 'other'
       END,
       abstained_at = COALESCE(conflict_declared_at, assigned_at)
 WHERE status = 'recused' AND abstention_reason IS NULL;

CREATE INDEX idx_assignments_event_abstention
  ON evaluator_assignments(event_id, status, abstention_reason);

-- A schedule-publication trigger is the event-level opt-in and must have one
-- authoritative template selection per event.
CREATE UNIQUE INDEX ux_schedule_published_trigger_event
  ON communication_triggers(event_id)
  WHERE trigger_type = 'schedule_published';
