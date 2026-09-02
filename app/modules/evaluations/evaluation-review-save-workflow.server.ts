import type { AuditOrigin } from "~/platform/audit/audit-contract";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import { WebhookService } from "~/platform/operations/webhook-service.server";
import { EvaluationRevisionConflictError } from "./evaluation-errors";
import { resolveEvaluationReviewAiProvenance } from "./evaluation-review-ai-provenance.server";
import { loadEvaluationReviewSaveContext } from "./evaluation-review-save-context.server";
import { reviewDraftSchema } from "./evaluation-schema";
import { EvaluationServiceFoundation } from "./evaluation-service-foundation.server";
import { reviewableSubmissionSql } from "./evaluation-submission-review-eligibility.server";

type ReviewerActionOrigin = Extract<AuditOrigin, "participant_ui" | "api">;

export class EvaluationReviewSaveWorkflow extends EvaluationServiceFoundation {
  async saveReview(
    viewer: Viewer,
    input: unknown,
    origin: ReviewerActionOrigin,
  ) {
    return this.projectCommand(
      viewer,
      "evaluation.review.save",
      input,
      undefined,
      () => this.saveReviewD1(viewer, input, origin),
    );
  }

  protected async saveReviewD1(
    viewer: Viewer,
    input: unknown,
    origin: ReviewerActionOrigin,
  ) {
    await this.assertViewerEvent(viewer);
    const parsed = reviewDraftSchema.parse(input);
    const {
      assignment,
      recommendationChoicesSnapshotJson,
      sourceSnapshotHash,
      criteriaSnapshotJson,
      responses,
      weightedScore,
      criterionInputTypeById,
      existing,
      reviewId,
    } = await loadEvaluationReviewSaveContext({
      env: this.env,
      viewer,
      parsed,
    });
    const {
      suggestion,
      suggestionId,
      importedCriterionIds,
      confirmedAiCriterionIds,
    } = await resolveEvaluationReviewAiProvenance({
      env: this.env,
      viewer,
      parsed,
      context: {
        assignment,
        recommendationChoicesSnapshotJson,
        sourceSnapshotHash,
        criteriaSnapshotJson,
        responses,
        weightedScore,
        criterionInputTypeById,
        existing,
        reviewId,
      },
    });
    const nextRevision = parsed.revision + 1;
    const operationId = crypto.randomUUID();
    const status = parsed.intent === "submit" ? "submitted" : "draft";
    const auditEventId = crypto.randomUUID();
    const reviewRevisionId = crypto.randomUUID();
    const webhookService = new WebhookService(this.env);
    const preparedWebhook =
      parsed.intent === "submit"
        ? await webhookService.prepareEventForAudit(
            viewer,
            {
              eventType: "review.submitted",
              entityType: "review",
              entityId: reviewId,
              idempotencyKey: `review.submitted:${reviewId}:${nextRevision}`,
              correlationId: operationId,
              data: {
                assignmentId: assignment.id,
                revision: nextRevision,
                weightedScore,
              },
            },
            auditEventId,
          )
        : null;
    const reviewMutation = existing
      ? this.env.DB.prepare(
          `
      UPDATE reviews SET status = ?, scores_json = ?, weighted_score = ?, recommendation = ?, confidence = ?,
             submitter_feedback = ?, private_notes = ?,
             ai_suggestion_id = ?, imported_criterion_ids_json = ?,
             confirmed_ai_criterion_ids_json = ?,
             -- The attestation is stamped the first time it is given and not
             -- refreshed on later saves: it records when the reviewer answered,
             -- not when they last typed.
             conflict_affirmed_at = CASE
               WHEN ? = 1 THEN COALESCE(conflict_affirmed_at, unixepoch())
               ELSE NULL
             END,
             revision = revision + 1, last_operation_id = ?,
             updated_at = unixepoch(), submitted_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE submitted_at END,
             locked_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE locked_at END
       WHERE id = ? AND event_id = ?
         AND EXISTS (
           SELECT 1 FROM events review_event
            WHERE review_event.id = reviews.event_id
              AND review_event.organisation_id = ?
         )
         AND (
           ? IS NULL
           OR EXISTS (
             SELECT 1 FROM reviewer_ai_suggestions suggestion_guard
              WHERE suggestion_guard.id = ?
                AND suggestion_guard.event_id = ?
                AND suggestion_guard.assignment_id = ?
                AND suggestion_guard.evaluator_person_id = ?
                AND (
                  (suggestion_guard.status = 'imported'
                   AND reviews.ai_suggestion_id = suggestion_guard.id)
                  OR
                  (suggestion_guard.status = 'offered'
                   AND EXISTS (
                     SELECT 1 FROM event_ai_review_settings setting
                      WHERE setting.event_id = suggestion_guard.event_id
                        AND setting.enabled = 1
                   ))
                )
           )
         )
         AND revision = ? AND status IN ('draft','reopened')
         AND EXISTS (
           SELECT 1 FROM evaluator_assignments assignment
           LEFT JOIN submissions active_submission
             ON active_submission.id = assignment.submission_id
            AND active_submission.event_id = assignment.event_id
           LEFT JOIN sessions active_session
             ON active_session.id = assignment.session_id
            AND active_session.event_id = assignment.event_id
            WHERE assignment.id = ? AND assignment.event_id = ?
              AND assignment.evaluator_person_id = ? AND assignment.revision = ?
              AND COALESCE(active_submission.submitted_snapshot_json,
                           assignment.session_snapshot_json) = ?
              AND assignment.status IN ('assigned','in_progress','reopened')
              AND EXISTS (
                SELECT 1 FROM evaluation_rounds review_round
                JOIN evaluation_plans review_plan
                  ON review_plan.id = review_round.plan_id
                 AND review_plan.event_id = review_round.event_id
                 WHERE review_round.id = assignment.round_id
                   AND review_round.event_id = assignment.event_id
                   AND review_plan.status = 'active'
                   AND review_round.status = 'active'
                   AND review_round.scorecard_id = ?
                   AND review_round.scorecard_version = ?
                   AND (review_round.opens_at IS NULL OR review_round.opens_at <= unixepoch())
                   AND (review_round.closes_at IS NULL OR review_round.closes_at > unixepoch())
              )
              AND EXISTS (
                SELECT 1 FROM evaluation_round_reviewers pool
                 WHERE pool.event_id = assignment.event_id
                   AND pool.round_id = assignment.round_id
                   AND pool.person_id = assignment.evaluator_person_id
              )
              AND (
                (assignment.submission_id IS NOT NULL
                 AND ${reviewableSubmissionSql("active_submission", "review")})
                OR
                (assignment.session_id IS NOT NULL
                 AND active_session.status NOT IN ('cancelled','archived'))
              )
         )
    `,
        ).bind(
          status,
          JSON.stringify(responses),
          weightedScore,
          parsed.recommendation,
          parsed.confidence,
          parsed.submitterFeedback || null,
          parsed.privateNotes || null,
          suggestionId,
          JSON.stringify(importedCriterionIds),
          JSON.stringify(confirmedAiCriterionIds),
          parsed.conflictAffirmed ? 1 : 0,
          operationId,
          status,
          status,
          reviewId,
          viewer.eventId,
          viewer.organisationId,
          suggestionId,
          suggestionId,
          viewer.eventId,
          assignment.id,
          viewer.personId,
          parsed.revision,
          assignment.id,
          viewer.eventId,
          viewer.personId,
          assignment.revision,
          assignment.sourceSnapshotJson,
          assignment.scorecardId,
          assignment.scorecardVersion,
        )
      : this.env.DB.prepare(
          `
      INSERT INTO reviews (id, event_id, assignment_id, status, scores_json, weighted_score, recommendation, recommendation_choices_snapshot_json, confidence, submitter_feedback, private_notes, ai_suggestion_id, imported_criterion_ids_json, confirmed_ai_criterion_ids_json, conflict_affirmed_at, revision, last_operation_id, created_at, updated_at, submitted_at, locked_at)
      SELECT ?, ?, assignment.id, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             CASE WHEN ? = 1 THEN unixepoch() END,
             1, ?, unixepoch(), unixepoch(),
             CASE WHEN ? = 'submitted' THEN unixepoch() END,
             CASE WHEN ? = 'submitted' THEN unixepoch() END
        FROM evaluator_assignments assignment
        LEFT JOIN submissions active_submission
          ON active_submission.id = assignment.submission_id
         AND active_submission.event_id = assignment.event_id
        LEFT JOIN sessions active_session
          ON active_session.id = assignment.session_id
         AND active_session.event_id = assignment.event_id
       WHERE assignment.id = ? AND assignment.event_id = ?
         AND EXISTS (
           SELECT 1 FROM events review_event
            WHERE review_event.id = assignment.event_id
              AND review_event.organisation_id = ?
         )
         AND (
           ? IS NULL
           OR EXISTS (
             SELECT 1 FROM reviewer_ai_suggestions suggestion_guard
              WHERE suggestion_guard.id = ?
                AND suggestion_guard.event_id = ?
                AND suggestion_guard.assignment_id = assignment.id
                AND suggestion_guard.evaluator_person_id = ?
                AND suggestion_guard.status = 'offered'
                AND EXISTS (
                  SELECT 1 FROM event_ai_review_settings setting
                   WHERE setting.event_id = suggestion_guard.event_id
                     AND setting.enabled = 1
                )
           )
         )
         AND assignment.evaluator_person_id = ? AND assignment.revision = ?
         AND COALESCE(active_submission.submitted_snapshot_json,
                      assignment.session_snapshot_json) = ?
         AND assignment.status IN ('assigned','in_progress','reopened')
         AND EXISTS (
           SELECT 1 FROM evaluation_rounds review_round
           JOIN evaluation_plans review_plan
             ON review_plan.id = review_round.plan_id
            AND review_plan.event_id = review_round.event_id
            WHERE review_round.id = assignment.round_id
              AND review_round.event_id = assignment.event_id
              AND review_plan.status = 'active'
              AND review_round.status = 'active'
              AND review_round.scorecard_id = ?
              AND review_round.scorecard_version = ?
              AND (review_round.opens_at IS NULL OR review_round.opens_at <= unixepoch())
              AND (review_round.closes_at IS NULL OR review_round.closes_at > unixepoch())
         )
         AND EXISTS (
           SELECT 1 FROM evaluation_round_reviewers pool
            WHERE pool.event_id = assignment.event_id
              AND pool.round_id = assignment.round_id
              AND pool.person_id = assignment.evaluator_person_id
         )
         AND (
           (assignment.submission_id IS NOT NULL
            AND ${reviewableSubmissionSql("active_submission", "review")})
           OR
           (assignment.session_id IS NOT NULL
            AND active_session.status NOT IN ('cancelled','archived'))
         )
    `,
        ).bind(
          reviewId,
          viewer.eventId,
          status,
          JSON.stringify(responses),
          weightedScore,
          parsed.recommendation,
          recommendationChoicesSnapshotJson,
          parsed.confidence,
          parsed.submitterFeedback || null,
          parsed.privateNotes || null,
          suggestionId,
          JSON.stringify(importedCriterionIds),
          JSON.stringify(confirmedAiCriterionIds),
          parsed.conflictAffirmed ? 1 : 0,
          operationId,
          status,
          status,
          assignment.id,
          viewer.eventId,
          viewer.organisationId,
          suggestionId,
          suggestionId,
          viewer.eventId,
          viewer.personId,
          viewer.personId,
          assignment.revision,
          assignment.sourceSnapshotJson,
          assignment.scorecardId,
          assignment.scorecardVersion,
        );
    const suggestionImportStatement =
      suggestion?.status === "offered"
        ? this.env.DB.prepare(
            `UPDATE reviewer_ai_suggestions AS suggestion
                SET status = 'imported', imported_at = unixepoch(),
                    lifecycle_operation_id = ?
              WHERE suggestion.id = ? AND suggestion.event_id = ?
                AND suggestion.assignment_id = ?
                AND suggestion.evaluator_person_id = ?
                AND suggestion.status = 'offered'
                AND EXISTS (
                  SELECT 1 FROM events event
                   WHERE event.id = suggestion.event_id
                     AND event.organisation_id = ?
                     AND event.repository_provider = 'd1'
                )
                AND EXISTS (
                  SELECT 1 FROM reviews review
                   WHERE review.id = ? AND review.event_id = suggestion.event_id
                     AND review.last_operation_id = ?
                )`,
          ).bind(
            operationId,
            suggestionId,
            viewer.eventId,
            assignment.id,
            viewer.personId,
            viewer.organisationId,
            reviewId,
            operationId,
          )
        : null;
    const batchResults = await this.env.DB.batch([
      reviewMutation,
      ...(suggestionImportStatement ? [suggestionImportStatement] : []),
      this.env.DB.prepare(
        `
        UPDATE evaluator_assignments
           SET status = ?, revision = revision + 1, last_operation_id = ?,
               cancellation_reason = NULL,
               submitted_at = CASE WHEN ? = 'submitted' THEN unixepoch() ELSE submitted_at END
         WHERE id = ? AND event_id = ?
           AND EXISTS (
             SELECT 1 FROM events assignment_event
              WHERE assignment_event.id = evaluator_assignments.event_id
                AND assignment_event.organisation_id = ?
           )
           AND evaluator_person_id = ? AND revision = ?
           AND status IN ('assigned','in_progress','reopened')
           AND EXISTS (
             SELECT 1 FROM evaluation_rounds review_round
             JOIN evaluation_plans review_plan
               ON review_plan.id = review_round.plan_id
              AND review_plan.event_id = review_round.event_id
              WHERE review_round.id = evaluator_assignments.round_id
                AND review_round.event_id = evaluator_assignments.event_id
                AND review_plan.status = 'active'
                AND review_round.status = 'active'
                AND (review_round.opens_at IS NULL OR review_round.opens_at <= unixepoch())
                AND (review_round.closes_at IS NULL OR review_round.closes_at > unixepoch())
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
           AND EXISTS (
             SELECT 1 FROM evaluation_round_reviewers pool
              WHERE pool.event_id = evaluator_assignments.event_id
                AND pool.round_id = evaluator_assignments.round_id
                AND pool.person_id = evaluator_assignments.evaluator_person_id
           )
           AND EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?)
      `,
      ).bind(
        parsed.intent === "submit" ? "submitted" : "in_progress",
        operationId,
        status,
        assignment.id,
        viewer.eventId,
        viewer.organisationId,
        viewer.personId,
        assignment.revision,
        reviewId,
        operationId,
      ),
      this.env.DB.prepare(
        `
        INSERT INTO review_revisions (
          id, event_id, review_id, revision_number, scores_json, content_json,
          save_kind, saved_by_person_id, idempotency_key, scorecard_id,
          scorecard_version, criteria_snapshot_json, ai_suggestion_id,
          imported_criterion_ids_json, confirmed_ai_criterion_ids_json,
          recommendation_choices_snapshot_json, created_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch()
         WHERE EXISTS (
           SELECT 1 FROM reviews review
            JOIN events event
              ON event.id = review.event_id AND event.organisation_id = ?
           WHERE review.id = ? AND review.last_operation_id = ?
         )
           AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)
      `,
      ).bind(
        reviewRevisionId,
        viewer.eventId,
        reviewId,
        nextRevision,
        JSON.stringify(responses),
        JSON.stringify({
          recommendation: parsed.recommendation,
          confidence: parsed.confidence,
          submitterFeedback: parsed.submitterFeedback,
          privateNotes: parsed.privateNotes,
        }),
        parsed.intent === "submit" ? "submitted" : "manual",
        viewer.personId,
        operationId,
        assignment.scorecardId,
        assignment.scorecardVersion,
        criteriaSnapshotJson,
        suggestionId,
        JSON.stringify(importedCriterionIds),
        JSON.stringify(confirmedAiCriterionIds),
        recommendationChoicesSnapshotJson,
        viewer.organisationId,
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
      this.env.DB.prepare(
        `UPDATE submissions SET status = 'in_review', revision = revision + 1, updated_at = unixepoch()
          WHERE id = ? AND event_id = ?
            AND EXISTS (
              SELECT 1 FROM events submission_event
               WHERE submission_event.id = submissions.event_id
                 AND submission_event.organisation_id = ?
            )
            AND status IN ('assigned','submitted')
            AND EXISTS (SELECT 1 FROM reviews WHERE id = ? AND last_operation_id = ?)
            AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        assignment.submissionId,
        viewer.eventId,
        viewer.organisationId,
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
      this.env.DB.prepare(
        `INSERT INTO audit_events (id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action, entity_type, entity_id, correlation_id, metadata_json, created_at)
         SELECT ?, 'person', ?, 1, ?, ?, ?, ?, 'review', ?, ?, ?, unixepoch()
          WHERE EXISTS (
            SELECT 1 FROM reviews review
             JOIN events event
               ON event.id = review.event_id AND event.organisation_id = ?
            WHERE review.id = ? AND review.last_operation_id = ?
          )
            AND EXISTS (SELECT 1 FROM evaluator_assignments WHERE id = ? AND last_operation_id = ?)`,
      ).bind(
        auditEventId,
        origin,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        parsed.intent === "submit" ? "review.submitted" : "review.saved",
        reviewId,
        operationId,
        JSON.stringify({
          revision: nextRevision,
          aiSuggestionId: suggestionId,
          importedCriterionIds,
          confirmedAiCriterionIds,
        }),
        viewer.organisationId,
        reviewId,
        operationId,
        assignment.id,
        operationId,
      ),
      ...(preparedWebhook?.statements ?? []),
      atomicBatchGuardStatement(
        this.env,
        `(EXISTS (
            SELECT 1 FROM reviews review
             WHERE review.id = ? AND review.event_id = ?
               AND review.last_operation_id = ?
          ) OR EXISTS (
            SELECT 1 FROM evaluator_assignments assignment
             WHERE assignment.id = ? AND assignment.event_id = ?
               AND assignment.last_operation_id = ?
          ) OR EXISTS (
            SELECT 1 FROM review_revisions revision WHERE revision.id = ?
          ) OR EXISTS (
            SELECT 1 FROM audit_events audit WHERE audit.id = ?
          )) AND NOT (
            EXISTS (
              SELECT 1 FROM reviews review
               WHERE review.id = ? AND review.event_id = ?
                 AND review.status = ? AND review.revision = ?
                 AND review.last_operation_id = ?
            ) AND EXISTS (
              SELECT 1 FROM evaluator_assignments assignment
               WHERE assignment.id = ? AND assignment.event_id = ?
                 AND assignment.status = ? AND assignment.revision = ?
                 AND assignment.last_operation_id = ?
            ) AND EXISTS (
              SELECT 1 FROM review_revisions revision
               WHERE revision.id = ? AND revision.event_id = ?
                 AND revision.review_id = ? AND revision.revision_number = ?
                 AND revision.idempotency_key = ? AND revision.save_kind = ?
            ) AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.organisation_id = ?
                 AND audit.event_id = ? AND audit.actor_person_id = ?
                 AND audit.origin = ? AND audit.action = ?
                 AND audit.entity_type = 'review' AND audit.entity_id = ?
                 AND audit.correlation_id = ?
            ) AND (
              ? IS NULL OR EXISTS (
                SELECT 1 FROM reviewer_ai_suggestions suggestion
                 WHERE suggestion.id = ? AND suggestion.event_id = ?
                   AND suggestion.assignment_id = ?
                   AND suggestion.evaluator_person_id = ?
                   AND suggestion.status = 'imported'
                   AND (? = 0 OR suggestion.lifecycle_operation_id = ?)
              )
            ) AND (
              ? IS NULL OR NOT EXISTS (
                SELECT 1 FROM submissions submission
                 WHERE submission.id = ? AND submission.event_id = ?
                   AND submission.status IN ('submitted','assigned')
              )
            )
          )`,
        [
          reviewId,
          viewer.eventId,
          operationId,
          assignment.id,
          viewer.eventId,
          operationId,
          reviewRevisionId,
          auditEventId,
          reviewId,
          viewer.eventId,
          status,
          nextRevision,
          operationId,
          assignment.id,
          viewer.eventId,
          parsed.intent === "submit" ? "submitted" : "in_progress",
          assignment.revision + 1,
          operationId,
          reviewRevisionId,
          viewer.eventId,
          reviewId,
          nextRevision,
          operationId,
          parsed.intent === "submit" ? "submitted" : "manual",
          auditEventId,
          viewer.organisationId,
          viewer.eventId,
          viewer.personId,
          origin,
          parsed.intent === "submit" ? "review.submitted" : "review.saved",
          reviewId,
          operationId,
          suggestionId,
          suggestionId,
          viewer.eventId,
          assignment.id,
          viewer.personId,
          suggestionImportStatement ? 1 : 0,
          operationId,
          assignment.submissionId,
          assignment.submissionId,
          viewer.eventId,
        ],
      ),
    ]).catch((error: unknown) => {
      if (isAtomicBatchGuardError(error)) {
        throw new Error(
          "The review could not record its complete revision, audit, and delivery evidence.",
          { cause: error },
        );
      }
      throw error;
    });
    const saved = batchResults[0];
    const suggestionImported = suggestionImportStatement
      ? batchResults[1]
      : null;
    const assignmentUpdated = batchResults[suggestionImportStatement ? 2 : 1];
    if (
      suggestionImportStatement &&
      (suggestionImported?.meta.changes ?? 0) !== 1
    ) {
      throw new EvaluationRevisionConflictError(
        "The AI suggestion changed before it could be imported. Refresh the review.",
      );
    }
    if (
      (saved.meta.changes ?? 0) !== 1 ||
      (assignmentUpdated.meta.changes ?? 0) !== 1
    )
      throw new EvaluationRevisionConflictError();
    const webhookDeliveries = preparedWebhook
      ? await webhookService.dispatchPreparedEvent(preparedWebhook)
      : [];
    const nextAssignment =
      parsed.intent === "submit"
        ? await this.env.DB.prepare(
            `
            SELECT a.id
              FROM evaluator_assignments a
              JOIN evaluation_rounds r
                ON r.id = a.round_id AND r.event_id = a.event_id
              JOIN evaluation_plans plan
                ON plan.id = r.plan_id AND plan.event_id = r.event_id
              LEFT JOIN submissions submission
                ON submission.id = a.submission_id
               AND submission.event_id = a.event_id
              LEFT JOIN sessions session
                ON session.id = a.session_id
               AND session.event_id = a.event_id
              JOIN evaluation_round_reviewers pool
                ON pool.event_id = a.event_id
               AND pool.round_id = a.round_id
               AND pool.person_id = a.evaluator_person_id
              JOIN events event
                ON event.id = a.event_id AND event.organisation_id = ?
             WHERE a.event_id = ? AND a.evaluator_person_id = ?
               AND a.id <> ? AND a.status IN ('assigned','in_progress','reopened')
               AND plan.status = 'active'
               AND r.status = 'active'
               AND (r.opens_at IS NULL OR r.opens_at <= unixepoch())
               AND (r.closes_at IS NULL OR r.closes_at > unixepoch())
               AND (
                 (a.submission_id IS NOT NULL
                  AND ${reviewableSubmissionSql("submission", "review")})
                 OR (a.session_id IS NOT NULL
                     AND session.status NOT IN ('cancelled','archived'))
               )
             ORDER BY CASE a.status WHEN 'in_progress' THEN 0 WHEN 'reopened' THEN 1 ELSE 2 END,
                      a.due_at, a.assigned_at
             LIMIT 1
          `,
          )
            .bind(
              viewer.organisationId,
              viewer.eventId,
              viewer.personId,
              assignment.id,
            )
            .first<{ id: string }>()
        : null;
    return {
      reviewId,
      revision: nextRevision,
      weightedScore,
      nextAssignmentId: nextAssignment?.id ?? null,
      webhookDeliveries,
    };
  }
}
