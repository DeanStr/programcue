-- Decision previews written before accepted drafts persisted the selected
-- current Event Setup format have no sessionFormatKey property. Preserve that
-- known legacy state explicitly so the strict loader can ask the organiser to
-- choose again without inferring a format from the submitted label.
CREATE TABLE migration_0033_decision_format_guard (
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO migration_0033_decision_format_guard (valid)
SELECT 0
  FROM submission_decisions
 WHERE status = 'draft'
   AND json_type(effect_preview_json) <> 'object'
 LIMIT 1;

DROP TABLE migration_0033_decision_format_guard;

UPDATE submission_decisions
   SET effect_preview_json = json_set(
     effect_preview_json,
     '$.sessionFormatKey',
     json('null')
   )
 WHERE status = 'draft'
   AND json_type(effect_preview_json, '$.sessionFormatKey') IS NULL;
