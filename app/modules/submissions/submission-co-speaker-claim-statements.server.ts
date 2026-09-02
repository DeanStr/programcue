import {
  acceptanceTaskPlanBindings,
  acceptanceTaskPlanCteSql,
} from "~/modules/evaluations/evaluation-decision-statements.server";

export function buildAcceptedClaimPropagationAuditStatement(
  env: CloudflareEnvironment,
  input: {
    organisationId: string;
    eventId: string;
    submissionId: string;
    sessionId: string;
    decisionId: string;
    speakerId: string;
    personId: string;
    operationId: string;
  },
) {
  return env.DB.prepare(
    `${acceptanceTaskPlanCteSql}
     INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
       entity_type, entity_id, correlation_id, metadata_json, created_at
     )
     SELECT lower(hex(randomblob(16))), 'person', 'public_form', 1, ?, scope.event_id, ?,
            'submission.speaker.acceptance_propagated',
            'submission_speaker', ?, ?,
            json_object(
              'decisionId', scope.decision_id,
              'sessionId', scope.session_id
            ), unixepoch()
       FROM acceptance_scope scope
      WHERE EXISTS (
        SELECT 1 FROM submission_speakers speaker
        JOIN submissions submission
          ON submission.id = speaker.submission_id
         AND submission.event_id = speaker.event_id
         AND submission.status = 'accepted'
         WHERE speaker.id = ? AND speaker.event_id = scope.event_id
           AND speaker.submission_id = scope.submission_id
           AND speaker.person_id = ?
           AND speaker.invitation_status = 'claimed'
      )
        AND 1 = (
          SELECT COUNT(*) FROM session_speakers relationship
           WHERE relationship.session_id = scope.session_id
             AND relationship.event_id = scope.event_id
             AND relationship.person_id = ?
        )
        AND 1 = (
          SELECT COUNT(*) FROM memberships membership
           WHERE membership.event_id = scope.event_id
             AND membership.person_id = ?
             AND membership.role = 'speaker'
             AND membership.accepted_at IS NOT NULL
             AND membership.revoked_at IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
            FROM acceptance_task_plan plan
            JOIN task_templates template ON template.id = plan.template_id
            JOIN acceptance_targets target
              ON target.target_type = template.target_type
           WHERE NOT EXISTS (
             SELECT 1 FROM task_instances task
              WHERE task.event_id = scope.event_id
                AND task.template_id = template.id
                AND task.target_type = target.target_type
                AND task.target_id = target.target_id
           )
        )
        AND NOT EXISTS (
          SELECT 1
            FROM acceptance_task_plan plan
            JOIN task_template_dependencies dependency
              ON dependency.template_id = plan.template_id
            JOIN task_templates template ON template.id = dependency.template_id
            JOIN acceptance_targets target
              ON target.target_type = template.target_type
            JOIN task_instances task
              ON task.event_id = scope.event_id
             AND task.template_id = dependency.template_id
             AND task.target_type = target.target_type
             AND task.target_id = target.target_id
            JOIN task_instances prerequisite
              ON prerequisite.event_id = task.event_id
             AND prerequisite.template_id = dependency.depends_on_template_id
             AND prerequisite.target_type = task.target_type
             AND prerequisite.target_id = task.target_id
           WHERE NOT EXISTS (
             SELECT 1 FROM task_instance_dependencies edge
              WHERE edge.task_id = task.id
                AND edge.depends_on_task_id = prerequisite.id
           )
        )`,
  ).bind(
    ...acceptanceTaskPlanBindings({
      eventId: input.eventId,
      submissionId: input.submissionId,
      sessionId: input.sessionId,
      decisionId: input.decisionId,
    }),
    input.organisationId,
    input.personId,
    input.speakerId,
    input.operationId,
    input.speakerId,
    input.personId,
    input.personId,
    input.personId,
  );
}

export function unscheduledClaimDraftEntryGuards(
  eventId: string,
  sessionId: string,
) {
  return {
    versionGuardSql: `AND NOT EXISTS (
           SELECT 1 FROM schedule_entries entry
           JOIN schedule_versions version
             ON version.id = entry.schedule_version_id
            AND version.event_id = entry.event_id
          WHERE entry.event_id = events.id
            AND entry.session_id = ?
            AND version.status = 'draft'
         )`,
    versionGuardBindings: [sessionId] as Array<string | number>,
    speakerGuardSql: `AND NOT EXISTS (
           SELECT 1 FROM schedule_entries entry
           JOIN schedule_versions version
             ON version.id = entry.schedule_version_id
            AND version.event_id = entry.event_id
          WHERE entry.event_id = ?
            AND entry.session_id = ?
            AND version.status = 'draft'
         )`,
    speakerGuardBindings: [eventId, sessionId] as Array<string | number>,
    statements: [] as D1PreparedStatement[],
  };
}

export function buildAcceptedDirectClaimPropagationAuditStatement(
  env: CloudflareEnvironment,
  input: {
    organisationId: string;
    eventId: string;
    sessionId: string;
    speakerId: string;
    personId: string;
    operationId: string;
  },
) {
  return env.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
       entity_type, entity_id, correlation_id, metadata_json, created_at
     )
     SELECT lower(hex(randomblob(16))), 'person', 'public_form', 1, ?, speaker.event_id, ?,
            'submission.speaker.acceptance_propagated',
            'submission_speaker', speaker.id, ?,
            json_object('sessionId', session.id, 'source', 'direct_session'),
            unixepoch()
       FROM submission_speakers speaker
       JOIN submissions submission
         ON submission.id = speaker.submission_id
        AND submission.event_id = speaker.event_id
        AND submission.status = 'accepted'
       JOIN form_versions version
         ON version.id = submission.form_version_id
        AND version.event_id = submission.event_id
       JOIN form_definitions form
         ON form.id = version.form_id
        AND form.event_id = version.event_id
        AND form.kind = 'direct_session'
       JOIN sessions session
         ON session.source_submission_id = submission.id
        AND session.event_id = submission.event_id
        AND session.id = ?
        AND session.status IN ('unscheduled','scheduled')
      WHERE speaker.id = ? AND speaker.event_id = ?
        AND speaker.person_id = ?
        AND speaker.invitation_status = 'claimed'
        AND 1 = (
          SELECT COUNT(*) FROM sessions derived
           WHERE derived.source_submission_id = submission.id
             AND derived.event_id = submission.event_id
        )
        AND 1 = (
          SELECT COUNT(*) FROM session_speakers relationship
           WHERE relationship.session_id = session.id
             AND relationship.event_id = session.event_id
             AND relationship.person_id = speaker.person_id
        )
        AND 1 = (
          SELECT COUNT(*) FROM memberships membership
           WHERE membership.event_id = speaker.event_id
             AND membership.person_id = speaker.person_id
             AND membership.role = 'speaker'
             AND membership.accepted_at IS NOT NULL
             AND membership.revoked_at IS NULL
        )`,
  ).bind(
    input.organisationId,
    input.personId,
    input.operationId,
    input.sessionId,
    input.speakerId,
    input.eventId,
    input.personId,
  );
}
