-- Published schedule snapshots created after the original content-management
-- migration but before publication required approval still carry the default
-- draft label. Preserve that already-public content and attribute its legacy
-- approval to the real schedule-version creator at the publication boundary.
UPDATE schedule_session_contents
   SET content_status = 'approved',
       approved_by_person_id = (
         SELECT version.created_by_person_id
           FROM schedule_versions version
          WHERE version.id = schedule_session_contents.schedule_version_id
            AND version.event_id = schedule_session_contents.event_id
       ),
       approved_at = COALESCE(
         (
           SELECT version.published_at
             FROM schedule_versions version
            WHERE version.id = schedule_session_contents.schedule_version_id
              AND version.event_id = schedule_session_contents.event_id
         ),
         updated_at
       )
 WHERE content_status <> 'approved'
   AND EXISTS (
     SELECT 1 FROM schedule_versions version
      WHERE version.id = schedule_session_contents.schedule_version_id
        AND version.event_id = schedule_session_contents.event_id
        AND version.status = 'published'
   );
