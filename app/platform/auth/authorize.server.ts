import { redirect } from "react-router";
import {
  DEMO_IDENTITIES,
  DEMO_IDENTITY_COOKIE,
  type DemoIdentityKey,
  ensureDemoData,
  isDemoIdentityKey,
} from "~/platform/demo/seed.server";
import {
  EVALUATION_ORGANISATION_ID,
  evaluationPersonForSession,
  readEvaluationSession,
} from "~/platform/evaluation/evaluation-session.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";
import { createAuth } from "./auth.server";

export type ViewerRole =
  | "owner"
  | "administrator"
  | "committee_chair"
  | "evaluator"
  | "submitter"
  | "speaker";

export type Viewer = {
  personId: string;
  name: string;
  email: string;
  role: ViewerRole;
  organisationId: string;
  eventId: string;
  demo: boolean;
  evaluation?: boolean;
  authenticationCreatedAt?: Date | null;
};

function invalidDemoIdentityCookie(): never {
  throw new Response(
    "The demo identity selection is invalid. Choose an identity again.",
    {
      status: 400,
      statusText: "Invalid demo identity",
      headers: {
        "cache-control": "no-store",
        "set-cookie": `${DEMO_IDENTITY_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
      },
    },
  );
}

function forbidden(message: string, status = 403): never {
  throw new Response(message, {
    status,
    statusText: status === 401 ? "Unauthorized" : "Forbidden",
  });
}

export function eventRoleAccessMessage(
  allowedRoles: ReadonlyArray<ViewerRole>,
) {
  if (allowedRoles.length === 0) {
    return "This page has no authorised roles configured.";
  }
  const roles = new Set(allowedRoles);
  if (roles.size === 1 && roles.has("owner")) {
    return "This page is for organisation owners. Your current role cannot open it.";
  }
  const adminOnly = [...roles].every(
    (role) => role === "owner" || role === "administrator",
  );
  if (adminOnly) {
    return "This page is for event administrators. Your current role cannot open it.";
  }
  if (
    roles.has("committee_chair") &&
    !roles.has("evaluator") &&
    !roles.has("speaker") &&
    !roles.has("submitter")
  ) {
    return "This page is for committee chairs and administrators. Your current role cannot open it.";
  }
  if (roles.has("evaluator")) {
    return "This page is for reviewers with accepted event access. An organiser must invite this account before review work can begin.";
  }
  if (
    (roles.has("speaker") || roles.has("submitter")) &&
    !roles.has("owner") &&
    !roles.has("administrator") &&
    !roles.has("committee_chair") &&
    !roles.has("evaluator")
  ) {
    return "This page is part of the participant workspace. Your current role cannot open it.";
  }
  return "Your account cannot open this page. Ask an event administrator if you need access.";
}

function signInLocation(request: Request, demo = false) {
  const url = new URL(request.url);
  const returnTo = `${url.pathname}${url.search}`;
  const destination = demo ? "/demo" : "/sign-in";
  return `${destination}?${new URLSearchParams({ returnTo })}`;
}

function requireEvaluationIdentity(
  unauthenticatedBehavior: "redirect" | "response",
): never {
  if (unauthenticatedBehavior === "redirect") throw redirect("/evaluate");
  forbidden(
    "Choose an evaluation identity before opening a private workspace.",
    401,
  );
}

function cookieValue(request: Request, name: string) {
  const cookie = request.headers.get("cookie") ?? "";
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      invalidDemoIdentityCookie();
    }
  }
  return null;
}

export function selectedDemoIdentity(request: Request): {
  identityKey: DemoIdentityKey;
  identity: (typeof DEMO_IDENTITIES)[DemoIdentityKey];
} | null {
  const requestedIdentity = cookieValue(request, DEMO_IDENTITY_COOKIE);
  if (requestedIdentity === null) return null;
  if (!isDemoIdentityKey(requestedIdentity)) invalidDemoIdentityCookie();
  return {
    identityKey: requestedIdentity,
    identity: DEMO_IDENTITIES[requestedIdentity],
  };
}

export async function requireAuthenticatedPerson(
  request: Request,
  env: CloudflareEnvironment,
  unauthenticatedBehavior: "redirect" | "response" = "redirect",
) {
  const runtime = requireRuntimeMode(env);
  if (runtime.demo) {
    const selected = selectedDemoIdentity(request);
    if (!selected) {
      if (unauthenticatedBehavior === "redirect") {
        throw redirect(signInLocation(request, true));
      }
      forbidden(
        "Choose a demo identity before opening a private workspace.",
        401,
      );
    }
    await ensureDemoData(env);
    return {
      ...selected.identity,
      demo: true,
      evaluation: false,
      demoIdentity: selected.identityKey,
      restrictedOrganisationId: null,
      authenticationCreatedAt: null,
    };
  }

  if (runtime.evaluation) {
    const evaluationSession = await readEvaluationSession(request, env);
    if (evaluationSession) {
      const selected = await evaluationPersonForSession(env, evaluationSession);
      if (!selected) requireEvaluationIdentity(unauthenticatedBehavior);
      return {
        personId: selected.personId,
        name: selected.name,
        email: selected.email,
        demo: false,
        evaluation: true,
        demoIdentity: null,
        restrictedOrganisationId: EVALUATION_ORGANISATION_ID,
        authenticationCreatedAt: null,
      };
    }
  }

  const session = await createAuth(env).api.getSession({
    headers: request.headers,
  });
  if (!session?.user) {
    if (unauthenticatedBehavior === "redirect")
      throw redirect(signInLocation(request));
    forbidden("Sign in to open this page.", 401);
  }
  return {
    personId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    demo: false,
    evaluation: false,
    demoIdentity: null,
    restrictedOrganisationId: null,
    authenticationCreatedAt: session.session.createdAt,
  };
}

async function resolveEventRole(
  request: Request,
  env: CloudflareEnvironment,
  eventId: string,
  allowedRoles: ReadonlyArray<Viewer["role"]>,
  unauthenticatedBehavior: "redirect" | "response",
  acceptPendingInvitation: boolean,
): Promise<Viewer> {
  const {
    personId,
    name,
    email,
    demo,
    evaluation,
    restrictedOrganisationId,
    authenticationCreatedAt,
  } = await requireAuthenticatedPerson(request, env, unauthenticatedBehavior);

  if (allowedRoles.length === 0)
    forbidden(eventRoleAccessMessage(allowedRoles));
  const rolePlaceholders = allowedRoles.map(() => "?").join(",");

  let membership = await env.DB.prepare(
    `
    SELECT m.id, m.organisation_id AS organisationId, m.event_id AS eventId, m.role
      FROM memberships m
      JOIN events e ON e.organisation_id = m.organisation_id
     WHERE e.id = ?
       AND e.activation_status = 'active'
       AND (? IS NULL OR e.organisation_id = ?)
       AND m.person_id = ?
       AND (m.event_id = e.id OR (m.event_id IS NULL AND m.role IN ('owner', 'administrator')))
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
  `,
  )
    .bind(
      eventId,
      restrictedOrganisationId,
      restrictedOrganisationId,
      personId,
      ...allowedRoles,
    )
    .first<{
      id: string;
      organisationId: string;
      eventId: string | null;
      role: ViewerRole;
    }>();

  if (!membership && acceptPendingInvitation) {
    const invitation = await env.DB.prepare(
      `
      SELECT m.id, m.organisation_id AS organisationId, m.event_id AS eventId, m.role
        FROM memberships m
        JOIN events e ON e.organisation_id = m.organisation_id
       WHERE e.id = ?
         AND e.activation_status = 'active'
         AND (? IS NULL OR e.organisation_id = ?)
         AND m.person_id = ?
         AND (m.event_id = e.id OR (m.event_id IS NULL AND m.role IN ('owner', 'administrator')))
         AND m.role IN (${rolePlaceholders})
         AND m.accepted_at IS NULL
         AND m.invited_at IS NOT NULL
         AND m.revoked_at IS NULL
         AND m.invitation_expires_at > unixepoch()
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
    `,
    )
      .bind(
        eventId,
        restrictedOrganisationId,
        restrictedOrganisationId,
        personId,
        ...allowedRoles,
      )
      .first<{
        id: string;
        organisationId: string;
        eventId: string | null;
        role: ViewerRole;
      }>();

    if (invitation) {
      const auditEventId = crypto.randomUUID();
      const [audited, accepted] = await env.DB.batch([
        env.DB.prepare(
          `
          INSERT INTO audit_events (
            id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
            entity_type, entity_id, metadata_json, created_at
          )
          SELECT ?, 'person', 'admin_ui', 1, m.organisation_id, event.id, ?, 'membership.accepted',
                 'membership', m.id, ?, unixepoch()
            FROM memberships m
            JOIN events event
              ON event.id = ? AND event.organisation_id = m.organisation_id
             AND event.activation_status = 'active'
           WHERE m.id = ? AND m.accepted_at IS NULL
             AND m.invited_at IS NOT NULL
             AND m.organisation_id = ? AND m.person_id = ? AND m.role = ?
             AND (
               m.event_id = event.id
               OR (m.event_id IS NULL
                   AND m.role IN ('owner', 'administrator'))
             )
             AND m.revoked_at IS NULL
             AND m.invitation_expires_at > unixepoch()
        `,
        ).bind(
          auditEventId,
          personId,
          JSON.stringify({ role: invitation.role }),
          eventId,
          invitation.id,
          invitation.organisationId,
          personId,
          invitation.role,
        ),
        env.DB.prepare(
          `
          UPDATE memberships
             SET accepted_at = unixepoch(), last_operation_id = ?
           WHERE id = ? AND accepted_at IS NULL AND invited_at IS NOT NULL
             AND organisation_id = ? AND person_id = ?
             AND role = ?
             AND (
               event_id = ?
               OR (event_id IS NULL AND role IN ('owner', 'administrator'))
             )
             AND revoked_at IS NULL
             AND invitation_expires_at > unixepoch()
             AND EXISTS (
               SELECT 1 FROM audit_events audit
                WHERE audit.id = ?
                  AND audit.organisation_id = memberships.organisation_id
                  AND audit.event_id = ?
                  AND audit.action = 'membership.accepted'
                  AND audit.entity_type = 'membership'
                  AND audit.entity_id = memberships.id
             )
          RETURNING id, organisation_id AS organisationId, event_id AS eventId, role
        `,
        ).bind(
          auditEventId,
          invitation.id,
          invitation.organisationId,
          personId,
          invitation.role,
          eventId,
          auditEventId,
          eventId,
        ),
      ]);
      const acceptedCount = accepted.results.length;
      const auditCount = audited.meta.changes ?? 0;
      if (
        !(
          (acceptedCount === 1 && auditCount === 1) ||
          (acceptedCount === 0 && auditCount === 0)
        )
      ) {
        throw new Error(
          "Invitation acceptance did not preserve its required audit boundary.",
        );
      }
      membership =
        (accepted.results[0] as typeof membership | undefined) ??
        (await env.DB.prepare(
          `
          SELECT m.id, m.organisation_id AS organisationId,
                 m.event_id AS eventId, m.role
            FROM memberships m
            JOIN events e ON e.organisation_id = m.organisation_id
           WHERE m.id = ? AND e.id = ? AND m.person_id = ?
             AND e.activation_status = 'active'
             AND (? IS NULL OR e.organisation_id = ?)
             AND (m.event_id = e.id
                  OR (m.event_id IS NULL
                      AND m.role IN ('owner', 'administrator')))
             AND m.role IN (${rolePlaceholders})
             AND m.accepted_at IS NOT NULL
             AND m.revoked_at IS NULL
             AND EXISTS (
               SELECT 1 FROM audit_events audit
                WHERE audit.id = m.last_operation_id
                  AND audit.organisation_id = m.organisation_id
                  AND audit.event_id = ?
                  AND audit.action = 'membership.accepted'
                  AND audit.entity_type = 'membership'
                  AND audit.entity_id = m.id
             )
           LIMIT 1
        `,
        )
          .bind(
            invitation.id,
            eventId,
            personId,
            restrictedOrganisationId,
            restrictedOrganisationId,
            ...allowedRoles,
            eventId,
          )
          .first<{
            id: string;
            organisationId: string;
            eventId: string | null;
            role: ViewerRole;
          }>()) ??
        null;
    }
  }

  if (!membership) {
    forbidden(eventRoleAccessMessage(allowedRoles));
  }

  return {
    personId,
    name,
    email,
    role: membership.role,
    organisationId: membership.organisationId,
    eventId,
    demo,
    evaluation,
    authenticationCreatedAt,
  };
}

export function requireEventRole(
  request: Request,
  env: CloudflareEnvironment,
  eventId: string,
  allowedRoles: ReadonlyArray<Viewer["role"]>,
  unauthenticatedBehavior: "redirect" | "response" = "redirect",
): Promise<Viewer> {
  return resolveEventRole(
    request,
    env,
    eventId,
    allowedRoles,
    unauthenticatedBehavior,
    false,
  );
}

/**
 * Accepts a pending invitation only through an explicit same-origin POST.
 * Ordinary loaders must use requireEventRole so navigation and prefetch remain
 * read-only.
 */
export function acceptEventInvitation(
  request: Request,
  env: CloudflareEnvironment,
  eventId: string,
  allowedRoles: ReadonlyArray<Viewer["role"]>,
  unauthenticatedBehavior: "redirect" | "response" = "redirect",
): Promise<Viewer> {
  if (request.method.toUpperCase() !== "POST") {
    throw new Response("Invitation acceptance requires POST.", {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  }
  if (request.headers.get("origin") !== new URL(request.url).origin) {
    forbidden(
      "This invitation must be accepted from Program Cue itself. Open the invitation link again.",
    );
  }
  return resolveEventRole(
    request,
    env,
    eventId,
    allowedRoles,
    unauthenticatedBehavior,
    true,
  );
}
