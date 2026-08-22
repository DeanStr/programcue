import {
  atomicBatchGuardStatement,
  isAtomicBatchGuardError,
} from "~/platform/database/atomic-batch-guard.server";
import {
  DEMO_EVENT_ID,
  DEMO_ORGANISATION_ID,
} from "~/platform/demo/demo-identities";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

export const EVALUATION_FIXTURE_RESET_OPERATION_ID =
  "operation-production-evaluation-fixture-reset";
export const EVALUATION_FIXTURE_RESET_OPERATION_TYPE =
  "evaluation.fixture.reset";
export const EVALUATION_FIXTURE_RESET_ACTOR_ID =
  "production-evaluation-fixture-operator";
export const EVALUATION_FIXTURE_RESET_ACCESS_ACTOR_ID =
  "production-evaluation-access";
const EVALUATION_FIXTURE_RESET_RECONCILER_ACTOR_ID =
  "production-evaluation-fixture-reconciler";
const EVALUATION_FIXTURE_RESET_OPERATION_KEY =
  "production-evaluation-fixture-reset";
const EVALUATION_FIXTURE_RESET_LEASE_SECONDS = 30 * 60;

// Use this predicate inside the same D1 statement that starts fixture-scoped
// work. It deliberately mirrors currentEvaluationFixtureGeneration(),
// including a cancelled pre-destructive reset that restored the last verified
// generation. The consuming query must alias the singleton operation row as
// `fixture_reset` and bind the expected fixture generation to the one placeholder.
export const EVALUATION_FIXTURE_GENERATION_FENCE_PREDICATE = `
  fixture_reset.id = '${EVALUATION_FIXTURE_RESET_OPERATION_ID}'
  AND fixture_reset.type = '${EVALUATION_FIXTURE_RESET_OPERATION_TYPE}'
  AND fixture_reset.claim_token IS NULL
  AND fixture_reset.claim_expires_at IS NULL
  AND json_extract(fixture_reset.result_json, '$.fixtureGeneration') = ?
  AND EXISTS (
    SELECT 1 FROM audit_events completed_reset
     WHERE completed_reset.id =
           json_extract(fixture_reset.result_json, '$.fixtureGeneration')
       AND completed_reset.organisation_id = '${DEMO_ORGANISATION_ID}'
       AND completed_reset.event_id = '${DEMO_EVENT_ID}'
       AND completed_reset.action = 'evaluation.fixture.reset'
       AND completed_reset.entity_type = 'event'
       AND completed_reset.entity_id = '${DEMO_EVENT_ID}'
       AND json_extract(completed_reset.metadata_json, '$.status') = 'completed'
       AND json_extract(completed_reset.metadata_json, '$.attemptId') =
           json_extract(fixture_reset.result_json, '$.attemptId')
  )
  AND (
    (
      fixture_reset.status = 'completed'
      AND json_extract(fixture_reset.payload_json, '$.attemptId') =
          json_extract(fixture_reset.result_json, '$.attemptId')
    )
    OR (
      fixture_reset.status = 'cancelled'
      AND json_extract(fixture_reset.payload_json, '$.destructiveStarted') = 0
      AND EXISTS (
        SELECT 1 FROM audit_events cancelled_reset
         WHERE cancelled_reset.id =
               'evaluation-fixture-reset-terminal:' ||
               json_extract(fixture_reset.payload_json, '$.attemptId')
           AND cancelled_reset.organisation_id = '${DEMO_ORGANISATION_ID}'
           AND cancelled_reset.event_id = '${DEMO_EVENT_ID}'
           AND cancelled_reset.action = 'evaluation.fixture.reset.cancelled'
           AND cancelled_reset.entity_type = 'event'
           AND cancelled_reset.entity_id = '${DEMO_EVENT_ID}'
           AND json_extract(cancelled_reset.metadata_json, '$.status') = 'cancelled'
           AND json_extract(cancelled_reset.metadata_json, '$.destructiveStarted') = 0
           AND json_extract(cancelled_reset.metadata_json, '$.attemptId') =
               json_extract(fixture_reset.payload_json, '$.attemptId')
           AND json_extract(cancelled_reset.metadata_json, '$.restoredFixtureGeneration') =
               json_extract(fixture_reset.result_json, '$.fixtureGeneration')
           AND json_extract(cancelled_reset.metadata_json, '$.restoredAttemptId') =
               json_extract(fixture_reset.result_json, '$.attemptId')
      )
    )
  )`;

