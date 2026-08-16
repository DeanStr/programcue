import type { AuditOrigin } from "~/platform/audit/audit-contract";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import {
  EvaluationRevisionConflictError,
  EvaluationStateError,
  EvaluationValidationError,
} from "./evaluation-errors";
import { moderationSchema, reviewReopenSchema } from "./evaluation-schema";
import { EvaluationServiceFoundation } from "./evaluation-service-foundation.server";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

type ManagerReviewActionOrigin = Extract<AuditOrigin, "admin_ui" | "api">;

export class EvaluationReviewerWorkflows extends EvaluationServiceFoundation {
  async moderate(
    viewer: Viewer,
    input: unknown,
    origin: ManagerReviewActionOrigin,
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.review.moderate",
      input,
      undefined,
      () => this.moderateD1(viewer, input, origin),
    );
  }

  protected async moderateD1(
    viewer: Viewer,
    input: unknown,
    origin: ManagerReviewActionOrigin,
  ) {
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
    const submissionState = await this.env.DB.prepare(
      `SELECT status, revision FROM submissions WHERE id = ? AND event_id = ?`,
    )
      .bind(parsed.submissionId, viewer.eventId)
      .first<{ status: string; revision: number }>();
    if (!submissionState) {
      throw new EvaluationStateError("The moderated submission was not found.");
    }
    const advancesSubmission =
      parsed.status === "confirmed" &&
      ["submitted", "assigned", "in_review"].includes(submissionState.status);
    const expectedSubmissionStatus = advancesSubmission
      ? "decision_ready"
      : submissionState.status;
    const expectedSubmissionRevision =
      submissionState.revision + (advancesSubmission ? 1 : 0);
    const moderationId = crypto.randomUUID();
    const operationId = crypto.randomUUID();
    const auditEventId = crypto.randomUUID();
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
         WHERE id = ? AND event_id = ?
           AND status IN ('submitted','assigned','in_review')
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
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, 'person', ?, 1, ?, ?, ?, ?, 'review_moderation', ?, ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM review_moderations WHERE id = ? AND event_id = ?
         )
      `,
      ).bind(
        auditEventId,
        origin,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.status === "confirmed"
          ? "review.moderation.confirmed"
          : "review.moderation.saved",
        moderationId,
        operationId,
        JSON.stringify({
          submissionId: parsed.submissionId,
          roundId: parsed.roundId,
          recommendation: parsed.recommendation,
          supersededModerationId: current?.id ?? null,
        }),
        moderationId,
        viewer.eventId,
      ),
      atomicBatchGuardStatement(
        this.env,
        `EXISTS (
           SELECT 1 FROM events event
            WHERE event.id = ? AND event.organisation_id = ?
              AND event.last_operation_id = ?
         ) AND NOT (
           EXISTS (
             SELECT 1 FROM review_moderations moderation
              WHERE moderation.id = ? AND moderation.event_id = ?
                AND moderation.round_id = ? AND moderation.submission_id = ?
                AND moderation.moderator_person_id = ?
                AND moderation.status = ?
                AND moderation.recommendation IS ?
                AND moderation.moderated_score IS ?
                AND moderation.notes IS ?
                AND ((? = 'confirmed' AND moderation.confirmed_at IS NOT NULL)
                  OR (? <> 'confirmed' AND moderation.confirmed_at IS NULL))
           ) AND (
             ? IS NULL OR EXISTS (
               SELECT 1 FROM review_moderations previous
                WHERE previous.id = ? AND previous.event_id = ?
                  AND previous.round_id = ? AND previous.submission_id = ?
                  AND previous.status = 'superseded'
             )
           ) AND EXISTS (
             SELECT 1 FROM audit_events audit
              WHERE audit.id = ? AND audit.organisation_id = ?
                AND audit.event_id = ? AND audit.actor_person_id = ?
                AND audit.origin = ? AND audit.action = ?
                AND audit.entity_type = 'review_moderation'
                AND audit.entity_id = ? AND audit.correlation_id = ?
           ) AND EXISTS (
             SELECT 1 FROM submissions submission
              WHERE submission.id = ? AND submission.event_id = ?
                AND submission.status = ? AND submission.revision = ?
           )
         )`,
        [
          viewer.eventId,
          viewer.organisationId,
          operationId,
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
          parsed.status,
          current?.id ?? null,
          current?.id ?? null,
          viewer.eventId,
          parsed.roundId,
          parsed.submissionId,
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          origin,
          parsed.status === "confirmed"
            ? "review.moderation.confirmed"
            : "review.moderation.saved",
          moderationId,
          operationId,
          parsed.submissionId,
          viewer.eventId,
          expectedSubmissionStatus,
          expectedSubmissionRevision,
        ],
      ),
    ]).catch((error: unknown) => {
      if (isAtomicBatchGuardError(error)) {
        throw new Error(
          "The moderation could not record its complete state and audit evidence.",
          { cause: error },
        );
      }
      throw error;
    });
    if ((claimed.meta.changes ?? 0) !== 1) {
      throw new EvaluationRevisionConflictError(
        "The round, submission, reviews, or moderation changed before the moderation could be saved.",
      );
    }
    return moderationId;
  }

  async reopenReview(
    viewer: Viewer,
    input: unknown,
    origin: ManagerReviewActionOrigin,
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.review.reopen",
      input,
      undefined,
      () => this.reopenReviewD1(viewer, input, origin),
    );
  }

  protected async reopenReviewD1(
    viewer: Viewer,
    input: unknown,
    origin: ManagerReviewActionOrigin,
  ) {
    await this.assertViewerEvent(viewer);
    this.assertEvaluationManager(viewer);
    const parsed = reviewReopenSchema.parse(input);
    const state = await this.env.DB.prepare(
      `
      SELECT a.id, a.revision AS assignmentRevision,
             a.round_id AS roundId, a.submission_id AS submissionId,
             r.id AS reviewId, r.revision AS reviewRevision,
             r.ai_suggestion_id AS aiSuggestionId,
             r.recommendation, r.confidence,
             r.submitter_feedback AS submitterFeedback,
             r.private_notes AS privateNotes,
             r.conflict_affirmed_at AS conflictAffirmedAt
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
        aiSuggestionId: string | null;
        recommendation: string | null;
        confidence: number | null;
        submitterFeedback: string | null;
        privateNotes: string | null;
        conflictAffirmedAt: number | null;
      }>();
    if (!state) {
      throw new EvaluationStateError(
        "Only a submitted review for an eligible target in the current active round can be reopened.",
      );
    }
    const scorecard = await this.env.DB.prepare(
      `SELECT round.scorecard_id AS scorecardId,
              round.scorecard_version AS scorecardVersion,
              COALESCE((
                SELECT json_group_array(json(ordered.snapshot))
                  FROM (
                    SELECT json_object(
                             'id', criterion.id,
                             'name', criterion.name,
                             'description', criterion.description,
                             'inputType', criterion.input_type,
                             'options', json(criterion.options_json),
                             'weightPercent', criterion.weight_percent,
                             'required', json(CASE WHEN criterion.required = 1
                                                  THEN 'true' ELSE 'false' END),
                             'position', criterion.position
                           ) AS snapshot
                      FROM evaluation_criteria criterion
                     WHERE criterion.event_id = round.event_id
                       AND criterion.round_id = round.id
                     ORDER BY criterion.position
                  ) ordered
              ), '[]') AS criteriaSnapshotJson
         FROM evaluation_rounds round
         JOIN events event
           ON event.id = round.event_id AND event.organisation_id = ?
        WHERE round.id = ? AND round.event_id = ?`,
    )
      .bind(viewer.organisationId, state.roundId, viewer.eventId)
      .first<{
        scorecardId: string;
        scorecardVersion: number;
        criteriaSnapshotJson: string;
      }>();
    if (!scorecard) {
      throw new EvaluationStateError(
        "The review scorecard is no longer available.",
      );
    }
    const operationId = crypto.randomUUID();
    const nextRevision = state.reviewRevision + 1;
    const auditEventId = crypto.randomUUID();
    const reviewRevisionId = crypto.randomUUID();
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
               locked_at = NULL, conflict_affirmed_at = NULL,
               last_operation_id = ?, updated_at = unixepoch()
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
          scorecard_id, scorecard_version, criteria_snapshot_json,
          ai_suggestion_id, imported_criterion_ids_json,
          confirmed_ai_criterion_ids_json, created_at
        )
        SELECT ?, review.event_id, review.id, ?, review.scores_json, ?,
               'reopened', ?, ?, ?, ?, ?, review.ai_suggestion_id,
               review.imported_criterion_ids_json,
               review.confirmed_ai_criterion_ids_json, unixepoch()
          FROM reviews review
         WHERE review.id = ? AND review.event_id = ?
           AND review.status = 'reopened'
           AND review.revision = ? AND review.last_operation_id = ?
      `,
      ).bind(
        reviewRevisionId,
        nextRevision,
        JSON.stringify({
          recommendation: state.recommendation,
          confidence: state.confidence,
          submitterFeedback: state.submitterFeedback,
          privateNotes: state.privateNotes,
          priorConflictAffirmedAt: state.conflictAffirmedAt,
          reopenReason: parsed.reason,
        }),
        viewer.personId,
        operationId,
        scorecard.scorecardId,
        scorecard.scorecardVersion,
        scorecard.criteriaSnapshotJson,
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
          id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
          entity_type, entity_id, correlation_id, metadata_json, created_at
        )
        SELECT ?, 'person', ?, 1, ?, ?, ?, 'review.reopened', 'review', ?, ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM reviews
            WHERE id = ? AND event_id = ? AND status = 'reopened'
              AND last_operation_id = ?
         )
      `,
      ).bind(
        auditEventId,
        origin,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        state.reviewId,
        operationId,
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
      atomicBatchGuardStatement(
        this.env,
        `(EXISTS (
            SELECT 1 FROM evaluator_assignments assignment
             WHERE assignment.id = ? AND assignment.event_id = ?
               AND assignment.last_operation_id = ?
          ) OR EXISTS (
            SELECT 1 FROM reviews review
             WHERE review.id = ? AND review.event_id = ?
               AND review.last_operation_id = ?
          ) OR EXISTS (
            SELECT 1 FROM review_revisions revision WHERE revision.id = ?
          ) OR EXISTS (
            SELECT 1 FROM audit_events audit WHERE audit.id = ?
          )) AND NOT (
            EXISTS (
              SELECT 1 FROM evaluator_assignments assignment
               WHERE assignment.id = ? AND assignment.event_id = ?
                 AND assignment.status = 'reopened'
                 AND assignment.revision = ?
                 AND assignment.last_operation_id = ?
            ) AND EXISTS (
              SELECT 1 FROM reviews review
               WHERE review.id = ? AND review.event_id = ?
                 AND review.status = 'reopened'
                 AND review.revision = ?
                 AND review.last_operation_id = ?
            ) AND EXISTS (
              SELECT 1 FROM review_revisions revision
               WHERE revision.id = ? AND revision.event_id = ?
                 AND revision.review_id = ? AND revision.revision_number = ?
                 AND revision.idempotency_key = ?
                 AND revision.save_kind = 'reopened'
            ) AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.organisation_id = ?
                 AND audit.event_id = ? AND audit.actor_person_id = ?
                 AND audit.origin = ? AND audit.action = 'review.reopened'
                 AND audit.entity_type = 'review' AND audit.entity_id = ?
                 AND audit.correlation_id = ?
            ) AND (
              ? IS NULL OR EXISTS (
                SELECT 1 FROM reviewer_ai_suggestions suggestion
                 WHERE suggestion.id = ? AND suggestion.event_id = ?
                   AND suggestion.status = 'imported'
              )
            ) AND (
              ? IS NULL OR NOT EXISTS (
                SELECT 1 FROM review_moderations moderation
                 WHERE moderation.event_id = ? AND moderation.round_id = ?
                   AND moderation.submission_id = ?
                   AND moderation.status IN ('draft','confirmed')
              )
            ) AND (
              ? IS NULL OR NOT EXISTS (
                SELECT 1 FROM submissions submission
                 WHERE submission.id = ? AND submission.event_id = ?
                   AND submission.status = 'decision_ready'
              )
            )
          )`,
        [
          state.id,
          viewer.eventId,
          operationId,
          state.reviewId,
          viewer.eventId,
          operationId,
          reviewRevisionId,
          auditEventId,
          state.id,
          viewer.eventId,
          state.assignmentRevision + 1,
          operationId,
          state.reviewId,
          viewer.eventId,
          nextRevision,
          operationId,
          reviewRevisionId,
          viewer.eventId,
          state.reviewId,
          nextRevision,
          operationId,
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          origin,
          state.reviewId,
          operationId,
          state.aiSuggestionId,
          state.aiSuggestionId,
          viewer.eventId,
          state.submissionId,
          viewer.eventId,
          state.roundId,
          state.submissionId,
          state.submissionId,
          state.submissionId,
          viewer.eventId,
        ],
      ),
    ]).catch((error: unknown) => {
      if (isAtomicBatchGuardError(error)) {
        throw new Error(
          "The reopened review could not record its complete revision, audit, and delivery evidence.",
          { cause: error },
        );
      }
      throw error;
    });
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
