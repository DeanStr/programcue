import { reviewableSubmissionSql } from "~/modules/evaluations/evaluation-submission-review-eligibility.server";
import type { Viewer } from "~/platform/auth/authorize.server";
import {
  type GenerationOperationPayload,
  generationAttemptIdempotencyKey,
  parseCompletedGenerationResult,
  parseFailedGenerationResult,
  parseGenerationOperationPayload,
  parseStagedGenerationResult,
  type StagedGenerationResult,
} from "./ai-review-assessment-durable-state";
import {
  AiReviewAssessmentConflictError,
  AiReviewAssessmentIntentConflictError,
  AiReviewAssessmentStateError,
} from "./ai-review-assessment-errors";
import type { AiReviewAssessment } from "./ai-review-assessment-reader.server";
import { AiProviderError } from "./openai-responses-provider.server";

type GenerationOperationRow = {
  id: string;
  organisationId: string | null;
  eventId: string | null;
  requestedByPersonId: string | null;
  type: string;
  idempotencyKey: string;
  status: string;
  payloadJson: string;
  resultJson: string | null;
  lastError: string | null;
  claimToken: string | null;
  claimExpiresAt: number | null;
};

function safeErrorMetadata(error: unknown) {
  return {
    errorType: error instanceof Error ? error.name : "UnknownError",
    message:
      error instanceof Error
        ? error.message.slice(0, 500)
        : String(error).slice(0, 500),
    ...(error instanceof AiProviderError && error.providerRequestId
      ? { providerRequestId: error.providerRequestId }
      : {}),
  };
}

function epochSeconds(value: Date) {
  const epoch = Math.floor(value.getTime() / 1_000);
  if (!Number.isFinite(epoch)) {
    throw new Error("AI assessment time source returned an invalid date.");
  }
  return epoch;
}

export class AiReviewAssessmentOperationStore {
  constructor(
    private readonly env: CloudflareEnvironment,
    private readonly now: () => Date,
    private readonly readAssessment: (
      viewer: Viewer,
      assessmentId: string,
    ) => Promise<AiReviewAssessment | null>,
    private readonly assertEvent: (viewer: Viewer) => Promise<unknown>,
  ) {}

  async loadExactGenerationOperation(operationId: string) {
    return this.env.DB.prepare(
      `SELECT id, organisation_id AS organisationId, event_id AS eventId,
              requested_by_person_id AS requestedByPersonId, type,
              idempotency_key AS idempotencyKey, status,
              payload_json AS payloadJson, result_json AS resultJson,
              last_error AS lastError, claim_token AS claimToken,
              claim_expires_at AS claimExpiresAt
         FROM operation_jobs
        WHERE id = ?
        LIMIT 1`,
    )
      .bind(operationId)
      .first<GenerationOperationRow>();
  }

  async loadGenerationOperation(
    operationId: string,
    eventId: string,
    targetKey: string,
  ) {
    return this.env.DB.prepare(
      `SELECT id, organisation_id AS organisationId, event_id AS eventId,
              requested_by_person_id AS requestedByPersonId, type,
              idempotency_key AS idempotencyKey, status,
              payload_json AS payloadJson, result_json AS resultJson,
              last_error AS lastError, claim_token AS claimToken,
              claim_expires_at AS claimExpiresAt
         FROM operation_jobs
        WHERE id = ? OR (event_id = ? AND idempotency_key = ?)
        ORDER BY CASE WHEN id = ? THEN 0 ELSE 1 END
        LIMIT 1`,
    )
      .bind(operationId, eventId, targetKey, operationId)
      .first<GenerationOperationRow>();
  }

  async loadRunningGenerationOperation(
    organisationId: string,
    eventId: string,
    targetKey: string,
  ) {
    return this.env.DB.prepare(
      `SELECT id, organisation_id AS organisationId, event_id AS eventId,
              requested_by_person_id AS requestedByPersonId, type,
              idempotency_key AS idempotencyKey, status,
              payload_json AS payloadJson, result_json AS resultJson,
              last_error AS lastError, claim_token AS claimToken,
              claim_expires_at AS claimExpiresAt
         FROM operation_jobs
        WHERE organisation_id = ? AND event_id = ?
          AND type = 'ai.review_assessment.generate'
          AND status = 'running'
          AND json_extract(payload_json, '$.targetKey') = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1`,
    )
      .bind(organisationId, eventId, targetKey)
      .first<GenerationOperationRow>();
  }

