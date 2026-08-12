import type { OrganisationAdministrator } from "~/platform/auth/organisation.server";

const EMAIL_RELATIONSHIP_LOOKUP_SIZE = 90;

export const CONTACT_RELATIONSHIP_REQUIRED_MESSAGE =
  "This email cannot be added directly. Invite the speaker or connect them through an event first.";
const CONTACT_RELATIONSHIP_CONSTRAINT =
  "NOT NULL constraint failed: organisation_contacts.person_id";
export const CONTACT_IDENTITY_INVARIANT_MESSAGE =
  "The Speaker Network contact identity was missing after creation.";

export const contactScopeCte = `WITH candidate_contact_ids(person_id) AS (
  SELECT contact.person_id
    FROM organisation_contacts contact
   WHERE contact.organisation_id = ? AND contact.status = 'active'
  UNION
  SELECT membership.person_id
    FROM memberships membership
    JOIN events event ON event.id = membership.event_id
   WHERE membership.organisation_id = ? AND membership.role = 'speaker'
     AND event.organisation_id = membership.organisation_id
     AND event.activation_status = 'active'
     AND membership.accepted_at IS NOT NULL AND membership.revoked_at IS NULL
  UNION
  SELECT speaker.person_id
    FROM session_speakers speaker
    JOIN events event ON event.id = speaker.event_id
   WHERE event.organisation_id = ? AND event.activation_status = 'active'
  UNION
  SELECT speaker.person_id
    FROM submission_speakers speaker
    JOIN events event ON event.id = speaker.event_id
   WHERE event.organisation_id = ? AND event.activation_status = 'active'
     AND speaker.person_id IS NOT NULL
), organisation_contact_ids(person_id) AS (
  SELECT candidate.person_id
    FROM candidate_contact_ids candidate
   WHERE NOT EXISTS (
     SELECT 1 FROM organisation_contacts merged
      WHERE merged.organisation_id = ? AND merged.person_id = candidate.person_id
        AND merged.status = 'merged'
   )
)`;

export function contactScopeBindings(viewer: OrganisationAdministrator) {
  return Array(5).fill(viewer.organisationId);
}

export const existingPersonOrganisationRelationshipSql = `(
  EXISTS (
    SELECT 1 FROM organisation_contacts existing_contact
     WHERE existing_contact.organisation_id = ?
       AND existing_contact.person_id = person.id
  )
  OR EXISTS (
    SELECT 1 FROM memberships membership
     WHERE membership.organisation_id = ?
       AND membership.person_id = person.id
       AND membership.accepted_at IS NOT NULL
       AND membership.revoked_at IS NULL
       AND (
         membership.event_id IS NULL
         OR EXISTS (
           SELECT 1 FROM events membership_event
            WHERE membership_event.id = membership.event_id
              AND membership_event.organisation_id = membership.organisation_id
              AND membership_event.activation_status = 'active'
         )
       )
  )
  OR EXISTS (
    SELECT 1 FROM session_speakers speaker
    JOIN events event ON event.id = speaker.event_id
     WHERE event.organisation_id = ? AND event.activation_status = 'active'
       AND speaker.person_id = person.id
  )
  OR EXISTS (
    SELECT 1 FROM submission_speakers speaker
    JOIN events event ON event.id = speaker.event_id
     WHERE event.organisation_id = ? AND event.activation_status = 'active'
       AND speaker.person_id = person.id
  )
  OR EXISTS (
    SELECT 1 FROM submissions submission
    JOIN events event ON event.id = submission.event_id
     WHERE event.organisation_id = ? AND event.activation_status = 'active'
       AND submission.submitter_person_id = person.id
  )
)`;

export function organisationRelationshipBindings(
  viewer: OrganisationAdministrator,
) {
  return Array(5).fill(viewer.organisationId);
}

export async function unavailableExistingEmails(
  env: CloudflareEnvironment,
  viewer: OrganisationAdministrator,
  emails: string[],
) {
  if (!emails.length) return new Set<string>();
  const normalizedEmails = [
    ...new Set(emails.map((email) => email.toLowerCase())),
  ];
  const unavailable = new Set<string>();
  for (
    let offset = 0;
    offset < normalizedEmails.length;
    offset += EMAIL_RELATIONSHIP_LOOKUP_SIZE
  ) {
    const batch = normalizedEmails.slice(
      offset,
      offset + EMAIL_RELATIONSHIP_LOOKUP_SIZE,
    );
    const placeholders = batch.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      `SELECT lower(person.email) AS email
         FROM people person
        WHERE lower(person.email) IN (${placeholders})
          AND NOT ${existingPersonOrganisationRelationshipSql}`,
    )
      .bind(...batch, ...organisationRelationshipBindings(viewer))
      .all<{ email: string }>();
    rows.results.forEach((row) => unavailable.add(row.email));
  }
  return unavailable;
}

export function isContactRelationshipConstraint(error: unknown) {
  return (
    error instanceof Error &&
    error.message.includes(CONTACT_RELATIONSHIP_CONSTRAINT)
  );
}
