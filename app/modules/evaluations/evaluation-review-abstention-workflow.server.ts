import type { AuditOrigin } from "~/platform/audit/audit-contract";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
} from "./evaluation-errors";
import { reviewAbstentionSchema } from "./evaluation-schema";
import { EvaluationServiceFoundation } from "./evaluation-service-foundation.server";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

type ReviewerActionOrigin = Extract<AuditOrigin, "participant_ui" | "api">;

export class EvaluationReviewAbstentionWorkflow extends EvaluationServiceFoundation {
  async abstain(viewer: Viewer, input: unknown, origin: ReviewerActionOrigin) {
    return this.projectCommand(
      viewer,
      "evaluation.review.abstain",
      input,
      undefined,
      () => this.abstainD1(viewer, input, origin),
    );
  }

  protected async abstainD1(
    viewer: Viewer,
    input: unknown,
    origin: ReviewerActionOrigin,
  ) {
    await this.assertViewerEvent(viewer);
    const parsed = reviewAbstentionSchema.parse(input);
    const assignment = await this.env.DB.prepare(
      `SELECT assignment.id, assignment.revision,
              assignment.round_id AS roundId,
              assignment.submission_id AS submissionId,
              assignment.session_id AS sessionId
         FROM evaluator_assignments assignment
         JOIN evaluation_round_reviewers pool
           ON pool.event_id = assignment.event_id
          AND pool.round_id = assignment.round_id
          AND pool.person_id = assignment.evaluator_person_id
         JOIN evaluation_rounds round
           ON round.id = assignment.round_id
          AND round.event_id = assignment.event_id
         JOIN evaluation_plans plan
           ON plan.id = round.plan_id AND plan.event_id = round.event_id
         LEFT JOIN submissions submission
           ON submission.id = assignment.submission_id
          AND submission.event_id = assignment.event_id
         LEFT JOIN sessions session
           ON session.id = assignment.session_id
          AND session.event_id = assignment.event_id
         JOIN events event
           ON event.id = assignment.event_id AND event.organisation_id = ?
        WHERE assignment.id = ? AND assignment.event_id = ?
          AND assignment.evaluator_person_id = ?
          AND assignment.status IN ('assigned','in_progress','reopened')
          AND plan.status = 'active' AND round.status = 'active'
          AND (round.opens_at IS NULL OR round.opens_at <= unixepoch())
          AND (round.closes_at IS NULL OR round.closes_at > unixepoch())
          AND (
            (assignment.submission_id IS NOT NULL
             AND ${reviewableSubmissionSql("submission", "review")})
            OR (assignment.session_id IS NOT NULL
                AND session.status NOT IN ('cancelled','archived'))
          )`,
    )
      .bind(
        viewer.organisationId,
        parsed.assignmentId,
        viewer.eventId,
        viewer.personId,
      )
      .first<{
        id: string;
        revision: number;
        roundId: string;
        submissionId: string | null;
        sessionId: string | null;
      }>();
    if (!assignment) {
      throw new EvaluationStateError(
        "Assignment not found or cannot be returned.",
      );
    }
    const targetId = assignment.submissionId ?? assignment.sessionId;
    if (!targetId) {
      throw new Error(`Evaluation assignment ${assignment.id} has no target.`);
    }
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const note = parsed.note || null;
    const [returned] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE evaluator_assignments
            SET status = 'recused', conflict_declared_at = NULL,
                abstention_reason = ?, abstention_note = ?,
                abstained_at = unixepoch(), revision = revision + 1,
                last_operation_id = ?
          WHERE id = ? AND event_id = ? AND evaluator_person_id = ?
            AND revision = ? AND status IN ('assigned','in_progress','reopened')
            AND EXISTS (
              SELECT 1 FROM evaluation_rounds round
              JOIN evaluation_plans plan
                ON plan.id = round.plan_id AND plan.event_id = round.event_id
               WHERE round.id = evaluator_assignments.round_id
                 AND round.event_id = evaluator_assignments.event_id
                 AND plan.status = 'active' AND round.status = 'active'
                 AND (round.opens_at IS NULL OR round.opens_at <= unixepoch())
                 AND (round.closes_at IS NULL OR round.closes_at > unixepoch())
            )
            AND EXISTS (
              SELECT 1 FROM evaluation_round_reviewers pool
               WHERE pool.event_id = evaluator_assignments.event_id
                 AND pool.round_id = evaluator_assignments.round_id
                 AND pool.person_id = evaluator_assignments.evaluator_person_id
            )
            AND (
              EXISTS (
                SELECT 1 FROM submissions active_submission
                 WHERE active_submission.id = evaluator_assignments.submission_id
                   AND active_submission.event_id = evaluator_assignments.event_id
                   AND ${reviewableSubmissionSql("active_submission", "review")}
              )
              OR EXISTS (
                SELECT 1 FROM sessions active_session
                 WHERE active_session.id = evaluator_assignments.session_id
                   AND active_session.event_id = evaluator_assignments.event_id
                   AND active_session.status NOT IN ('cancelled','archived')
              )
            )`,
      ).bind(
        parsed.reason,
        note,
        operationId,
        assignment.id,
        viewer.eventId,
        viewer.personId,
        assignment.revision,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, action, entity_type, entity_id, correlation_id,
           metadata_json, created_at
         )
         SELECT ?, 'person', ?, 1, ?, ?, ?, 'review.abstained',
                'evaluator_assignment', ?, ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM evaluator_assignments assignment
             WHERE assignment.id = ? AND assignment.event_id = ?
               AND assignment.last_operation_id = ?
          )`,
      ).bind(
        auditEventId,
        origin,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        assignment.id,
        operationId,
        JSON.stringify({
          reason: parsed.reason,
          roundId: assignment.roundId,
          targetType: assignment.submissionId ? "submission" : "session",
          targetId,
        }),
        assignment.id,
        viewer.eventId,
        operationId,
      ),
      atomicBatchGuardStatement(
        this.env,
        `EXISTS (
           SELECT 1 FROM evaluator_assignments assignment
            WHERE assignment.id = ? AND assignment.event_id = ?
              AND assignment.last_operation_id = ?
         ) AND NOT (
         EXISTS (
           SELECT 1 FROM evaluator_assignments assignment
            WHERE assignment.id = ? AND assignment.event_id = ?
              AND assignment.evaluator_person_id = ?
              AND assignment.status = 'recused'
              AND assignment.revision = ?
              AND assignment.conflict_declared_at IS NULL
              AND assignment.abstention_reason = ?
              AND assignment.abstention_note IS ?
              AND assignment.abstained_at IS NOT NULL
              AND assignment.last_operation_id = ?
         ) AND EXISTS (
           SELECT 1 FROM audit_events audit
            WHERE audit.id = ? AND audit.organisation_id = ?
              AND audit.event_id = ? AND audit.actor_person_id = ?
              AND audit.origin = ? AND audit.action = 'review.abstained'
              AND audit.entity_type = 'evaluator_assignment'
              AND audit.entity_id = ? AND audit.correlation_id = ?
         ))`,
        [
          assignment.id,
          viewer.eventId,
          operationId,
          assignment.id,
          viewer.eventId,
          viewer.personId,
          assignment.revision + 1,
          parsed.reason,
          note,
          operationId,
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          origin,
          assignment.id,
          operationId,
        ],
      ),
    ]).catch((error: unknown) => {
      if (isAtomicBatchGuardError(error)) {
        throw new Error(
          "The assignment return could not record its complete audit evidence.",
          { cause: error },
        );
      }
      throw error;
    });
    if ((returned.meta.changes ?? 0) !== 1) {
      throw new EvaluationRevisionConflictError(
        "This assignment changed before it could be returned.",
      );
    }
  }
}
