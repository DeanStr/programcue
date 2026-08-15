import { WebhookService } from "~/platform/operations/webhook-service.server";
import { EvaluationRevisionConflictError } from "./evaluation-errors";
import { roundAdvancementSchema } from "./evaluation-schema";
import {
  advancementCommandResultSchema,
  EvaluationServiceFoundation,
  evaluationAuditActor,
  type EvaluationAdminActor,
  type EvaluationAdvancementExecutionResult,
  type EvaluationAdvancementResult,
  type EvaluationApiCommand,
} from "./evaluation-service-foundation.server";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

export class EvaluationRoundAdvanceWorkflow extends EvaluationServiceFoundation {
  async advanceRound(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ): Promise<EvaluationAdvancementExecutionResult> {
    return this.projectCommand(
      viewer,
      "evaluation.advance",
      input,
      command,
      () => this.advanceRoundD1(viewer, input, command),
    );
  }

  protected async advanceRoundD1(
    viewer: EvaluationAdminActor,
    input: unknown,
    command?: EvaluationApiCommand,
  ): Promise<EvaluationAdvancementExecutionResult> {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const auditActor = evaluationAuditActor(viewer);
    const commandState = await this.prepareApiCommand(
      viewer,
      "evaluation.advance",
      command,
      advancementCommandResultSchema,
    );
    if (commandState.replay) return commandState.replay;
    const commandGuard = this.commandGuard(commandState.prepared);
    const parsed = roundAdvancementSchema.parse(input);
    const evaluatorPersonIds = await this.resolveEvaluatorTarget(
      viewer,
      parsed.toRoundId,
      parsed.teamId,
      parsed.evaluatorPersonIds,
    );
    const submissionPlaceholders = parsed.submissionIds
      .map(() => "?")
      .join(",");
    const evaluatorPlaceholders = evaluatorPersonIds.map(() => "?").join(",");
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const result: EvaluationAdvancementResult = {
      advancedSubmissionCount: parsed.submissionIds.length,
      assignmentCount: parsed.submissionIds.length * evaluatorPersonIds.length,
    };
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "round.advanced",
        entityType: "evaluation_round",
        entityId: parsed.toRoundId,
        idempotencyKey: `round.advanced:${parsed.toRoundId}:${parsed.toRoundRevision + 1}`,
        correlationId: operationId,
        data: {
          fromRoundId: parsed.fromRoundId,
          toRoundId: parsed.toRoundId,
          advancedSubmissionCount: result.advancedSubmissionCount,
          assignmentCount: result.assignmentCount,
        },
      },
      auditEventId,
    );
    const eligibilitySql = `
      EXISTS (
        SELECT 1
          FROM evaluation_rounds source_round
          JOIN evaluation_plans source_plan
            ON source_plan.id = source_round.plan_id
           AND source_plan.event_id = source_round.event_id
          JOIN evaluation_rounds target_round
            ON target_round.plan_id = source_round.plan_id
           AND target_round.event_id = source_round.event_id
           AND target_round.round_number = source_round.round_number + 1
         WHERE source_round.id = ? AND source_round.event_id = ?
           AND source_plan.status = 'active'
           AND source_round.status = 'active' AND source_round.revision = ?
           AND target_round.id = ? AND target_round.status = 'draft'
           AND target_round.revision = ?
           AND (target_round.closes_at IS NULL OR target_round.closes_at > unixepoch())
      )
      AND NOT EXISTS (
        SELECT 1 FROM evaluator_assignments unfinished
         WHERE unfinished.event_id = ? AND unfinished.round_id = ?
           AND unfinished.status IN ('assigned','in_progress','reopened')
           AND (
             (unfinished.submission_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM submissions submission
                WHERE submission.id = unfinished.submission_id
                  AND submission.event_id = unfinished.event_id
                  AND ${reviewableSubmissionSql("submission", "review")}
             ))
             OR (unfinished.session_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM sessions session
                WHERE session.id = unfinished.session_id
                  AND session.event_id = unfinished.event_id
                  AND session.status NOT IN ('cancelled','archived')
             ))
           )
      )
      AND NOT EXISTS (
        SELECT 1 FROM evaluator_assignments existing_target_assignment
         WHERE existing_target_assignment.event_id = ?
           AND existing_target_assignment.round_id = ?
      )
      AND (
        SELECT COUNT(DISTINCT eligible.submission_id)
          FROM evaluator_assignments eligible
          JOIN reviews completed_review
            ON completed_review.assignment_id = eligible.id
           AND completed_review.event_id = eligible.event_id
           AND completed_review.status IN ('submitted','locked')
          JOIN submissions submission
            ON submission.id = eligible.submission_id
           AND submission.event_id = eligible.event_id
         WHERE eligible.event_id = ? AND eligible.round_id = ?
           AND eligible.submission_id IN (${submissionPlaceholders})
           AND ${reviewableSubmissionSql("submission", "review")}
      ) = ?
      AND (
        SELECT COUNT(DISTINCT m.person_id) FROM memberships m
         WHERE m.event_id = ? AND m.accepted_at IS NOT NULL
           AND m.revoked_at IS NULL
           AND m.role IN ('evaluator','committee_chair')
           AND m.person_id IN (${evaluatorPlaceholders})
      ) = ?
      AND (
        SELECT COUNT(DISTINCT pool.person_id)
          FROM evaluation_round_reviewers pool
          JOIN events pool_event
            ON pool_event.id = pool.event_id
           AND pool_event.organisation_id = ?
         WHERE pool.event_id = ?
           AND pool.round_id = ?
           AND pool.person_id IN (${evaluatorPlaceholders})
      ) = ?
      ${
        parsed.teamId
          ? `AND (
        SELECT COUNT(DISTINCT tm.person_id)
          FROM evaluation_team_members tm
          JOIN evaluation_teams t
            ON t.id = tm.team_id AND t.event_id = tm.event_id
          JOIN memberships team_membership
            ON team_membership.event_id = tm.event_id
           AND team_membership.person_id = tm.person_id
           AND team_membership.accepted_at IS NOT NULL
           AND team_membership.revoked_at IS NULL
           AND team_membership.role IN ('evaluator','committee_chair')
         WHERE tm.event_id = ? AND tm.team_id = ? AND tm.removed_at IS NULL
           AND t.status = 'active'
           AND tm.person_id IN (${evaluatorPlaceholders})
      ) = ?
      AND (
        SELECT COUNT(DISTINCT tm.person_id)
          FROM evaluation_team_members tm
          JOIN evaluation_teams t
            ON t.id = tm.team_id AND t.event_id = tm.event_id
          JOIN evaluation_round_reviewers pool
            ON pool.event_id = tm.event_id
           AND pool.round_id = ?
           AND pool.person_id = tm.person_id
          JOIN memberships team_membership
            ON team_membership.event_id = tm.event_id
           AND team_membership.person_id = tm.person_id
           AND team_membership.accepted_at IS NOT NULL
           AND team_membership.revoked_at IS NULL
           AND team_membership.role IN ('evaluator','committee_chair')
         WHERE tm.event_id = ? AND tm.team_id = ? AND tm.removed_at IS NULL
           AND t.status = 'active'
      ) = ?`
          : ""
      }
    `;
    const eligibilityBindings: unknown[] = [
      parsed.fromRoundId,
      viewer.eventId,
      parsed.fromRoundRevision,
      parsed.toRoundId,
      parsed.toRoundRevision,
      viewer.eventId,
      parsed.fromRoundId,
      viewer.eventId,
      parsed.toRoundId,
      viewer.eventId,
      parsed.fromRoundId,
      ...parsed.submissionIds,
      parsed.submissionIds.length,
      viewer.eventId,
      ...evaluatorPersonIds,
      evaluatorPersonIds.length,
      viewer.organisationId,
      viewer.eventId,
      parsed.toRoundId,
      ...evaluatorPersonIds,
      evaluatorPersonIds.length,
      ...(parsed.teamId
        ? [
            viewer.eventId,
            parsed.teamId,
            ...evaluatorPersonIds,
            evaluatorPersonIds.length,
            parsed.toRoundId,
            viewer.eventId,
            parsed.teamId,
            evaluatorPersonIds.length,
          ]
        : []),
    ];
    const commandStatements = this.commandClaimStatements(
      commandState.prepared,
    );
    const domainStatementIndex = commandStatements.length;
    const statements: D1PreparedStatement[] = [
      ...commandStatements,
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ? AND ${eligibilitySql}
           ${commandGuard.sql}
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        ...eligibilityBindings,
        ...commandGuard.bindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_rounds SET status = 'closed',
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ? AND status = 'active'
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.fromRoundId,
        viewer.eventId,
        parsed.fromRoundRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_rounds SET status = 'active',
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ? AND status = 'draft'
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.toRoundId,
        viewer.eventId,
        parsed.toRoundRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE reviews SET status = 'locked', locked_at = unixepoch(),
               updated_at = unixepoch()
         WHERE event_id = ? AND status = 'submitted'
           AND assignment_id IN (
             SELECT id FROM evaluator_assignments
              WHERE event_id = ? AND round_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        viewer.eventId,
        parsed.fromRoundId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'decision_ready',
               revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND status IN ('assigned','in_review')
           AND id IN (
             SELECT submission_id FROM evaluator_assignments
              WHERE event_id = ? AND round_id = ?
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        viewer.eventId,
        parsed.fromRoundId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
    ];
    for (const submissionId of parsed.submissionIds) {
      for (const evaluatorPersonId of evaluatorPersonIds) {
        statements.push(
          this.env.DB.prepare(
            `
            INSERT INTO evaluator_assignments (
              id, event_id, round_id, submission_id, evaluator_person_id,
              team_id, status, revision, last_operation_id, assigned_at
            )
            SELECT ?, ?, ?, ?, ?, ?, 'assigned', 1, ?, unixepoch()
             WHERE EXISTS (
               SELECT 1 FROM events
                WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
             )
          `,
          ).bind(
            crypto.randomUUID(),
            viewer.eventId,
            parsed.toRoundId,
            submissionId,
            evaluatorPersonId,
            parsed.teamId,
            operationId,
            viewer.eventId,
            viewer.organisationId,
            operationId,
          ),
        );
      }
    }
    statements.push(
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'assigned',
               revision = revision + 1, updated_at = unixepoch()
         WHERE event_id = ? AND id IN (${submissionPlaceholders})
           AND status = 'decision_ready'
           AND (
             SELECT COUNT(*) FROM evaluator_assignments next_assignment
              WHERE next_assignment.event_id = submissions.event_id
                AND next_assignment.round_id = ?
                AND next_assignment.submission_id = submissions.id
                AND next_assignment.last_operation_id = ?
           ) = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        ...parsed.submissionIds,
        parsed.toRoundId,
        operationId,
        evaluatorPersonIds.length,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, actor_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'evaluation.round.advanced',
               'evaluation_round', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_rounds
            WHERE id = ? AND event_id = ? AND status = 'active'
         )
           AND (
             SELECT COUNT(*) FROM evaluator_assignments committed_assignment
              WHERE committed_assignment.event_id = ?
                AND committed_assignment.round_id = ?
                AND committed_assignment.last_operation_id = ?
           ) = ?
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        auditActor.personId,
        auditActor.actorId,
        parsed.toRoundId,
        JSON.stringify({
          fromRoundId: parsed.fromRoundId,
          submissionIds: parsed.submissionIds,
          evaluatorPersonIds,
          teamId: parsed.teamId,
        }),
        parsed.toRoundId,
        viewer.eventId,
        viewer.eventId,
        parsed.toRoundId,
        operationId,
        result.assignmentCount,
      ),
    );
    if (commandState.prepared) {
      statements.push(
        this.env.DB.prepare(
          `
          UPDATE idempotency_records
             SET status = 'completed', response_status = 200,
                 response_json = json_object(
                   'advancedSubmissionCount', ?,
                   'assignmentCount', ?
                 ),
                 entity_type = 'evaluation_round', entity_id = ?,
                 completed_at = unixepoch()
           WHERE id = ? AND organisation_id = ? AND event_id = ?
             AND actor_id = ? AND scope = 'evaluation.advance'
             AND idempotency_key = ? AND request_hash = ?
             AND status = 'processing'
             AND EXISTS (
               SELECT 1 FROM evaluation_rounds committed_round
                WHERE committed_round.id = ?
                  AND committed_round.event_id = idempotency_records.event_id
                  AND committed_round.status = 'active'
             )
             AND (
               SELECT COUNT(*) FROM evaluator_assignments committed_assignment
                WHERE committed_assignment.event_id = idempotency_records.event_id
                  AND committed_assignment.round_id = ?
                  AND committed_assignment.last_operation_id = ?
             ) = ?
        `,
        ).bind(
          result.advancedSubmissionCount,
          result.assignmentCount,
          parsed.toRoundId,
          commandState.prepared.recordId,
          viewer.organisationId,
          viewer.eventId,
          commandState.prepared.actor.actorId,
          commandState.prepared.input.idempotencyKey,
          commandState.prepared.input.requestHash,
          parsed.toRoundId,
          parsed.toRoundId,
          operationId,
          result.assignmentCount,
        ),
      );
    }
    statements.push(...preparedWebhook.statements);
    const results = await this.env.DB.batch(statements);
    const claimed = results[domainStatementIndex]!;
    if ((claimed.meta.changes ?? 0) !== 1) {
      const replay = await this.recoverApiCommand(commandState.prepared);
      if (replay) return replay;
      throw new EvaluationRevisionConflictError(
        "Round advancement could not be committed. Complete all current assignments and refresh the plan before trying again.",
      );
    }
    const webhookDeliveries =
      await webhookService.dispatchPreparedEvent(preparedWebhook);
    if (commandState.prepared) {
      const replay = await this.readApiCommand(commandState.prepared);
      if (!replay) {
        throw new Error(
          "The evaluation advancement command did not commit an idempotency result.",
        );
      }
      return replay;
    }
    return { ...result, webhookDeliveries };
  }
}
