import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import { type AcceptedSpeakerInvitationPlan } from "./accepted-speaker-invitation.server";
import { decisionSchema } from "./evaluation-schema";

export type DecisionSubmission = {
  id: string;
  title: string;
  reference: string;
  format: string | null;
  category: string | null;
  status: string;
  revision: number;
  snapshotJson: string | null;
};

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
        title, description, task_type, impact, status, readiness_state,
        readiness_percent, revision, last_operation_id, due_at,
        created_at, updated_at
      )
      SELECT lower(hex(randomblob(16))), scope.event_id, template.id,
             target.target_type, target.target_id, target.owner_person_id,
             template.name, template.description, template.task_type,
             template.impact,
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

export function buildDecisionStatements(input: {
  env: CloudflareEnvironment;
  viewer: Viewer;
  parsed: ReturnType<typeof decisionSchema.parse>;
  submission: DecisionSubmission;
  revision: number;
  decisionId: string;
  status: "published" | "draft";
  submissionStatus: string;
  sessionId: string | null;
  sessionTitle: string;
  sessionDescription: string;
  slug: string;
  format: string;
  sessionDurationMinutes: number;
  sessionTrack: { id: string; name: string } | null;
  notificationOperationId: string | null;
  notificationFeedback: string[];
  roundId: string | null;
  speakerMemberships: Array<{ membershipId: string; personId: string }>;
  speakerInvitationPlans: AcceptedSpeakerInvitationPlan[];
  auditEventId: string;
}) {
  const {
    env,
    viewer,
    parsed,
    submission,
    revision,
    decisionId,
    status,
    submissionStatus,
    sessionId,
    sessionTitle,
    sessionDescription,
    slug,
    format,
    sessionDurationMinutes,
    sessionTrack,
    notificationOperationId,
    notificationFeedback,
    roundId,
    speakerMemberships,
    speakerInvitationPlans,
    auditEventId,
  } = input;
  if (parsed.decision === "accepted" && !sessionTrack) {
    throw new Error(
      "Accepted decision statements require the confirmed submitted track.",
    );
  }
  if (parsed.decision !== "accepted" && sessionTrack) {
    throw new Error(
      "Only accepted decision statements may carry a programme track.",
    );
  }
  const speakerSetGuard = speakerMemberships.length
    ? `(
        SELECT COUNT(*) FROM submission_speakers current_speaker
         WHERE current_speaker.event_id = submissions.event_id
           AND current_speaker.submission_id = submissions.id
           AND current_speaker.person_id IS NOT NULL
      ) = ?
      AND NOT EXISTS (
        SELECT 1 FROM submission_speakers current_speaker
         WHERE current_speaker.event_id = submissions.event_id
           AND current_speaker.submission_id = submissions.id
           AND (
             current_speaker.person_id IS NULL
             OR current_speaker.person_id NOT IN (${speakerMemberships.map(() => "?").join(",")})
           )
      )`
    : "0";
  const speakerSetBindings = speakerMemberships.length
    ? [
        speakerMemberships.length,
        ...speakerMemberships.map((membership) => membership.personId),
      ]
    : [];
  return [
    env.DB.prepare(
      `
        UPDATE submissions
           SET status = ?, revision = revision + 1, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND status IN ('submitted','assigned','in_review','decision_ready')
           AND (
             ? IS NULL
             OR EXISTS (
               SELECT 1
                 FROM evaluator_assignments evidence_assignment
                 JOIN reviews evidence_review
                   ON evidence_review.assignment_id = evidence_assignment.id
                  AND evidence_review.event_id = evidence_assignment.event_id
                  AND evidence_review.status IN ('submitted','locked')
                 JOIN evaluation_rounds evidence_round
                   ON evidence_round.id = evidence_assignment.round_id
                  AND evidence_round.event_id = evidence_assignment.event_id
                 JOIN evaluation_plans evidence_plan
                   ON evidence_plan.id = evidence_round.plan_id
                  AND evidence_plan.event_id = evidence_round.event_id
                WHERE evidence_assignment.event_id = submissions.event_id
                  AND evidence_assignment.submission_id = submissions.id
                  AND evidence_assignment.round_id = ?
                  AND evidence_round.status IN ('active','closed')
                  AND evidence_plan.status IN ('active','closed')
                  AND (SELECT COUNT(*)
                         FROM evaluation_plans current_plan
                        WHERE current_plan.event_id = submissions.event_id
                          AND current_plan.status <> 'archived') = 1
             )
           )
           AND (
             ? <> 'published' OR ? <> 'accepted'
             OR ((${speakerSetGuard}) AND (${acceptanceTaskPlanGuardSql}))
           )
           AND (
             ? <> 'accepted'
              OR EXISTS (
                SELECT 1 FROM submission_track_selections selection
                JOIN tracks current_track
                  ON current_track.id = selection.track_id
                 AND current_track.event_id = selection.event_id
                 WHERE selection.submission_id = submissions.id
                   AND selection.event_id = submissions.event_id
                   AND selection.track_id = ?
                   AND current_track.name = ?
              )
           )
           AND (
             ? <> 'published'
             OR ? IN ('owner','administrator')
             OR (
               ? = 'committee_chair'
               AND EXISTS (
                 SELECT 1 FROM evaluation_plans authority_plan
                  WHERE authority_plan.event_id = submissions.event_id
                    AND authority_plan.status = 'active'
                    AND authority_plan.decision_role = 'committee_chair'
               )
             )
           )
      `,
    ).bind(
      submissionStatus,
      decisionId,
      submission.id,
      viewer.eventId,
      submission.revision,
      roundId,
      roundId,
      status,
      parsed.decision,
      ...speakerSetBindings,
      parsed.decision,
      sessionTrack?.id ?? null,
      sessionTrack?.name ?? null,
      status,
      viewer.role,
      viewer.role,
    ),
    env.DB.prepare(
      `
        UPDATE submission_decisions SET status = 'superseded'
         WHERE event_id = ? AND submission_id = ? AND status = 'draft'
           AND EXISTS (
             SELECT 1 FROM submissions
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
    ).bind(
      viewer.eventId,
      submission.id,
      submission.id,
      viewer.eventId,
      decisionId,
    ),
    env.DB.prepare(
      `
        UPDATE evaluator_assignments
           SET status = 'cancelled', revision = revision + 1,
               last_operation_id = ?, cancellation_reason = 'decision_published'
         WHERE event_id = ? AND submission_id = ?
           AND status IN ('assigned','in_progress','reopened')
           AND ? = 'published'
           AND EXISTS (
             SELECT 1
               FROM evaluation_rounds current_round
               JOIN evaluation_plans current_plan
                 ON current_plan.id = current_round.plan_id
                AND current_plan.event_id = current_round.event_id
              WHERE current_round.id = evaluator_assignments.round_id
                AND current_round.event_id = evaluator_assignments.event_id
                AND current_round.status <> 'archived'
                AND current_plan.status <> 'archived'
           )
           AND EXISTS (
             SELECT 1 FROM submissions
              WHERE id = ? AND event_id = ? AND last_operation_id = ?
           )
      `,
    ).bind(
      decisionId,
      viewer.eventId,
      submission.id,
      status,
      submission.id,
      viewer.eventId,
      decisionId,
    ),
    env.DB.prepare(
      `
        INSERT INTO submission_decisions (
          id, event_id, submission_id, round_id, revision_number, status, decision,
          decided_by_person_id, rationale, notification_feedback_json,
          effect_preview_json, idempotency_key,
          decided_at, published_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(),
               CASE WHEN ? = 'published' THEN unixepoch() END
         WHERE EXISTS (
           SELECT 1 FROM submissions
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
      `,
    ).bind(
      decisionId,
      viewer.eventId,
      submission.id,
      roundId,
      revision,
      status,
      parsed.decision,
      viewer.personId,
      parsed.rationale || null,
      JSON.stringify(notificationFeedback),
      JSON.stringify({
        createsSession: Boolean(sessionId),
        materializesOnboardingTaskPlan: Boolean(sessionId),
        queuesNotification: Boolean(notificationOperationId),
        roundId,
        reviewEvidenceOverride: status === "published" && roundId === null,
        sessionTrackId: sessionTrack?.id ?? null,
        sessionTrackName: sessionTrack?.name ?? null,
      }),
      `decision:${submission.id}:${revision}`,
      status,
      submission.id,
      viewer.eventId,
      decisionId,
    ),
    ...(sessionId
      ? [
          env.DB.prepare(
            `
          INSERT INTO sessions (
            id, event_id, source_submission_id, track_id, title, slug, description, format,
            duration_minutes, status, visibility, revision, created_at, updated_at
          )
          SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unscheduled', 'public', 1, unixepoch(), unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM submission_decisions
              WHERE id = ? AND event_id = ? AND status = 'published' AND decision = 'accepted'
           )
             AND EXISTS (
               SELECT 1 FROM submission_track_selections selection
               JOIN tracks current_track
                 ON current_track.id = selection.track_id
                AND current_track.event_id = selection.event_id
                WHERE selection.submission_id = ? AND selection.event_id = ?
                  AND selection.track_id = ?
                  AND current_track.name = ?
             )
        `,
          ).bind(
            sessionId,
            viewer.eventId,
            submission.id,
            sessionTrack!.id,
            sessionTitle,
            slug,
            sessionDescription,
            format,
            sessionDurationMinutes,
            decisionId,
            viewer.eventId,
            submission.id,
            viewer.eventId,
            sessionTrack!.id,
            sessionTrack!.name,
          ),
          env.DB.prepare(
            `
          INSERT INTO session_speakers (
            session_id, event_id, person_id, position, role_label,
            participation_status, participation_confirmed_at, visibility
          )
          SELECT ?, event_id, person_id, position,
                 CASE WHEN is_primary = 1 THEN 'Primary speaker' ELSE 'Co-speaker' END,
                 'confirmed', unixepoch(), 'public'
            FROM submission_speakers
           WHERE submission_id = ? AND event_id = ? AND person_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM sessions WHERE id = ? AND event_id = ?)
        `,
          ).bind(
            sessionId,
            submission.id,
            viewer.eventId,
            sessionId,
            viewer.eventId,
          ),
          ...materializePublishedResourceAcknowledgementsForSession(
            env,
            viewer.eventId,
            sessionId,
          ),
          ...speakerMemberships.flatMap(({ membershipId, personId }) => [
            env.DB.prepare(
              `
              INSERT INTO memberships (
                id, organisation_id, event_id, person_id, role, invited_at,
                invitation_expires_at, accepted_at, revoked_at, created_at
              )
              SELECT ?, ?, ?, ?, 'speaker', unixepoch(),
                     unixepoch() + 604800, NULL, NULL, unixepoch()
               WHERE EXISTS (
                 SELECT 1 FROM sessions
                  WHERE id = ? AND event_id = ?
               )
              ON CONFLICT(event_id, person_id, role)
              WHERE event_id IS NOT NULL DO UPDATE SET
                invited_at = CASE
                  WHEN memberships.accepted_at IS NULL
                    OR memberships.revoked_at IS NOT NULL
                  THEN unixepoch() ELSE memberships.invited_at END,
                invitation_expires_at = CASE
                  WHEN memberships.accepted_at IS NULL
                    OR memberships.revoked_at IS NOT NULL
                  THEN unixepoch() + 604800
                  ELSE memberships.invitation_expires_at END,
                accepted_at = CASE
                  WHEN memberships.revoked_at IS NOT NULL THEN NULL
                  ELSE memberships.accepted_at END,
                revoked_at = NULL
            `,
            ).bind(
              membershipId,
              viewer.organisationId,
              viewer.eventId,
              personId,
              sessionId,
              viewer.eventId,
            ),
            env.DB.prepare(
              `
              INSERT INTO audit_events (
                id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
                entity_type, entity_id, metadata_json, created_at
              )
              SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'membership.speaker.invited',
                     'membership', membership.id, ?, unixepoch()
                FROM memberships membership
               WHERE membership.event_id = ? AND membership.person_id = ?
                 AND membership.role = 'speaker'
                 AND membership.accepted_at IS NULL
                 AND membership.revoked_at IS NULL
                 AND membership.invitation_expires_at > unixepoch()
                 AND EXISTS (
                   SELECT 1 FROM sessions
                    WHERE id = ? AND event_id = ?
                 )
            `,
            ).bind(
              crypto.randomUUID(),
              viewer.organisationId,
              viewer.eventId,
              viewer.personId,
              JSON.stringify({ sessionId, submissionId: submission.id }),
              viewer.eventId,
              personId,
              sessionId,
              viewer.eventId,
            ),
          ]),
          ...speakerInvitationPlans.flatMap((plan) => plan.statements),
          ...buildAcceptanceTaskPlanStatements({
            env,
            viewer,
            submissionId: submission.id,
            sessionId,
            decisionId,
          }),
        ]
      : []),
    ...(notificationOperationId
      ? [
          env.DB.prepare(
            `
        INSERT INTO operation_jobs (
          id, organisation_id, event_id, requested_by_person_id, type,
          idempotency_key, correlation_id, status, payload_json,
          progress_completed, progress_total, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, 'decision.notification', ?, ?, 'queued', ?, 0, 1, unixepoch(), unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM submission_decisions
            WHERE id = ? AND event_id = ? AND status = 'published'
         )
      `,
          ).bind(
            notificationOperationId,
            viewer.organisationId,
            viewer.eventId,
            viewer.personId,
            `decision-notification:${decisionId}`,
            crypto.randomUUID(),
            JSON.stringify({
              operationId: notificationOperationId,
              eventId: viewer.eventId,
              organisationId: viewer.organisationId,
              type: "decision.notification",
              idempotencyKey: `decision-notification:${decisionId}`,
              payload: { decisionId },
            }),
            decisionId,
            viewer.eventId,
          ),
        ]
      : []),
    env.DB.prepare(
      `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, ?, 'submission_decision', ?, ?, unixepoch()
         WHERE EXISTS (SELECT 1 FROM submission_decisions WHERE id = ? AND event_id = ?)
      `,
    ).bind(
      auditEventId,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      parsed.release ? "decision.published" : "decision.drafted",
      decisionId,
      JSON.stringify({
        decision: parsed.decision,
        sessionId,
        sessionTrackId: sessionTrack?.id ?? null,
        sessionTrackName: sessionTrack?.name ?? null,
        notificationOperationId,
        reviewEvidenceOverride: parsed.release && roundId === null,
      }),
      decisionId,
      viewer.eventId,
    ),
  ];
}
