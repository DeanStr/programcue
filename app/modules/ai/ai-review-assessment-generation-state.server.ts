import { reviewableSubmissionSql } from "~/modules/evaluations/evaluation-submission-review-eligibility.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  type GenerationOperationPayload,
  generationAttemptIdempotencyKey,
  parseFailedGenerationResult,
  parseGenerationOperationPayload,
} from "./ai-review-assessment-durable-state";
import {
  AiReviewAssessmentIntentConflictError,
  AiReviewAssessmentStateError,
} from "./ai-review-assessment-errors";
import { AiReviewAssessmentFoundation } from "./ai-review-assessment-foundation.server";
import {
  assertAssessmentAdministrator,
  epochSeconds,
  GENERATION_LEASE_SECONDS,
  type GenerationOperationRow,
  generationReconciliationInputSchema,
} from "./ai-review-assessment-support.server";

export class AiReviewAssessmentGenerationState extends AiReviewAssessmentFoundation {
  protected async reserveGeneration(
    viewer: Viewer,
    input: {
      generationIntentId: string;
      targetKey: string;
      payload: GenerationOperationPayload;
    },
  ): Promise<
    | { kind: "claimed"; claimToken: string }
    | { kind: "existing"; operation: GenerationOperationRow }
  > {
    const claimToken = crypto.randomUUID();
    const now = epochSeconds(this.now());
    const idempotencyKey = generationAttemptIdempotencyKey(
      input.generationIntentId,
      input.targetKey,
      input.payload.retryOfOperationId,
    );
    const metadata = JSON.stringify({
      operationId: input.generationIntentId,
      retryOfOperationId: input.payload.retryOfOperationId,
      assessmentId: input.payload.assessmentId,
      roundId: input.payload.roundId,
      submissionId: input.payload.submissionId,
      provider: input.payload.provider,
      model: input.payload.model,
      roundRevision: input.payload.roundRevision,
      scorecardId: input.payload.scorecardId,
      scorecardVersion: input.payload.scorecardVersion,
      submissionRevisionId: input.payload.submissionRevisionId,
      submissionRevisionNumber: input.payload.submissionRevisionNumber,
      sourceSnapshotSha256: input.payload.sourceSnapshotSha256,
      modelInputSha256: input.payload.modelInputSha256,
      promptVersion: input.payload.promptVersion,
      criterionIds: input.payload.criterionIds,
    });
    await this.dependencies.beforeGenerationReserved?.();
    await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO operation_jobs (
         id, organisation_id, event_id, requested_by_person_id, type,
         idempotency_key, correlation_id, status, payload_json,
         progress_total, progress_completed, progress_failed, attempt_count,
         cancellable, claim_token, claim_expires_at, started_at, created_at,
         updated_at
       )
       SELECT ?, event.organisation_id, event.id, ?,
              'ai.review_assessment.generate', ?, ?, 'running', ?,
              1, 0, 0, 1, 0, ?, ?, ?, ?, ?
         FROM events event
         JOIN evaluation_rounds round
           ON round.id = ? AND round.event_id = event.id
         JOIN evaluation_plans plan
           ON plan.id = round.plan_id AND plan.event_id = round.event_id
         JOIN submissions submission
           ON submission.id = ? AND submission.event_id = event.id
        WHERE event.id = ? AND event.organisation_id = ?
          AND event.repository_provider = 'd1'
          AND event.participant_retention_completed_at IS NULL
          AND round.revision = ?
          AND round.scorecard_id = ? AND round.scorecard_version = ?
          AND submission.submitted_snapshot_json = ?
          AND EXISTS (
            SELECT 1 FROM submission_revisions source_revision
             WHERE source_revision.id = ?
               AND source_revision.event_id = submission.event_id
               AND source_revision.submission_id = submission.id
               AND source_revision.revision_number = ?
               AND source_revision.save_kind = 'submitted'
          )
          AND round.status IN ('active','closed')
          AND plan.status IN ('active','closed')
          AND NOT EXISTS (
            SELECT 1 FROM evaluation_plans other_plan
             WHERE other_plan.event_id = plan.event_id
               AND other_plan.id <> plan.id
               AND other_plan.status <> 'archived'
          )
          AND submission.submitted_at IS NOT NULL
          AND ${reviewableSubmissionSql("submission", "review")}
          AND NOT EXISTS (
            SELECT 1 FROM ai_review_assessments existing
             WHERE existing.event_id = event.id
               AND existing.round_id = round.id
               AND existing.submission_id = submission.id
          )
          AND NOT EXISTS (
            SELECT 1 FROM operation_jobs active_attempt
             WHERE active_attempt.event_id = event.id
               AND active_attempt.type = 'ai.review_assessment.generate'
               AND active_attempt.status IN ('running','completed')
               AND json_extract(active_attempt.payload_json, '$.targetKey') = ?
          )
          AND (
            ? IS NULL OR NOT EXISTS (
              SELECT 1 FROM operation_jobs retry_attempt
               WHERE retry_attempt.event_id = event.id
                 AND retry_attempt.type = 'ai.review_assessment.generate'
                 AND json_extract(
                       retry_attempt.payload_json,
                       '$.retryOfOperationId'
                     ) = ?
            )
          )`,
      ).bind(
        input.generationIntentId,
        viewer.personId,
        idempotencyKey,
        input.generationIntentId,
        JSON.stringify(input.payload),
        claimToken,
        now + GENERATION_LEASE_SECONDS,
        now,
        now,
        now,
        input.payload.roundId,
        input.payload.submissionId,
        viewer.eventId,
        viewer.organisationId,
        input.payload.roundRevision,
        input.payload.scorecardId,
        input.payload.scorecardVersion,
        input.payload.sourceSnapshotJson,
        input.payload.submissionRevisionId,
        input.payload.submissionRevisionNumber,
        input.targetKey,
        input.payload.retryOfOperationId,
        input.payload.retryOfOperationId,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
         entity_type, entity_id, correlation_id, metadata_json, created_at
       )
       SELECT ?, 'person', 'admin_ui', 1, operation.organisation_id, operation.event_id,
              operation.requested_by_person_id,
              'ai.review_assessment.requested', 'submission', ?,
              operation.id, ?, ?
        FROM operation_jobs operation
        WHERE operation.id = ? AND operation.event_id = ?
          AND operation.organisation_id = ?
          AND operation.claim_token = ?
          AND EXISTS (
            SELECT 1 FROM events event
             WHERE event.id = operation.event_id
               AND event.organisation_id = operation.organisation_id
               AND event.repository_provider = 'd1'
               AND event.participant_retention_completed_at IS NULL
          )`,
      ).bind(
        `ai-review-assessment-requested:${input.generationIntentId}`,
        input.payload.submissionId,
        metadata,
        now,
        input.generationIntentId,
        viewer.eventId,
        viewer.organisationId,
        claimToken,
      ),
    ]);
    const exactOperation = await this.operations.loadExactGenerationOperation(
      input.generationIntentId,
    );
    const operation =
      exactOperation ??
      (input.payload.retryOfOperationId
        ? null
        : await this.operations.loadGenerationOperation(
            input.generationIntentId,
            viewer.eventId,
            input.targetKey,
          ));
    if (!operation) {
      const state = await this.env.DB.prepare(
        `SELECT event.repository_provider AS repositoryProvider,
              event.participant_retention_completed_at AS retentionCompletedAt,
              EXISTS (
                SELECT 1
                  FROM evaluation_rounds round
                  JOIN evaluation_plans plan
                    ON plan.id = round.plan_id
                   AND plan.event_id = round.event_id
                  JOIN submissions submission
                    ON submission.id = ?
                   AND submission.event_id = round.event_id
                 WHERE round.id = ? AND round.event_id = event.id
                   AND round.revision = ?
                   AND round.scorecard_id = ?
                   AND round.scorecard_version = ?
                   AND submission.submitted_snapshot_json = ?
                   AND EXISTS (
                     SELECT 1 FROM submission_revisions source_revision
                      WHERE source_revision.id = ?
                        AND source_revision.event_id = submission.event_id
                        AND source_revision.submission_id = submission.id
                        AND source_revision.revision_number = ?
                        AND source_revision.save_kind = 'submitted'
                   )
                   AND round.status IN ('active','closed')
                   AND plan.status IN ('active','closed')
                   AND NOT EXISTS (
                     SELECT 1 FROM evaluation_plans other_plan
                      WHERE other_plan.event_id = plan.event_id
                        AND other_plan.id <> plan.id
                        AND other_plan.status <> 'archived'
                   )
                   AND submission.submitted_at IS NOT NULL
                   AND ${reviewableSubmissionSql("submission", "review")}
                   AND NOT EXISTS (
                     SELECT 1 FROM ai_review_assessments existing
                      WHERE existing.event_id = event.id
                        AND existing.round_id = round.id
                        AND existing.submission_id = submission.id
                   )
              ) AS targetIsCurrent,
              EXISTS (
                SELECT 1 FROM operation_jobs active_attempt
                 WHERE active_attempt.event_id = event.id
                   AND active_attempt.type = 'ai.review_assessment.generate'
                   AND active_attempt.status IN ('running','completed')
                   AND json_extract(active_attempt.payload_json, '$.targetKey') = ?
              ) AS generationInProgress,
              EXISTS (
                SELECT 1 FROM operation_jobs retry_attempt
                 WHERE retry_attempt.event_id = event.id
                   AND retry_attempt.type = 'ai.review_assessment.generate'
                   AND json_extract(
                         retry_attempt.payload_json,
                         '$.retryOfOperationId'
                       ) = ?
              ) AS retryAlreadyCreated
         FROM events event
        WHERE event.id = ? AND event.organisation_id = ?`,
      )
        .bind(
          input.payload.submissionId,
          input.payload.roundId,
          input.payload.roundRevision,
          input.payload.scorecardId,
          input.payload.scorecardVersion,
          input.payload.sourceSnapshotJson,
          input.payload.submissionRevisionId,
          input.payload.submissionRevisionNumber,
          input.targetKey,
          input.payload.retryOfOperationId,
          viewer.eventId,
          viewer.organisationId,
        )
        .first<{
          repositoryProvider: string;
          retentionCompletedAt: number | null;
          targetIsCurrent: number | boolean;
          generationInProgress: number | boolean;
          retryAlreadyCreated: number | boolean;
        }>();
      if (!state) {
        throw new Error(
          "The authorised event disappeared during AI assessment reservation.",
        );
      }
      if (state.repositoryProvider !== "d1") {
        await this.assertViewerEvent(viewer);
      }
      if (state.retentionCompletedAt !== null) {
        throw new AiReviewAssessmentStateError(
          "Participant retention has completed for this event, so no new AI assessment can be generated.",
        );
      }
      if (!state.targetIsCurrent) {
        throw new AiReviewAssessmentStateError(
          "The review cycle, rubric or proposal changed before the AI assessment was reserved. Refresh before generating it.",
        );
      }
      if (state.generationInProgress) {
        throw new AiReviewAssessmentStateError(
          "An AI first-pass assessment attempt is already running for this exact round and submission.",
        );
      }
      if (state.retryAlreadyCreated) {
        throw new AiReviewAssessmentStateError(
          "A newer retry already exists for this failed AI assessment attempt. Refresh before retrying the latest failure.",
        );
      }
      throw new Error("The AI assessment operation could not be recorded.");
    }
    if (
      operation.id === input.generationIntentId &&
      operation.claimToken === claimToken
    ) {
      return { kind: "claimed", claimToken };
    }
    return { kind: "existing", operation };
  }

  protected async assertReconciliationScope(
    viewer: Viewer,
    operation: GenerationOperationRow,
  ) {
    if (
      operation.organisationId !== viewer.organisationId ||
      operation.eventId !== viewer.eventId ||
      operation.type !== "ai.review_assessment.generate" ||
      !operation.requestedByPersonId
    ) {
      throw new AiReviewAssessmentIntentConflictError();
    }
    const payload = parseGenerationOperationPayload(
      operation.payloadJson,
      operation.id,
    );
    const [requestHash, targetKey] = await Promise.all([
      this.generationRequestHash(payload, payload),
      this.generationTargetKey(payload),
    ]);
    if (
      payload.generationIntentId !== operation.id ||
      payload.requestHash !== requestHash ||
      payload.targetKey !== targetKey ||
      operation.idempotencyKey !==
        generationAttemptIdempotencyKey(
          operation.id,
          targetKey,
          payload.retryOfOperationId,
        )
    ) {
      throw new AiReviewAssessmentIntentConflictError();
    }
    return payload;
  }

  async reconcileGenerationAttempt(viewer: Viewer, rawInput: unknown) {
    assertAssessmentAdministrator(viewer);
    const event = await this.assertViewerEvent(viewer);
    if (event.retentionCompletedAt !== null) {
      throw new AiReviewAssessmentStateError(
        "Participant retention has completed for this event, so AI assessment attempts cannot be reconciled.",
      );
    }
    const input = generationReconciliationInputSchema.parse(rawInput);
    const operation = await this.operations.loadExactGenerationOperation(
      input.operationId,
    );
    if (!operation) {
      throw new AiReviewAssessmentStateError(
        "The AI assessment attempt is no longer available to reconcile.",
      );
    }
    const payload = await this.assertReconciliationScope(viewer, operation);
    try {
      const assessment = await this.operations.settleGenerationOperation(
        viewer,
        operation,
        payload,
      );
      return { status: "completed" as const, assessment };
    } catch (error) {
      if (!(error instanceof AiReviewAssessmentStateError)) throw error;
      const settled = await this.operations.loadExactGenerationOperation(
        operation.id,
      );
      if (!settled) {
        throw new Error(
          `AI assessment operation ${operation.id} disappeared during reconciliation.`,
        );
      }
      const settledPayload = await this.assertReconciliationScope(
        viewer,
        settled,
      );
      if (settled.status === "completed") {
        const assessment = await this.operations.settleGenerationOperation(
          viewer,
          settled,
          settledPayload,
        );
        return { status: "completed" as const, assessment };
      }
      if (settled.status !== "failed") throw error;
      if (!settled.resultJson) {
        throw new Error(
          `Failed AI assessment operation ${operation.id} has no result.`,
        );
      }
      parseFailedGenerationResult(settled.resultJson, settled.id);
      return { status: "failed" as const, operationId: settled.id };
    }
  }
}
