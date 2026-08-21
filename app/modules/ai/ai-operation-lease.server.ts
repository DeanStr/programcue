import type { Viewer } from "~/platform/auth/authorize.server";
import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import { DEMO_ORGANISATION_ID } from "~/platform/demo/demo-identities";
import {
  EVALUATION_FIXTURE_RESET_OPERATION_ID,
  EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
} from "~/platform/evaluation/evaluation-fixture-reset-lock.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";
import { AiAssistantBusyError } from "./ai-assistant-errors";
import type { SafeAiErrorMetadata } from "./ai-error-metadata";

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

export type AiOperationAudit = {
  actorKind: "person" | "agent";
  action: string;
  entityType: string;
  entityId?: string | null;
  correlationId: string;
  metadata: Record<string, unknown>;
};

export type AiOperationAtomicMutation = {
  statements: D1PreparedStatement[];
  failurePredicateSql: string;
  bindings: Array<string | number | null>;
  conflict?: {
    predicateSql: string;
    bindings: Array<string | number | null>;
    createError: () => Error;
  };
};

export class AiOperationSettlementIndeterminateError extends Error {
  constructor(operationId: string, cause: unknown) {
    super(
      `AI operation ${operationId} could not confirm its durable settlement.`,
      { cause },
    );
    this.name = "AiOperationSettlementIndeterminateError";
  }
}

function operationAuditStatement(
  env: CloudflareEnvironment,
  viewer: Viewer,
  operation: { id: string; type: AiOperationType },
  auditId: string,
  audit: AiOperationAudit,
  requiredStatus: "running" | "completed" | "failed" | "cancelled",
  resultJson: string | null,
) {
  return env.DB.prepare(
    `INSERT INTO audit_events (
       id, actor_kind, origin, metadata_version, organisation_id, event_id,
       actor_person_id, actor_id, action, entity_type, entity_id,
       correlation_id, metadata_json, created_at
     )
     SELECT ?, ?, 'admin_ui', 1, operation.organisation_id,
            operation.event_id, operation.requested_by_person_id,
            CASE WHEN ? = 'agent' THEN 'program_cue_agent' ELSE NULL END,
            ?, ?, ?, ?, ?, unixepoch()
       FROM operation_jobs operation
      WHERE operation.id = ? AND operation.type = ?
        AND operation.organisation_id = ? AND operation.event_id = ?
        AND operation.requested_by_person_id = ?
        AND operation.status = ?
        AND (? IS NULL OR operation.result_json = ?)`,
  ).bind(
    auditId,
    audit.actorKind,
    audit.actorKind,
    audit.action,
    audit.entityType,
    audit.entityId ?? null,
    audit.correlationId,
    JSON.stringify(audit.metadata),
    operation.id,
    operation.type,
    viewer.organisationId,
    viewer.eventId,
    viewer.personId,
    requiredStatus,
    resultJson,
    resultJson,
  );
}

async function evaluationResetIsRunning(env: CloudflareEnvironment) {
  return Boolean(
    await env.DB.prepare(
      `SELECT 1 FROM operation_jobs
        WHERE id = ? AND type = ? AND status = 'running'`,
    )
      .bind(
        EVALUATION_FIXTURE_RESET_OPERATION_ID,
        EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      )
      .first(),
  );
}

async function operationAndAuditSettled(
  env: CloudflareEnvironment,
  lease: AiOperationLease,
  status: "running" | "completed" | "failed" | "cancelled",
  resultJson: string | null,
  auditId: string | null,
) {
  const row = await env.DB.prepare(
    `SELECT operation.status, operation.result_json AS resultJson,
            CASE WHEN ? IS NULL THEN 1 ELSE EXISTS(
              SELECT 1 FROM audit_events audit WHERE audit.id = ?
            ) END AS audited
       FROM operation_jobs operation
      WHERE operation.id = ? AND operation.type = ?`,
  )
    .bind(auditId, auditId, lease.id, lease.type)
    .first<{ status: string; resultJson: string | null; audited: number }>();
  return Boolean(
    row?.status === status &&
      row.audited === 1 &&
      (resultJson === null || row.resultJson === resultJson),
  );
}

async function operationLeaseIsLive(
  env: CloudflareEnvironment,
  viewer: Viewer,
  lease: AiOperationLease,
) {
  return Boolean(
    await env.DB.prepare(
      `SELECT 1 FROM operation_jobs
        WHERE id = ? AND type = ? AND status = 'running'
          AND organisation_id = ? AND event_id = ?
          AND requested_by_person_id = ? AND claim_token = ?
          AND claim_expires_at > unixepoch()`,
    )
      .bind(
        lease.id,
        lease.type,
        viewer.organisationId,
        viewer.eventId,
        viewer.personId,
        lease.claimToken,
      )
      .first(),
  );
}

