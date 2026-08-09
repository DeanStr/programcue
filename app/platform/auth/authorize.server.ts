import { redirect } from "react-router";

import { createAuth } from "./auth.server";
import { DEMO_IDENTITIES, ensureDemoData, type DemoRole } from "~/platform/demo/seed.server";

export type ViewerRole = "owner" | "administrator" | "committee_chair" | "evaluator" | "submitter" | "speaker";

export type Viewer = {
  personId: string;
  name: string;
  email: string;
  role: ViewerRole;
  organisationId: string;
  eventId: string;
  demo: boolean;
};

function forbidden(message: string, status = 403): never {
  throw new Response(message, { status, statusText: status === 401 ? "Unauthorized" : "Forbidden" });
}

function signInLocation(request: Request) {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  return `/sign-in?${new URLSearchParams({ returnTo })}`;
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return decodeURIComponent(value.join("="));
  }
  return null;
}

export async function requireAuthenticatedPerson(
  request: Request,
  env: CloudflareEnvironment,
  unauthenticatedBehavior: "redirect" | "response" = "redirect",
) {
  await ensureDemoData(env);
  if (String(env.DEMO_MODE) === "true") {
    const requestedRole = cookieValue(request, "program_cue_demo_role");
    const role: DemoRole = requestedRole && requestedRole in DEMO_IDENTITIES
      ? requestedRole as DemoRole
      : "administrator";
    return { ...DEMO_IDENTITIES[role], demo: true, demoRole: role };
  }

  const session = await createAuth(env).api.getSession({ headers: request.headers });
  if (!session?.user) {
    if (unauthenticatedBehavior === "redirect") throw redirect(signInLocation(request));
    forbidden("Authentication is required", 401);
  }
  return {
    personId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    demo: false,
    demoRole: null,
  };
}

export async function requireEventRole(
  request: Request,
  env: CloudflareEnvironment,
  eventId: string,
  allowedRoles: ReadonlyArray<Viewer["role"]>,
  unauthenticatedBehavior: "redirect" | "response" = "redirect",
): Promise<Viewer> {
  const { personId, name, email, demo } = await requireAuthenticatedPerson(
    request,
    env,
    unauthenticatedBehavior,
  );

  if (allowedRoles.length === 0) forbidden("You do not have permission to manage this event");
  const rolePlaceholders = allowedRoles.map(() => "?").join(",");

  let membership = await env.DB.prepare(`
    SELECT m.id, m.organisation_id AS organisationId, m.event_id AS eventId, m.role
      FROM memberships m
      JOIN events e ON e.organisation_id = m.organisation_id
     WHERE e.id = ?
       AND m.person_id = ?
       AND (m.event_id = e.id OR (m.event_id IS NULL AND m.role = 'owner'))
       AND m.role IN (${rolePlaceholders})
       AND m.accepted_at IS NOT NULL
       AND m.revoked_at IS NULL
     ORDER BY CASE m.role
                WHEN 'owner' THEN 0
                WHEN 'administrator' THEN 1
                WHEN 'committee_chair' THEN 2
                WHEN 'evaluator' THEN 3
                WHEN 'speaker' THEN 4
                WHEN 'submitter' THEN 5
                ELSE 6
              END,
              CASE WHEN m.event_id = e.id THEN 0 ELSE 1 END
     LIMIT 1
  `).bind(eventId, personId, ...allowedRoles).first<{ id: string; organisationId: string; eventId: string | null; role: ViewerRole }>();

  if (!membership) {
    const invitation = await env.DB.prepare(`
      SELECT m.id, m.organisation_id AS organisationId, m.event_id AS eventId, m.role
        FROM memberships m
        JOIN events e ON e.organisation_id = m.organisation_id
       WHERE e.id = ?
         AND m.person_id = ?
         AND (m.event_id = e.id OR (m.event_id IS NULL AND m.role = 'owner'))
         AND m.role IN (${rolePlaceholders})
         AND m.accepted_at IS NULL
         AND m.invited_at IS NOT NULL
         AND m.revoked_at IS NULL
         AND (m.invitation_expires_at IS NULL OR m.invitation_expires_at > unixepoch())
       ORDER BY CASE m.role
                  WHEN 'owner' THEN 0
                  WHEN 'administrator' THEN 1
                  WHEN 'committee_chair' THEN 2
                  WHEN 'evaluator' THEN 3
                  WHEN 'speaker' THEN 4
                  WHEN 'submitter' THEN 5
                  ELSE 6
                END,
                CASE WHEN m.event_id = e.id THEN 0 ELSE 1 END
       LIMIT 1
    `).bind(eventId, personId, ...allowedRoles).first<{ id: string; organisationId: string; eventId: string | null; role: ViewerRole }>();

    if (invitation) {
      const [accepted] = await env.DB.batch([
        env.DB.prepare(`
          UPDATE memberships
             SET accepted_at = unixepoch()
           WHERE id = ? AND accepted_at IS NULL AND invited_at IS NOT NULL
             AND revoked_at IS NULL
             AND (invitation_expires_at IS NULL OR invitation_expires_at > unixepoch())
          RETURNING id, organisation_id AS organisationId, event_id AS eventId, role
        `).bind(invitation.id),
        env.DB.prepare(`
          INSERT INTO audit_events (
            id, organisation_id, event_id, actor_person_id, action,
            entity_type, entity_id, metadata_json, created_at
          )
          SELECT ?, m.organisation_id, ?, ?, 'membership.accepted',
                 'membership', m.id, ?, unixepoch()
            FROM memberships m
           WHERE m.id = ? AND changes() = 1
        `).bind(
          crypto.randomUUID(),
          eventId,
          personId,
          JSON.stringify({ role: invitation.role }),
          invitation.id,
        ),
      ]);
      membership = accepted.results[0] as typeof membership | undefined ?? null;
    }
  }

  if (!membership) {
    forbidden("You do not have permission to manage this event");
  }

  return {
    personId,
    name,
    email,
    role: membership.role,
    organisationId: membership.organisationId,
    eventId,
    demo,
  };
}
