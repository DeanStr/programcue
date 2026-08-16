import type { Viewer } from "~/platform/auth/authorize.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import { hasRunningAiAssessmentForRound } from "./evaluation-round-workflow-support.server";
import { evaluationRoundDeleteSchema } from "./evaluation-schema";
import { EvaluationServiceFoundation } from "./evaluation-service-foundation.server";

export class EvaluationRoundDeleteWorkflow extends EvaluationServiceFoundation {
  async deleteDraftRound(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.round.delete",
      input,
      undefined,
      () => this.deleteDraftRoundD1(viewer, input),
    );
  }

  protected async deleteDraftRoundD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = evaluationRoundDeleteSchema.parse(input);
    const round = await this.env.DB.prepare(
      `
      SELECT r.plan_id AS planId, r.name, r.status, r.revision,
             r.round_number AS roundNumber, p.revision AS planRevision,
             CASE WHEN r.round_number = (
               SELECT MAX(plan_round.round_number)
                 FROM evaluation_rounds plan_round
                WHERE plan_round.event_id = r.event_id
                  AND plan_round.plan_id = r.plan_id
             ) THEN 1 ELSE 0 END AS lastRound,
             (SELECT COUNT(*) FROM evaluation_rounds plan_round
               WHERE plan_round.event_id = r.event_id
                 AND plan_round.plan_id = r.plan_id) AS roundCount,
             EXISTS (
               SELECT 1 FROM evaluator_assignments assignment
                WHERE assignment.event_id = r.event_id
                  AND assignment.round_id = r.id
               UNION ALL
               SELECT 1 FROM evaluator_conflicts conflict
                WHERE conflict.event_id = r.event_id
                  AND conflict.round_id = r.id
               UNION ALL
               SELECT 1 FROM review_moderations moderation
                WHERE moderation.event_id = r.event_id
                  AND moderation.round_id = r.id
               UNION ALL
               SELECT 1 FROM submission_decisions decision
                WHERE decision.event_id = r.event_id
                  AND decision.round_id = r.id
               UNION ALL
               SELECT 1 FROM ai_review_assessments assessment
                WHERE assessment.event_id = r.event_id
                  AND assessment.round_id = r.id
             ) AS hasActivity,
             EXISTS (
               SELECT 1 FROM operation_jobs operation
                WHERE operation.event_id = r.event_id
                  AND operation.organisation_id = e.organisation_id
                  AND operation.type = 'ai.review_assessment.generate'
                  AND operation.status = 'running'
                  AND json_type(operation.payload_json, '$.roundId') = 'text'
                  AND json_extract(operation.payload_json, '$.roundId') = r.id
             ) AS hasRunningAiAssessment
        FROM evaluation_rounds r
        JOIN evaluation_plans p
          ON p.id = r.plan_id AND p.event_id = r.event_id
         AND p.status IN ('draft','active')
        JOIN events e ON e.id = r.event_id AND e.organisation_id = ?
       WHERE r.id = ? AND r.event_id = ?
    `,
    )
      .bind(viewer.organisationId, parsed.roundId, viewer.eventId)
      .first<{
        planId: string;
        name: string;
        status: string;
        revision: number;
        roundNumber: number;
        planRevision: number;
        roundCount: number;
        lastRound: number | boolean;
        hasActivity: number | boolean;
        hasRunningAiAssessment: number | boolean;
      }>();
    if (!round) {
      throw new EvaluationStateError(
        "The evaluation round is not available in this event.",
      );
    }
    const reviewerRows = await this.env.DB.prepare(
      `SELECT pool.person_id AS personId
         FROM evaluation_round_reviewers pool
         JOIN events event
           ON event.id = pool.event_id AND event.organisation_id = ?
        WHERE pool.event_id = ? AND pool.round_id = ?
        ORDER BY pool.person_id`,
    )
      .bind(viewer.organisationId, viewer.eventId, parsed.roundId)
      .all<{ personId: string }>();
    const expectedReviewerPersonIds = [
      ...parsed.expectedReviewerPersonIds,
    ].sort();
    const currentReviewerPersonIds = reviewerRows.results.map(
      (reviewer) => reviewer.personId,
    );
    if (
      currentReviewerPersonIds.length !== expectedReviewerPersonIds.length ||
      currentReviewerPersonIds.some(
        (personId, index) => personId !== expectedReviewerPersonIds[index],
      )
    ) {
      throw new EvaluationRevisionConflictError(
        "The round reviewer pool changed after the deletion was confirmed. Refresh and review the affected reviewers before trying again.",
      );
    }
    if (
      round.revision !== parsed.roundRevision ||
      round.planRevision !== parsed.planRevision
    ) {
      throw new EvaluationRevisionConflictError(
        "The evaluation plan or round changed before it could be deleted.",
      );
    }
    if (round.status !== "draft") {
      throw new EvaluationStateError(
        "Only a draft evaluation round can be deleted.",
      );
    }
    if (round.roundCount <= 1) {
      throw new EvaluationStateError(
        "An evaluation plan must keep at least one round.",
      );
    }
    if (!round.lastRound) {
      throw new EvaluationStateError(
        "Only the final draft round in an evaluation plan can be deleted.",
      );
    }
    if (round.hasRunningAiAssessment) {
      throw new EvaluationStateError(
        "Wait for the running AI review assessment to finish before deleting this round.",
      );
    }
    if (round.hasActivity) {
      throw new EvaluationStateError(
        "A draft round with assignment, conflict, moderation, decision or AI-assessment activity cannot be deleted.",
      );
    }

    const operationId = crypto.randomUUID();
    const reviewerPlaceholders = expectedReviewerPersonIds
      .map(() => "?")
      .join(", ");
    const reviewerSnapshotGuard = `
      AND (SELECT COUNT(*) FROM evaluation_round_reviewers pool
            WHERE pool.event_id = deletable_round.event_id
              AND pool.round_id = deletable_round.id) = ?
      ${
        expectedReviewerPersonIds.length > 0
          ? `AND NOT EXISTS (
               SELECT 1 FROM evaluation_round_reviewers pool
                WHERE pool.event_id = deletable_round.event_id
                  AND pool.round_id = deletable_round.id
                  AND pool.person_id NOT IN (${reviewerPlaceholders})
             )`
          : ""
      }
    `;
    const results = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1
               FROM evaluation_rounds deletable_round
               JOIN evaluation_plans plan
                 ON plan.id = deletable_round.plan_id
                AND plan.event_id = deletable_round.event_id
                AND plan.status IN ('draft','active')
              WHERE deletable_round.id = ?
                AND deletable_round.event_id = events.id
                AND deletable_round.status = 'draft'
                AND deletable_round.revision = ?
                AND plan.revision = ?
                AND (SELECT COUNT(*) FROM evaluation_rounds plan_round
                      WHERE plan_round.event_id = deletable_round.event_id
                        AND plan_round.plan_id = deletable_round.plan_id) > 1
                AND deletable_round.round_number = (
                  SELECT MAX(plan_round.round_number)
                    FROM evaluation_rounds plan_round
                   WHERE plan_round.event_id = deletable_round.event_id
                     AND plan_round.plan_id = deletable_round.plan_id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM evaluator_assignments assignment
                   WHERE assignment.event_id = deletable_round.event_id
                     AND assignment.round_id = deletable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM evaluator_conflicts conflict
                   WHERE conflict.event_id = deletable_round.event_id
                     AND conflict.round_id = deletable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM review_moderations moderation
                   WHERE moderation.event_id = deletable_round.event_id
                     AND moderation.round_id = deletable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM submission_decisions decision
                   WHERE decision.event_id = deletable_round.event_id
                     AND decision.round_id = deletable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM ai_review_assessments assessment
                   WHERE assessment.event_id = deletable_round.event_id
                     AND assessment.round_id = deletable_round.id
                )
                AND NOT EXISTS (
                  SELECT 1 FROM operation_jobs operation
                   WHERE operation.event_id = deletable_round.event_id
                     AND operation.organisation_id = events.organisation_id
                     AND operation.type = 'ai.review_assessment.generate'
                     AND operation.status = 'running'
                     AND json_type(operation.payload_json, '$.roundId') = 'text'
                     AND json_extract(operation.payload_json, '$.roundId') = deletable_round.id
                )
                ${reviewerSnapshotGuard}
           )
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.roundId,
        parsed.roundRevision,
        parsed.planRevision,
        expectedReviewerPersonIds.length,
        ...expectedReviewerPersonIds,
      ),
      this.env.DB.prepare(
        `
        DELETE FROM evaluation_rounds
         WHERE id = ? AND event_id = ? AND plan_id = ?
           AND status = 'draft' AND revision = ?
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ?
                AND last_operation_id = ?
           )
      `,
      ).bind(
        parsed.roundId,
        viewer.eventId,
        round.planId,
        parsed.roundRevision,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE evaluation_plans
           SET revision = revision + 1,
               blinded_reviewing = CASE WHEN EXISTS (
                 SELECT 1 FROM evaluation_rounds remaining_round
                  WHERE remaining_round.event_id = evaluation_plans.event_id
                    AND remaining_round.plan_id = evaluation_plans.id
                    AND remaining_round.blinded_reviewing = 1
               ) THEN 1 ELSE 0 END,
               updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND NOT EXISTS (
             SELECT 1 FROM evaluation_rounds deleted_round
              WHERE deleted_round.id = ?
                AND deleted_round.event_id = evaluation_plans.event_id
           )
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ?
                AND last_operation_id = ?
           )
      `,
      ).bind(
        round.planId,
        viewer.eventId,
        parsed.planRevision,
        parsed.roundId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, 'person', 'admin_ui', 1, ?, ?, ?, 'evaluation.round.deleted',
               'evaluation_round', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluation_plans plan
            WHERE plan.id = ? AND plan.event_id = ? AND plan.revision = ?
         )
           AND NOT EXISTS (
             SELECT 1 FROM evaluation_rounds deleted_round
              WHERE deleted_round.id = ? AND deleted_round.event_id = ?
           )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.roundId,
        JSON.stringify({
          name: round.name,
          roundNumber: round.roundNumber,
        }),
        round.planId,
        viewer.eventId,
        parsed.planRevision + 1,
        parsed.roundId,
        viewer.eventId,
      ),
    ]);
    if ((results[0]?.meta.changes ?? 0) !== 1) {
      if (
        await hasRunningAiAssessmentForRound(
          this.env.DB,
          viewer.organisationId,
          viewer.eventId,
          parsed.roundId,
        )
      ) {
        throw new EvaluationStateError(
          "A running AI review assessment appeared before the round could be deleted. Wait for it to finish and try again.",
        );
      }
      throw new EvaluationRevisionConflictError(
        "The evaluation plan or round changed before it could be deleted.",
      );
    }
    if (
      (results[1]?.meta.changes ?? 0) < 1 ||
      (results[2]?.meta.changes ?? 0) !== 1 ||
      (results[3]?.meta.changes ?? 0) !== 1
    ) {
      throw new Error(
        "The confirmed evaluation round deletion did not commit completely.",
      );
    }
    return {
      roundId: parsed.roundId,
      planRevision: parsed.planRevision + 1,
    };
  }
}