export function shouldFenceEvaluationFixtureMutation(
  env: CloudflareEnvironment,
  organisationId: string,
) {
  return (
    requireRuntimeMode(env).evaluation &&
    organisationId === DEMO_ORGANISATION_ID
  );
}

export async function evaluationFixtureResetIsRunning(
  env: CloudflareEnvironment,
  organisationId: string,
) {
  if (!shouldFenceEvaluationFixtureMutation(env, organisationId)) return false;
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

async function reconcileExpiredEvaluationFixtureReset(
  env: CloudflareEnvironment,
) {
  const state = await env.DB.prepare(
    `SELECT claim_token AS claimToken,
            json_extract(payload_json, '$.attemptId') AS attemptId,
            json_extract(payload_json, '$.actorId') AS actorId
       FROM operation_jobs
      WHERE id = ? AND type = ? AND status = 'running'
        AND claim_token IS NOT NULL
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at <= unixepoch()`,
  )
    .bind(
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
    )
    .first<{
      claimToken: string;
      attemptId: string | null;
      actorId: string | null;
    }>();
  if (!state) return;

  const terminalId = `evaluation-fixture-reset-terminal:${state.claimToken}`;
  const actorId =
    state.actorId === EVALUATION_FIXTURE_RESET_ACTOR_ID ||
    state.actorId === EVALUATION_FIXTURE_RESET_ACCESS_ACTOR_ID
      ? state.actorId
      : EVALUATION_FIXTURE_RESET_RECONCILER_ACTOR_ID;
  const [audit, operation] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id,
         actor_id, action, entity_type, entity_id, metadata_json, created_at
       )
       SELECT ?, 'system', 'internal', 1, ?, ?, ?,
              CASE
                WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                  AND claim_token = json_extract(payload_json, '$.attemptId')
                THEN 'evaluation.fixture.reset.cancelled'
                ELSE 'evaluation.fixture.reset.failed'
              END,
              'event', ?,
              json_object(
                'status', CASE
                  WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                    AND claim_token = json_extract(payload_json, '$.attemptId')
                  THEN 'cancelled'
                  ELSE 'failed'
                END,
                'attemptId', json_extract(payload_json, '$.attemptId'),
                'destructiveStarted', CASE
                  WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                  THEN json('false')
                  WHEN json_extract(payload_json, '$.destructiveStarted') = 1
                  THEN json('true')
                  ELSE NULL
                END,
                'restoredFixtureGeneration',
                  CASE
                    WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                      AND claim_token = json_extract(payload_json, '$.attemptId')
                    THEN json_extract(result_json, '$.fixtureGeneration')
                    ELSE NULL
                  END,
                'restoredAttemptId',
                  CASE
                    WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                      AND claim_token = json_extract(payload_json, '$.attemptId')
                    THEN json_extract(result_json, '$.attemptId')
                    ELSE NULL
                  END,
                'errorName', 'EvaluationFixtureResetLeaseExpired'
              ),
              unixepoch()
         FROM operation_jobs
        WHERE id = ? AND type = ? AND status = 'running'
          AND claim_token = ?
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at <= unixepoch()
          AND json_extract(payload_json, '$.attemptId') IS ?`,
    ).bind(
      terminalId,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      actorId,
      DEMO_EVENT_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      state.claimToken,
      state.attemptId,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
          SET status = CASE
                WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                  AND claim_token = json_extract(payload_json, '$.attemptId')
                THEN 'cancelled'
                ELSE 'failed'
              END,
              progress_failed = CASE
                WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                  AND claim_token = json_extract(payload_json, '$.attemptId')
                THEN 0
                ELSE 1
              END,
              last_error = 'The evaluation fixture reset lease expired.',
              claim_token = NULL,
              claim_expires_at = NULL,
              completed_at = unixepoch(),
              updated_at = unixepoch()
        WHERE id = ? AND type = ? AND status = 'running'
          AND claim_token = ?
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at <= unixepoch()
          AND json_extract(payload_json, '$.attemptId') IS ?`,
    ).bind(
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      state.claimToken,
      state.attemptId,
    ),
  ]);
  const auditChanges = audit.meta.changes ?? 0;
  const operationChanges = operation.meta.changes ?? 0;
  if (auditChanges === 0 && operationChanges === 0) return;
  if (auditChanges !== 1 || operationChanges !== 1) {
    throw new Error(
      "The expired production evaluation fixture reset could not be reconciled.",
    );
  }
}

