import type { Viewer } from "~/platform/auth/authorize.server";

export function adminSpeakerScopeSql(alias = "person.id") {
  return `EXISTS (
      SELECT 1 FROM events scope_event
       WHERE scope_event.id = ? AND scope_event.organisation_id = ?
         AND (
           EXISTS (
             SELECT 1 FROM session_speakers link
              WHERE link.event_id = scope_event.id AND link.person_id = ${alias}
           )
           OR EXISTS (
             SELECT 1 FROM memberships membership
              WHERE membership.event_id = scope_event.id
                AND membership.person_id = ${alias}
                AND membership.role = 'speaker'
                AND membership.accepted_at IS NOT NULL
                AND membership.revoked_at IS NULL
           )
           OR EXISTS (
             SELECT 1 FROM event_speaker_workflows workflow
              WHERE workflow.event_id = scope_event.id
                AND workflow.person_id = ${alias}
           )
         )
    )`;
}

/**
 * People are canonical identities rather than event-owned copies. An event
 * organiser may therefore edit the shared row only while every relevant event
 * association belongs to the current event. Once another event or an
 * organisation-wide membership shares the identity, the person must own
 * profile changes so one organiser cannot alter another event's records.
 */
export async function adminProfileIsShared(
  env: CloudflareEnvironment,
  viewer: Viewer,
  personId: string,
) {
  const shared = await env.DB.prepare(
    `
      SELECT 1 AS shared
       WHERE EXISTS (
         SELECT 1
           FROM session_speakers link
           JOIN events linked_event ON linked_event.id = link.event_id
          WHERE link.person_id = ?
            AND (link.event_id <> ? OR linked_event.organisation_id <> ?)
       )
          OR EXISTS (
         SELECT 1
           FROM event_speaker_workflows workflow
           JOIN events workflow_event ON workflow_event.id = workflow.event_id
          WHERE workflow.person_id = ?
            AND (workflow.event_id <> ? OR workflow_event.organisation_id <> ?)
       )
          OR EXISTS (
         SELECT 1
           FROM submissions submission
           JOIN events submission_event
             ON submission_event.id = submission.event_id
          WHERE submission.submitter_person_id = ?
            AND (submission.event_id <> ? OR submission_event.organisation_id <> ?)
       )
          OR EXISTS (
         SELECT 1
           FROM submission_speakers submission_speaker
           JOIN events submission_event
             ON submission_event.id = submission_speaker.event_id
          WHERE submission_speaker.person_id = ?
            AND (submission_speaker.event_id <> ? OR submission_event.organisation_id <> ?)
       )
          OR EXISTS (
         SELECT 1
           FROM memberships membership
          WHERE membership.person_id = ?
            AND membership.accepted_at IS NOT NULL
            AND membership.revoked_at IS NULL
            AND (
              membership.event_id IS NULL
              OR membership.event_id <> ?
              OR membership.organisation_id <> ?
            )
       )
      LIMIT 1
    `,
  )
    .bind(
      personId,
      viewer.eventId,
      viewer.organisationId,
      personId,
      viewer.eventId,
      viewer.organisationId,
      personId,
      viewer.eventId,
      viewer.organisationId,
      personId,
      viewer.eventId,
      viewer.organisationId,
      personId,
      viewer.eventId,
      viewer.organisationId,
    )
    .first<{ shared: number }>();
  return Boolean(shared);
}

export function adminProfileExclusiveSql(alias = "people.id") {
  return `NOT EXISTS (
      SELECT 1
        FROM session_speakers other_link
        JOIN events other_event ON other_event.id = other_link.event_id
       WHERE other_link.person_id = ${alias}
         AND (other_link.event_id <> ? OR other_event.organisation_id <> ?)
    ) AND NOT EXISTS (
      SELECT 1
        FROM event_speaker_workflows other_workflow
        JOIN events other_event ON other_event.id = other_workflow.event_id
       WHERE other_workflow.person_id = ${alias}
         AND (other_workflow.event_id <> ? OR other_event.organisation_id <> ?)
    ) AND NOT EXISTS (
      SELECT 1
        FROM submissions other_submission
        JOIN events other_event ON other_event.id = other_submission.event_id
       WHERE other_submission.submitter_person_id = ${alias}
         AND (other_submission.event_id <> ? OR other_event.organisation_id <> ?)
    ) AND NOT EXISTS (
      SELECT 1
        FROM submission_speakers other_speaker
        JOIN events other_event ON other_event.id = other_speaker.event_id
       WHERE other_speaker.person_id = ${alias}
         AND (other_speaker.event_id <> ? OR other_event.organisation_id <> ?)
    ) AND NOT EXISTS (
      SELECT 1
        FROM memberships other_membership
       WHERE other_membership.person_id = ${alias}
         AND other_membership.accepted_at IS NOT NULL
         AND other_membership.revoked_at IS NULL
         AND (
           other_membership.event_id IS NULL
           OR other_membership.event_id <> ?
           OR other_membership.organisation_id <> ?
         )
    )`;
}
