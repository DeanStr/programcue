export function apiKeyLifecycleState(
  key: { expiresAt: number | null; revokedAt: number | null },
  nowEpoch: number,
): "active" | "expired" | "revoked" {
  if (key.revokedAt !== null) return "revoked";
  if (key.expiresAt !== null && key.expiresAt <= nowEpoch) return "expired";
  return "active";
}
