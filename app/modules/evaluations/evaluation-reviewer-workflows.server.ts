import type { Viewer } from "~/platform/auth/authorize.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
import { EvaluationReviewSubmissionWorkflows } from "./evaluation-review-submission-workflows.server";
import { moderationSchema, reviewReopenSchema } from "./evaluation-schema";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

export abstract class EvaluationReviewerWorkflows extends EvaluationReviewSubmissionWorkflows {
  async moderate(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.review.moderate",
      input,
      undefined,
      () => this.moderateD1(viewer, input),
    );
  }

  protected async moderateD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = moderationSchema.parse(input);
    if (parsed.status === "confirmed" && !parsed.confirmed) {
      throw new EvaluationValidationError(
        "Confirm the moderation effect before locking it.",
      );
    }
    const current = await this.env.DB.prepare(
      `
      SELECT id, status FROM review_moderations
       WHERE event_id = ? AND round_id = ? AND submission_id = ?
         AND status IN ('draft','confirmed')
    `,
    )
      .bind(viewer.eventId, parsed.roundId, parsed.submissionId)
      .first<{ id: string; status: "draft" | "confirmed" }>();
    if ((current?.id ?? null) !== parsed.expectedModerationId) {
      throw new EvaluationRevisionConflictError(
        "The moderation changed after it was loaded. Refresh before saving again.",
      );
    }
    if (
      current?.status === "confirmed" &&
      (parsed.status !== "confirmed" || !parsed.confirmed)
    ) {
      throw new EvaluationStateError(
        "A confirmed moderation can only be replaced by another explicitly confirmed moderation.",
      );
    }
    const moderationId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const currentPredicate = current
      ? `EXISTS (
           SELECT 1 FROM review_moderations current_moderation
            WHERE current_moderation.id = ?
              AND current_moderation.event_id = events.id
              AND current_moderation.round_id = ?
              AND current_moderation.submission_id = ?
              AND current_moderation.status IN ('draft','confirmed')
         )`
      : `NOT EXISTS (
           SELECT 1 FROM review_moderations current_moderation
            WHERE current_moderation.event_id = events.id
              AND current_moderation.round_id = ?
              AND current_moderation.submission_id = ?
              AND current_moderation.status IN ('draft','confirmed')
         )`;
    const currentBindings = current
      ? [current.id, parsed.roundId, parsed.submissionId]
      : [parsed.roundId, parsed.submissionId];
    const [claimed] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE events SET last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND organisation_id = ?
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds active_round
             JOIN evaluation_plans active_plan
               ON active_plan.id = active_round.plan_id
              AND active_plan.event_id = active_round.event_id
              WHERE active_round.id = ? AND active_round.event_id = events.id
                AND active_round.status = 'active'
                AND active_plan.status = 'active'
           )
           AND EXISTS (
             SELECT 1 FROM submissions submission
              WHERE submission.id = ? AND submission.event_id = events.id
                AND ${reviewableSubmissionSql("submission", "review")}
           )
           AND EXISTS (
             SELECT 1 FROM evaluator_assignments assignment
             JOIN reviews completed_review
               ON completed_review.assignment_id = assignment.id
              AND completed_review.event_id = assignment.event_id
              AND completed_review.status IN ('submitted','locked')
              WHERE assignment.event_id = events.id
                AND assignment.round_id = ?
                AND assignment.submission_id = ?
           )
           AND ${currentPredicate}
      `,
      ).bind(
        operationId,
        viewer.eventId,
        viewer.organisationId,
        parsed.roundId,
        parsed.submissionId,
        parsed.roundId,
        parsed.submissionId,
        ...currentBindings,
      ),
      this.env.DB.prepare(
        `
        UPDATE review_moderations SET status = 'superseded',
               updated_at = unixepoch()
         WHERE event_id = ? AND round_id = ? AND submission_id = ?
           AND status IN ('draft','confirmed')
           AND EXISTS (
             SELECT 1 FROM events
              WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        parsed.roundId,
        parsed.submissionId,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO review_moderations (
          id, event_id, round_id, submission_id, moderator_person_id,
          status, recommendation, moderated_score, notes,
          created_at, updated_at, confirmed_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch(), unixepoch(),
               CASE WHEN ? = 'confirmed' THEN unixepoch() END
         WHERE EXISTS (
           SELECT 1 FROM events
            WHERE id = ? AND organisation_id = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        moderationId,
        viewer.eventId,
        parsed.roundId,
        parsed.submissionId,
        viewer.personId,
        parsed.status,
        parsed.recommendation,
        parsed.moderatedScore,
        parsed.notes,
        parsed.status,
        viewer.eventId,
        viewer.organisationId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'decision_ready',
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status IN ('assigned','in_review')
           AND ? = 'confirmed'
           AND EXISTS (
             SELECT 1 FROM review_moderations
              WHERE id = ? AND event_id = ? AND status = 'confirmed'
           )
      `,
      ).bind(
        parsed.submissionId,
        viewer.eventId,
        parsed.status,
        moderationId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, 'review_moderation', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM review_moderations WHERE id = ? AND event_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.status === "confirmed"
          ? "review.moderation.confirmed"
          : "review.moderation.saved",
        moderationId,
        JSON.stringify({
          submissionId: parsed.submissionId,
          roundId: parsed.roundId,
          recommendation: parsed.recommendation,
          supersededModerationId: current?.id ?? null,
        }),
        moderationId,
        viewer.eventId,
      ),
    ]);
    if ((claimed.meta.changes ?? 0) !== 1) {
      throw new EvaluationRevisionConflictError(
        "The round, submission, reviews, or moderation changed before the moderation could be saved.",
      );
    }
    return moderationId;
  }

  async reopenReview(viewer: Viewer, input: unknown) {
    return this.projectCommand(
      viewer,
      "evaluation.review.reopen",
      input,
      undefined,
      () => this.reopenReviewD1(viewer, input),
    );
  }

  protected async reopenReviewD1(viewer: Viewer, input: unknown) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = reviewReopenSchema.parse(input);
    const state = await this.env.DB.prepare(
      `
      SELECT a.id, a.revision AS assignmentRevision,
             a.round_id AS roundId, a.submission_id AS submissionId,
             r.id AS reviewId, r.revision AS reviewRevision,
             r.scores_json AS scoresJson, r.recommendation, r.confidence,
             r.submitter_feedback AS submitterFeedback,
             r.private_notes AS privateNotes
        FROM evaluator_assignments a
        JOIN reviews r ON r.assignment_id = a.id AND r.event_id = a.event_id
        JOIN evaluation_rounds round
          ON round.id = a.round_id AND round.event_id = a.event_id
        JOIN evaluation_plans plan
          ON plan.id = round.plan_id AND plan.event_id = round.event_id
       WHERE a.id = ? AND a.event_id = ?
         AND a.status = 'submitted' AND r.status IN ('submitted','locked')
         AND plan.status = 'active'
         AND round.status = 'active'
         AND (round.opens_at IS NULL OR round.opens_at <= unixepoch())
         AND (round.closes_at IS NULL OR round.closes_at > unixepoch())
         AND EXISTS (
           SELECT 1 FROM evaluation_round_reviewers pool
            WHERE pool.event_id = a.event_id
              AND pool.round_id = a.round_id
              AND pool.person_id = a.evaluator_person_id
         )
         AND (
           (a.submission_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM submissions submission
              WHERE submission.id = a.submission_id
                AND submission.event_id = a.event_id
                AND ${reviewableSubmissionSql("submission", "review")}
           ))
           OR (a.session_id IS NOT NULL AND EXISTS (
             SELECT 1 FROM sessions session
              WHERE session.id = a.session_id
                AND session.event_id = a.event_id
                AND session.status NOT IN ('cancelled','archived')
           ))
         )
    `,
    )
      .bind(parsed.assignmentId, viewer.eventId)
      .first<{
        id: string;
        assignmentRevision: number;
        roundId: string;
        submissionId: string | null;
        reviewId: string;
        reviewRevision: number;
        scoresJson: string;
        recommendation: string | null;
        confidence: number | null;
        submitterFeedback: string | null;
        privateNotes: string | null;
      }>();
    if (!state) {
      throw new EvaluationStateError(
        "Only a submitted review for an eligible target in the current active round can be reopened.",
      );
    }
    const operationId = crypto.randomUUID();
    const nextRevision = state.reviewRevision + 1;
    const auditEventId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook = await webhookService.prepareEventForAudit(
      viewer,
      {
        eventType: "review.reopened",
        entityType: "review",
        entityId: state.reviewId,
        idempotencyKey: `review.reopened:${state.reviewId}:${nextRevision}`,
        correlationId: operationId,
        data: { assignmentId: state.id, revision: nextRevision },
      },
      auditEventId,
    );
    const [assignmentUpdated, reviewUpdated] = await this.env.DB.batch([
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = 'reopened', revision = revision + 1,
               last_operation_id = ?
         WHERE id = ? AND event_id = ? AND revision = ? AND status = 'submitted'
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds round
             JOIN evaluation_plans plan
               ON plan.id = round.plan_id AND plan.event_id = round.event_id
              WHERE round.id = ? AND round.event_id = ?
                AND plan.status = 'active' AND round.status = 'active'
                AND (round.opens_at IS NULL OR round.opens_at <= unixepoch())
                AND (round.closes_at IS NULL OR round.closes_at > unixepoch())
                AND EXISTS (
                  SELECT 1 FROM evaluation_round_reviewers pool
                   WHERE pool.event_id = evaluator_assignments.event_id
                     AND pool.round_id = evaluator_assignments.round_id
                     AND pool.person_id = evaluator_assignments.evaluator_person_id
                )
           )
           AND (
             (submission_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM submissions submission
                WHERE submission.id = evaluator_assignments.submission_id
                  AND submission.event_id = evaluator_assignments.event_id
                  AND ${reviewableSubmissionSql("submission", "review")}
             ))
             OR (session_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM sessions session
                WHERE session.id = evaluator_assignments.session_id
                  AND session.event_id = evaluator_assignments.event_id
                  AND session.status NOT IN ('cancelled','archived')
             ))
           )
      `,
      ).bind(
        operationId,
        state.id,
        viewer.eventId,
        state.assignmentRevision,
        state.roundId,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `
        UPDATE reviews SET status = 'reopened', revision = revision + 1,
               locked_at = NULL, last_operation_id = ?, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND revision = ?
           AND status IN ('submitted','locked')
           AND EXISTS (
             SELECT 1 FROM evaluator_assignments
              WHERE id = ? AND event_id = ? AND status = 'reopened'
                AND last_operation_id = ?
           )
      `,
      ).bind(
        operationId,
        state.reviewId,
        viewer.eventId,
        state.reviewRevision,
        state.id,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json,
          content_json, save_kind, saved_by_person_id, idempotency_key,
          created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, 'reopened', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM reviews
            WHERE id = ? AND event_id = ? AND status = 'reopened'
              AND revision = ? AND last_operation_id = ?
         )
      `,
      ).bind(
        crypto.randomUUID(),
        viewer.eventId,
        state.reviewId,
        nextRevision,
        state.scoresJson,
        JSON.stringify({
          recommendation: state.recommendation,
          confidence: state.confidence,
          submitterFeedback: state.submitterFeedback,
          privateNotes: state.privateNotes,
          reopenReason: parsed.reason,
        }),
        viewer.personId,
        operationId,
        state.reviewId,
        viewer.eventId,
        nextRevision,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE review_moderations SET status = 'superseded',
               updated_at = unixepoch()
         WHERE event_id = ? AND round_id = ? AND submission_id = ?
           AND status IN ('draft','confirmed')
           AND EXISTS (
             SELECT 1 FROM reviews
              WHERE id = ? AND event_id = ? AND status = 'reopened'
                AND last_operation_id = ?
           )
      `,
      ).bind(
        viewer.eventId,
        state.roundId,
        state.submissionId,
        state.reviewId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        UPDATE submissions SET status = 'in_review',
               revision = revision + 1, updated_at = unixepoch()
         WHERE id = ? AND event_id = ? AND status = 'decision_ready'
           AND EXISTS (
             SELECT 1 FROM reviews
              WHERE id = ? AND event_id = ? AND status = 'reopened'
                AND last_operation_id = ?
           )
      `,
      ).bind(
        state.submissionId,
        viewer.eventId,
        state.reviewId,
        viewer.eventId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO audit_events (
          id, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, metadata_json, created_at
        )
        SELECT ?, ?, ?, ?, 'review.reopened', 'review', ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM reviews
            WHERE id = ? AND event_id = ? AND status = 'reopened'
              AND last_operation_id = ?
         )
      `,
      ).bind(
        auditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        state.reviewId,
        JSON.stringify({
          assignmentId: state.id,
          reason: parsed.reason,
          revision: nextRevision,
        }),
        state.reviewId,
        viewer.eventId,
        operationId,
      ),
      ...preparedWebhook.statements,
    ]);
    if (
      (assignmentUpdated.meta.changes ?? 0) !== 1 ||
      (reviewUpdated.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationRevisionConflictError(
        "The review or assignment changed before it could be reopened.",
      );
    }
    const webhookDeliveries =
      await webhookService.dispatchPreparedEvent(preparedWebhook);
    return {
      reviewId: state.reviewId,
      revision: nextRevision,
      webhookDeliveries,
    };
  }
}
