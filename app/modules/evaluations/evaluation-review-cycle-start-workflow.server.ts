import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import { reviewCycleStartSchema } from "./evaluation-schema";
import {
  type EvaluationReviewCycleResult,
  EvaluationServiceFoundation,
} from "./evaluation-service-foundation.server";

export class EvaluationReviewCycleStartWorkflow extends EvaluationServiceFoundation {
  async startReviewCycle(
    viewer: Viewer,
    input: unknown,
  ): Promise<EvaluationReviewCycleResult> {
    return this.projectCommand(
      viewer,
      "evaluation.review_cycle.start",
      input,
      undefined,
      () => this.startReviewCycleD1(viewer, input),
    );
  }

  protected async startReviewCycleD1(
    viewer: Viewer,
    input: unknown,
  ): Promise<EvaluationReviewCycleResult> {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationAccessAdministrator(viewer);
    const parsed = reviewCycleStartSchema.parse(input);
    const current = await this.env.DB.prepare(
      `SELECT plan.id, plan.revision, plan.status,
              plan.decision_role AS decisionRole,
              (SELECT COUNT(*)
                 FROM evaluation_plans current_plan
                WHERE current_plan.event_id = plan.event_id
                  AND current_plan.status <> 'archived') AS currentPlanCount,
              (SELECT COUNT(*)
                 FROM evaluation_rounds round
                WHERE round.event_id = plan.event_id
                  AND round.plan_id = plan.id) AS roundCount,
              (SELECT COUNT(*)
                 FROM evaluation_rounds round
                WHERE round.event_id = plan.event_id
                  AND round.plan_id = plan.id
                  AND round.status <> 'archived') AS unarchivedRoundCount,
              (SELECT COUNT(*)
                 FROM evaluator_assignments assignment
                 JOIN evaluation_rounds round
                   ON round.id = assignment.round_id
                  AND round.event_id = assignment.event_id
                WHERE round.event_id = plan.event_id
                  AND round.plan_id = plan.id
                  AND assignment.status IN ('assigned','in_progress','reopened'))
                AS unfinishedAssignmentCount,
              (SELECT COUNT(*)
                 FROM reviews review
                 JOIN evaluator_assignments assignment
                   ON assignment.id = review.assignment_id
                  AND assignment.event_id = review.event_id
                 JOIN evaluation_rounds round
                   ON round.id = assignment.round_id
                  AND round.event_id = assignment.event_id
                WHERE round.event_id = plan.event_id
                  AND round.plan_id = plan.id
                  AND review.status IN ('draft','reopened'))
                AS unfinishedReviewCount,
              (SELECT COUNT(*)
                 FROM operation_jobs operation
                 JOIN evaluation_rounds operation_round
                   ON operation_round.id = json_extract(
                        operation.payload_json,
                        '$.roundId'
                      )
                  AND operation_round.event_id = operation.event_id
                WHERE operation.event_id = plan.event_id
                  AND operation.organisation_id = event.organisation_id
                  AND operation.type = 'ai.review_assessment.generate'
                  AND operation.status = 'running'
                  AND operation_round.plan_id = plan.id)
                AS runningAssessmentOperationCount
         FROM evaluation_plans plan
         JOIN events event
           ON event.id = plan.event_id AND event.organisation_id = ?
        WHERE plan.id = ? AND plan.event_id = ?
          AND plan.status <> 'archived'`,
    )
      .bind(viewer.organisationId, parsed.currentPlanId, viewer.eventId)
      .first<{
        id: string;
        revision: number;
        status: "draft" | "active" | "closed";
        decisionRole: "administrator" | "committee_chair";
        currentPlanCount: number;
        roundCount: number;
        unarchivedRoundCount: number;
        unfinishedAssignmentCount: number;
        unfinishedReviewCount: number;
        runningAssessmentOperationCount: number;
      }>();
    if (!current || Number(current.currentPlanCount) !== 1) {
      throw new EvaluationStateError(
        "Start a new review cycle only from the event's single current evaluation plan.",
      );
    }
    if (current.status === "draft") {
      throw new EvaluationStateError(
        "Activate the current evaluation plan before starting a later review cycle.",
      );
    }
    if (
      Number(current.roundCount) === 0 ||
      Number(current.unarchivedRoundCount) === 0
    ) {
      throw new EvaluationStateError(
        "The current evaluation plan has no review round to archive.",
      );
    }
    if (Number(current.runningAssessmentOperationCount) !== 0) {
      throw new EvaluationStateError(
        "Wait for every running AI review assessment in the current cycle to finish before starting a new review cycle.",
      );
    }
    if (
      current.revision !== parsed.currentPlanRevision ||
      Number(current.runningAssessmentOperationCount) !==
        parsed.expectedRunningAssessmentOperationCount ||
      Number(current.unfinishedAssignmentCount) !==
        parsed.expectedUnfinishedAssignmentCount ||
      Number(current.unfinishedReviewCount) !==
        parsed.expectedUnfinishedReviewCount
    ) {
      throw new EvaluationRevisionConflictError(
        "The current review cycle changed after the confirmation was prepared. Refresh and review the latest unfinished counts.",
      );
    }

    const operationId = crypto.randomUUID();
    const planId = crypto.randomUUID();
    const roundId = crypto.randomUUID();
    const criteria = parsed.round.criteria.map((criterion, position) => ({
      ...criterion,
      id: crypto.randomUUID(),
      position,
    }));
    const opensAt = parsed.round.opensAt
      ? Math.floor(Date.parse(parsed.round.opensAt) / 1_000)
      : null;
    const closesAt = parsed.round.closesAt
      ? Math.floor(Date.parse(parsed.round.closesAt) / 1_000)
      : null;
    const unfinishedAssignmentCountSql = `(
      SELECT COUNT(*)
        FROM evaluator_assignments assignment
        JOIN evaluation_rounds round
          ON round.id = assignment.round_id
         AND round.event_id = assignment.event_id
       WHERE round.event_id = events.id
         AND round.plan_id = ?
         AND assignment.status IN ('assigned','in_progress','reopened')
    )`;
    const unfinishedReviewCountSql = `(
      SELECT COUNT(*)
        FROM reviews review
        JOIN evaluator_assignments assignment
          ON assignment.id = review.assignment_id
         AND assignment.event_id = review.event_id
        JOIN evaluation_rounds round
          ON round.id = assignment.round_id
         AND round.event_id = assignment.event_id
       WHERE round.event_id = events.id
         AND round.plan_id = ?
         AND review.status IN ('draft','reopened')
    )`;
    const statements: D1PreparedStatement[] = [
      this.env.DB.prepare(
        `UPDATE events
            SET last_operation_id = ?, updated_at = unixepoch()
          WHERE id = ? AND organisation_id = ?
            AND (SELECT COUNT(*) FROM evaluation_plans current_plan
                  WHERE current_plan.event_id = events.id
                    AND current_plan.status <> 'archived') = 1
            AND EXISTS (
              SELECT 1 FROM evaluation_plans current_plan
               WHERE current_plan.id = ?
                 AND current_plan.event_id = events.id
                 AND current_plan.revision = ?
                 AND current_plan.status IN ('active','closed')
            )
            AND ? = (
              SELECT COUNT(*) FROM evaluation_rounds current_round
               WHERE current_round.event_id = events.id
                 AND current_round.plan_id = ?
                 AND current_round.status <> 'archived'
            )
            AND ? = ${unfinishedAssignmentCountSql}
            AND ? = ${unfinishedReviewCountSql}
            AND NOT EXISTS (
              SELECT 1
                FROM operation_jobs operation
                JOIN evaluation_rounds operation_round
                  ON operation_round.id = json_extract(
                       operation.payload_json,
                       '$.roundId'
                     )
                 AND operation_round.event_id = operation.event_id
               WHERE operation.event_id = events.id
                 AND operation.organisation_id = events.organisation_id
                 AND operation.type = 'ai.review_assessment.generate'
                 AND operation.status = 'running'
                 AND operation_round.plan_id = ?
            )`,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.currentPlanId,
        parsed.currentPlanRevision,
        Number(current.unarchivedRoundCount),
        parsed.currentPlanId,
        parsed.expectedUnfinishedAssignmentCount,
        parsed.currentPlanId,
        parsed.expectedUnfinishedReviewCount,
        parsed.currentPlanId,
        parsed.currentPlanId,
      ),
      this.env.DB.prepare(
        `UPDATE evaluation_plans
            SET status = 'archived', revision = revision + 1,
                updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND revision = ?
            AND status IN ('active','closed')
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = evaluation_plans.event_id
                 AND event.organisation_id = ?
                 AND event.last_operation_id = ?
            )`,
      ).bind(
        parsed.currentPlanId,
        viewer.eventId,
        parsed.currentPlanRevision,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE evaluation_rounds
            SET status = 'archived', revision = revision + 1,
                last_operation_id = ?, updated_at = unixepoch()
          WHERE event_id = ? AND plan_id = ? AND status <> 'archived'
            AND EXISTS (
              SELECT 1 FROM evaluation_plans archived_plan
               WHERE archived_plan.id = evaluation_rounds.plan_id
                 AND archived_plan.event_id = evaluation_rounds.event_id
                 AND archived_plan.status = 'archived'
                 AND archived_plan.revision = ?
            )
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = evaluation_rounds.event_id
                 AND event.organisation_id = ?
                 AND event.last_operation_id = ?
            )`,
      ).bind(
        operationId,
        viewer.eventId,
        parsed.currentPlanId,
        parsed.currentPlanRevision + 1,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO evaluation_plans (
           id, event_id, name, status, blinded_reviewing, decision_role,
           revision, created_by_person_id, created_at, updated_at
         )
         SELECT ?, event.id, ?, 'active', ?, ?, 1, ?, unixepoch(), unixepoch()
           FROM events event
          WHERE event.id = ? AND event.organisation_id = ?
            AND event.last_operation_id = ?
            AND EXISTS (
              SELECT 1 FROM evaluation_plans archived_plan
               WHERE archived_plan.id = ?
                 AND archived_plan.event_id = event.id
                 AND archived_plan.status = 'archived'
                 AND archived_plan.revision = ?
            )
            AND NOT EXISTS (
              SELECT 1 FROM evaluation_plans current_plan
               WHERE current_plan.event_id = event.id
                 AND current_plan.status <> 'archived'
            )`,
      ).bind(
        planId,
        parsed.planName,
        parsed.round.anonymous ? 1 : 0,
        current.decisionRole,
        viewer.personId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
        parsed.currentPlanId,
        parsed.currentPlanRevision + 1,
      ),
      this.env.DB.prepare(
        `INSERT INTO evaluation_rounds (
           id, event_id, plan_id, round_number, name, status,
           opens_at, closes_at, blinded_reviewing, scorecard_id,
           scorecard_version, advancement_rule_json, revision,
           created_at, updated_at
         )
         SELECT ?, plan.event_id, plan.id, 1, ?, 'active', ?, ?, ?, ?, 1,
                '{}', 1, unixepoch(), unixepoch()
           FROM evaluation_plans plan
           JOIN events event
             ON event.id = plan.event_id AND event.organisation_id = ?
          WHERE plan.id = ? AND plan.event_id = ? AND plan.status = 'active'
            AND plan.revision = 1 AND event.last_operation_id = ?`,
      ).bind(
        roundId,
        parsed.round.name,
        opensAt,
        closesAt,
        parsed.round.anonymous ? 1 : 0,
        roundId,
        viewer.organisationId,
        planId,
        viewer.eventId,
        operationId,
      ),
    ];
    for (const criterion of criteria) {
      statements.push(
        this.env.DB.prepare(
          `INSERT INTO evaluation_criteria (
             id, event_id, round_id, name, description, input_type,
             options_json, weight_percent, required, position
           )
           SELECT ?, round.event_id, round.id, ?, ?, ?, ?, ?, ?, ?
             FROM evaluation_rounds round
             JOIN evaluation_plans plan
               ON plan.id = round.plan_id AND plan.event_id = round.event_id
             JOIN events event
               ON event.id = round.event_id AND event.organisation_id = ?
            WHERE round.id = ? AND round.event_id = ?
              AND round.status = 'active' AND round.revision = 1
              AND plan.id = ? AND plan.status = 'active'
              AND event.last_operation_id = ?`,
        ).bind(
          criterion.id,
          criterion.name,
          criterion.description || null,
          criterion.inputType,
          JSON.stringify(criterion.options),
          criterion.weightPercent,
          criterion.required ? 1 : 0,
          criterion.position,
          viewer.organisationId,
          roundId,
          viewer.eventId,
          planId,
          operationId,
        ),
      );
    }
    const auditIndex = statements.length;
    statements.push(
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
           entity_type, entity_id, metadata_json, created_at
         )
         SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'evaluation.review_cycle.started',
                'evaluation_plan', ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM evaluation_plans archived_plan
             WHERE archived_plan.id = ? AND archived_plan.event_id = ?
               AND archived_plan.status = 'archived'
          )
            AND NOT EXISTS (
              SELECT 1 FROM evaluation_rounds old_round
               WHERE old_round.event_id = ? AND old_round.plan_id = ?
                 AND old_round.status <> 'archived'
            )
            AND EXISTS (
              SELECT 1 FROM evaluation_plans new_plan
               WHERE new_plan.id = ? AND new_plan.event_id = ?
                 AND new_plan.status = 'active'
            )
            AND EXISTS (
              SELECT 1 FROM evaluation_rounds new_round
               WHERE new_round.id = ? AND new_round.event_id = ?
                 AND new_round.plan_id = ? AND new_round.status = 'active'
                 AND (SELECT COUNT(*) FROM evaluation_criteria criterion
                       WHERE criterion.event_id = new_round.event_id
                         AND criterion.round_id = new_round.id) = ?
            )
            AND EXISTS (
              SELECT 1 FROM events event
               WHERE event.id = ? AND event.organisation_id = ?
                 AND event.last_operation_id = ?
            )`,
      ).bind(
        operationId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        planId,
        JSON.stringify({
          archivedPlanId: parsed.currentPlanId,
          planId,
          roundId,
          unfinishedAssignmentCount: parsed.expectedUnfinishedAssignmentCount,
          unfinishedReviewCount: parsed.expectedUnfinishedReviewCount,
        }),
        parsed.currentPlanId,
        viewer.eventId,
        viewer.eventId,
        parsed.currentPlanId,
        planId,
        viewer.eventId,
        roundId,
        viewer.eventId,
        planId,
        criteria.length,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `SELECT CASE WHEN EXISTS (
           SELECT 1 FROM audit_events audit
            WHERE audit.id = ? AND audit.organisation_id = ?
              AND audit.event_id = ?
              AND audit.action = 'evaluation.review_cycle.started'
         ) THEN 1 ELSE json_extract('review-cycle-commit-failed', '$') END
           AS valid`,
      ).bind(operationId, viewer.organisationId, viewer.eventId),
    );

    let results: D1Result[];
    try {
      results = await this.env.DB.batch(statements);
    } catch (error) {
      const refreshed = await this.env.DB.prepare(
        `SELECT plan.id, plan.revision,
                (SELECT COUNT(*)
                   FROM evaluation_rounds round
                  WHERE round.event_id = plan.event_id
                    AND round.plan_id = plan.id
                    AND round.status <> 'archived') AS unarchivedRoundCount,
                (SELECT COUNT(*)
                   FROM evaluator_assignments assignment
                   JOIN evaluation_rounds round
                     ON round.id = assignment.round_id
                    AND round.event_id = assignment.event_id
                  WHERE round.event_id = plan.event_id
                    AND round.plan_id = plan.id
                    AND assignment.status IN ('assigned','in_progress','reopened'))
                  AS unfinishedAssignmentCount,
                (SELECT COUNT(*)
                   FROM reviews review
                   JOIN evaluator_assignments assignment
                     ON assignment.id = review.assignment_id
                    AND assignment.event_id = review.event_id
                   JOIN evaluation_rounds round
                     ON round.id = assignment.round_id
                    AND round.event_id = assignment.event_id
                  WHERE round.event_id = plan.event_id
                    AND round.plan_id = plan.id
                    AND review.status IN ('draft','reopened'))
                  AS unfinishedReviewCount,
                (SELECT COUNT(*)
                   FROM operation_jobs operation
                   JOIN evaluation_rounds operation_round
                     ON operation_round.id = json_extract(
                          operation.payload_json,
                          '$.roundId'
                        )
                    AND operation_round.event_id = operation.event_id
                  WHERE operation.event_id = plan.event_id
                    AND operation.organisation_id = event.organisation_id
                    AND operation.type = 'ai.review_assessment.generate'
                    AND operation.status = 'running'
                    AND operation_round.plan_id = plan.id)
                  AS runningAssessmentOperationCount
           FROM evaluation_plans plan
           JOIN events event
             ON event.id = plan.event_id AND event.organisation_id = ?
          WHERE plan.event_id = ? AND plan.status <> 'archived'
          ORDER BY plan.created_at DESC LIMIT 1`,
      )
        .bind(viewer.organisationId, viewer.eventId)
        .first<{
          id: string;
          revision: number;
          unarchivedRoundCount: number;
          unfinishedAssignmentCount: number;
          unfinishedReviewCount: number;
          runningAssessmentOperationCount: number;
        }>();
      if (Number(refreshed?.runningAssessmentOperationCount ?? 0) !== 0) {
        throw new EvaluationStateError(
          "A running AI review assessment appeared before the new review cycle could start. Wait for it to finish and try again.",
        );
      }
      if (
        !refreshed ||
        refreshed.id !== parsed.currentPlanId ||
        refreshed.revision !== parsed.currentPlanRevision ||
        Number(refreshed.unarchivedRoundCount) !==
          Number(current.unarchivedRoundCount) ||
        Number(refreshed.unfinishedAssignmentCount) !==
          parsed.expectedUnfinishedAssignmentCount ||
        Number(refreshed.unfinishedReviewCount) !==
          parsed.expectedUnfinishedReviewCount
      ) {
        throw new EvaluationRevisionConflictError(
          "The current review cycle changed before the new cycle could start. Refresh and try again.",
        );
      }
      throw error;
    }
    const expectedChanges = [
      [results[0], 1],
      [results[1], 1],
      [results[2], Number(current.unarchivedRoundCount)],
      [results[3], 1],
      [results[4], 1],
      ...criteria.map((_, index) => [results[5 + index], 1] as const),
      [results[auditIndex], 1],
    ] as const;
    if (
      expectedChanges.some(
        ([result, expected]) => (result?.meta.changes ?? 0) !== expected,
      )
    ) {
      throw new Error(
        "The new review cycle committed without its complete historical archive and fresh rubric.",
      );
    }
    return {
      archivedPlanId: parsed.currentPlanId,
      planId,
      roundId,
      unfinishedAssignmentCount: parsed.expectedUnfinishedAssignmentCount,
      unfinishedReviewCount: parsed.expectedUnfinishedReviewCount,
    };
  }
}
