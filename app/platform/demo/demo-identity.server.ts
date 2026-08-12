import {
  DEMO_EVENT_ID,
  DEMO_IDENTITIES,
  type DemoIdentityKey,
} from "./demo-identities";

export async function resolveDemoIdentityState(
  env: CloudflareEnvironment,
  identityKey: DemoIdentityKey,
) {
  const identity = DEMO_IDENTITIES[identityKey];
  if (identityKey !== "sbek_reviewer" && identityKey !== "sbek_speaker") {
    return { destination: identity.destination, role: identity.role };
  }

  const activatedRole =
    identityKey === "sbek_reviewer" ? "evaluator" : "speaker";
  const activeMembership = await env.DB.prepare(
    `SELECT 1 FROM memberships
      WHERE event_id = ? AND person_id = ? AND role = ?
        AND accepted_at IS NOT NULL AND revoked_at IS NULL
      LIMIT 1`,
  )
    .bind(DEMO_EVENT_ID, identity.personId, activatedRole)
    .first();
  if (!activeMembership) {
    return { destination: identity.destination, role: identity.role };
  }
  return {
    destination:
      identityKey === "sbek_reviewer"
        ? "/review/workbench"
        : "/participant/dashboard",
    role: activatedRole,
  };
}