export async function acquireEvaluationFixtureReset(
  env: CloudflareEnvironment,
  ownerToken: string,
  expectedFixtureGeneration?: string,
  actorId:
    | typeof EVALUATION_FIXTURE_RESET_ACTOR_ID
    | typeof EVALUATION_FIXTURE_RESET_ACCESS_ACTOR_ID = EVALUATION_FIXTURE_RESET_ACTOR_ID,
) {
  await reconcileExpiredEvaluationFixtureReset(env);
  const initialPayload = JSON.stringify({
    attemptId: ownerToken,
    actorId,
    destructiveStarted: false,
  });
  // This singleton also publishes the last completed fixture generation.
  // Keep that verified result while an attempt is only claimed; the explicit
  // destructive transition clears it before any mutable cleanup can begin.
  const acquired = await env.DB.prepare(
    `INSERT INTO operation_jobs (
       id, type, idempotency_key, correlation_id, status, payload_json,
       progress_total, attempt_count, cancellable, claim_token,
       claim_expires_at, started_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'running', ?, 1, 1, 0, ?,
               unixepoch() + ?, unixepoch(), unixepoch(), unixepoch())
     ON CONFLICT(id) DO UPDATE SET
       status = 'running',
       payload_json = excluded.payload_json,
       result_json = CASE
         WHEN (
           (operation_jobs.status = 'completed'
             AND operation_jobs.claim_token IS NULL
             AND operation_jobs.claim_expires_at IS NULL
             AND json_extract(operation_jobs.payload_json, '$.attemptId') =
                 json_extract(operation_jobs.result_json, '$.attemptId'))
           OR
           (operation_jobs.status = 'cancelled'
             AND operation_jobs.claim_token IS NULL
             AND operation_jobs.claim_expires_at IS NULL
             AND json_extract(operation_jobs.payload_json, '$.destructiveStarted') = 0)
         )
         AND EXISTS (
           SELECT 1 FROM audit_events completed_reset
            WHERE completed_reset.id =
                  json_extract(operation_jobs.result_json, '$.fixtureGeneration')
              AND completed_reset.organisation_id = ?
              AND completed_reset.event_id = ?
              AND completed_reset.action = 'evaluation.fixture.reset'
              AND completed_reset.entity_type = 'event'
              AND completed_reset.entity_id = ?
              AND json_extract(completed_reset.metadata_json, '$.status') = 'completed'
              AND json_extract(completed_reset.metadata_json, '$.attemptId') =
                  json_extract(operation_jobs.result_json, '$.attemptId')
         )
         AND (
           operation_jobs.status <> 'cancelled'
           OR EXISTS (
             SELECT 1 FROM audit_events cancelled_reset
              WHERE cancelled_reset.id =
                    'evaluation-fixture-reset-terminal:' ||
                    json_extract(operation_jobs.payload_json, '$.attemptId')
                AND cancelled_reset.organisation_id = ?
                AND cancelled_reset.event_id = ?
                AND cancelled_reset.action = 'evaluation.fixture.reset.cancelled'
                AND cancelled_reset.entity_type = 'event'
                AND cancelled_reset.entity_id = ?
                AND json_extract(cancelled_reset.metadata_json, '$.status') = 'cancelled'
                AND json_extract(cancelled_reset.metadata_json, '$.destructiveStarted') = 0
                AND json_extract(cancelled_reset.metadata_json, '$.attemptId') =
                    json_extract(operation_jobs.payload_json, '$.attemptId')
                AND json_extract(cancelled_reset.metadata_json, '$.restoredFixtureGeneration') =
                    json_extract(operation_jobs.result_json, '$.fixtureGeneration')
                AND json_extract(cancelled_reset.metadata_json, '$.restoredAttemptId') =
                    json_extract(operation_jobs.result_json, '$.attemptId')
           )
         )
         THEN operation_jobs.result_json
         ELSE NULL
       END,
       progress_total = 1,
       progress_completed = 0,
       progress_failed = 0,
       attempt_count = operation_jobs.attempt_count + 1,
       last_error = NULL,
       cancellable = 0,
       claim_token = excluded.claim_token,
       claim_expires_at = excluded.claim_expires_at,
       dispatched_at = NULL,
       started_at = unixepoch(),
       completed_at = NULL,
       updated_at = unixepoch()
     WHERE operation_jobs.type = excluded.type
       AND (? IS NULL OR (
         json_extract(operation_jobs.result_json, '$.fixtureGeneration') = ?
         AND (
           (operation_jobs.status = 'completed'
             AND operation_jobs.claim_token IS NULL
             AND operation_jobs.claim_expires_at IS NULL
             AND json_extract(operation_jobs.payload_json, '$.attemptId') =
                 json_extract(operation_jobs.result_json, '$.attemptId'))
           OR
           (operation_jobs.status = 'cancelled'
             AND operation_jobs.claim_token IS NULL
             AND operation_jobs.claim_expires_at IS NULL
             AND json_extract(operation_jobs.payload_json, '$.destructiveStarted') = 0)
         )
         AND EXISTS (
           SELECT 1 FROM audit_events completed_reset
            WHERE completed_reset.id =
                  json_extract(operation_jobs.result_json, '$.fixtureGeneration')
              AND completed_reset.organisation_id = ?
              AND completed_reset.event_id = ?
              AND completed_reset.action = 'evaluation.fixture.reset'
              AND completed_reset.entity_type = 'event'
              AND completed_reset.entity_id = ?
              AND json_extract(completed_reset.metadata_json, '$.status') = 'completed'
              AND json_extract(completed_reset.metadata_json, '$.attemptId') =
                  json_extract(operation_jobs.result_json, '$.attemptId')
         )
         AND (
           operation_jobs.status <> 'cancelled'
           OR EXISTS (
             SELECT 1 FROM audit_events cancelled_reset
              WHERE cancelled_reset.id =
                    'evaluation-fixture-reset-terminal:' ||
                    json_extract(operation_jobs.payload_json, '$.attemptId')
                AND cancelled_reset.organisation_id = ?
                AND cancelled_reset.event_id = ?
                AND cancelled_reset.action = 'evaluation.fixture.reset.cancelled'
                AND cancelled_reset.entity_type = 'event'
                AND cancelled_reset.entity_id = ?
                AND json_extract(cancelled_reset.metadata_json, '$.status') = 'cancelled'
                AND json_extract(cancelled_reset.metadata_json, '$.destructiveStarted') = 0
                AND json_extract(cancelled_reset.metadata_json, '$.attemptId') =
                    json_extract(operation_jobs.payload_json, '$.attemptId')
                AND json_extract(cancelled_reset.metadata_json, '$.restoredFixtureGeneration') =
                    json_extract(operation_jobs.result_json, '$.fixtureGeneration')
                AND json_extract(cancelled_reset.metadata_json, '$.restoredAttemptId') =
                    json_extract(operation_jobs.result_json, '$.attemptId')
           )
         )
       ))
       AND (
         (operation_jobs.status IN ('completed', 'failed', 'cancelled')
           AND operation_jobs.claim_token IS NULL
           AND operation_jobs.claim_expires_at IS NULL)
       )`,
  )
    .bind(
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      EVALUATION_FIXTURE_RESET_OPERATION_KEY,
      EVALUATION_FIXTURE_RESET_OPERATION_KEY,
      initialPayload,
      ownerToken,
      EVALUATION_FIXTURE_RESET_LEASE_SECONDS,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      expectedFixtureGeneration ?? null,
      expectedFixtureGeneration ?? null,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
    )
    .run();
  if ((acquired.meta.changes ?? 0) === 1) return;

  const existing = await env.DB.prepare(
    `SELECT type, status, claim_token AS claimToken,
            json_extract(result_json, '$.fixtureGeneration') AS fixtureGeneration
       FROM operation_jobs WHERE id = ?`,
  )
    .bind(EVALUATION_FIXTURE_RESET_OPERATION_ID)
    .first<{
      type: string;
      status: string;
      claimToken: string | null;
      fixtureGeneration: string | null;
    }>();
  if (
    existing?.type === EVALUATION_FIXTURE_RESET_OPERATION_TYPE &&
    existing.status === "running" &&
    existing.claimToken
  ) {
    throw new Error(
      "A production evaluation fixture reset is already in progress.",
    );
  }
  if (
    expectedFixtureGeneration &&
    existing?.type === EVALUATION_FIXTURE_RESET_OPERATION_TYPE &&
    existing.fixtureGeneration !== expectedFixtureGeneration
  ) {
    throw new Error(
      "Evaluation access expired because another fixture reset completed. Enter the access code again.",
    );
  }
  throw new Error(
    "The production evaluation fixture reset lock is in an invalid state.",
  );
}

