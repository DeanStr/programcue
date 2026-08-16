const ATOMIC_BATCH_GUARD_MARKER = "program cue atomic batch invariant failed";

/**
 * D1 rolls a batch back only when a statement fails. This deliberately invokes
 * SQLite's JSON validator with invalid JSON when a required postcondition is
 * absent, turning a zero-row conditional mutation into an atomic batch failure.
 */
export function atomicBatchGuardStatement(
  env: CloudflareEnvironment,
  failurePredicateSql: string,
  bindings: Array<string | number | null>,
) {
  return env.DB.prepare(
    `SELECT json('${ATOMIC_BATCH_GUARD_MARKER}')
       WHERE ${failurePredicateSql}`,
  ).bind(...bindings);
}

export function isAtomicBatchGuardError(error: unknown) {
  return error instanceof Error && /malformed JSON/u.test(error.message);
}
