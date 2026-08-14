import {
  DEMO_EVENT_ID,
  DEMO_ORGANISATION_ID,
} from "~/platform/demo/demo-identities";

export const EVALUATION_FIXTURE_RESET_OPERATION_ID =
  "operation-production-evaluation-fixture-reset";
export const EVALUATION_FIXTURE_RESET_OPERATION_TYPE =
  "evaluation.fixture.reset";
export const EVALUATION_FIXTURE_RESET_ACTOR_ID =
  "production-evaluation-fixture-operator";
const EVALUATION_FIXTURE_RESET_OPERATION_KEY =
  "production-evaluation-fixture-reset";
const EVALUATION_FIXTURE_RESET_LEASE_SECONDS = 30 * 60;

export async function acquireEvaluationFixtureReset(
  env: CloudflareEnvironment,
  ownerToken: string,
  expectedFixtureGeneration?: string,
) {
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
       result_json = NULL,
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
         operation_jobs.status = 'completed'
         AND json_extract(operation_jobs.result_json, '$.fixtureGeneration') = ?
       ))
       AND (
         (operation_jobs.status IN ('completed', 'failed')
           AND operation_jobs.claim_token IS NULL)
         OR
         (operation_jobs.status = 'running'
           AND operation_jobs.claim_token IS NOT NULL
           AND operation_jobs.claim_expires_at IS NOT NULL
           AND operation_jobs.claim_expires_at <= unixepoch())
       )`,
  )
    .bind(
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      EVALUATION_FIXTURE_RESET_OPERATION_KEY,
      EVALUATION_FIXTURE_RESET_OPERATION_KEY,
      JSON.stringify({ attemptId: ownerToken }),
      ownerToken,
      EVALUATION_FIXTURE_RESET_LEASE_SECONDS,
      expectedFixtureGeneration ?? null,
      expectedFixtureGeneration ?? null,
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
) {
  const message = error instanceof Error ? error.message : "Reset failed.";
  const failed = await env.DB.prepare(
    `UPDATE operation_jobs
        SET status = 'failed', progress_failed = 1, last_error = ?,
            claim_token = NULL, claim_expires_at = NULL,
            completed_at = unixepoch(),
            updated_at = unixepoch()
      WHERE id = ? AND type = ? AND status = 'running'
        AND claim_token = ?
        AND json_extract(payload_json, '$.attemptId') = ?`,
  )
    .bind(
      message,
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      ownerToken,
      ownerToken,
    )
    .run();
  if ((failed.meta.changes ?? 0) !== 1) {
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
         id, organisation_id, event_id, actor_id, action,
         entity_type, entity_id, metadata_json, created_at
       )
       SELECT ?, ?, ?, ?,
              'evaluation.fixture.reset', 'event', ?, ?, unixepoch()
         FROM operation_jobs
        WHERE id = ? AND type = ? AND status = 'running'
          AND claim_token = ?
          AND claim_expires_at IS NOT NULL
          AND claim_expires_at > unixepoch()
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
  const state = await env.DB.prepare(
    `SELECT
       CASE
         WHEN reset_lock.id IS NULL THEN legacy_reset.id
         WHEN reset_lock.type = ?
          AND reset_lock.status = 'completed'
          AND reset_lock.claim_token IS NULL
          AND completed_reset.id IS NOT NULL
          AND json_extract(reset_lock.payload_json, '$.attemptId') =
              json_extract(reset_lock.result_json, '$.attemptId')
          AND json_extract(reset_lock.result_json, '$.attemptId') =
              json_extract(completed_reset.metadata_json, '$.attemptId')
         THEN completed_reset.id
         ELSE NULL
       END AS fixtureGeneration,
       CASE
         WHEN reset_lock.id IS NULL
         THEN legacy_reset.action = 'evaluation.fixture.reset'
         WHEN reset_lock.type = ?
          AND reset_lock.status = 'completed'
          AND reset_lock.claim_token IS NULL
          AND completed_reset.id IS NOT NULL
          AND json_extract(reset_lock.payload_json, '$.attemptId') =
              json_extract(reset_lock.result_json, '$.attemptId')
          AND json_extract(reset_lock.result_json, '$.attemptId') =
              json_extract(completed_reset.metadata_json, '$.attemptId')
         THEN 1
         ELSE 0
       END AS completed
     FROM (SELECT 1) anchor
     LEFT JOIN operation_jobs reset_lock ON reset_lock.id = ?
     LEFT JOIN audit_events completed_reset
       ON completed_reset.id =
          json_extract(reset_lock.result_json, '$.fixtureGeneration')
      AND completed_reset.organisation_id = ?
      AND completed_reset.event_id = ?
      AND completed_reset.action = 'evaluation.fixture.reset'
      AND completed_reset.entity_type = 'event'
      AND completed_reset.entity_id = ?
      AND json_extract(completed_reset.metadata_json, '$.status') = 'completed'
     LEFT JOIN (
       SELECT id, action
         FROM audit_events
        WHERE organisation_id = ? AND event_id = ?
          AND action IN (
            'evaluation.fixture.reset.started',
            'evaluation.fixture.reset'
          )
          AND entity_type = 'event' AND entity_id = ?
        ORDER BY rowid DESC
        LIMIT 1
     ) legacy_reset ON reset_lock.id IS NULL`,
  )
    .bind(
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      EVALUATION_FIXTURE_RESET_OPERATION_TYPE,
      EVALUATION_FIXTURE_RESET_OPERATION_ID,
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