export async function beginEvaluationFixtureResetDestructiveWork(
  env: CloudflareEnvironment,
  ownerToken: string,
) {
  const resetOwnsDestructivePhase = `EXISTS (
    SELECT 1 FROM operation_jobs fixture_reset
     WHERE fixture_reset.id = ? AND fixture_reset.type = ?
       AND fixture_reset.status = 'running'
       AND fixture_reset.claim_token = ?
       AND fixture_reset.claim_expires_at IS NOT NULL
       AND fixture_reset.claim_expires_at > unixepoch()
       AND json_extract(fixture_reset.payload_json, '$.attemptId') = ?
       AND json_extract(fixture_reset.payload_json, '$.destructiveStarted') = 1
  )`;
  try {
    const [started] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE operation_jobs
            SET payload_json = json_set(
                  payload_json,
                  '$.destructiveStarted',
                  json('true')
                ),
                result_json = NULL,
                updated_at = unixepoch()
          WHERE id = ? AND type = ? AND status = 'running'
            AND claim_token = ?
            AND claim_expires_at IS NOT NULL
            AND claim_expires_at > unixepoch()
            AND json_extract(payload_json, '$.attemptId') = ?
            AND json_extract(payload_json, '$.destructiveStarted') = 0`,
      ).bind(
        EVALUATION_FIXTURE_RESET_OPERATION_ID,
        EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
        ownerToken,
        ownerToken,
      ),
      env.DB.prepare(
        `UPDATE operation_jobs
            SET status = 'cancelled', cancellable = 0,
                last_error = 'The uncommitted preview was cancelled by the evaluation fixture reset.',
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE organisation_id = ? AND status = 'received' AND cancellable = 1
            AND type IN ('task.bulk','session.bulk','data.import')
            AND event_id IN (
              SELECT id FROM events WHERE organisation_id = ?
            )
            AND ${resetOwnsDestructivePhase}`,
      ).bind(
        DEMO_ORGANISATION_ID,
        DEMO_ORGANISATION_ID,
        EVALUATION_FIXTURE_RESET_OPERATION_ID,
        EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
        ownerToken,
        ownerToken,
      ),
      env.DB.prepare(
        `UPDATE operation_items
            SET status = 'skipped', error_code = 'FIXTURE_RESET',
                error_message = 'The preview was cancelled before the evaluation fixture reset.',
                completed_at = unixepoch(), updated_at = unixepoch()
          WHERE status = 'pending'
            AND operation_id IN (
              SELECT id FROM operation_jobs
               WHERE organisation_id = ? AND status = 'cancelled'
                 AND last_error = 'The uncommitted preview was cancelled by the evaluation fixture reset.'
            )
            AND ${resetOwnsDestructivePhase}`,
      ).bind(
        DEMO_ORGANISATION_ID,
        EVALUATION_FIXTURE_RESET_OPERATION_ID,
        EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
        ownerToken,
        ownerToken,
      ),
      atomicBatchGuardStatement(env, `NOT ${resetOwnsDestructivePhase}`, [
        EVALUATION_FIXTURE_RESET_OPERATION_ID,
        EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
        ownerToken,
        ownerToken,
      ]),
    ]);
    if ((started.meta.changes ?? 0) === 1) return;
  } catch (error) {
    if (!isAtomicBatchGuardError(error)) throw error;
  }
  throw new Error(
    "The production evaluation fixture reset could not enter its destructive phase.",
  );
}

export async function assertEvaluationFixtureResetOwner(
  env: CloudflareEnvironment,
  ownerToken: string,
) {
  const owned = await env.DB.prepare(
    `UPDATE operation_jobs
        SET claim_expires_at = unixepoch() + ?, updated_at = unixepoch()
      WHERE id = ? AND type = ? AND status = 'running'
        AND claim_token = ?
        AND claim_expires_at IS NOT NULL
        AND claim_expires_at > unixepoch()
        AND json_extract(payload_json, '$.attemptId') = ?`,
  )
    .bind(
      EVALUATION_FIXTURE_RESET_LEASE_SECONDS,
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      ownerToken,
      ownerToken,
    )
    .run();
  if ((owned.meta.changes ?? 0) !== 1) {
    throw new Error(
      "The production evaluation fixture reset lost its ownership claim.",
    );
  }
}

export async function markEvaluationFixtureResetFailed(
  env: CloudflareEnvironment,
  ownerToken: string,
  error: unknown,
  actorId = EVALUATION_FIXTURE_RESET_ACTOR_ID,
) {
  const message = error instanceof Error ? error.message : "Reset failed.";
  const errorName = error instanceof Error ? error.name : "UnknownError";
  const [audit, operation] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id,
         actor_id, action, entity_type, entity_id, metadata_json, created_at
       )
       SELECT ?, 'system', 'internal', 1, ?, ?, ?,
              CASE
                WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                THEN 'evaluation.fixture.reset.cancelled'
                ELSE 'evaluation.fixture.reset.failed'
              END,
              'event', ?,
              json_object(
                'status', CASE
                  WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                  THEN 'cancelled'
                  ELSE 'failed'
                END,
                'attemptId', ?,
                'destructiveStarted',
                  CASE
                    WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                    THEN json('false')
                    WHEN json_extract(payload_json, '$.destructiveStarted') = 1
                    THEN json('true')
                    ELSE NULL
                  END,
                'restoredFixtureGeneration',
                  CASE
                    WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                    THEN json_extract(result_json, '$.fixtureGeneration')
                    ELSE NULL
                  END,
                'restoredAttemptId',
                  CASE
                    WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                    THEN json_extract(result_json, '$.attemptId')
                    ELSE NULL
                  END,
                'errorName', ?
              ),
              unixepoch()
         FROM operation_jobs
        WHERE id = ? AND type = ? AND status = 'running'
          AND claim_token = ?
          AND json_extract(payload_json, '$.attemptId') = ?`,
    ).bind(
      `evaluation-fixture-reset-terminal:${ownerToken}`,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      actorId,
      DEMO_EVENT_ID,
      ownerToken,
      errorName,
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      ownerToken,
      ownerToken,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
          SET status = CASE
                WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                THEN 'cancelled'
                ELSE 'failed'
              END,
              progress_failed = CASE
                WHEN json_extract(payload_json, '$.destructiveStarted') = 0
                THEN 0
                ELSE 1
              END,
              last_error = ?,
              claim_token = NULL,
              claim_expires_at = NULL,
              completed_at = unixepoch(),
              updated_at = unixepoch()
        WHERE id = ? AND type = ? AND status = 'running'
          AND claim_token = ?
          AND json_extract(payload_json, '$.attemptId') = ?`,
    ).bind(
      message,
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      ownerToken,
      ownerToken,
    ),
  ]);
  if ((audit.meta.changes ?? 0) !== 1 || (operation.meta.changes ?? 0) !== 1) {
    throw new Error(
      "The failed production evaluation fixture reset no longer owns its claim.",
    );
  }
}

export async function completeEvaluationFixtureReset(
  env: CloudflareEnvironment,
  ownerToken: string,
  fixtureGeneration: string,
  metadata: Record<string, unknown>,
  actorId = EVALUATION_FIXTURE_RESET_ACTOR_ID,
) {
  const completionMetadata = {
    ...metadata,
    status: "completed",
    attemptId: ownerToken,
  };
  const [audit, operation] = await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO audit_events (
         id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_id, action,
         entity_type, entity_id, metadata_json, created_at
       )
       SELECT ?, 'system', 'internal', 1, ?, ?, ?,
              'evaluation.fixture.reset', 'event', ?, ?, unixepoch()
         FROM operation_jobs
        WHERE id = ? AND type = ? AND status = 'running'
          AND claim_token = ?
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at > unixepoch()
          AND json_extract(payload_json, '$.destructiveStarted') = 1
          AND json_extract(payload_json, '$.attemptId') = ?`,
    ).bind(
      fixtureGeneration,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      actorId,
      DEMO_EVENT_ID,
      JSON.stringify(completionMetadata),
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      ownerToken,
      ownerToken,
    ),
    env.DB.prepare(
      `UPDATE operation_jobs
          SET status = 'completed',
              result_json = ?,
              progress_completed = 1,
              claim_token = NULL,
              claim_expires_at = NULL,
              completed_at = unixepoch(),
              updated_at = unixepoch()
        WHERE id = ? AND type = ? AND status = 'running'
          AND claim_token = ?
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at > unixepoch()
          AND json_extract(payload_json, '$.destructiveStarted') = 1
          AND json_extract(payload_json, '$.attemptId') = ?`,
    ).bind(
      JSON.stringify({ attemptId: ownerToken, fixtureGeneration }),
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      ownerToken,
      ownerToken,
    ),
  ]);
  if ((audit.meta.changes ?? 0) !== 1 || (operation.meta.changes ?? 0) !== 1) {
    throw new Error(
      "The production evaluation fixture completion lost its ownership claim.",
    );
  }
}

