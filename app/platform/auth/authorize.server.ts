import { redirect } from "react-router";

import { createAuth } from "./auth.server";
import {
  DEMO_IDENTITY_COOKIE,
  DEMO_IDENTITIES,
  ensureDemoData,
  isDemoIdentityKey,
  type DemoIdentityKey,
} from "~/platform/demo/seed.server";
import {
  EVALUATION_ORGANISATION_ID,
  evaluationPersonForSession,
  readEvaluationSession,
} from "~/platform/evaluation/evaluation-session.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

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
    "Choose an evaluation identity before opening a private workspace",
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
        "Choose a demo identity before opening a private workspace",
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
      };
    }
  }

  const session = await createAuth(env).api.getSession({
    headers: request.headers,
  });
  if (!session?.user) {
    if (unauthenticatedBehavior === "redirect")
      throw redirect(signInLocation(request));
    forbidden("Authentication is required", 401);
  }
  return {
    personId: session.user.id,
    name: session.user.name,
    email: session.user.email,
    demo: false,
    evaluation: false,
    demoIdentity: null,
    restrictedOrganisationId: null,
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
  const { personId, name, email, demo, evaluation, restrictedOrganisationId } =
    await requireAuthenticatedPerson(request, env, unauthenticatedBehavior);

  if (allowedRoles.length === 0)
    forbidden("You do not have permission to manage this event");
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
      const acceptanceOperationId = `membership-accepted:${crypto.randomUUID()}`;
      const [accepted] = await env.DB.batch([
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
          RETURNING id, organisation_id AS organisationId, event_id AS eventId, role
        `,
        ).bind(
          acceptanceOperationId,
          invitation.id,
          invitation.organisationId,
          personId,
          invitation.role,
          eventId,
        ),
        env.DB.prepare(
          `
          INSERT INTO audit_events (
            id, organisation_id, event_id, actor_person_id, action,
            entity_type, entity_id, metadata_json, created_at
          )
          SELECT ?, m.organisation_id, event.id, ?, 'membership.accepted',
                 'membership', m.id, ?, unixepoch()
            FROM memberships m
            JOIN events event
              ON event.id = ? AND event.organisation_id = m.organisation_id
             AND event.activation_status = 'active'
           WHERE m.id = ? AND m.accepted_at IS NOT NULL
             AND m.organisation_id = ? AND m.person_id = ? AND m.role = ?
             AND (
               m.event_id = event.id
               OR (m.event_id IS NULL
                   AND m.role IN ('owner', 'administrator'))
             )
             AND m.revoked_at IS NULL AND m.last_operation_id = ?
        `,
        ).bind(
          crypto.randomUUID(),
          personId,
          JSON.stringify({ role: invitation.role }),
          eventId,
          invitation.id,
          invitation.organisationId,
          personId,
          invitation.role,
          acceptanceOperationId,
        ),
      ]);
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
    evaluation,
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
    forbidden("A same-origin request is required to accept an invitation");
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