  assertOperationScope(
    viewer: Viewer,
    operation: GenerationOperationRow,
    input: {
      generationIntentId: string;
      roundId: string;
      submissionId: string;
      retryFailedOperationId?: string;
    },
    targetKey: string,
    requestHash: string,
  ) {
    if (
      operation.organisationId !== viewer.organisationId ||
      operation.eventId !== viewer.eventId ||
      operation.type !== "ai.review_assessment.generate"
    ) {
      throw new AiReviewAssessmentIntentConflictError();
    }
    const payload = parseGenerationOperationPayload(
      operation.payloadJson,
      operation.id,
    );
    const exactIntent = operation.id === input.generationIntentId;
    if (
      payload.targetKey !== targetKey ||
      operation.idempotencyKey !==
        generationAttemptIdempotencyKey(
          operation.id,
          targetKey,
          payload.retryOfOperationId,
        ) ||
      payload.generationIntentId !== operation.id ||
      !operation.requestedByPersonId ||
      payload.roundId !== input.roundId ||
      payload.submissionId !== input.submissionId ||
      payload.requestHash !== requestHash ||
      (exactIntent &&
        payload.retryOfOperationId !==
          (input.retryFailedOperationId ?? null)) ||
      (exactIntent && operation.requestedByPersonId !== viewer.personId)
    ) {
      throw new AiReviewAssessmentIntentConflictError();
    }
    return payload;
  }

  assertExactOperationEnvelope(
    viewer: Viewer,
    operation: GenerationOperationRow,
  ) {
    if (
      operation.organisationId !== viewer.organisationId ||
      operation.eventId !== viewer.eventId ||
      operation.requestedByPersonId !== viewer.personId ||
      operation.type !== "ai.review_assessment.generate"
    ) {
      throw new AiReviewAssessmentIntentConflictError();
    }
  }