export async function currentEvaluationFixtureGeneration(
  env: CloudflareEnvironment,
) {
  await reconcileExpiredEvaluationFixtureReset(env);
  const state = await env.DB.prepare(
    `WITH reset_state AS (
       SELECT id, type, status, claim_token,
              json_extract(payload_json, '$.attemptId') AS stateAttemptId,
              CASE
                WHEN type = ? AND status = 'completed'
                  AND claim_token IS NULL
                  AND claim_expires_at IS NULL
                  AND json_extract(payload_json, '$.attemptId') =
                      json_extract(result_json, '$.attemptId')
                THEN json_extract(result_json, '$.fixtureGeneration')
                WHEN type = ?
                  AND json_extract(payload_json, '$.destructiveStarted') = 0
                  AND status = 'cancelled' AND claim_token IS NULL
                  AND claim_expires_at IS NULL
                THEN json_extract(result_json, '$.fixtureGeneration')
                ELSE NULL
              END AS fixtureGeneration,
              CASE
                WHEN type = ? AND status = 'completed'
                  AND claim_token IS NULL
                  AND claim_expires_at IS NULL
                  AND json_extract(payload_json, '$.attemptId') =
                      json_extract(result_json, '$.attemptId')
                THEN json_extract(result_json, '$.attemptId')
                WHEN type = ?
                  AND json_extract(payload_json, '$.destructiveStarted') = 0
                  AND status = 'cancelled' AND claim_token IS NULL
                  AND claim_expires_at IS NULL
                THEN json_extract(result_json, '$.attemptId')
                ELSE NULL
              END AS attemptId
         FROM operation_jobs
        WHERE id = ?
     )
     SELECT
       CASE
         WHEN reset_lock.id IS NULL THEN legacy_reset.id
         WHEN reset_lock.fixtureGeneration IS NOT NULL
          AND completed_reset.id IS NOT NULL
          AND reset_lock.attemptId =
              json_extract(completed_reset.metadata_json, '$.attemptId')
          AND (
            reset_lock.status = 'completed'
            OR (reset_lock.status = 'cancelled'
              AND cancelled_reset.id IS NOT NULL)
          )
         THEN completed_reset.id
         ELSE NULL
       END AS fixtureGeneration,
       CASE
         WHEN reset_lock.id IS NULL
         THEN legacy_reset.action = 'evaluation.fixture.reset'
         WHEN reset_lock.fixtureGeneration IS NOT NULL
          AND completed_reset.id IS NOT NULL
          AND reset_lock.attemptId =
              json_extract(completed_reset.metadata_json, '$.attemptId')
          AND (
            reset_lock.status = 'completed'
            OR (reset_lock.status = 'cancelled'
              AND cancelled_reset.id IS NOT NULL)
          )
         THEN 1
         ELSE 0
       END AS completed
     FROM (SELECT 1) anchor
     LEFT JOIN reset_state reset_lock ON TRUE
     LEFT JOIN audit_events completed_reset
       ON completed_reset.id = reset_lock.fixtureGeneration
      AND completed_reset.organisation_id = ?
      AND completed_reset.event_id = ?
      AND completed_reset.action = 'evaluation.fixture.reset'
      AND completed_reset.entity_type = 'event'
      AND completed_reset.entity_id = ?
      AND json_extract(completed_reset.metadata_json, '$.status') = 'completed'
     LEFT JOIN audit_events cancelled_reset
       ON reset_lock.status = 'cancelled'
      AND cancelled_reset.id =
          'evaluation-fixture-reset-terminal:' || reset_lock.stateAttemptId
      AND cancelled_reset.organisation_id = ?
      AND cancelled_reset.event_id = ?
      AND cancelled_reset.action = 'evaluation.fixture.reset.cancelled'
      AND cancelled_reset.entity_type = 'event'
      AND cancelled_reset.entity_id = ?
      AND json_extract(cancelled_reset.metadata_json, '$.status') = 'cancelled'
      AND json_extract(cancelled_reset.metadata_json, '$.attemptId') =
          reset_lock.stateAttemptId
      AND json_extract(cancelled_reset.metadata_json, '$.destructiveStarted') = 0
      AND json_extract(cancelled_reset.metadata_json, '$.restoredFixtureGeneration') =
          reset_lock.fixtureGeneration
      AND json_extract(cancelled_reset.metadata_json, '$.restoredAttemptId') =
          reset_lock.attemptId
     LEFT JOIN (
       SELECT id, action
         FROM audit_events
        WHERE organisation_id = ? AND event_id = ?
          AND action IN (
            'evaluation.fixture.reset.started',
            'evaluation.fixture.reset',
            'evaluation.fixture.reset.cancelled',
            'evaluation.fixture.reset.failed'
          )
          AND entity_type = 'event' AND entity_id = ?
        ORDER BY rowid DESC
        LIMIT 1
     ) legacy_reset ON reset_lock.id IS NULL`,
  )
    .bind(
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
      DEMO_ORGANISATION_ID,
      DEMO_EVENT_ID,
      DEMO_EVENT_ID,
    )
    .first<{ fixtureGeneration: string | null; completed: number }>();
  return state?.completed === 1 && state.fixtureGeneration
    ? state.fixtureGeneration
    : null;
}
