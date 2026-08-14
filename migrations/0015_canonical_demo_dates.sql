-- Migration 0015 updates the production evaluation fixture, which was seeded
-- before its canonical event moved from 2025 to 2027. Runtime seed helpers
-- intentionally do not overwrite
-- existing rows, so migrate the stable fixture identifiers once instead of
-- adding a compatibility path to every demo loader.
UPDATE events
   SET name = 'Future of Events 2027',
       starts_at = unixepoch('2027-05-20T00:00:00Z'),
       ends_at = unixepoch('2027-05-22T23:59:59Z'),
       revision = revision + 1,
       updated_at = unixepoch()
 WHERE id = 'evt-foe-2025'
   AND slug = 'future-of-events-2025';

UPDATE schedule_entries
   SET starts_at = CASE id
         WHEN 'demo-entry-1' THEN unixepoch('2027-05-20T13:00:00Z')
         WHEN 'demo-entry-2' THEN unixepoch('2027-05-20T14:00:00Z')
         WHEN 'demo-entry-3' THEN unixepoch('2027-05-20T15:15:00Z')
         WHEN 'demo-entry-4' THEN unixepoch('2027-05-21T13:30:00Z')
         WHEN 'demo-entry-5' THEN unixepoch('2027-05-21T17:00:00Z')
       END,
       ends_at = CASE id
         WHEN 'demo-entry-1' THEN unixepoch('2027-05-20T13:45:00Z')
         WHEN 'demo-entry-2' THEN unixepoch('2027-05-20T15:00:00Z')
         WHEN 'demo-entry-3' THEN unixepoch('2027-05-20T16:15:00Z')
         WHEN 'demo-entry-4' THEN unixepoch('2027-05-21T14:15:00Z')
         WHEN 'demo-entry-5' THEN unixepoch('2027-05-21T18:00:00Z')
       END,
       revision = revision + 1,
       updated_at = unixepoch()
 WHERE event_id = 'evt-foe-2025'
   AND schedule_version_id = 'demo-schedule-published'
   AND id IN (
     'demo-entry-1',
     'demo-entry-2',
     'demo-entry-3',
     'demo-entry-4',
     'demo-entry-5'
   );

UPDATE form_definitions
   SET closes_at = unixepoch('2027-05-01T03:59:59Z'),
       revision = revision + 1,
       updated_at = unixepoch()
 WHERE event_id = 'evt-foe-2025'
   AND public_slug = 'form';

UPDATE form_versions
   SET settings_snapshot_json = json_set(
         settings_snapshot_json,
         '$.closesAt',
         unixepoch('2027-05-01T03:59:59Z')
       ),
       revision = revision + 1,
       updated_at = unixepoch()
 WHERE event_id = 'evt-foe-2025'
   AND form_id IN (
     SELECT id
       FROM form_definitions
      WHERE event_id = 'evt-foe-2025'
        AND public_slug = 'form'
   );

UPDATE task_templates
   SET fixed_due_at = CASE id
         WHEN 'task-template-profile' THEN unixepoch('2027-05-10T16:00:00Z')
         WHEN 'task-template-slides' THEN unixepoch('2027-05-10T16:00:00Z')
         WHEN 'task-template-handbook' THEN unixepoch('2027-05-12T16:00:00Z')
       END,
       updated_at = unixepoch()
 WHERE event_id = 'evt-foe-2025'
   AND id IN (
     'task-template-profile',
     'task-template-slides',
     'task-template-handbook'
   );

UPDATE task_instances
   SET due_at = CASE id
         WHEN 'task-demo-profile' THEN unixepoch('2027-05-10T16:00:00Z')
         WHEN 'task-demo-slides' THEN unixepoch('2027-05-16T16:00:00Z')
         WHEN 'task-demo-handbook' THEN unixepoch('2027-05-12T16:00:00Z')
       END,
       revision = revision + 1,
       updated_at = unixepoch()
 WHERE event_id = 'evt-foe-2025'
   AND id IN ('task-demo-profile', 'task-demo-slides', 'task-demo-handbook');
