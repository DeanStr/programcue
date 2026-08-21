DROP TRIGGER task_instances_participant_retention_no_pii_insert;
DROP TRIGGER task_instances_participant_retention_no_pii_update;
DROP TRIGGER task_comments_participant_retention_no_pii_insert;
DROP TRIGGER task_comments_participant_retention_no_pii_update;
DROP TRIGGER task_evidence_participant_retention_no_pii_insert;
DROP TRIGGER task_evidence_participant_retention_no_pii_update;

CREATE TRIGGER task_instances_participant_retention_no_pii_insert
BEFORE INSERT ON task_instances
WHEN (
  NEW.target_type = 'speaker'
  OR (
    NEW.target_type = 'session'
    AND json_extract(NEW.configuration_json, '$.preset') = 'session_details_review_v1'
  )
) AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id = NEW.event_id
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER task_instances_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, target_type, target_id, owner_person_id, title, description, configuration_json, evidence_json, waiver_json, completed_by_person_id ON task_instances
WHEN (
  OLD.target_type = 'speaker'
  OR NEW.target_type = 'speaker'
  OR (
    OLD.target_type = 'session'
    AND json_extract(OLD.configuration_json, '$.preset') = 'session_details_review_v1'
  )
  OR (
    NEW.target_type = 'session'
    AND json_extract(NEW.configuration_json, '$.preset') = 'session_details_review_v1'
  )
) AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER task_comments_participant_retention_no_pii_insert
BEFORE INSERT ON task_comments
WHEN EXISTS (
  SELECT 1 FROM task_instances task
  JOIN participant_retention_locked_events locked ON locked.event_id = task.event_id
  WHERE task.id = NEW.task_id AND task.event_id = NEW.event_id
    AND (
      task.target_type = 'speaker'
      OR (
        task.target_type = 'session'
        AND json_extract(task.configuration_json, '$.preset') = 'session_details_review_v1'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER task_comments_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, task_id, author_person_id, body ON task_comments
WHEN EXISTS (
  SELECT 1 FROM task_instances task
  JOIN participant_retention_locked_events locked ON locked.event_id = task.event_id
  WHERE task.id IN (OLD.task_id, NEW.task_id)
    AND task.event_id IN (OLD.event_id, NEW.event_id)
    AND (
      task.target_type = 'speaker'
      OR (
        task.target_type = 'session'
        AND json_extract(task.configuration_json, '$.preset') = 'session_details_review_v1'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER task_evidence_participant_retention_no_pii_insert
BEFORE INSERT ON task_evidence
WHEN EXISTS (
  SELECT 1 FROM task_instances task
  JOIN participant_retention_locked_events locked ON locked.event_id = task.event_id
  WHERE task.id = NEW.task_id AND task.event_id = NEW.event_id
    AND (
      task.target_type = 'speaker'
      OR (
        task.target_type = 'session'
        AND json_extract(task.configuration_json, '$.preset') = 'session_details_review_v1'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;

CREATE TRIGGER task_evidence_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, task_id, submitted_by_person_id, file_asset_id, evidence_json ON task_evidence
WHEN EXISTS (
  SELECT 1 FROM task_instances task
  JOIN participant_retention_locked_events locked ON locked.event_id = task.event_id
  WHERE task.id IN (OLD.task_id, NEW.task_id)
    AND task.event_id IN (OLD.event_id, NEW.event_id)
    AND (
      task.target_type = 'speaker'
      OR (
        task.target_type = 'session'
        AND json_extract(task.configuration_json, '$.preset') = 'session_details_review_v1'
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;
