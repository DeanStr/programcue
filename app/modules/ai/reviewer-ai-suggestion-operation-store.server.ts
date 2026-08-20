import { z } from "zod";
import type { Viewer } from "~/platform/auth/authorize.server";
import { AiProviderError } from "./openai-responses-provider.server";
import { ReviewerAiSuggestionFoundation } from "./reviewer-ai-suggestion-foundation.server";
import {
  invariantGuardStatement,
  isInvariantGuardError,
  type ReviewerAiSuggestionRetry,
} from "./reviewer-ai-suggestion-support.server";

export class ReviewerAiSuggestionOperationStore extends ReviewerAiSuggestionFoundation {
  async getRetryForAssignment(
    viewer: Viewer,
    rawAssignmentId: unknown,
  ): Promise<ReviewerAiSuggestionRetry | null> {
    const assignmentId = z
      .string()
      .trim()
      .min(1)
      .max(200)
      .parse(rawAssignmentId);
    await this.recoverInterruptedOperation(viewer, assignmentId);
    return this.env.DB.prepare(
      `SELECT operation.id AS operationId,
              json_extract(operation.result_json, '$.providerRequestId') AS providerRequestId,
              operation.last_error AS lastError
         FROM operation_jobs operation
         JOIN evaluator_assignments assignment
           ON assignment.event_id = operation.event_id
          AND assignment.id = json_extract(operation.payload_json, '$.assignmentId')
         JOIN evaluation_rounds round
           ON round.id = assignment.round_id AND round.event_id = assignment.event_id
         JOIN events event
           ON event.id = operation.event_id AND event.organisation_id = ?
          AND event.repository_provider = 'd1'
        WHERE operation.event_id = ?
          AND operation.requested_by_person_id = ?
          AND operation.type = 'ai.reviewer_suggestion.generate'
          AND operation.status = 'failed'
          AND assignment.id = ?
          AND assignment.evaluator_person_id = ?
          AND json_extract(operation.result_json, '$.retrySafe') = 0
          AND NOT EXISTS (
            SELECT 1 FROM operation_jobs retry
             WHERE retry.event_id = operation.event_id
               AND retry.type = operation.type
               AND json_extract(
                 retry.payload_json, '$.retryOfOperationId'
               ) = operation.id
          )
        ORDER BY operation.created_at DESC, operation.id DESC
        LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        assignmentId,
        viewer.personId,
      )
      .first<ReviewerAiSuggestionRetry>();
  }
  protected async auditedTerminalOperation(
    viewer: Viewer,
    operationId: string,
  ) {
    return this.env.DB.prepare(
      `SELECT operation.status,
              CASE
                WHEN operation.status = 'completed' THEN EXISTS (
                  SELECT 1 FROM audit_events audit
                   WHERE audit.event_id = operation.event_id
                     AND audit.organisation_id = operation.organisation_id
                     AND audit.correlation_id = operation.id
                     AND audit.action = 'ai.reviewer_suggestion.generated'
                     AND audit.entity_id = json_extract(
                       operation.result_json, '$.suggestionId'
                     )
                )
                WHEN operation.status = 'failed' THEN EXISTS (
                  SELECT 1 FROM audit_events audit
                   WHERE audit.event_id = operation.event_id
                     AND audit.organisation_id = operation.organisation_id
                     AND audit.correlation_id = operation.id
                     AND audit.entity_id = operation.id
                     AND audit.action IN (
                       'ai.reviewer_suggestion.failed',
                       'ai.reviewer_suggestion.interrupted'
                     )
                )
                ELSE 0
              END AS hasTerminalAudit
         FROM operation_jobs operation
        WHERE operation.id = ? AND operation.event_id = ?
          AND operation.requested_by_person_id = ?`,
    )
      .bind(operationId, viewer.eventId, viewer.personId)
      .first<{ status: string; hasTerminalAudit: number | boolean }>();
  }
  protected async recoverInterruptedOperation(
    viewer: Viewer,
    assignmentId: string,
  ) {
    const interrupted = await this.env.DB.prepare(
      `SELECT operation.id
         FROM operation_jobs operation
         JOIN events event
           ON event.id = operation.event_id AND event.organisation_id = ?
          AND event.repository_provider = 'd1'
        WHERE operation.event_id = ?
          AND operation.requested_by_person_id = ?
          AND operation.type = 'ai.reviewer_suggestion.generate'
          AND operation.status = 'running'
          AND operation.claim_token IS NOT NULL
          AND operation.claim_expires_at <= unixepoch()
          AND json_extract(operation.payload_json, '$.assignmentId') = ?
        ORDER BY operation.created_at DESC, operation.id DESC
        LIMIT 1`,
    )
      .bind(
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        assignmentId,
      )
      .first<{ id: string }>();
    if (!interrupted) return;
    const recoveryId = crypto.randomUUID();
    const interruptedAuditEventId = crypto.randomUUID();
    const message =
      "The AI request was interrupted before Program Cue could record its result.";
    const [audited, failed] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, actor_id, action, entity_type, entity_id,
           correlation_id, metadata_json, created_at
         )
         SELECT ?, 'agent', 'participant_ui', 1, ?, ?, ?,
                'program_cue_reviewer_ai',
                'ai.reviewer_suggestion.interrupted', 'operation',
                operation.id, operation.id, ?, unixepoch()
           FROM operation_jobs operation
          WHERE operation.id = ? AND operation.event_id = ?
            AND operation.status = 'running'
            AND operation.claim_expires_at <= unixepoch()`,
      ).bind(
        interruptedAuditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        JSON.stringify({ message, retrySafe: false, recoveryId }),
        interrupted.id,
        viewer.eventId,
      ),
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'failed', progress_failed = 1, last_error = ?,
                result_json = ?, claim_token = NULL, claim_expires_at = NULL,
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND status = 'running'
            AND claim_expires_at <= unixepoch()
            AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.event_id = ?
                 AND audit.action = 'ai.reviewer_suggestion.interrupted'
                 AND audit.entity_id = ? AND audit.correlation_id = ?
            )`,
      ).bind(
        message,
        JSON.stringify({
          errorType: "InterruptedAiRequest",
          providerRequestId: null,
          retrySafe: false,
          recoveryId,
        }),
        interrupted.id,
        viewer.eventId,
        interruptedAuditEventId,
        viewer.eventId,
        interrupted.id,
        interrupted.id,
      ),
      invariantGuardStatement(
        this.env,
        `EXISTS (
           SELECT 1 FROM audit_events audit WHERE audit.id = ?
         ) <> EXISTS (
           SELECT 1 FROM operation_jobs operation
            WHERE operation.id = ? AND operation.event_id = ?
              AND operation.status = 'failed'
              AND json_extract(operation.result_json, '$.recoveryId') = ?
         )`,
        [interruptedAuditEventId, interrupted.id, viewer.eventId, recoveryId],
      ),
    ]).catch((error: unknown) => {
      if (isInvariantGuardError(error)) {
        throw new Error(
          "Interrupted reviewer AI work could not record complete recovery evidence.",
          { cause: error },
        );
      }
      throw error;
    });
    if ((failed.meta.changes ?? 0) === 1 && (audited.meta.changes ?? 0) === 1) {
      return;
    }
    const recovered = await this.auditedTerminalOperation(
      viewer,
      interrupted.id,
    );
    if (
      (recovered?.status === "failed" || recovered?.status === "completed") &&
      recovered.hasTerminalAudit
    ) {
      return;
    }
    throw new Error(
      "Interrupted reviewer AI work could not record complete recovery evidence.",
    );
  }
  protected async failOperation(
    viewer: Viewer,
    operationId: string,
    claimToken: string,
    error: unknown,
    retrySafe: boolean,
    providerRequestIdOverride: string | null = null,
  ) {
    const message =
      error instanceof Error
        ? error.message.slice(0, 500)
        : "Unknown AI suggestion failure.";
    const providerRequestId =
      providerRequestIdOverride ??
      (error instanceof AiProviderError ? error.providerRequestId : null);
    const failedAuditEventId = crypto.randomUUID();
    const [audited, failed] = await this.env.DB.batch([
      this.env.DB.prepare(
        `INSERT INTO audit_events (
           id, actor_kind, origin, metadata_version, organisation_id, event_id,
           actor_person_id, actor_id, action, entity_type, entity_id, correlation_id,
           metadata_json, created_at
         )
         SELECT ?, 'agent', 'participant_ui', 1, ?, ?, ?, 'program_cue_reviewer_ai',
                'ai.reviewer_suggestion.failed', 'operation', ?, ?, ?, unixepoch()
           FROM operation_jobs operation
          WHERE operation.id = ? AND operation.event_id = ?
            AND operation.status = 'running' AND operation.claim_token = ?`,
      ).bind(
        failedAuditEventId,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        operationId,
        operationId,
        JSON.stringify({ message, providerRequestId, retrySafe }),
        operationId,
        viewer.eventId,
        claimToken,
      ),
      this.env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'failed', progress_failed = 1, last_error = ?,
                result_json = ?, claim_token = NULL, claim_expires_at = NULL,
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE id = ? AND event_id = ? AND status = 'running'
            AND claim_token = ?
            AND EXISTS (
              SELECT 1 FROM audit_events audit
               WHERE audit.id = ? AND audit.event_id = ?
                 AND audit.action = 'ai.reviewer_suggestion.failed'
                 AND audit.entity_id = ? AND audit.correlation_id = ?
            )`,
      ).bind(
        message,
        JSON.stringify({
          errorType: error instanceof Error ? error.name : "UnknownError",
          providerRequestId,
          retrySafe,
        }),
        operationId,
        viewer.eventId,
        claimToken,
        failedAuditEventId,
        viewer.eventId,
        operationId,
        operationId,
      ),
      invariantGuardStatement(
        this.env,
        `EXISTS (
           SELECT 1 FROM audit_events audit
            WHERE audit.id = ?
         ) <> EXISTS (
           SELECT 1 FROM operation_jobs operation
            WHERE operation.id = ? AND operation.event_id = ?
              AND operation.status = 'failed' AND operation.last_error = ?
         )`,
        [failedAuditEventId, operationId, viewer.eventId, message],
      ),
    ]).catch((failureError: unknown) => {
      if (isInvariantGuardError(failureError)) {
        throw new Error(
          "The reviewer AI failure could not record complete audit evidence.",
          { cause: failureError },
        );
      }
      throw failureError;
    });
    if ((audited.meta.changes ?? 0) === 1 && (failed.meta.changes ?? 0) === 1) {
      return;
    }
    const existing = await this.auditedTerminalOperation(viewer, operationId);
    if (
      (existing?.status === "failed" || existing?.status === "completed") &&
      existing.hasTerminalAudit
    ) {
      return;
    }
    throw new Error(
      "The reviewer AI failure could not record complete audit evidence.",
    );
  }
}
