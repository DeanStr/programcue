-- The deployed manual event-roster path created new draft identities with
-- organiser-entered enrichment on people after the earlier scoped-profile
-- backfill had already run. Only records with the old command's exact creation
-- provenance and an untouched profile revision are safe to move. Existing
-- identities and participant-updated profiles are deliberately excluded.
INSERT INTO organisation_contacts (
  organisation_id, person_id, source, status, created_by_person_id,
  created_at, updated_at
)
SELECT DISTINCT audit.organisation_id, person.id, 'manual', 'active',
       audit.actor_person_id, audit.created_at, person.updated_at
  FROM audit_events audit
  JOIN events event
    ON event.id = audit.event_id
   AND event.organisation_id = audit.organisation_id
  JOIN people person ON person.id = audit.entity_id
 WHERE audit.action = 'speaker.admin.added'
   AND audit.entity_type = 'person'
   AND audit.correlation_id = person.last_operation_id
   AND json_extract(audit.metadata_json, '$.createdIdentity') = 1
   AND person.profile_revision = 1
 ON CONFLICT(organisation_id, person_id) DO NOTHING;

INSERT INTO organisation_contact_profiles (
  organisation_id, person_id, display_name, biography,
  organisation_name, job_title, source, created_by_person_id,
  updated_by_person_id, last_operation_id, created_at, updated_at
)
SELECT DISTINCT contact.organisation_id, person.id, person.display_name,
       NULLIF(person.biography, ''), NULLIF(person.organisation_name, ''),
       NULLIF(person.job_title, ''), 'manual', audit.actor_person_id,
       audit.actor_person_id, audit.correlation_id, audit.created_at,
       person.updated_at
  FROM audit_events audit
  JOIN events event
    ON event.id = audit.event_id
   AND event.organisation_id = audit.organisation_id
  JOIN people person ON person.id = audit.entity_id
  JOIN organisation_contacts contact
    ON contact.organisation_id = audit.organisation_id
   AND contact.person_id = person.id
   AND contact.status = 'active'
 WHERE audit.action = 'speaker.admin.added'
   AND audit.entity_type = 'person'
   AND audit.correlation_id = person.last_operation_id
   AND json_extract(audit.metadata_json, '$.createdIdentity') = 1
   AND person.profile_revision = 1
 ON CONFLICT(organisation_id, person_id) DO NOTHING;

UPDATE people
   SET display_name = email,
       biography = NULL,
       organisation_name = NULL,
       job_title = NULL,
       updated_at = unixepoch()
 WHERE profile_revision = 1
   AND EXISTS (
     SELECT 1
       FROM audit_events audit
       JOIN events event
         ON event.id = audit.event_id
        AND event.organisation_id = audit.organisation_id
       JOIN organisation_contacts contact
         ON contact.organisation_id = audit.organisation_id
        AND contact.person_id = people.id
        AND contact.status = 'active'
       JOIN organisation_contact_profiles profile
         ON profile.organisation_id = contact.organisation_id
        AND profile.person_id = contact.person_id
      WHERE audit.action = 'speaker.admin.added'
        AND audit.entity_type = 'person'
        AND audit.entity_id = people.id
        AND audit.correlation_id = people.last_operation_id
        AND json_extract(audit.metadata_json, '$.createdIdentity') = 1
   );

-- Every exact-provenance candidate must now have an active scoped profile and
-- a neutral canonical identity. Invalid legacy enrichment fails at the profile
-- constraints above; merged/conflicting contacts or any other partial outcome
-- reach this guard and abort rather than leaving organiser data globally owned.
INSERT INTO people (id, email, display_name)
SELECT 'migration-0019-manual-speaker-profile-guard', NULL,
       'Manual speaker profile ownership migration guard'
 WHERE EXISTS (
   SELECT 1
     FROM audit_events audit
     JOIN events event
       ON event.id = audit.event_id
      AND event.organisation_id = audit.organisation_id
     JOIN people person ON person.id = audit.entity_id
    WHERE audit.action = 'speaker.admin.added'
      AND audit.entity_type = 'person'
      AND audit.correlation_id = person.last_operation_id
      AND json_extract(audit.metadata_json, '$.createdIdentity') = 1
      AND person.profile_revision = 1
      AND (
        person.display_name <> person.email
        OR person.biography IS NOT NULL
        OR person.organisation_name IS NOT NULL
        OR person.job_title IS NOT NULL
        OR NOT EXISTS (
          SELECT 1
            FROM organisation_contacts contact
            JOIN organisation_contact_profiles profile
              ON profile.organisation_id = contact.organisation_id
             AND profile.person_id = contact.person_id
           WHERE contact.organisation_id = audit.organisation_id
             AND contact.person_id = person.id
             AND contact.status = 'active'
        )
      )
 );
