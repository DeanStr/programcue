CREATE TABLE organisation_contact_profiles (
  organisation_id TEXT NOT NULL,
  person_id TEXT NOT NULL,
  display_name TEXT NOT NULL CHECK (length(trim(display_name)) BETWEEN 2 AND 120),
  biography TEXT CHECK (biography IS NULL OR length(biography) <= 5000),
  organisation_name TEXT CHECK (
    organisation_name IS NULL OR length(organisation_name) <= 160
  ),
  job_title TEXT CHECK (job_title IS NULL OR length(job_title) <= 160),
  source TEXT NOT NULL CHECK (source IN ('import','manual')),
  created_by_person_id TEXT REFERENCES people(id),
  updated_by_person_id TEXT REFERENCES people(id),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (organisation_id, person_id),
  FOREIGN KEY (organisation_id, person_id)
    REFERENCES organisation_contacts(organisation_id, person_id)
    ON DELETE CASCADE
);

-- Preserve existing organiser-authored, single-organisation Network-only
-- profiles while removing their enrichment from the canonical identity.
-- Ambiguous multi-organisation enrichment is cleared rather than copied
-- between tenants. Submitted, claimed, authenticated or already-published
-- identities are left untouched because provenance cannot be inferred safely.
INSERT INTO organisation_contact_profiles (
  organisation_id, person_id, display_name, biography,
  organisation_name, job_title, source, created_by_person_id,
  updated_by_person_id, created_at, updated_at
)
SELECT contact.organisation_id, contact.person_id, person.display_name,
       person.biography, person.organisation_name, person.job_title,
       contact.source, contact.created_by_person_id,
       contact.created_by_person_id, contact.created_at, contact.updated_at
  FROM organisation_contacts contact
  JOIN people person ON person.id = contact.person_id
 WHERE contact.status = 'active'
   AND contact.source IN ('import','manual')
   AND person.email_verified = 0
   AND person.profile_status = 'draft'
   AND NOT EXISTS (
     SELECT 1 FROM organisation_contacts other_contact
      WHERE other_contact.person_id = person.id
        AND other_contact.organisation_id <> contact.organisation_id
   )
   AND NOT EXISTS (
     SELECT 1 FROM submissions WHERE submitter_person_id = person.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM submission_speakers WHERE person_id = person.id
   )
   AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE person_id = person.id)
   AND NOT EXISTS (SELECT 1 FROM auth_sessions WHERE person_id = person.id);

UPDATE people
   SET display_name = email,
       biography = NULL,
       organisation_name = NULL,
       job_title = NULL,
       updated_at = unixepoch()
 WHERE EXISTS (
   SELECT 1 FROM organisation_contacts contact
    WHERE contact.person_id = people.id
      AND contact.status = 'active'
      AND contact.source IN ('import','manual')
 )
   AND email_verified = 0
   AND profile_status = 'draft'
   AND NOT EXISTS (
     SELECT 1 FROM submissions WHERE submitter_person_id = people.id
   )
   AND NOT EXISTS (
     SELECT 1 FROM submission_speakers WHERE person_id = people.id
   )
   AND NOT EXISTS (SELECT 1 FROM auth_accounts WHERE person_id = people.id)
   AND NOT EXISTS (SELECT 1 FROM auth_sessions WHERE person_id = people.id);