  async failGeneration(
    viewer: Viewer,
    input: {
      operationId: string;
      claimToken: string;
      submissionId: string;
      requestedByPersonId: string;
      error: unknown;
    },
  ) {
    const failure = safeErrorMetadata(input.error);
    const now = epochSeconds(this.now());
    const resultJson = JSON.stringify({
      phase: "failed",
      errorType: failure.errorType,
      ...(failure.providerRequestId
        ? { providerRequestId: failure.providerRequestId }
        : {}),
      retrySafe: false,
    });
    const metadata = JSON.stringify({
      operationId: input.operationId,
      retrySafe: false,
      ...failure,
    });
    const [failed] = await this.env.DB.batch([
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'failed', progress_failed = 1, last_error = ?,
                result_json = ?, claim_token = NULL, claim_expires_at = NULL,
                completed_at = ?, updated_at = ?
          WHERE id = ? AND event_id = ? AND organisation_id = ?
            AND type = 'ai.review_assessment.generate'
            AND status = 'running' AND claim_token = ?`,
      ).bind(
        failure.message,
        resultJson,
        now,
        now,
        input.operationId,
        viewer.eventId,
        viewer.organisationId,
        input.claimToken,
      ),
      this.env.DB.prepare(
        `INSERT OR IGNORE INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id, action,
           entity_type, entity_id, correlation_id, metadata_json, created_at
         )
         SELECT ?, 'agent', 'admin_ui', 1, operation.organisation_id, operation.event_id, ?, 'program_cue_agent',
                'ai.review_assessment.failed', 'submission', ?, operation.id,
                ?, ?
           FROM operation_jobs operation
          WHERE operation.id = ? AND operation.event_id = ?
            AND operation.status = 'failed'`,
      ).bind(
        `ai-review-assessment-failed:${input.operationId}`,
        input.requestedByPersonId,
        input.submissionId,
        metadata,
        now,
        input.operationId,
        viewer.eventId,
      ),
    ]);
    if ((failed.meta.changes ?? 0) === 1) return;
    const settled = await this.env.DB.prepare(
      `SELECT status FROM operation_jobs
        WHERE id = ? AND event_id = ? AND organisation_id = ?`,
    )
      .bind(input.operationId, viewer.eventId, viewer.organisationId)
      .first<{ status: string }>();
    if (settled?.status === "failed" || settled?.status === "completed") return;
    throw new Error(
      `AI assessment operation ${input.operationId} could not record its failure.`,
      { cause: input.error },
    );
  }

  async stageGenerationResult(
    viewer: Viewer,
    operationId: string,
    claimToken: string,
    result: StagedGenerationResult,
  ) {
    const now = epochSeconds(this.now());
    const resultJson = JSON.stringify(result);
    const staged = await this.env.DB.prepare(
      `UPDATE operation_jobs
          SET result_json = ?, updated_at = ?
        WHERE id = ? AND event_id = ? AND organisation_id = ?
          AND type = 'ai.review_assessment.generate'
          AND status = 'running' AND claim_token = ?
          AND result_json IS NULL`,
    )
      .bind(
        resultJson,
        now,
        operationId,
        viewer.eventId,
        viewer.organisationId,
        claimToken,
      )
      .run();
    if ((staged.meta.changes ?? 0) === 1) return resultJson;
    const operation = await this.env.DB.prepare(
      `SELECT status, result_json AS resultJson
         FROM operation_jobs
        WHERE id = ? AND event_id = ? AND organisation_id = ?`,
    )
      .bind(operationId, viewer.eventId, viewer.organisationId)
      .first<{ status: string; resultJson: string | null }>();
    if (
      operation?.status === "running" &&
      operation.resultJson === resultJson
    ) {
      return resultJson;
    }
    throw new AiReviewAssessmentStateError(
      "The AI assessment provider claim ended before its response could be saved. The provider will not be called again automatically.",
    );
  }

  async completeGeneration(
    viewer: Viewer,
    input: {
      operationId: string;
      claimToken: string;
      requestedByPersonId: string;
      payload: GenerationOperationPayload;
      staged: StagedGenerationResult;
      stagedJson: string;
    },
  ) {
    if (input.staged.assessmentId !== input.payload.assessmentId) {
      throw new Error(
        `AI assessment operation ${input.operationId} staged a result for another assessment.`,
      );
    }
    const resultJson = JSON.stringify({
      phase: "completed",
      assessmentId: input.staged.assessmentId,
      score: input.staged.score,
      provider: input.staged.provider,
      model: input.staged.model,
      responseId: input.staged.responseId,
    });
    const auditMetadata = JSON.stringify({
      operationId: input.operationId,
      assessmentId: input.staged.assessmentId,
      roundId: input.payload.roundId,
      submissionId: input.payload.submissionId,
      score: input.staged.score,
      provider: input.staged.provider,
      model: input.staged.model,
      responseId: input.staged.responseId,
      rationaleHash: input.staged.rationaleHash,
      roundRevision: input.payload.roundRevision,
      scorecardId: input.payload.scorecardId,
      scorecardVersion: input.payload.scorecardVersion,
      submissionRevisionId: input.payload.submissionRevisionId,
      submissionRevisionNumber: input.payload.submissionRevisionNumber,
      sourceSnapshotSha256: input.payload.sourceSnapshotSha256,
      modelInputSha256: input.payload.modelInputSha256,
      promptVersion: input.payload.promptVersion,
    });
    try {
      await this.env.DB.batch([
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO ai_review_assessments (
             id, event_id, round_id, submission_id, scorecard_id,
             scorecard_version, round_revision, score, rationale, provider,
             model, provider_response_id, generated_by_person_id, generated_at,
             submission_revision_id, source_snapshot_sha256,
             model_input_sha256, prompt_version,
             revision, last_operation_id, updated_at
           )
           SELECT ?, round.event_id, round.id, submission.id,
                  round.scorecard_id, round.scorecard_version, round.revision,
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?
             FROM evaluation_rounds round
             JOIN events event
               ON event.id = round.event_id AND event.organisation_id = ?
              AND event.repository_provider = 'd1'
              AND event.participant_retention_completed_at IS NULL
             JOIN evaluation_plans plan
               ON plan.id = round.plan_id AND plan.event_id = round.event_id
             JOIN submissions submission
               ON submission.event_id = round.event_id AND submission.id = ?
            WHERE round.id = ? AND round.event_id = ? AND round.revision = ?
              AND round.scorecard_id = ? AND round.scorecard_version = ?
              AND round.status IN ('active','closed')
              AND plan.status IN ('active','closed')
              AND NOT EXISTS (
                SELECT 1 FROM evaluation_plans other_plan
                 WHERE other_plan.event_id = plan.event_id
                   AND other_plan.id <> plan.id
                   AND other_plan.status <> 'archived'
              )
              AND submission.submitted_at IS NOT NULL
              AND submission.submitted_snapshot_json = ?
              AND EXISTS (
                SELECT 1 FROM submission_revisions source_revision
                 WHERE source_revision.id = ?
                   AND source_revision.event_id = submission.event_id
                   AND source_revision.submission_id = submission.id
                   AND source_revision.revision_number = ?
                   AND source_revision.save_kind = 'submitted'
              )
              AND ${reviewableSubmissionSql("submission", "review")}
              AND EXISTS (
                SELECT 1 FROM operation_jobs operation
                 WHERE operation.id = ? AND operation.event_id = round.event_id
                   AND operation.organisation_id = event.organisation_id
                   AND operation.status = 'running'
                   AND operation.claim_token = ?
                   AND operation.result_json = ?
              )
              AND NOT EXISTS (
                SELECT 1 FROM ai_review_assessments existing
                 WHERE existing.event_id = round.event_id
                   AND existing.round_id = round.id
                   AND existing.submission_id = submission.id
              )`,
        ).bind(
          input.staged.assessmentId,
          input.staged.score,
          input.staged.rationale,
          input.staged.provider,
          input.staged.model,
          input.staged.responseId,
          input.requestedByPersonId,
          input.staged.generatedAt,
          input.payload.submissionRevisionId,
          input.payload.sourceSnapshotSha256,
          input.payload.modelInputSha256,
          input.payload.promptVersion,
          input.operationId,
          input.staged.generatedAt,
          viewer.organisationId,
          input.payload.submissionId,
          input.payload.roundId,
          viewer.eventId,
          input.payload.roundRevision,
          input.payload.scorecardId,
          input.payload.scorecardVersion,
          input.payload.sourceSnapshotJson,
          input.payload.submissionRevisionId,
          input.payload.submissionRevisionNumber,
          input.operationId,
          input.claimToken,
          input.stagedJson,
        ),
        this.env.DB.prepare(
          `UPDATE operation_jobs
              SET status = 'completed', result_json = ?,
                  progress_completed = 1, last_error = NULL,
                  claim_token = NULL, claim_expires_at = NULL,
                  completed_at = ?, updated_at = ?
            WHERE id = ? AND event_id = ? AND organisation_id = ?
              AND status = 'running' AND claim_token = ?
              AND result_json = ?
              AND EXISTS (
                SELECT 1 FROM ai_review_assessments assessment
                 WHERE assessment.id = ?
                   AND assessment.last_operation_id = operation_jobs.id
              )
              AND EXISTS (
                SELECT 1 FROM events event
                 WHERE event.id = operation_jobs.event_id
                   AND event.organisation_id = operation_jobs.organisation_id
                   AND event.repository_provider = 'd1'
              )`,
        ).bind(
          resultJson,
          input.staged.generatedAt,
          input.staged.generatedAt,
          input.operationId,
          viewer.eventId,
          viewer.organisationId,
          input.claimToken,
          input.stagedJson,
          input.staged.assessmentId,
        ),
        this.env.DB.prepare(
          `INSERT OR IGNORE INTO audit_events (
             id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, actor_id, action,
             entity_type, entity_id, correlation_id, metadata_json, created_at
           )
           SELECT ?, 'agent', 'admin_ui', 1, operation.organisation_id, operation.event_id, ?, 'program_cue_agent',
                  'ai.review_assessment.generated', 'ai_review_assessment',
                  assessment.id, operation.id, ?, ?
             FROM operation_jobs operation
             JOIN ai_review_assessments assessment
               ON assessment.last_operation_id = operation.id
            WHERE operation.id = ? AND operation.event_id = ?
              AND operation.status = 'completed'
              AND operation.result_json = ?
              AND EXISTS (
                SELECT 1 FROM events event
                 WHERE event.id = operation.event_id
                   AND event.organisation_id = operation.organisation_id
                   AND event.repository_provider = 'd1'
              )`,
        ).bind(
          `ai-review-assessment-generated:${input.operationId}`,
          input.requestedByPersonId,
          auditMetadata,
          input.staged.generatedAt,
          input.operationId,
          viewer.eventId,
          resultJson,
        ),
      ]);
    } catch (error) {
      const settled = await this.readAssessment(
        viewer,
        input.staged.assessmentId,
      );
      if (settled) return settled;
      throw error;
    }
    const saved = await this.readAssessment(viewer, input.staged.assessmentId);
    if (saved) return saved;
    await this.assertEvent(viewer);
    throw new AiReviewAssessmentConflictError(
      "The round, rubric or submission changed while the AI assessment was being generated. No assessment was saved.",
    );
  }

  async settleGenerationOperation(
    viewer: Viewer,
    operation: GenerationOperationRow,
    payload: GenerationOperationPayload,
  ): Promise<AiReviewAssessment> {
    if (!operation.requestedByPersonId) {
      throw new Error(
        `AI assessment operation ${operation.id} has no requesting person.`,
      );
    }
    if (operation.status === "completed") {
      if (!operation.resultJson) {
        throw new Error(
          `Completed AI assessment operation ${operation.id} has no result.`,
        );
      }
      const result = parseCompletedGenerationResult(
        operation.resultJson,
        operation.id,
      );
      if (result.assessmentId !== payload.assessmentId) {
        throw new Error(
          `Completed AI assessment operation ${operation.id} has an inconsistent assessment identity.`,
        );
      }
      const assessment = await this.readAssessment(viewer, result.assessmentId);
      if (!assessment) {
        throw new Error(
          `Completed AI assessment operation ${operation.id} has no persisted assessment.`,
        );
      }
      return assessment;
    }
    if (operation.status === "failed") {
      if (!operation.resultJson) {
        throw new Error(
          `Failed AI assessment operation ${operation.id} has no result.`,
        );
      }
      parseFailedGenerationResult(operation.resultJson, operation.id);
      throw new AiReviewAssessmentStateError(
        `${operation.lastError ?? "The AI first-pass assessment failed."} The saved request will not call the provider again automatically.`,
      );
    }
    if (operation.status !== "running") {
      throw new Error(
        `AI assessment operation ${operation.id} has unsupported ${operation.status} status.`,
      );
    }
    if (!operation.claimToken || operation.claimExpiresAt === null) {
      throw new Error(
        `Running AI assessment operation ${operation.id} has no provider claim.`,
      );
    }
    if (operation.resultJson) {
      const staged = parseStagedGenerationResult(
        operation.resultJson,
        operation.id,
      );
      try {
        return await this.completeGeneration(viewer, {
          operationId: operation.id,
          claimToken: operation.claimToken,
          requestedByPersonId: operation.requestedByPersonId,
          payload,
          staged,
          stagedJson: operation.resultJson,
        });
      } catch (error) {
        if (
          error instanceof AiReviewAssessmentConflictError ||
          error instanceof AiReviewAssessmentStateError
        ) {
          await this.failGeneration(viewer, {
            operationId: operation.id,
            claimToken: operation.claimToken,
            submissionId: payload.submissionId,
            requestedByPersonId: operation.requestedByPersonId,
            error,
          });
        }
        throw error;
      }
    }
    const now = epochSeconds(this.now());
    if (operation.claimExpiresAt > now) {
      throw new AiReviewAssessmentStateError(
        "This AI first-pass assessment is already running. Retry after the current attempt finishes.",
      );
    }
    const stalled = new AiReviewAssessmentStateError(
      "The AI provider claim expired before a response was saved. Its outcome is indeterminate, so Program Cue will not call the provider again automatically.",
    );
    await this.failGeneration(viewer, {
      operationId: operation.id,
      claimToken: operation.claimToken,
      submissionId: payload.submissionId,
      requestedByPersonId: operation.requestedByPersonId,
      error: stalled,
    });
    throw stalled;
  }
}
