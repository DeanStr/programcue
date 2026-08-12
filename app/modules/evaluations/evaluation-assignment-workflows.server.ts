import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import { EvaluationRoundWorkflows } from "./evaluation-round-workflows.server";
import {
  assignmentBatchSchema,
  assignmentUndoSchema,
} from "./evaluation-schema";
import {
  assignmentCommandResultSchema,
  evaluationAuditActor,
  type EvaluationAdminActor,
  type EvaluationApiCommand,
  type EvaluationAssignmentResult,
} from "./evaluation-service-foundation.server";

export abstract class EvaluationAssignmentWorkflows extends EvaluationRoundWorkflows {
  async assign(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ): Promise<EvaluationAssignmentResult> {
    return this.projectCommand(
      viewer,
      "evaluation.assign",
      input,
      command,
      () => this.assignD1(viewer, input, command),
    );
  }

  protected async assignD1(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ): Promise<EvaluationAssignmentResult> {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const auditActor = evaluationAuditActor(viewer);
    const commandState = await this.prepareApiCommand(
      viewer,
      "evaluation.assign",
      command,
      assignmentCommandResultSchema,
    );
    if (commandState.replay) return commandState.replay;
    const commandGuard = this.commandGuard(commandState.prepared);
    const parsed = assignmentBatchSchema.parse(input);
    const evaluatorPersonIds = await this.resolveEvaluatorTarget(
      viewer,
      parsed.roundId,
      parsed.teamId,
      parsed.evaluatorPersonIds,
    );
    const round = await this.env.DB.prepare(
      `
      SELECT r.id FROM evaluation_rounds r JOIN evaluation_plans p ON p.id = r.plan_id AND p.event_id = r.event_id
      JOIN events e ON e.id = r.event_id
       WHERE r.id = ? AND r.event_id = ? AND e.organisation_id = ?
         AND r.status = 'active'
         AND (r.opens_at IS NULL OR r.opens_at <= unixepoch())
         AND (r.closes_at IS NULL OR r.closes_at > unixepoch())
    `,
    )
      .bind(parsed.roundId, viewer.eventId, viewer.organisationId)
      .first();
    if (!round)
      throw new EvaluationStateError("Active evaluation round not found.");
    const targetTable =
      parsed.targetType === "submission" ? "submissions" : "sessions";
    const targetStatus =
      parsed.targetType === "submission"
        ? "status IN ('submitted','assigned','in_review')"
        : "status NOT IN ('cancelled','archived')";
    const targetColumn =
      parsed.targetType === "submission" ? "submission_id" : "session_id";
    const targetPlaceholders = parsed.targetIds.map(() => "?").join(",");
    const validTargets = await this.env.DB.prepare(
      `SELECT target.id
         FROM ${targetTable} target
         JOIN events event
           ON event.id = target.event_id AND event.organisation_id = ?
        WHERE target.event_id = ?
          AND target.id IN (${targetPlaceholders})
          AND target.${targetStatus}`,
    )
      .bind(viewer.organisationId, viewer.eventId, ...parsed.targetIds)
      .all<{ id: string }>();
    if (validTargets.results.length !== parsed.targetIds.length)
      throw new EvaluationStateError(
        `One or more ${parsed.targetType}s cannot be assigned.`,
      );
    const operationId = crypto.randomUUID();
    const evaluatorPlaceholders = evaluatorPersonIds.map(() => "?").join(",");
    const eligibilitySql = `
      EXISTS (
        SELECT 1
          FROM evaluation_rounds current_round
          JOIN evaluation_plans current_plan
            ON current_plan.id = current_round.plan_id
           AND current_plan.event_id = current_round.event_id
          JOIN events current_event ON current_event.id = current_round.event_id
         WHERE current_round.id = ? AND current_round.event_id = ?
           AND current_event.organisation_id = ?
           AND current_round.status = 'active'
           AND (current_round.opens_at IS NULL OR current_round.opens_at <= unixepoch())
           AND (current_round.closes_at IS NULL OR current_round.closes_at > unixepoch())
      )
      AND (
        SELECT COUNT(*) FROM ${targetTable} current_target
         WHERE current_target.event_id = ?
           AND current_target.id IN (${targetPlaceholders})
           AND current_target.${targetStatus}
      ) = ?
      AND (
        SELECT COUNT(DISTINCT current_membership.person_id)
          FROM memberships current_membership
         WHERE current_membership.event_id = ?
           AND current_membership.accepted_at IS NOT NULL
           AND current_membership.revoked_at IS NULL
           AND current_membership.role IN ('evaluator','committee_chair')
           AND current_membership.person_id IN (${evaluatorPlaceholders})
        ) = ?
      AND (
        SELECT COUNT(DISTINCT current_pool.person_id)
          FROM evaluation_round_reviewers current_pool
          JOIN events current_pool_event
            ON current_pool_event.id = current_pool.event_id
           AND current_pool_event.organisation_id = ?
         WHERE current_pool.event_id = ?
           AND current_pool.round_id = ?
           AND current_pool.person_id IN (${evaluatorPlaceholders})
      ) = ?
      ${
        parsed.teamId
          ? `AND (
        SELECT COUNT(DISTINCT current_team_member.person_id)
          FROM evaluation_team_members current_team_member
          JOIN evaluation_teams current_team
            ON current_team.id = current_team_member.team_id
           AND current_team.event_id = current_team_member.event_id
          JOIN memberships current_team_membership
            ON current_team_membership.event_id = current_team_member.event_id
           AND current_team_membership.person_id = current_team_member.person_id
           AND current_team_membership.accepted_at IS NOT NULL
           AND current_team_membership.revoked_at IS NULL
           AND current_team_membership.role IN ('evaluator','committee_chair')
         WHERE current_team_member.event_id = ?
           AND current_team_member.team_id = ?
           AND current_team_member.removed_at IS NULL
           AND current_team.status = 'active'
           AND current_team_member.person_id IN (${evaluatorPlaceholders})
      ) = ?
      AND (
        SELECT COUNT(DISTINCT current_team_member.person_id)
          FROM evaluation_team_members current_team_member
          JOIN evaluation_teams current_team
            ON current_team.id = current_team_member.team_id
           AND current_team.event_id = current_team_member.event_id
          JOIN evaluation_round_reviewers current_pool
            ON current_pool.event_id = current_team_member.event_id
           AND current_pool.round_id = ?
           AND current_pool.person_id = current_team_member.person_id
          JOIN memberships current_team_membership
            ON current_team_membership.event_id = current_team_member.event_id
           AND current_team_membership.person_id = current_team_member.person_id
           AND current_team_membership.accepted_at IS NOT NULL
           AND current_team_membership.revoked_at IS NULL
           AND current_team_membership.role IN ('evaluator','committee_chair')
         WHERE current_team_member.event_id = ?
           AND current_team_member.team_id = ?
           AND current_team_member.removed_at IS NULL
           AND current_team.status = 'active'
      ) = ?`
          : ""
      }
      AND NOT EXISTS (
        SELECT 1 FROM evaluator_assignments blocked_assignment
         WHERE blocked_assignment.event_id = ?
           AND blocked_assignment.round_id = ?
           AND blocked_assignment.${targetColumn} IN (${targetPlaceholders})
           AND blocked_assignment.evaluator_person_id IN (${evaluatorPlaceholders})
           AND (
             blocked_assignment.status = 'recused'
             OR (
               blocked_assignment.status = 'cancelled'
               AND (
                 blocked_assignment.cancellation_reason IS NULL
                 OR blocked_assignment.cancellation_reason <> 'reviewer_removed'
               )
             )
           )
      )
      ${commandGuard.sql}
    `;
    const eligibilityBindings = [
      parsed.roundId,
      viewer.eventId,
      viewer.organisationId,
      viewer.eventId,
      ...parsed.targetIds,
      parsed.targetIds.length,
      viewer.eventId,
      ...evaluatorPersonIds,
      evaluatorPersonIds.length,
      viewer.organisationId,
      viewer.eventId,
      parsed.roundId,
      ...evaluatorPersonIds,
      evaluatorPersonIds.length,
      ...(parsed.teamId
        ? [
            viewer.eventId,
            parsed.teamId,
            ...evaluatorPersonIds,
            evaluatorPersonIds.length,
            parsed.roundId,
            viewer.eventId,
            parsed.teamId,
            evaluatorPersonIds.length,
          ]
        : []),
      viewer.eventId,
      parsed.roundId,
      ...parsed.targetIds,
      ...evaluatorPersonIds,
      ...commandGuard.bindings,
    ];
    const coverageSql = `
      (
        SELECT COUNT(*) FROM evaluator_assignments requested_assignment
         WHERE requested_assignment.event_id = ?
           AND requested_assignment.round_id = ?
           AND requested_assignment.${targetColumn} IN (${targetPlaceholders})
           AND requested_assignment.evaluator_person_id IN (${evaluatorPlaceholders})
           AND requested_assignment.status NOT IN ('recused','cancelled')
      ) = ?
    `;
    const coverageBindings = [
      viewer.eventId,
      parsed.roundId,
      ...parsed.targetIds,
      ...evaluatorPersonIds,
      parsed.targetIds.length * evaluatorPersonIds.length,
    ];
    const commandStatements = this.commandClaimStatements(
      commandState.prepared,
    );
    const domainStatementIndex = commandStatements.length;
    const statements: D1PreparedStatement[] = [...commandStatements];
    const assignmentTargetSelect =
      parsed.targetType === "submission"
        ? "target.id, NULL, NULL"
        : `NULL, target.id,
           json_object(
             'schemaVersion', 1,
             'sessionId', target.id,
             'title', target.title,
             'description', target.description,
             'format', target.format,
             'durationMinutes', target.duration_minutes,
             'trackName', (
               SELECT track.name FROM tracks track
                WHERE track.id = target.track_id AND track.event_id = target.event_id
             ),
             'speakers', json(COALESCE((
               SELECT json_group_array(json(ordered_speaker.snapshot))
                 FROM (
                   SELECT json_object(
                            'name', person.display_name,
                            'roleLabel', session_speaker.role_label
                          ) AS snapshot
                     FROM session_speakers session_speaker
                     JOIN people person ON person.id = session_speaker.person_id
                    WHERE session_speaker.session_id = target.id
                      AND session_speaker.event_id = target.event_id
                    ORDER BY session_speaker.position
                 ) ordered_speaker
             ), '[]'))
           )`;
    const conflictTarget = `ON CONFLICT(round_id, ${targetColumn}, evaluator_person_id)
      WHERE ${targetColumn} IS NOT NULL DO UPDATE SET
        status = 'assigned',
        session_snapshot_json = excluded.session_snapshot_json,
        team_id = excluded.team_id,
        revision = evaluator_assignments.revision + 1,
        last_operation_id = excluded.last_operation_id,
        assigned_at = unixepoch(),
        submitted_at = NULL,
        cancellation_reason = NULL
      WHERE evaluator_assignments.status = 'cancelled'
        AND evaluator_assignments.cancellation_reason = 'reviewer_removed'`;
    for (const targetId of parsed.targetIds)
      for (const evaluatorId of evaluatorPersonIds) {
        statements.push(
          this.env.DB.prepare(
            `
        INSERT INTO evaluator_assignments (
          id, event_id, round_id, submission_id, session_id,
          session_snapshot_json, evaluator_person_id, status, team_id,
          revision, last_operation_id, assigned_at
        )
        SELECT ?, ?, ?, ${assignmentTargetSelect}, ?, 'assigned', ?, 1, ?, unixepoch()
          FROM ${targetTable} target
         WHERE target.id = ? AND target.event_id = ? AND target.${targetStatus}
           AND ${eligibilitySql}
        ${conflictTarget}
      `,
          ).bind(
            crypto.randomUUID(),
            viewer.eventId,
            parsed.roundId,
            evaluatorId,
            parsed.teamId,
            operationId,
            targetId,
            viewer.eventId,
            ...eligibilityBindings,
          ),
        );
      }
    if (parsed.targetType === "submission") {
      statements.push(
        this.env.DB.prepare(
          `
      UPDATE submissions
         SET status = 'assigned', revision = revision + 1,
             last_operation_id = ?, updated_at = unixepoch()
       WHERE event_id = ? AND id IN (${targetPlaceholders})
         AND status = 'submitted'
         AND ${eligibilitySql}
         AND ${coverageSql}
    `,
        ).bind(
          operationId,
          viewer.eventId,
          ...parsed.targetIds,
          ...eligibilityBindings,
          ...coverageBindings,
        ),
      );
    }
    statements.push(
      this.env.DB.prepare(
        `
      INSERT INTO audit_events (
        id, organisation_id, event_id, actor_person_id, actor_id, action,
        entity_type, metadata_json, created_at
      )
      SELECT ?, ?, ?, ?, ?, 'evaluation.assignments.created',
             'evaluator_assignment', ?, unixepoch()
       WHERE ${eligibilitySql} AND ${coverageSql}
         AND EXISTS (
           SELECT 1 FROM evaluator_assignments created_assignment
            WHERE created_assignment.event_id = ?
              AND created_assignment.round_id = ?
              AND created_assignment.last_operation_id = ?
         )
    `,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        JSON.stringify({
          targetType: parsed.targetType,
          targetCount: parsed.targetIds.length,
          evaluatorCount: evaluatorPersonIds.length,
          teamId: parsed.teamId,
        }),
        ...eligibilityBindings,
        ...coverageBindings,
        viewer.eventId,
        parsed.roundId,
        operationId,
      ),
    );
    statements.push(
      this.env.DB.prepare(
        `
      SELECT CASE WHEN ${eligibilitySql} AND ${coverageSql}
                  THEN 1 ELSE 0 END AS valid
    `,
      ).bind(...eligibilityBindings, ...coverageBindings),
    );
    const validationStatementIndex = statements.length - 1;
    const requestedAssignmentCount =
      parsed.targetIds.length * evaluatorPersonIds.length;
    if (commandState.prepared) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE idempotency_records
             SET status = 'completed', response_status = 200,
                 response_json = json_object(
                   'createdAssignmentCount', (
                     SELECT COUNT(*) FROM evaluator_assignments created
                      WHERE created.event_id = idempotency_records.event_id
                        AND created.round_id = ?
                        AND created.last_operation_id = ?
                   ),
                   'requestedAssignmentCount', ?,
                   'undoOperationId', CASE WHEN EXISTS (
                     SELECT 1 FROM evaluator_assignments created
                      WHERE created.event_id = idempotency_records.event_id
                        AND created.round_id = ?
                        AND created.last_operation_id = ?
                   ) THEN ? ELSE NULL END,
                   'undoExpiresAt', CASE WHEN EXISTS (
                     SELECT 1 FROM evaluator_assignments created
                      WHERE created.event_id = idempotency_records.event_id
                        AND created.round_id = ?
                        AND created.last_operation_id = ?
                   ) THEN unixepoch() + 300 ELSE NULL END
                 ),
                 entity_type = 'evaluator_assignment', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'evaluation.assign'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND ${eligibilitySql} AND ${coverageSql}
        `,
        ).bind(
          parsed.roundId,
          operationId,
          requestedAssignmentCount,
          parsed.roundId,
          operationId,
          operationId,
          parsed.roundId,
          operationId,
          operationId,
          commandState.prepared.recordId,
          viewer.organisationId,
          viewer.eventId,
          commandState.prepared.actor.actorId,
          commandState.prepared.input.idempotencyKey,
          commandState.prepared.input.requestHash,
          ...eligibilityBindings,
          ...coverageBindings,
        ),
      );
    }
    const results = await this.env.DB.batch(statements);
    const validation = results[validationStatementIndex]?.results?.[0] as
      { valid?: number | boolean } | undefined;
    if (Number(validation?.valid ?? 0) !== 1) {
      const replay = await this.recoverApiCommand(commandState.prepared);
      if (replay) return replay;
      throw new EvaluationRevisionConflictError(
        "The round, evaluation targets, or evaluators changed before the assignments were created. Refresh before trying again.",
      );
    }
    const createdAssignmentCount = results
      .slice(
        domainStatementIndex,
        domainStatementIndex + requestedAssignmentCount,
      )
      .reduce((count, result) => count + (result.meta.changes ?? 0), 0);
    const result: EvaluationAssignmentResult = {
      createdAssignmentCount,
      requestedAssignmentCount,
      undoOperationId: createdAssignmentCount > 0 ? operationId : null,
      undoExpiresAt:
        createdAssignmentCount > 0
          ? Math.floor(Date.now() / 1_000) + 5 * 60
          : null,
    };
    if (commandState.prepared) {
      const replay = await this.readApiCommand(commandState.prepared);
      if (!replay) {
        throw new Error(
          "The evaluation assignment command did not commit an idempotency result.",
        );
      }
      return replay;
    }
    return result;
  }

  async undoAssignments(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.assign.undo",
      input,
      undefined,
      () => this.undoAssignmentsD1(viewer, input),
    );
  }

  protected async undoAssignmentsD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = assignmentUndoSchema.parse(input);
    const operation = await this.env.DB.prepare(
      `
      SELECT COUNT(*) AS assignmentCount,
             SUM(CASE
               WHEN a.status <> 'assigned'
                 OR a.assigned_at < unixepoch() - 300
                 OR round.status <> 'active'
                 OR EXISTS (
                   SELECT 1 FROM reviews review
                    WHERE review.event_id = a.event_id
                      AND review.assignment_id = a.id
                 )
               THEN 1 ELSE 0 END) AS blockedCount
        FROM evaluator_assignments a
        JOIN evaluation_rounds round
          ON round.id = a.round_id AND round.event_id = a.event_id
       WHERE a.event_id = ? AND a.last_operation_id = ?
         AND EXISTS (
           SELECT 1 FROM audit_events original
            WHERE original.id = ?
              AND original.organisation_id = ?
              AND original.event_id = a.event_id
              AND original.action = 'evaluation.assignments.created'
         )
    `,
    )
      .bind(
        viewer.eventId,
        parsed.operationId,
        parsed.operationId,
        viewer.organisationId,
      )
      .first<{ assignmentCount: number; blockedCount: number | null }>();
    const assignmentCount = Number(operation?.assignmentCount ?? 0);
    if (assignmentCount === 0) {
      const auditState = await this.env.DB.prepare(
        `
        SELECT
          EXISTS (
            SELECT 1 FROM audit_events original
             WHERE original.id = ? AND original.organisation_id = ?
               AND original.event_id = ?
               AND original.action = 'evaluation.assignments.created'
          ) AS originalExists,
          EXISTS (
            SELECT 1 FROM audit_events undone
             WHERE undone.organisation_id = ? AND undone.event_id = ?
               AND undone.action = 'evaluation.assignments.undone'
               AND undone.entity_id = ?
          ) AS alreadyUndone
      `,
      )
        .bind(
          parsed.operationId,
          viewer.organisationId,
          viewer.eventId,
          viewer.organisationId,
          viewer.eventId,
          parsed.operationId,
        )
        .first<{
          originalExists: number | boolean;
          alreadyUndone: number | boolean;
        }>();
      if (auditState?.originalExists && !auditState.alreadyUndone) {
        throw new EvaluationStateError(
          "These assignments can no longer be undone because five minutes elapsed, the round changed, or review work started.",
        );
      }
      throw new EvaluationStateError(
        "The assignment operation was not found or has already been undone.",
      );
    }
    if (Number(operation?.blockedCount ?? 0) > 0) {
      throw new EvaluationStateError(
        "These assignments can no longer be undone because five minutes elapsed, the round changed, or review work started.",
      );
    }

    const undoAuditId = crypto.randomUUID();
    const [deleted, , audited] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        DELETE FROM evaluator_assignments
         WHERE event_id = ? AND last_operation_id = ?
           AND EXISTS (
             SELECT 1 FROM audit_events original
              WHERE original.id = ?
                AND original.organisation_id = ?
                AND original.event_id = evaluator_assignments.event_id
                AND original.action = 'evaluation.assignments.created'
           )
           AND NOT EXISTS (
             SELECT 1
               FROM evaluator_assignments blocked
               JOIN evaluation_rounds blocked_round
                 ON blocked_round.id = blocked.round_id
                AND blocked_round.event_id = blocked.event_id
              WHERE blocked.event_id = evaluator_assignments.event_id
                AND blocked.last_operation_id = ?
                AND (
                  blocked.status <> 'assigned'
                  OR blocked.assigned_at < unixepoch() - 300
                  OR blocked_round.status <> 'active'
                  OR EXISTS (
                    SELECT 1 FROM reviews review
                     WHERE review.event_id = blocked.event_id
                       AND review.assignment_id = blocked.id
                  )
                )
           )
      `,
      ).bind(
        viewer.eventId,
        parsed.operationId,
        parsed.operationId,
        viewer.organisationId,
        parsed.operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submissions
           SET status = 'submitted', revision = revision + 1,
               last_operation_id = ?, updated_at = unixepoch()
         WHERE event_id = ? AND status = 'assigned'
           AND last_operation_id = ?
           AND NOT EXISTS (
             SELECT 1 FROM evaluator_assignments remaining
              WHERE remaining.event_id = submissions.event_id
                AND remaining.submission_id = submissions.id
                AND remaining.status NOT IN ('recused','cancelled')
           )
           AND NOT EXISTS (
             SELECT 1 FROM evaluator_assignments original
              WHERE original.event_id = submissions.event_id
                AND original.last_operation_id = ?
           )
      `,
      ).bind(
        undoAuditId,
        viewer.eventId,
        parsed.operationId,
        parsed.operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'evaluation.assignments.undone',
               'evaluator_assignment', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM audit_events original
            WHERE original.id = ? AND original.organisation_id = ?
              AND original.event_id = ?
              AND original.action = 'evaluation.assignments.created'
         )
           AND NOT EXISTS (
             SELECT 1 FROM evaluator_assignments remaining
              WHERE remaining.event_id = ?
                AND remaining.last_operation_id = ?
           )
           AND NOT EXISTS (
             SELECT 1 FROM audit_events prior_undo
              WHERE prior_undo.event_id = ?
                AND prior_undo.action = 'evaluation.assignments.undone'
                AND prior_undo.entity_id = ?
           )
      `,
      ).bind(
        undoAuditId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.operationId,
        JSON.stringify({ assignmentCount }),
        parsed.operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.eventId,
        parsed.operationId,
        viewer.eventId,
        parsed.operationId,
      ),
    ]);
    if (
      (deleted.meta.changes ?? 0) !== assignmentCount ||
      (audited.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationRevisionConflictError(
        "The assignments changed before the undo could be committed. Refresh before trying again.",
      );
    }
    return { undoneAssignmentCount: assignmentCount };
  }
}
