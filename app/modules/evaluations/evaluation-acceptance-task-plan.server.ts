import type { Viewer } from "~/platform/auth/authorize.server";

export const acceptanceTaskPlanGuardSql = `
  NOT EXISTS (
    WITH RECURSIVE acceptance_task_plan(template_id) AS (
      SELECT template.id
        FROM task_templates template
       WHERE template.event_id = submissions.event_id
         AND template.status = 'active'
         AND template.auto_assign_on_acceptance = 1
      UNION
      SELECT dependency.depends_on_template_id
        FROM acceptance_task_plan plan
        JOIN task_template_dependencies dependency
          ON dependency.template_id = plan.template_id
    )
    SELECT 1
      FROM acceptance_task_plan plan
      JOIN task_templates template ON template.id = plan.template_id
     WHERE template.event_id IS NOT submissions.event_id
        OR template.status <> 'active'
        OR template.due_anchor = 'session_start'
        OR (template.due_anchor = 'fixed' AND template.fixed_due_at IS NULL)
        OR (
          template.due_anchor = 'acceptance'
          AND template.due_offset_minutes IS NULL
        )
    UNION ALL
    SELECT 1
      FROM acceptance_task_plan plan
      JOIN task_template_dependencies dependency
        ON dependency.template_id = plan.template_id
      JOIN task_templates template ON template.id = dependency.template_id
      JOIN task_templates prerequisite
        ON prerequisite.id = dependency.depends_on_template_id
     WHERE template.target_type <> prerequisite.target_type
    LIMIT 1
  )`;

export const acceptanceTaskPlanCteSql = `
  WITH RECURSIVE
  acceptance_scope(event_id, submission_id, session_id, decision_id) AS (
    VALUES (?, ?, ?, ?)
  ),
  acceptance_task_plan(template_id) AS (
    SELECT template.id
      FROM task_templates template, acceptance_scope scope
     WHERE template.event_id = scope.event_id
       AND template.status = 'active'
       AND template.auto_assign_on_acceptance = 1
    UNION
    SELECT dependency.depends_on_template_id
      FROM acceptance_task_plan plan
      JOIN task_template_dependencies dependency
        ON dependency.template_id = plan.template_id
  ),
  acceptance_targets(target_type, target_id, owner_person_id) AS (
    SELECT 'speaker', speaker.person_id, speaker.person_id
      FROM submission_speakers speaker, acceptance_scope scope
     WHERE speaker.event_id = scope.event_id
       AND speaker.submission_id = scope.submission_id
       AND speaker.person_id IS NOT NULL
    UNION ALL
    SELECT 'session', scope.session_id, NULL FROM acceptance_scope scope
    UNION ALL
    SELECT 'event', scope.event_id, NULL FROM acceptance_scope scope
  )`;

export function acceptanceTaskPlanBindings(input: {
  eventId: string;
  submissionId: string;
  sessionId: string;
  decisionId: string;
}) {
  return [input.eventId, input.submissionId, input.sessionId, input.decisionId];
}

