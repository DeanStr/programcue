import type { Viewer } from "~/platform/auth/authorize.server";
import {
  findSessionFormatConfiguration,
  parseSessionFormatsConfiguration,
} from "~/modules/events/event-configuration";
import { materializePublishedResourceAcknowledgementsForSession } from "~/modules/resources/resource-service.server";
import { submittedSnapshotSchema } from "~/modules/submissions/submission-schema";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  EvaluationDecisionAuthorityError,
  EvaluationDecisionFinalError,
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
import { decisionSchema } from "./evaluation-schema";
import {
  persistAcceptedSpeakerQueueFailure,
  prepareAcceptedSpeakerInvitationPlans,
  type AcceptedSpeakerInvitationPlan,
} from "./accepted-speaker-invitation.server";

type DecisionSubmission = {
  id: string;
  title: string;
  reference: string;
  format: string | null;
  category: string | null;
  status: string;
  revision: number;
  snapshotJson: string | null;
};

const acceptanceTaskPlanGuardSql = `
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

const acceptanceTaskPlanCteSql = `
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

function acceptanceTaskPlanBindings(input: {
  eventId: string;
  submissionId: string;
  sessionId: string;
  decisionId: string;
}) {
  return [input.eventId, input.submissionId, input.sessionId, input.decisionId];
}