export async function aiOperationMutationConflict(
  env: CloudflareEnvironment,
  mutation: AiOperationAtomicMutation,
) {
  if (!mutation.conflict) return null;
  const conflict = await env.DB.prepare(
    `SELECT 1 WHERE ${mutation.conflict.predicateSql}`,
  )
    .bind(...mutation.conflict.bindings)
    .first();
  return conflict ? mutation.conflict.createError() : null;
}

export async function startAiOperationLease(
  env: CloudflareEnvironment,
  viewer: Viewer,
  input: {
    id: string;
    type: AiOperationType;
    payload: Record<string, unknown>;
    audit: AiOperationAudit;
  },
): Promise<AiOperationLease> {
  const claimToken = crypto.randomUUID();
  const lease = { id: input.id, type: input.type, claimToken };
  const guardEvaluationReset =
    requireRuntimeMode(env).evaluation &&
    viewer.organisationId === DEMO_ORGANISATION_ID;
  const startStatement = env.DB.prepare(
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
  ).bind(
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
  );
  const auditId = crypto.randomUUID();
  try {
    const [started, audited] = await env.DB.batch([
      startStatement,
      operationAuditStatement(
        env,
        viewer,
        lease,
        auditId,
        input.audit,
        "running",
        null,
      ),
      atomicBatchGuardStatement(
        env,
        `NOT EXISTS (
           SELECT 1 FROM operation_jobs operation
            WHERE operation.id = ? AND operation.type = ?
              AND operation.status = 'running' AND operation.claim_token = ?
         ) OR NOT EXISTS (
           SELECT 1 FROM audit_events audit WHERE audit.id = ?
         )`,
        [input.id, input.type, claimToken, auditId],
      ),
    ]);
    if (
      (started.meta.changes ?? 0) === 1 &&
      (audited.meta.changes ?? 0) === 1
    ) {
      return lease;
    }
  } catch (error) {
    if (await operationAndAuditSettled(env, lease, "running", null, auditId)) {
      return lease;
    }
    if (guardEvaluationReset && (await evaluationResetIsRunning(env))) {
      throw new AiAssistantBusyError();
    }
    throw error;
  }
  if (guardEvaluationReset && (await evaluationResetIsRunning(env))) {
    throw new AiAssistantBusyError();
  }
  throw new Error(
    `AI operation ${input.id} and its audit could not be started.`,
  );
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

export async function reconcileInterruptedAiOperations(
  env: CloudflareEnvironment,
) {
  const recoveryId = crypto.randomUUID();
  const message =
    "The AI request was interrupted before Program Cue could record its result.";
  const resultJson = JSON.stringify({
    phase: "failed",
    errorType: "InterruptedAiOperation",
    message,
    retrySafe: false,
    recoveryId,
  });
  const eligible = `operation.type IN (
      'ai.assistant.run', 'ai.context.run', 'ai.proposal.revision'
    )
    AND operation.status = 'running'
    AND operation.claim_token IS NOT NULL
    AND operation.claim_expires_at IS NOT NULL
    AND operation.claim_expires_at <= unixepoch()`;
  let results: D1Result[];
  try {
    results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id,
         actor_person_id, actor_id, action, entity_type, entity_id,
         correlation_id, metadata_json, created_at
       )
       SELECT 'assistant-interrupted-' || lower(hex(randomblob(16))),
              'agent', 'scheduled', 1, operation.organisation_id,
              operation.event_id, operation.requested_by_person_id,
              'program_cue_agent', 'assistant.interrupted', 'operation',
              operation.id, operation.id,
              json_object(
                'operationType', operation.type,
                'message', ?,
                'retrySafe', json('false'),
                'recoveryId', ?
              ), unixepoch()
         FROM operation_jobs operation
        WHERE ${eligible}`,
      ).bind(message, recoveryId),
      env.DB.prepare(
        `UPDATE operation_jobs AS operation
          SET status = 'failed', progress_completed = 0,
              progress_failed = progress_total, last_error = ?,
              result_json = ?, claim_token = NULL, claim_expires_at = NULL,
              completed_at = unixepoch(), updated_at = unixepoch()
        WHERE ${eligible}
          AND EXISTS (
            SELECT 1 FROM audit_events audit
             WHERE audit.correlation_id = operation.id
               AND audit.action = 'assistant.interrupted'
               AND json_extract(audit.metadata_json, '$.recoveryId') = ?
          )`,
      ).bind(message, resultJson, recoveryId),
      atomicBatchGuardStatement(
        env,
        `EXISTS (
         SELECT 1 FROM operation_jobs operation WHERE ${eligible}
       ) OR EXISTS (
         SELECT 1 FROM audit_events audit
         LEFT JOIN operation_jobs operation
           ON operation.id = audit.correlation_id
        WHERE audit.action = 'assistant.interrupted'
          AND json_extract(audit.metadata_json, '$.recoveryId') = ?
          AND (
            operation.id IS NULL
            OR operation.status <> 'failed'
            OR json_extract(operation.result_json, '$.recoveryId') IS NOT ?
          )
       )`,
        [recoveryId, recoveryId],
      ),
    ]);
  } catch (error) {
    if (isAtomicBatchGuardError(error)) {
      throw new Error(
        "Interrupted AI operations could not record complete recovery evidence.",
        { cause: error },
      );
    }
    throw error;
  }
  const [audited, failed] = results;
  if (!audited || !failed) {
    throw new Error(
      "Interrupted AI operations returned incomplete recovery results.",
    );
  }
  const auditedCount = audited.meta.changes ?? 0;
  const failedCount = failed.meta.changes ?? 0;
  if (auditedCount !== failedCount) {
    throw new Error(
      "Interrupted AI operations could not record complete recovery evidence.",
    );
  }
  return failedCount;
}

async function settleAiOperationLease(
  env: CloudflareEnvironment,
  viewer: Viewer,
  lease: AiOperationLease,
  input: {
    status: "completed" | "failed" | "cancelled";
    result: Record<string, unknown>;
    lastError: string | null;
    audit: AiOperationAudit;
    mutation?: AiOperationAtomicMutation;
  },
) {
  const resultJson = JSON.stringify(input.result);
  const auditId = crypto.randomUUID();
  const progressColumn =
    input.status === "completed"
      ? "progress_completed = 1, progress_failed = 0"
      : input.status === "failed"
        ? "progress_completed = 0, progress_failed = 1"
        : "progress_completed = 0, progress_failed = 0";
  const mutation = input.mutation;
  const statements = [
    ...(mutation?.statements ?? []),
    env.DB.prepare(
      `UPDATE operation_jobs
          SET status = ?, result_json = ?, ${progressColumn}, last_error = ?,
              claim_token = NULL, claim_expires_at = NULL,
              completed_at = unixepoch(), updated_at = unixepoch()
        WHERE id = ? AND type = ? AND status = 'running'
          AND organisation_id = ? AND event_id = ?
          AND requested_by_person_id = ?
          AND claim_token = ? AND claim_expires_at > unixepoch()`,
    ).bind(
      input.status,
      resultJson,
      input.lastError,
      lease.id,
      lease.type,
      viewer.organisationId,
      viewer.eventId,
      viewer.personId,
      lease.claimToken,
    ),
    operationAuditStatement(
      env,
      viewer,
      lease,
      auditId,
      input.audit,
      input.status,
      resultJson,
    ),
    atomicBatchGuardStatement(
      env,
      `NOT EXISTS (
         SELECT 1 FROM operation_jobs operation
          WHERE operation.id = ? AND operation.type = ?
            AND operation.status = ? AND operation.result_json = ?
       ) OR NOT EXISTS (
         SELECT 1 FROM audit_events audit WHERE audit.id = ?
       )${mutation ? ` OR (${mutation.failurePredicateSql})` : ""}`,
      [
        lease.id,
        lease.type,
        input.status,
        resultJson,
        auditId,
        ...(mutation?.bindings ?? []),
      ],
    ),
  ];
  try {
    await env.DB.batch(statements);
  } catch (error) {
    try {
      if (
        await operationAndAuditSettled(
          env,
          lease,
          input.status,
          resultJson,
          auditId,
        )
      ) {
        return;
      }
    } catch (recoveryError) {
      throw new AiOperationSettlementIndeterminateError(
        lease.id,
        new AggregateError([error, recoveryError]),
      );
    }
    if (isAtomicBatchGuardError(error)) {
      if (mutation && (await operationLeaseIsLive(env, viewer, lease))) {
        const conflict = await aiOperationMutationConflict(env, mutation);
        if (conflict) throw conflict;
      }
      throw new Error(
        `AI operation ${lease.id} could not atomically settle as ${input.status}.`,
        { cause: error },
      );
    }
    throw error;
  }
}

export function completeAiOperationLease(
  env: CloudflareEnvironment,
  viewer: Viewer,
  lease: AiOperationLease,
  result: Record<string, unknown>,
  audit: AiOperationAudit,
  mutation?: AiOperationAtomicMutation,
) {
  return settleAiOperationLease(env, viewer, lease, {
    status: "completed",
    result,
    lastError: null,
    audit,
    mutation,
  });
}

export function failAiOperationLease(
  env: CloudflareEnvironment,
  viewer: Viewer,
  lease: AiOperationLease,
  error: SafeAiErrorMetadata,
  audit: AiOperationAudit,
) {
  return settleAiOperationLease(env, viewer, lease, {
    status: "failed",
    result: { phase: "failed", ...error },
    lastError: error.message,
    audit,
  });
}

export function cancelAiOperationLease(
  env: CloudflareEnvironment,
  viewer: Viewer,
  lease: AiOperationLease,
  reason: SafeAiErrorMetadata,
  audit: AiOperationAudit,
) {
  return settleAiOperationLease(env, viewer, lease, {
    status: "cancelled",
    result: { phase: "cancelled", ...reason },
    lastError: null,
    audit,
  });
}
