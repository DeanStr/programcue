ALTER TABLE task_instances
  ADD COLUMN evidence_mode TEXT NOT NULL DEFAULT 'none'
  CHECK (evidence_mode IN ('none','checkbox','file','text','link','admin_approval'));

ALTER TABLE task_instances
  ADD COLUMN configuration_json TEXT NOT NULL DEFAULT '{}'
  CHECK (json_valid(configuration_json));

UPDATE task_instances
   SET evidence_mode = COALESCE(
         (
           SELECT template.evidence_mode
             FROM task_templates template
            WHERE template.id = task_instances.template_id
              AND template.event_id = task_instances.event_id
         ),
         CASE task_type
           WHEN 'checklist' THEN 'checkbox'
           WHEN 'acknowledgement' THEN 'checkbox'
           WHEN 'short_form' THEN 'text'
           WHEN 'file_upload' THEN 'file'
           WHEN 'link_visit' THEN 'link'
           ELSE 'none'
         END
       ),
       configuration_json = COALESCE(
         (
           SELECT template.configuration_json
             FROM task_templates template
            WHERE template.id = task_instances.template_id
              AND template.event_id = task_instances.event_id
         ),
         '{}'
       );

DROP TRIGGER task_instances_participant_retention_no_pii_update;

CREATE TRIGGER task_instances_participant_retention_no_pii_update
BEFORE UPDATE OF event_id, target_type, target_id, owner_person_id, title, description, configuration_json, evidence_json, waiver_json, completed_by_person_id ON task_instances
WHEN (OLD.target_type = 'speaker' OR NEW.target_type = 'speaker')
AND EXISTS (
  SELECT 1 FROM participant_retention_locked_events locked
  WHERE locked.event_id IN (OLD.event_id, NEW.event_id)
)
BEGIN
  SELECT RAISE(ABORT, 'event participant retention is complete; participant PII is read-only');
END;
