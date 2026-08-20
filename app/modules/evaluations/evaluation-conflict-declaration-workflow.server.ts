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
import { conflictDeclarationSchema } from "./evaluation-schema";
import { EvaluationServiceFoundation } from "./evaluation-service-foundation.server";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

type ReviewerActionOrigin = Extract<AuditOrigin, "participant_ui" | "api">;

export class EvaluationConflictDeclarationWorkflow extends EvaluationServiceFoundation {
  async declareConflict(
    viewer: Viewer,
    input: unknown,
    origin: ReviewerActionOrigin,
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.conflict.declare",
      input,
      undefined,
      () => this.declareConflictD1(viewer, input, origin),
    );
  }

  protected async declareConflictD1(
    viewer: Viewer,
    input: unknown,
    origin: ReviewerActionOrigin,
  ) {
    await this.assertViewerEvent(viewer);
    const parsed = conflictDeclarationSchema.parse(input);
    const assignment = await this.env.DB.prepare(
      `SELECT assignment.id, assignment.revision, assignment.round_id AS roundId,
              assignment.submission_id AS submissionId,
              assignment.session_id AS sessionId,
              existing_conflict.id AS conflictId
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
         LEFT JOIN evaluator_conflicts existing_conflict
           ON existing_conflict.event_id = assignment.event_id
          AND existing_conflict.round_id = assignment.round_id
          AND existing_conflict.evaluator_person_id = assignment.evaluator_person_id
          AND existing_conflict.submission_id IS assignment.submission_id
          AND existing_conflict.session_id IS assignment.session_id
         JOIN events event
           ON event.id = assignment.event_id AND event.organisation_id = ?
        WHERE assignment.id = ? AND assignment.event_id = ?
          AND assignment.evaluator_person_id = ?
          AND assignment.status IN ('assigned','in_progress','reopened')
          AND plan.status = 'active'
          AND round.status = 'active'
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
        conflictId: string | null;
      }>();
    if (!assignment)
      throw new EvaluationStateError(
        "Assignment not found or cannot be recused.",
      );
    const operationId = crypto.randomUUID();
    const conflictTargetColumn = assignment.submissionId
      ? "submission_id"
      : "session_id";
    const conflictTargetId = assignment.submissionId ?? assignment.sessionId;
    if (!conflictTargetId) {
      throw new Error(`Evaluation assignment ${assignment.id} has no target.`);
    }
    const conflictId = assignment.conflictId ?? crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
    const [recused] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = 'recused', conflict_declared_at = unixepoch(),
               revision = revision + 1, last_operation_id = ?
         WHERE id = ? AND event_id = ? AND evaluator_person_id = ?
           AND revision = ? AND status IN ('assigned','in_progress','reopened')
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds round
             JOIN evaluation_plans plan
               ON plan.id = round.plan_id AND plan.event_id = round.event_id
              WHERE round.id = evaluator_assignments.round_id
                AND round.event_id = evaluator_assignments.event_id
                AND plan.status = 'active'
                AND round.status = 'active'
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
           )
      `,
      ).bind(
        operationId,
        assignment.id,
        viewer.eventId,
        viewer.personId,
        assignment.revision,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO evaluator_conflicts (
          id, event_id, round_id, submission_id, session_id,
          evaluator_person_id,
          relationship, notes, status, declared_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'declared', ?, 'recused', unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM evaluator_assignments
            WHERE id = ? AND event_id = ? AND last_operation_id = ?
         )
        ON CONFLICT(round_id, ${conflictTargetColumn}, evaluator_person_id)
        WHERE ${conflictTargetColumn} IS NOT NULL DO UPDATE SET
          notes = excluded.notes, status = 'recused', declared_at = unixepoch()
        WHERE EXISTS (
          SELECT 1 FROM evaluator_assignments
           WHERE id = ? AND event_id = ? AND last_operation_id = ?
        )
      `,
      ).bind(
        conflictId,
        viewer.eventId,
        assignment.roundId,
        assignment.submissionId,
        assignment.sessionId,
        viewer.personId,
        parsed.reason,
        assignment.id,
        viewer.eventId,
        operationId,
        assignment.id,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at) SELECT ?, 'person', ?, 1, ?, ?, ?, 'review.conflict.declared', 'evaluator_assignment', ?, ?, ?, unixepoch() WHERE EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND event_id = ? AND last_operation_id = ?)`,
      ).bind(
        auditEventId,
        origin,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        assignment.id,
        operationId,
        JSON.stringify({
          roundId: assignment.roundId,
          targetType: assignment.submissionId ? "submission" : "session",
          targetId: conflictTargetId,
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
                AND assignment.conflict_declared_at IS NOT NULL
                AND assignment.last_operation_id = ?
           ) AND EXISTS (
             SELECT 1 FROM evaluator_conflicts conflict
              WHERE conflict.id = ? AND conflict.event_id = ?
                AND conflict.round_id = ?
                AND conflict.submission_id IS ? AND conflict.session_id IS ?
                AND conflict.evaluator_person_id = ?
                AND conflict.relationship = 'declared'
                AND conflict.notes = ? AND conflict.status = 'recused'
                AND conflict.declared_at IS NOT NULL
           ) AND EXISTS (
             SELECT 1 FROM audit_events audit
              WHERE audit.id = ? AND audit.organisation_id = ?
                AND audit.event_id = ? AND audit.actor_person_id = ?
                AND audit.origin = ?
                AND audit.action = 'review.conflict.declared'
                AND audit.entity_type = 'evaluator_assignment'
                AND audit.entity_id = ? AND audit.correlation_id = ?
           )
         )`,
        [
          assignment.id,
          viewer.eventId,
          operationId,
          assignment.id,
          viewer.eventId,
          viewer.personId,
          assignment.revision + 1,
          operationId,
          conflictId,
          viewer.eventId,
          assignment.roundId,
          assignment.submissionId,
          assignment.sessionId,
          viewer.personId,
          parsed.reason,
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
          "The conflict declaration could not record its complete recusal and audit evidence.",
          { cause: error },
        );
      }
      throw error;
    });
    if ((recused.meta.changes ?? 0) !== 1) {
      throw new EvaluationRevisionConflictError(
        "This assignment changed before the conflict could be recorded.",
      );
    }
  }
}