function buildAcceptanceTaskPlanStatements(input: {
  env: CloudflareEnvironment;
  viewer: Viewer;
  submissionId: string;
  sessionId: string;
  decisionId: string;
}) {
  const { env, viewer, submissionId, sessionId, decisionId } = input;
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
             0, 1, scope.decision_id,
             CASE template.due_anchor
               WHEN 'acceptance' THEN unixepoch() + template.due_offset_minutes * 60
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
    ).bind(...bindings),
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
         AND task.last_operation_id = (SELECT decision_id FROM acceptance_scope)
    `,
    ).bind(...bindings),
    env.DB.prepare(
      `
      ${acceptanceTaskPlanCteSql}
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, action,
        entity_type, entity_id, metadata_json, created_at
      )
      SELECT lower(hex(randomblob(16))), ?, scope.event_id, ?,
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
         AND task.last_operation_id = scope.decision_id
         AND NOT EXISTS (
           SELECT 1 FROM audit_events existing
            WHERE existing.event_id = scope.event_id
              AND existing.action = 'task.assigned'
              AND existing.entity_type = 'task_instance'
              AND existing.entity_id = task.id
              AND json_extract(existing.metadata_json, '$.decisionId') = scope.decision_id
         )
    `,
    ).bind(...bindings, viewer.organisationId, viewer.personId),
  ];
}

function buildDecisionStatements(input: {
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
    notificationOperationId,
    notificationFeedback,
    roundId,
    speakerMemberships,
    speakerInvitationPlans,
    auditEventId,
  } = input;
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
             ? <> 'published' OR ? <> 'accepted'
             OR ((${speakerSetGuard}) AND (${acceptanceTaskPlanGuardSql}))
           )
           AND (
             ? <> 'published' OR ? <> 'accepted'
             OR EXISTS (
               SELECT 1 FROM submission_track_selections selection
                WHERE selection.submission_id = submissions.id
                  AND selection.event_id = submissions.event_id
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
      status,
      parsed.decision,
      ...speakerSetBindings,
      status,
      parsed.decision,
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
               last_operation_id = ?
         WHERE event_id = ? AND submission_id = ?
           AND status IN ('assigned','in_progress','reopened')
           AND ? = 'published'
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
          SELECT ?, ?, ?, (
                   SELECT selection.track_id
                     FROM submission_track_selections selection
                    WHERE selection.submission_id = ? AND selection.event_id = ?
                    ORDER BY selection.position LIMIT 1
                 ), ?, ?, ?, ?, ?, 'unscheduled', 'public', 1, unixepoch(), unixepoch()
           WHERE EXISTS (
             SELECT 1 FROM submission_decisions
              WHERE id = ? AND event_id = ? AND status = 'published' AND decision = 'accepted'
           )
        `,
          ).bind(
            sessionId,
            viewer.eventId,
            submission.id,
            submission.id,
            viewer.eventId,
            sessionTitle,
            slug,
            sessionDescription,
            format,
            sessionDurationMinutes,
            decisionId,
            viewer.eventId,
          ),
          env.DB.prepare(
            `
          INSERT INTO session_speakers (session_id, event_id, person_id, position, role_label, visibility)
          SELECT ?, event_id, person_id, position,
                 CASE WHEN is_primary = 1 THEN 'Primary speaker' ELSE 'Co-speaker' END, 'public'
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
                id, organisation_id, event_id, actor_person_id, action,
                entity_type, entity_id, metadata_json, created_at
              )
              SELECT ?, ?, ?, ?, 'membership.speaker.invited',
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
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'submission_decision', ?, ?, unixepoch()
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
        notificationOperationId,
        reviewEvidenceOverride: parsed.release && roundId === null,
      }),
      decisionId,
      viewer.eventId,
    ),
  ];
}

export class EvaluationDecisionService {
  constructor(private readonly env: CloudflareEnvironment) {}

  private async acceptedSpeakerInvitationOutcome(
    viewer: Viewer,
    decisionId: string,
    sessionId: string | null,
  ) {
    if (!sessionId) {
      return {
        speakerInvitationStatus: "not_required" as const,
        speakerInvitationCount: 0,
      };
    }
    if (String(this.env.DEMO_MODE) === "true") {
      const pending = await this.env.DB.prepare(
        `SELECT COUNT(*) AS count
           FROM memberships membership
           JOIN session_speakers speaker
             ON speaker.event_id = membership.event_id
            AND speaker.person_id = membership.person_id
          WHERE speaker.session_id = ? AND membership.organisation_id = ?
            AND membership.event_id = ? AND membership.role = 'speaker'
            AND membership.accepted_at IS NULL AND membership.revoked_at IS NULL
            AND membership.invitation_expires_at > unixepoch()`,
      )
        .bind(sessionId, viewer.organisationId, viewer.eventId)
        .first<{ count: number }>();
      const count = Number(pending?.count ?? 0);
      return {
        speakerInvitationStatus:
          count > 0 ? ("demo_not_sent" as const) : ("not_required" as const),
        speakerInvitationCount: count,
      };
    }
    const summary = await this.env.DB.prepare(
      `SELECT COUNT(*) AS count,
              SUM(CASE WHEN operation.status IN (
                    'queue_failed','failed','partially_failed'
                  ) THEN 1 ELSE 0 END) AS retryCount
         FROM communications communication
         JOIN operation_jobs operation
           ON operation.id = communication.operation_id
          AND operation.event_id = communication.event_id
          AND operation.organisation_id = ?
        WHERE communication.event_id = ?
          AND json_extract(communication.audience_json, '$.type') =
              'accepted_speaker_invitation'
          AND json_extract(communication.audience_json, '$.decisionId') = ?`,
    )
      .bind(viewer.organisationId, viewer.eventId, decisionId)
      .first<{ count: number; retryCount: number | null }>();
    const count = Number(summary?.count ?? 0);
    return {
      speakerInvitationStatus:
        count === 0
          ? ("not_required" as const)
          : Number(summary?.retryCount ?? 0) > 0
            ? ("queue_failed" as const)
            : ("queued" as const),
      speakerInvitationCount: count,
    };
  }

  private async assertViewerEvent(viewer: Viewer) {
    const event = await this.env.DB.prepare(
      "SELECT id FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(viewer.eventId, viewer.organisationId)
      .first();
    if (!event) {
      throw new Error("Event not found in the authorised organisation.");
    }
  }

  private async assertAcceptanceTaskPlan(eventId: string) {
    const result = await this.env.DB.prepare(
      `
      WITH RECURSIVE
      acceptance_scope(event_id) AS (VALUES (?)),
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
      )
      SELECT CASE
        WHEN EXISTS (
          SELECT 1
            FROM acceptance_task_plan plan
            JOIN task_templates template ON template.id = plan.template_id
            CROSS JOIN acceptance_scope scope
           WHERE template.event_id IS NOT scope.event_id
              OR template.status <> 'active'
              OR template.due_anchor = 'session_start'
              OR (template.due_anchor = 'fixed' AND template.fixed_due_at IS NULL)
              OR (
                template.due_anchor = 'acceptance'
                AND template.due_offset_minutes IS NULL
              )
        ) THEN 'invalid_template'
        WHEN EXISTS (
          SELECT 1
            FROM acceptance_task_plan plan
            JOIN task_template_dependencies dependency
              ON dependency.template_id = plan.template_id
            JOIN task_templates template ON template.id = dependency.template_id
            JOIN task_templates prerequisite
              ON prerequisite.id = dependency.depends_on_template_id
           WHERE template.target_type <> prerequisite.target_type
        ) THEN 'mixed_scope'
        ELSE NULL
      END AS reason
    `,
    )
      .bind(eventId)
      .first<{ reason: "invalid_template" | "mixed_scope" | null }>();
    if (!result?.reason) return;
    const message = {
      invalid_template:
        "The automatic onboarding task plan contains an inactive, cross-event, or unresolved template.",
      mixed_scope:
        "Automatic onboarding prerequisites must use the same task scope.",
    }[result.reason];
    throw new EvaluationStateError(message);
  }

  private async assertAcceptanceTaskPlanMaterialized(input: {
    eventId: string;
    submissionId: string;
    sessionId: string;
    decisionId: string;
  }) {
    const bindings = acceptanceTaskPlanBindings(input);
    const missing = await this.env.DB.prepare(
      `
      ${acceptanceTaskPlanCteSql}
      SELECT 'task' AS missingKind
        FROM acceptance_task_plan plan
        JOIN task_templates template ON template.id = plan.template_id
        JOIN acceptance_targets target
          ON target.target_type = template.target_type
        CROSS JOIN acceptance_scope scope
       WHERE NOT EXISTS (
         SELECT 1 FROM task_instances task
          WHERE task.event_id = scope.event_id
            AND task.template_id = template.id
            AND task.target_type = target.target_type
            AND task.target_id = target.target_id
       )
      UNION ALL
      SELECT 'dependency' AS missingKind
        FROM acceptance_task_plan plan
        JOIN task_template_dependencies dependency
          ON dependency.template_id = plan.template_id
        JOIN task_templates template ON template.id = dependency.template_id
        JOIN acceptance_targets target
          ON target.target_type = template.target_type
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
       WHERE NOT EXISTS (
         SELECT 1 FROM task_instance_dependencies edge
          WHERE edge.task_id = task.id
            AND edge.depends_on_task_id = prerequisite.id
       )
       LIMIT 1
    `,
    )
      .bind(...bindings)
      .first<{ missingKind: "task" | "dependency" }>();
    if (missing)
      throw new EvaluationStateError(
        `The accepted decision committed without its complete automatic task ${missing.missingKind === "task" ? "plan" : "dependency plan"}. Retry the same decision operation before continuing.`,
      );
  }

  async decide(viewer: Viewer, input: unknown, commandId?: string) {
    await this.assertViewerEvent(viewer);
    if (
      viewer.role !== "owner" &&
      viewer.role !== "administrator" &&
      viewer.role !== "committee_chair"
    ) {
      throw new EvaluationDecisionAuthorityError();
    }
    const parsed = decisionSchema.parse(input);
    if (commandId) {
      const recovered = await this.env.DB.prepare(
        `SELECT decision.id AS decisionId,
                decision.status AS decisionStatus,
                decision.decision AS decision,
                decision.submission_id AS submissionId,
                session.id AS sessionId,
                operation.id AS notificationOperationId,
                operation.status AS notificationStatus
           FROM submission_decisions decision
           JOIN submissions submission
             ON submission.id = decision.submission_id
            AND submission.event_id = decision.event_id
           JOIN events event
             ON event.id = decision.event_id AND event.organisation_id = ?
           LEFT JOIN sessions session
             ON session.source_submission_id = decision.submission_id
            AND session.event_id = decision.event_id
           LEFT JOIN operation_jobs operation
             ON operation.event_id = decision.event_id
            AND operation.idempotency_key = 'decision-notification:' || decision.id
          WHERE decision.id = ? AND decision.event_id = ?`,
      )
        .bind(viewer.organisationId, commandId, viewer.eventId)
        .first<{
          decisionId: string;
          decisionStatus: string;
          decision: string;
          submissionId: string;
          sessionId: string | null;
          notificationOperationId: string | null;
          notificationStatus: string | null;
        }>();
      if (recovered) {
        if (
          recovered.decisionStatus === "published" &&
          recovered.decision === "accepted" &&
          recovered.sessionId
        )
          await this.assertAcceptanceTaskPlanMaterialized({
            eventId: viewer.eventId,
            submissionId: recovered.submissionId,
            sessionId: recovered.sessionId,
            decisionId: recovered.decisionId,
          });
        const speakerInvitations = await this.acceptedSpeakerInvitationOutcome(
          viewer,
          recovered.decisionId,
          recovered.sessionId,
        );
        return {
          decisionId: recovered.decisionId,
          sessionId: recovered.sessionId,
          notificationOperationId: recovered.notificationOperationId,
          notificationStatus:
            recovered.notificationStatus === "queue_failed"
              ? ("queue_failed" as const)
              : recovered.notificationOperationId
                ? ("queued" as const)
                : ("not_requested" as const),
          ...speakerInvitations,
        };
      }
    }
    if (
      parsed.release &&
      viewer.role !== "owner" &&
      viewer.role !== "administrator"
    ) {
      const plan = await this.env.DB.prepare(
        `
        SELECT decision_role AS decisionRole
          FROM evaluation_plans
         WHERE event_id = ? AND status = 'active'
         ORDER BY created_at DESC LIMIT 1
      `,
      )
        .bind(viewer.eventId)
        .first<{ decisionRole: string }>();
      if (
        viewer.role !== "committee_chair" ||
        plan?.decisionRole !== "committee_chair"
      ) {
        throw new EvaluationDecisionAuthorityError();
      }
    }
    const submission = await this.env.DB.prepare(
      `
      SELECT s.id, s.title, s.public_reference AS reference, s.format, s.category,
             s.status, s.revision, s.submitted_snapshot_json AS snapshotJson
        FROM submissions s JOIN events e ON e.id = s.event_id
       WHERE s.id = ? AND s.event_id = ? AND e.organisation_id = ? AND s.status NOT IN ('draft','withdrawn')
    `,
    )
      .bind(parsed.submissionId, viewer.eventId, viewer.organisationId)
      .first<DecisionSubmission>();
    if (!submission)
      throw new EvaluationStateError(
        "Submission not found or cannot be decided.",
      );
    const terminalStatuses = new Set(["accepted", "waitlisted", "rejected"]);
    const prior = await this.env.DB.prepare(
      `
      SELECT COALESCE(MAX(revision_number), 0) AS revision,
             COALESCE(MAX(CASE WHEN status = 'published' THEN 1 ELSE 0 END), 0) AS hasPublished
        FROM submission_decisions WHERE event_id = ? AND submission_id = ?
    `,
    )
      .bind(viewer.eventId, submission.id)
      .first<{ revision: number; hasPublished: number }>();
    if (
      terminalStatuses.has(submission.status) ||
      Number(prior?.hasPublished ?? 0) > 0
    ) {
      throw new EvaluationDecisionFinalError();
    }
    const revision = (prior?.revision ?? 0) + 1;
    const completedRound = await this.env.DB.prepare(
      `
      SELECT a.round_id AS roundId
        FROM evaluator_assignments a
        JOIN reviews r
          ON r.assignment_id = a.id AND r.event_id = a.event_id
         AND r.status IN ('submitted','locked')
        JOIN evaluation_rounds round
          ON round.id = a.round_id AND round.event_id = a.event_id
       WHERE a.event_id = ? AND a.submission_id = ?
       ORDER BY round.round_number DESC LIMIT 1
    `,
    )
      .bind(viewer.eventId, submission.id)
      .first<{ roundId: string }>();
    if (parsed.release && !completedRound) {
      if (!parsed.confirmedWithoutReview) {
        throw new EvaluationValidationError(
          "Confirm the review-evidence override before releasing a decision without completed review evidence.",
        );
      }
    }
    const notificationFeedback =
      parsed.includeReviewerFeedback && completedRound
        ? (
            await this.env.DB.prepare(
              `SELECT trim(review.submitter_feedback) AS feedback
                 FROM evaluator_assignments assignment
                 JOIN reviews review
                   ON review.assignment_id = assignment.id
                  AND review.event_id = assignment.event_id
                WHERE assignment.event_id = ?
                  AND assignment.submission_id = ?
                  AND assignment.round_id = ?
                  AND review.status IN ('submitted','locked')
                  AND length(trim(COALESCE(review.submitter_feedback, ''))) > 0
                ORDER BY assignment.assigned_at, assignment.id`,
            )
              .bind(viewer.eventId, submission.id, completedRound.roundId)
              .all<{ feedback: string }>()
          ).results.map((row) => row.feedback)
        : [];
    const decisionId = commandId ?? crypto.randomUUID();
    const sessionId =
      parsed.release && parsed.decision === "accepted"
        ? commandId
          ? `session:${commandId}`
          : crypto.randomUUID()
        : null;
    let sessionTitle = "";
    let sessionDescription = "";
    let format = "";
    let sessionDurationMinutes = 0;
    let acceptedEvent: {
      name: string;
      brandAccent: string;
      startsAt: number;
      endsAt: number;
      venueName: string | null;
      city: string | null;
    } | null = null;
    if (sessionId) {
      let rawSnapshot: unknown;
      try {
        rawSnapshot = JSON.parse(submission.snapshotJson ?? "null");
      } catch {
        rawSnapshot = null;
      }
      const snapshot = submittedSnapshotSchema.safeParse(rawSnapshot);
      if (!snapshot.success) {
        throw new EvaluationStateError(
          "The accepted submission is missing its valid immutable snapshot.",
        );
      }
      const title = snapshot.data.answers.title;
      sessionTitle = Array.isArray(title)
        ? title
            .map((value) => value.trim())
            .filter(Boolean)
            .join(", ")
        : typeof title === "string"
          ? title.trim()
          : "";
      if (!sessionTitle) {
        throw new EvaluationStateError(
          "The accepted submission snapshot is missing its session title.",
        );
      }
      const description = snapshot.data.answers.description;
      sessionDescription =
        typeof description === "string" ? description.trim() : "";
      const submittedFormat = snapshot.data.answers.format;
      const formatLabel = Array.isArray(submittedFormat)
        ? submittedFormat.join(", ")
        : typeof submittedFormat === "string"
          ? submittedFormat
          : "";
      const event = await this.env.DB.prepare(
        `SELECT name, brand_accent AS brandAccent,
                starts_at AS startsAt, ends_at AS endsAt,
                venue_name AS venueName, city,
                session_formats_json AS sessionFormatsJson
           FROM events WHERE id = ? AND organisation_id = ?`,
      )
        .bind(viewer.eventId, viewer.organisationId)
        .first<{
          name: string;
          brandAccent: string;
          startsAt: number;
          endsAt: number;
          venueName: string | null;
          city: string | null;
          sessionFormatsJson: string;
        }>();
      if (!event) {
        throw new EvaluationStateError(
          "The accepted submission event is unavailable.",
        );
      }
      let configuredFormat;
      try {
        configuredFormat = findSessionFormatConfiguration(
          parseSessionFormatsConfiguration(event.sessionFormatsJson),
          formatLabel,
        );
      } catch (error) {
        throw new EvaluationStateError(
          error instanceof Error
            ? error.message
            : "The event has invalid session-format configuration.",
        );
      }
      if (!configuredFormat) {
        throw new EvaluationStateError(
          `The accepted submission format ${formatLabel ? `“${formatLabel}”` : "is missing and"} is not configured for this event.`,
        );
      }
      format = configuredFormat.key;
      sessionDurationMinutes =
        parsed.sessionDurationMinutes ??
        configuredFormat.defaultDurationMinutes;
      acceptedEvent = event;
    }
    const notificationOperationId = parsed.release
      ? commandId
        ? `decision-notification:${commandId}`
        : crypto.randomUUID()
      : null;
    const status = parsed.release ? "published" : "draft";
    const submissionStatus = parsed.release
      ? parsed.decision
      : "decision_ready";
    const slug = `${
      (sessionTitle || submission.title)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")
        .slice(0, 80) || "session"
    }-${submission.reference.toLowerCase()}`;
    const acceptedSpeakers = sessionId
      ? await this.env.DB.prepare(
          `
          SELECT DISTINCT person.id, person.email,
                 membership.id AS existingMembershipId,
                 membership.accepted_at AS membershipAcceptedAt,
                 membership.revoked_at AS membershipRevokedAt
            FROM submission_speakers submission_speaker
            JOIN people person ON person.id = submission_speaker.person_id
            LEFT JOIN memberships membership
              ON membership.event_id = submission_speaker.event_id
             AND membership.person_id = submission_speaker.person_id
             AND membership.role = 'speaker'
           WHERE submission_speaker.event_id = ?
             AND submission_speaker.submission_id = ?
             AND submission_speaker.person_id IS NOT NULL
           ORDER BY person.id
        `,
        )
          .bind(viewer.eventId, submission.id)
          .all<{
            id: string;
            email: string;
            existingMembershipId: string | null;
            membershipAcceptedAt: number | null;
            membershipRevokedAt: number | null;
          }>()
      : {
          results: [] as Array<{
            id: string;
            email: string;
            existingMembershipId: string | null;
            membershipAcceptedAt: number | null;
            membershipRevokedAt: number | null;
          }>,
        };
    if (sessionId && acceptedSpeakers.results.length === 0) {
      throw new EvaluationStateError(
        "An accepted session requires at least one claimed speaker before release.",
      );
    }
    if (sessionId) await this.assertAcceptanceTaskPlan(viewer.eventId);
    const speakerMemberships = acceptedSpeakers.results.map((speaker) => ({
      membershipId:
        speaker.existingMembershipId ??
        (commandId
          ? `speaker-membership:${commandId}:${speaker.id}`
          : crypto.randomUUID()),
      personId: speaker.id,
    }));
    const speakerInvitations = acceptedSpeakers.results
      .map((speaker, index) => ({
        ...speaker,
        membershipId: speakerMemberships[index]!.membershipId,
      }))
      .filter(
        (speaker) =>
          speaker.membershipAcceptedAt === null ||
          speaker.membershipRevokedAt !== null,
      );
    const operationsQueue = this.env.OPERATIONS_QUEUE;
    if (parsed.release && !operationsQueue) {
      throw new Error("Required OPERATIONS_QUEUE binding is unavailable.");
    }
    const speakerInvitationPlans =
      sessionId && acceptedEvent
        ? await prepareAcceptedSpeakerInvitationPlans({
            env: this.env,
            viewer,
            decisionId,
            sessionId,
            event: acceptedEvent,
            speakers: speakerInvitations,
          })
        : [];
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: parsed.release ? "decision.released" : "decision.recorded",
        entityType: "submission_decision",
        entityId: decisionId,
        idempotencyKey: `${parsed.release ? "decision.released" : "decision.recorded"}:${decisionId}`,
        correlationId: decisionId,
        data: {
          submissionId: submission.id,
          decision: parsed.decision,
          released: parsed.release,
          sessionId,
        },
      },
      auditEventId,
    );
    const statements = buildDecisionStatements({
      env: this.env,
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
      notificationOperationId,
      notificationFeedback,
      roundId: completedRound?.roundId ?? null,
      speakerMemberships,
      speakerInvitationPlans,
      auditEventId,
    });
    statements.push(...preparedWebhook.statements);
    const [updated] = await this.env.DB.batch(statements);
    if ((updated.meta.changes ?? 0) !== 1) {
      if (sessionId) {
        await this.assertAcceptanceTaskPlan(viewer.eventId);
        const pendingSpeaker = await this.env.DB.prepare(
          `
          SELECT 1 FROM submission_speakers
           WHERE event_id = ? AND submission_id = ? AND person_id IS NULL
           LIMIT 1
        `,
        )
          .bind(viewer.eventId, submission.id)
          .first();
        if (pendingSpeaker) {
          throw new EvaluationStateError(
            "Claim every co-speaker before releasing an accepted decision. No speaker will be silently omitted from the session.",
          );
        }
        const submittedTrack = await this.env.DB.prepare(
          `SELECT 1 FROM submission_track_selections
            WHERE submission_id = ? AND event_id = ? LIMIT 1`,
        )
          .bind(submission.id, viewer.eventId)
          .first();
        if (!submittedTrack) {
          throw new EvaluationStateError(
            "An accepted submission must retain at least one submitted event track. Repair the submission before releasing it.",
          );
        }
      }
      if (parsed.release && viewer.role === "committee_chair") {
        const authority = await this.env.DB.prepare(
          `
          SELECT 1 FROM evaluation_plans
           WHERE event_id = ? AND status = 'active'
             AND decision_role = 'committee_chair'
           LIMIT 1
        `,
        )
          .bind(viewer.eventId)
          .first();
        if (!authority) throw new EvaluationDecisionAuthorityError();
      }
      throw new EvaluationRevisionConflictError(
        "This submission changed before the decision was saved. Refresh before trying again.",
      );
    }
    const webhookDeliveries =
      await webhookService.dispatchPreparedEvent(preparedWebhook);
    if (sessionId)
      await this.assertAcceptanceTaskPlanMaterialized({
        eventId: viewer.eventId,
        submissionId: submission.id,
        sessionId,
        decisionId,
      });
    let notificationStatus: "not_requested" | "queued" | "queue_failed" =
      notificationOperationId ? "queued" : "not_requested";
    if (notificationOperationId) {
      const message = {
        operationId: notificationOperationId,
        eventId: viewer.eventId,
        organisationId: viewer.organisationId,
        type: "decision.notification",
        idempotencyKey: `decision-notification:${decisionId}`,
        payload: { decisionId },
      };
      try {
        await operationsQueue!.send(message);
      } catch (error) {
        notificationStatus = "queue_failed";
        await this.env.DB.prepare(
          "UPDATE operation_jobs SET status = 'queue_failed', last_error = ?, updated_at = unixepoch() WHERE id = ?",
        )
          .bind(
            error instanceof Error ? error.message : String(error),
            notificationOperationId,
          )
          .run();
      }
    }
    let speakerInvitationStatus:
      "not_required" | "queued" | "queue_failed" | "demo_not_sent" =
      "not_required";
    const speakerInvitationCount = speakerInvitations.length;
    if (speakerInvitationCount > 0) {
      if (String(this.env.DEMO_MODE) === "true") {
        speakerInvitationStatus = "demo_not_sent";
      } else {
        speakerInvitationStatus = "queued";
        for (const plan of speakerInvitationPlans) {
          try {
            await operationsQueue!.send(plan.message);
          } catch (error) {
            await persistAcceptedSpeakerQueueFailure(this.env, plan, error);
            speakerInvitationStatus = "queue_failed";
          }
        }
      }
    }
    return {
      decisionId,
      sessionId,
      notificationOperationId,
      notificationStatus,
      speakerInvitationStatus,
      speakerInvitationCount,
      webhookDeliveries,
    };
  }
}
