import { requireCurrentEventRole } from "./current-event.server";

export type OrganisationAdministrator = {
  personId: string;
  name: string;
  email: string;
  role: "owner" | "administrator";
  organisationId: string;
  currentEventId: string;
  demo: boolean;
};

/**
 * Organisation workspaces are selected through the current event, but access is
 * granted only by an active organisation-wide owner/administrator membership.
 */
export async function requireOrganisationAdministrator(
  request: Request,
  env: CloudflareEnvironment,
): Promise<OrganisationAdministrator> {
  const current = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const membership = await env.DB.prepare(
    `SELECT role
       FROM memberships
      WHERE organisation_id = ? AND event_id IS NULL AND person_id = ?
        AND role IN ('owner','administrator')
        AND accepted_at IS NOT NULL AND revoked_at IS NULL
      ORDER BY CASE role WHEN 'owner' THEN 0 ELSE 1 END
      LIMIT 1`,
  )
    .bind(current.organisationId, current.personId)
    .first<{ role: "owner" | "administrator" }>();
  if (!membership) {
    throw new Response(
      "Organisation-wide owner or administrator access is required for the speaker directory.",
      { status: 403, statusText: "Forbidden" },
    );
  }
  return {
    personId: current.personId,
    name: current.name,
    email: current.email,
    role: membership.role,
    organisationId: current.organisationId,
    currentEventId: current.eventId,
    demo: current.demo,
  };
}