export function buildAcceptanceTaskPlanStatements(input: {
  env: CloudflareEnvironment;
  viewer: Pick<Viewer, "organisationId" | "eventId" | "personId">;
  submissionId: string;
  sessionId: string;
  decisionId: string;
  materializationOperationId?: string;
}) {
  const {
    env,
    viewer,
    submissionId,
    sessionId,
    decisionId,
    materializationOperationId = decisionId,
  } = input;
  const bindings = acceptanceTaskPlanBindings({
    eventId: viewer.eventId,
    submissionId,
    sessionId,
    decisionId,
  });
  return [
    env.DB.prepare(
      `
      ${acceptanceTaskPlanCteSql}
      INSERT INTO task_instances (
        id, event_id, template_id, target_type, target_id, owner_person_id,
        title, description, task_type, impact, evidence_mode,
        configuration_json, status, readiness_state, readiness_percent, revision,
        last_operation_id, due_at,
        created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), scope.event_id, template.id,
             target.target_type, target.target_id, target.owner_person_id,
             template.name, template.description, template.task_type,
             template.impact, template.evidence_mode,
             template.configuration_json,
             CASE WHEN EXISTS (
               SELECT 1 FROM task_template_dependencies dependency
                WHERE dependency.template_id = template.id
             ) THEN 'blocked' ELSE 'not_started' END,
             CASE WHEN EXISTS (
               SELECT 1 FROM task_template_dependencies dependency
                WHERE dependency.template_id = template.id
             ) THEN 'blocked' ELSE 'on_track' END,
             0, 1, ?,
             CASE template.due_anchor
               WHEN 'acceptance' THEN (
                 SELECT decision.published_at
                   FROM submission_decisions decision
                  WHERE decision.id = scope.decision_id
                    AND decision.event_id = scope.event_id
                    AND decision.status = 'published'
                    AND decision.decision = 'accepted'
               ) + template.due_offset_minutes * 60
               WHEN 'fixed' THEN template.fixed_due_at
               ELSE NULL
             END,
             unixepoch(), unixepoch()
        FROM acceptance_task_plan plan
        JOIN task_templates template ON template.id = plan.template_id
        JOIN acceptance_targets target
          ON target.target_type = template.target_type
        CROSS JOIN acceptance_scope scope
       WHERE template.event_id = scope.event_id
         AND template.status = 'active'
         AND EXISTS (
           SELECT 1 FROM submission_decisions decision
            WHERE decision.id = scope.decision_id
              AND decision.event_id = scope.event_id
              AND decision.status = 'published'
               AND decision.decision = 'accepted'
         )
      ON CONFLICT(event_id, template_id, target_type, target_id)
        WHERE template_id IS NOT NULL DO NOTHING
    `,
    ).bind(...bindings, materializationOperationId),
    env.DB.prepare(
      `
      ${acceptanceTaskPlanCteSql}
      INSERT INTO task_instance_dependencies (
        task_id, depends_on_task_id, created_at
      )
      SELECT task.id, prerequisite.id, unixepoch()
        FROM acceptance_task_plan plan
        JOIN task_template_dependencies dependency
          ON dependency.template_id = plan.template_id
        JOIN acceptance_targets target ON 1 = 1
        CROSS JOIN acceptance_scope scope
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
       WHERE EXISTS (
         SELECT 1 FROM submission_decisions decision
          WHERE decision.id = scope.decision_id
            AND decision.event_id = scope.event_id
            AND decision.status = 'published'
            AND decision.decision = 'accepted'
       )
      ON CONFLICT(task_id, depends_on_task_id) DO NOTHING
    `,
    ).bind(...bindings),
    env.DB.prepare(
      `
      ${acceptanceTaskPlanCteSql}
      UPDATE task_instances AS task
         SET status = CASE
               WHEN EXISTS (
                 SELECT 1
                   FROM task_instance_dependencies dependency
                   JOIN task_instances prerequisite
                     ON prerequisite.id = dependency.depends_on_task_id
                  WHERE dependency.task_id = task.id
                    AND prerequisite.status NOT IN ('completed','waived')
               ) THEN 'blocked'
               WHEN task.due_at IS NOT NULL AND task.due_at < unixepoch()
                 THEN 'overdue'
               ELSE 'not_started'
             END,
             readiness_state = CASE
               WHEN EXISTS (
                 SELECT 1
                   FROM task_instance_dependencies dependency
                   JOIN task_instances prerequisite
                     ON prerequisite.id = dependency.depends_on_task_id
                  WHERE dependency.task_id = task.id
                    AND prerequisite.status NOT IN ('completed','waived')
               ) THEN 'blocked'
               WHEN task.due_at IS NOT NULL AND task.due_at < unixepoch()
                 THEN 'overdue'
               ELSE 'on_track'
             END,
             updated_at = unixepoch()
       WHERE task.event_id = (SELECT event_id FROM acceptance_scope)
         AND task.last_operation_id = ?
    `,
    ).bind(...bindings, materializationOperationId),
    env.DB.prepare(
      `
      ${acceptanceTaskPlanCteSql}
      INSERT INTO audit_events (
        id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
        entity_type, entity_id, metadata_json, created_at
      )
      SELECT lower(hex(randomblob(16))), 'person', 'admin_ui', 1, ?, scope.event_id, ?,
             'task.assigned', 'task_instance', task.id,
             json_object(
               'templateId', task.template_id,
               'targetType', task.target_type,
               'targetId', task.target_id,
               'source', 'accepted_decision',
               'decisionId', scope.decision_id
             ),
             unixepoch()
        FROM task_instances task
        CROSS JOIN acceptance_scope scope
       WHERE task.event_id = scope.event_id
         AND task.last_operation_id = ?
         AND NOT EXISTS (
           SELECT 1 FROM audit_events existing
            WHERE existing.event_id = scope.event_id
              AND existing.action = 'task.assigned'
              AND existing.entity_type = 'task_instance'
              AND existing.entity_id = task.id
              AND json_extract(existing.metadata_json, '$.decisionId') = scope.decision_id
         )
    `,
    ).bind(
      ...bindings,
      viewer.organisationId,
      viewer.personId,
      materializationOperationId,
    ),
  ];
}
