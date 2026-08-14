/**
 * A short, quotable form of an internal identifier.
 *
 * Full identifiers are UUIDs or prefixed keys. Printed in full they read as
 * noise and are impossible to say aloud or copy accurately; printed not at all,
 * support conversations lose their only handle on a specific record. The first
 * deterministic digest is short enough to read out while still including every
 * part of composite identifiers such as calendar UIDs.
 */
export function shortReference(identifier: string | null | undefined) {
  if (!identifier) return null;
  const trimmed = identifier.trim();
  if (!trimmed) return null;
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < trimmed.length; index += 1) {
    hash ^= BigInt(trimmed.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(16).padStart(16, "0").slice(0, 10).toUpperCase();
}
