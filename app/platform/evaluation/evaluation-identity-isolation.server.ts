import { DEMO_ORGANISATION_ID } from "~/platform/demo/demo-identities";

const OUTSIDE_EVENT_PERSON_ATTRIBUTIONS = [
  ["event_speaker_workflows", "updated_by_person_id"],
  ["form_definitions", "created_by_person_id"],
  ["form_versions", "created_by_person_id"],
  ["submission_revisions", "saved_by_person_id"],
  ["evaluation_plans", "created_by_person_id"],
  ["evaluation_teams", "chair_person_id"],
  ["evaluation_round_reviewers", "added_by_person_id"],
  ["evaluator_conflicts", "resolved_by_person_id"],
  ["ai_review_assessments", "generated_by_person_id"],
  ["ai_review_assessments", "override_by_person_id"],
  ["review_revisions", "saved_by_person_id"],
  ["evaluation_discussion_messages", "author_person_id"],
  ["review_moderations", "moderator_person_id"],
  ["submission_decisions", "decided_by_person_id"],
  ["tags", "created_by_person_id"],
  ["session_tags", "created_by_person_id"],
  ["session_archives", "archived_by_person_id"],
  ["schedule_versions", "created_by_person_id"],
  ["schedule_session_contents", "last_edited_by_person_id"],
  ["schedule_session_contents", "approved_by_person_id"],
  ["session_content_revisions", "created_by_person_id"],
  ["schedule_conflicts", "resolved_by_person_id"],
  ["task_instances", "completed_by_person_id"],
  ["task_comments", "author_person_id"],
  ["file_versions", "created_by_person_id"],
  ["task_evidence", "reviewed_by_person_id"],
  ["resource_pages", "created_by_person_id"],
  ["resource_page_versions", "created_by_person_id"],
  ["communication_templates", "created_by_person_id"],
  ["communication_template_versions", "created_by_person_id"],
  ["communications", "created_by_person_id"],
  ["saved_views", "owner_person_id"],
] as const;

const OUTSIDE_ORGANISATION_PERSON_ATTRIBUTIONS = [
  ["organisation_ai_settings", "last_updated_by_person_id"],
  ["events", "last_updated_by_person_id"],
  ["organisation_contacts", "created_by_person_id"],
  ["organisation_contacts", "merged_into_person_id"],
  ["organisation_contact_profiles", "created_by_person_id"],
  ["organisation_contact_profiles", "updated_by_person_id"],
  ["organisation_contact_tags", "created_by_person_id"],
  ["organisation_contact_notes", "author_person_id"],
  ["crm_segments", "owner_person_id"],
  ["crm_pipeline_entries", "created_by_person_id"],
  ["crm_pipeline_activity", "actor_person_id"],
  ["webhook_endpoints", "created_by_person_id"],
  ["assistant_proposal_executions", "actor_person_id"],
  ["api_keys", "created_by_person_id"],
] as const;

function outsideAttributionPredicates() {
  return [
    ...OUTSIDE_EVENT_PERSON_ATTRIBUTIONS.map(
      ([table, column]) =>
        `EXISTS (SELECT 1 FROM ${table} WHERE ${table}.${column} = person.id AND ${table}.event_id IN outside_events)`,
    ),
    ...OUTSIDE_ORGANISATION_PERSON_ATTRIBUTIONS.map(
      ([table, column]) =>
        `EXISTS (SELECT 1 FROM ${table} WHERE ${table}.${column} = person.id AND ${table}.organisation_id <> (SELECT organisation_id FROM fixture_scope))`,
    ),
  ].join("\n          OR ");
}

export async function findPersonLinkedOutsideEvaluationOrganisation(
  env: CloudflareEnvironment,
  personIds: string[],
) {
  if (!personIds.length) return null;
  const personPlaceholders = personIds.map(() => "?").join(",");
  return env.DB.prepare(
    `WITH fixture_scope(organisation_id) AS (VALUES (?)),
     outside_events AS (
       SELECT id FROM events
        WHERE organisation_id <> (SELECT organisation_id FROM fixture_scope)
     )
     SELECT person.id
       FROM people person
      WHERE person.id IN (${personPlaceholders})
        AND (
          EXISTS (SELECT 1 FROM memberships record
                    WHERE record.person_id = person.id
                      AND record.organisation_id <> ?)
          OR EXISTS (SELECT 1 FROM organisation_contacts record
                      WHERE record.person_id = person.id
                        AND record.organisation_id <> ?)
          OR EXISTS (SELECT 1 FROM submissions record
                      WHERE record.submitter_person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM submission_speakers record
                      WHERE record.person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM session_speakers record
                      WHERE record.person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM event_speaker_workflows record
                      WHERE record.person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM event_participant_profiles record
                      WHERE record.person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM task_instances record
                      WHERE record.owner_person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM task_evidence record
                      WHERE record.submitted_by_person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM resource_acknowledgements record
                      WHERE record.person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM resource_audiences record
                      WHERE record.target_type = 'person'
                        AND record.target_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM public_itineraries record
                      WHERE record.person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM calendar_connections record
                      WHERE record.person_id = person.id
                        AND record.organisation_id <> ?)
          OR EXISTS (SELECT 1 FROM calendar_invitations record
                      WHERE record.person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM communication_deliveries record
                      WHERE record.person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM communication_unsubscribes record
                      WHERE record.person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM file_assets record
                      WHERE record.owner_person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM evaluator_conflicts record
                      WHERE record.evaluator_person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM evaluator_assignments record
                      WHERE record.evaluator_person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM evaluation_team_members record
                      WHERE record.person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM evaluation_round_reviewers record
                      WHERE record.person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM crm_segments record
                      WHERE record.owner_person_id = person.id
                        AND record.organisation_id <> ?)
          OR EXISTS (SELECT 1 FROM saved_views record
                      WHERE record.owner_person_id = person.id
                        AND record.event_id IN outside_events)
          OR EXISTS (SELECT 1 FROM audit_events record
                      WHERE record.actor_person_id = person.id
                        AND (record.organisation_id IS NULL
                             OR record.organisation_id <> ?))
          OR EXISTS (SELECT 1 FROM operation_jobs record
                      WHERE record.requested_by_person_id = person.id
                        AND (record.organisation_id IS NULL
                             OR record.organisation_id <> ?))
          OR ${outsideAttributionPredicates()}
        )
      LIMIT 1`,
  )
    .bind(
      DEMO_ORGANISATION_ID,
      ...personIds,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_ORGANISATION_ID,
    )
    .first<{ id: string }>();
}

export class EvaluationIdentityIsolationError extends Error {
  constructor(readonly personId: string) {
    super(
      `Fixture person ${personId} is linked outside the dedicated evaluation organisation.`,
    );
    this.name = "EvaluationIdentityIsolationError";
  }
}

export async function assertEvaluationPeopleAreDedicated(
  env: CloudflareEnvironment,
  personIds: string[],
) {
  const linked = await findPersonLinkedOutsideEvaluationOrganisation(
    env,
    personIds,
  );
  if (linked) throw new EvaluationIdentityIsolationError(linked.id);
}
