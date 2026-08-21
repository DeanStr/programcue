import type { Viewer } from "~/platform/auth/authorize.server";
import { DEMO_ORGANISATION_ID } from "~/platform/demo/demo-identities";
import {
  EVALUATION_FIXTURE_RESET_OPERATION_ID,
  EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
} from "~/platform/evaluation/evaluation-fixture-reset-lock.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";
import { AiAssistantBusyError } from "./ai-assistant-errors";

const AI_OPERATION_LEASE_SECONDS = 5 * 60;

export type AiOperationType =
  | "ai.assistant.run"
  | "ai.context.run"
  | "ai.proposal.revision";

export type AiOperationLease = {
  id: string;
  type: AiOperationType;
  claimToken: string;
};

export async function startAiOperationLease(
  env: CloudflareEnvironment,
  viewer: Viewer,
  input: {
    id: string;
    type: AiOperationType;
    payload: Record<string, unknown>;
  },
): Promise<AiOperationLease> {
  const claimToken = crypto.randomUUID();
  const guardEvaluationReset =
    requireRuntimeMode(env).evaluation &&
    viewer.organisationId === DEMO_ORGANISATION_ID;
  const started = await env.DB.prepare(
    `INSERT INTO operation_jobs (
       id, organisation_id, event_id, requested_by_person_id, type,
       idempotency_key, correlation_id, status, payload_json,
       progress_total, progress_completed, progress_failed, attempt_count,
       cancellable, claim_token, claim_expires_at, started_at, created_at,
       updated_at
     ) SELECT ?, ?, ?, ?, ?, ?, ?, 'running', ?, 1, 0, 0, 1, 0, ?,
              unixepoch() + ?, unixepoch(), unixepoch(), unixepoch()
        WHERE ? = 0 OR NOT EXISTS (
          SELECT 1 FROM operation_jobs fixture_reset
           WHERE fixture_reset.id = ? AND fixture_reset.type = ?
             AND fixture_reset.status = 'running'
        )`,
  )
    .bind(
      input.id,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      input.type,
      `${input.type}:${input.id}`,
      input.id,
      JSON.stringify(input.payload),
      claimToken,
      AI_OPERATION_LEASE_SECONDS,
      guardEvaluationReset ? 1 : 0,
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
    )
    .run();
  if ((started.meta.changes ?? 0) !== 1) {
    if (guardEvaluationReset) throw new AiAssistantBusyError();
    throw new Error(`AI operation ${input.id} could not be started.`);
  }
  return { id: input.id, type: input.type, claimToken };
}

export async function renewAiOperationLease(
  env: CloudflareEnvironment,
  lease: AiOperationLease,
) {
  const renewed = await env.DB.prepare(
    `UPDATE operation_jobs
        SET claim_expires_at = unixepoch() + ?, updated_at = unixepoch()
      WHERE id = ? AND type = ? AND status = 'running'
        AND claim_token = ? AND claim_expires_at > unixepoch()`,
  )
    .bind(AI_OPERATION_LEASE_SECONDS, lease.id, lease.type, lease.claimToken)
    .run();
  if ((renewed.meta.changes ?? 0) !== 1) {
    throw new Error(`AI operation ${lease.id} lost its ownership lease.`);
  }
}

export async function completeAiOperationLease(
  env: CloudflareEnvironment,
  lease: AiOperationLease,
  result: Record<string, unknown>,
) {
  const completed = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'completed', result_json = ?, progress_completed = 1,
            claim_token = NULL, claim_expires_at = NULL,
            completed_at = unixepoch(), updated_at = unixepoch()
      WHERE id = ? AND type = ? AND status = 'running'
        AND claim_token = ? AND claim_expires_at > unixepoch()`,
  )
    .bind(JSON.stringify(result), lease.id, lease.type, lease.claimToken)
    .run();
  if ((completed.meta.changes ?? 0) !== 1) {
    throw new Error(
      `AI operation ${lease.id} could not be completed by its lease owner.`,
    );
  }
}

export async function failAiOperationLease(
  env: CloudflareEnvironment,
  lease: AiOperationLease,
  error: unknown,
) {
  const errorType = error instanceof Error ? error.name : "UnknownError";
  const message =
    error instanceof Error
      ? error.message.slice(0, 500)
      : String(error).slice(0, 500);
  const failed = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'failed', progress_failed = 1, last_error = ?,
            result_json = ?, claim_token = NULL, claim_expires_at = NULL,
            completed_at = unixepoch(), updated_at = unixepoch()
      WHERE id = ? AND type = ? AND status = 'running'
        AND claim_token = ? AND claim_expires_at > unixepoch()`,
  )
    .bind(
      message,
      JSON.stringify({ errorType }),
      lease.id,
      lease.type,
      lease.claimToken,
    )
    .run();
  if ((failed.meta.changes ?? 0) !== 1) {
    throw new Error(
      `AI operation ${lease.id} could not record failure because its lease was lost.`,
    );
  }
}
