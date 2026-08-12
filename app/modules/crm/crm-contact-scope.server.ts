import type { OrganisationAdministrator } from "~/platform/auth/organisation.server";

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
