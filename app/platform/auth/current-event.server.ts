import { redirect } from "react-router";

import {
  requireAuthenticatedPerson,
  requireEventRole,
  type Viewer,
  type ViewerRole,
} from "./authorize.server";
import { requireRuntimeMode } from "~/platform/runtime-environment.server";

export const CURRENT_EVENT_COOKIE = "__Host-program_cue_event";
export const LOCAL_CURRENT_EVENT_COOKIE = "program_cue_event";

export const ALL_EVENT_ROLES = [
  "owner",
  "administrator",
  "committee_chair",
  "evaluator",
  "submitter",
  "speaker",
] as const satisfies ReadonlyArray<ViewerRole>;

export type AuthorisedEvent = {
  eventId: string;
  eventName: string;
  eventSlug: string;
  organisationId: string;
  organisationName: string;
  role: ViewerRole;
  invitationPending: boolean;
  pendingInvitationRole: ViewerRole | null;
};

const EVENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 14;

function cookieValue(request: Request, name: string) {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...value] = item.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(value.join("="));
    } catch {
      return "";
    }
  }
  return null;
}

function shouldUseLocalCookie(env: CloudflareEnvironment) {
  return requireRuntimeMode(env).appEnvironment !== "production";
}

function currentEventCookieName(env: CloudflareEnvironment) {
  return shouldUseLocalCookie(env)
    ? LOCAL_CURRENT_EVENT_COOKIE
    : CURRENT_EVENT_COOKIE;
}

export function currentEventCookie(
  eventId: string,
  env: CloudflareEnvironment,
) {
  if (!EVENT_ID_PATTERN.test(eventId))
    throw new Error("Cannot store an invalid current event identifier.");
  const secure = shouldUseLocalCookie(env) ? "" : "; Secure";
  return `${currentEventCookieName(env)}=${encodeURIComponent(eventId)}; Max-Age=${COOKIE_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function clearCurrentEventCookie(env: CloudflareEnvironment) {
  const secure = shouldUseLocalCookie(env) ? "" : "; Secure";
  return `${currentEventCookieName(env)}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function selectedEventId(request: Request, env: CloudflareEnvironment) {
  const value = cookieValue(request, currentEventCookieName(env));
  if (value === null) return null;
  if (!EVENT_ID_PATTERN.test(value)) {
    throw new Response(
      "The current event selection is malformed. Choose an event again.",
      {
        status: 400,
        statusText: "Invalid current event",
        headers: { "set-cookie": clearCurrentEventCookie(env) },
      },
    );
  }
  return value;
}

function localDestination(request: Request) {
  const url = new URL(request.url);
  return `${url.pathname}${url.search}${url.hash}`;
}

function selectionLocation(request: Request) {
  return `/events/select?${new URLSearchParams({ returnTo: localDestination(request) })}`;
}

/**
 * Chooses only an explicitly configured deployment event or an unambiguous
 * sole event. Callers must present a selector when this returns null.
 */
export function chooseInitialEvent(
  events: ReadonlyArray<Pick<AuthorisedEvent, "eventId">>,
  configuredDefaultEventId: string | undefined,
) {
  const configured = configuredDefaultEventId?.trim();
  if (configured && events.some((event) => event.eventId === configured))
    return configured;
  return events.length === 1 ? events[0]!.eventId : null;
}

export async function listAuthorisedEvents(
  request: Request,
  env: CloudflareEnvironment,
  allowedRoles: ReadonlyArray<ViewerRole> = ALL_EVENT_ROLES,
  unauthenticatedBehavior: "redirect" | "response" = "redirect",
): Promise<AuthorisedEvent[]> {
  if (allowedRoles.length === 0) return [];
  const person = await requireAuthenticatedPerson(
    request,
    env,
    unauthenticatedBehavior,
  );
  return listAuthorisedEventsForPerson(
    env,
    person.personId,
    allowedRoles,
    person.restrictedOrganisationId,
  );
}

async function listAuthorisedEventsForPerson(
  env: CloudflareEnvironment,
  personId: string,
  allowedRoles: ReadonlyArray<ViewerRole>,
  restrictedOrganisationId: string | null = null,
): Promise<AuthorisedEvent[]> {
  if (allowedRoles.length === 0) return [];
  const placeholders = allowedRoles.map(() => "?").join(",");
  const results = await env.DB.prepare(
    `
    SELECT e.id AS eventId, e.name AS eventName, e.slug AS eventSlug,
           e.organisation_id AS organisationId,
           organisation.name AS organisationName, membership.role,
           CASE WHEN membership.accepted_at IS NULL THEN 1 ELSE 0 END AS invitationPending
      FROM events e
      JOIN organisations organisation ON organisation.id = e.organisation_id
      JOIN memberships membership
        ON membership.organisation_id = e.organisation_id
       AND (membership.event_id = e.id
            OR (membership.event_id IS NULL
                AND membership.role IN ('owner', 'administrator')))
     WHERE membership.person_id = ?
       AND (? IS NULL OR e.organisation_id = ?)
       AND e.activation_status = 'active'
       AND membership.role IN (${placeholders})
       AND membership.revoked_at IS NULL
       AND (
         membership.accepted_at IS NOT NULL
         OR (
           membership.accepted_at IS NULL
           AND membership.invited_at IS NOT NULL
           AND membership.invitation_expires_at > unixepoch()
         )
       )
     ORDER BY organisation.name COLLATE NOCASE, e.starts_at DESC,
              e.name COLLATE NOCASE, e.id,
              CASE WHEN membership.accepted_at IS NULL THEN 1 ELSE 0 END,
              CASE membership.role
                WHEN 'owner' THEN 0
                WHEN 'administrator' THEN 1
                WHEN 'committee_chair' THEN 2
                WHEN 'evaluator' THEN 3
                WHEN 'speaker' THEN 4
                WHEN 'submitter' THEN 5
                ELSE 6
              END,
              CASE WHEN membership.event_id = e.id THEN 0 ELSE 1 END
  `,
  )
    .bind(
      personId,
      restrictedOrganisationId,
      restrictedOrganisationId,
      ...allowedRoles,
    )
    .all<
      Omit<AuthorisedEvent, "invitationPending" | "pendingInvitationRole"> & {
        invitationPending: number | boolean;
      }
    >();

  const events = new Map<string, AuthorisedEvent>();
  for (const row of results.results) {
    const invitationPending = Boolean(row.invitationPending);
    const existing = events.get(row.eventId);
    if (existing) {
      // Accepted access remains usable without accepting a different role,
      // while the highest-priority pending invitation stays visible for an
      // explicit selector action.
      if (invitationPending && existing.pendingInvitationRole === null)
        existing.pendingInvitationRole = row.role;
      continue;
    }
    events.set(row.eventId, {
      ...row,
      invitationPending,
      pendingInvitationRole: invitationPending ? row.role : null,
    });
  }
  return [...events.values()];
}

export async function listAcceptedEventRoles(
  request: Request,
  env: CloudflareEnvironment,
  eventId: string,
): Promise<ViewerRole[]> {
  if (!EVENT_ID_PATTERN.test(eventId)) return [];
  const person = await requireAuthenticatedPerson(request, env);
  const rows = await env.DB.prepare(
    `
    SELECT DISTINCT membership.role
      FROM events event
      JOIN memberships membership
        ON membership.organisation_id = event.organisation_id
       AND (membership.event_id = event.id
            OR (membership.event_id IS NULL
                AND membership.role IN ('owner', 'administrator')))
     WHERE event.id = ?
       AND (? IS NULL OR event.organisation_id = ?)
       AND event.activation_status = 'active'
       AND membership.person_id = ?
       AND membership.accepted_at IS NOT NULL
       AND membership.revoked_at IS NULL
       AND membership.role IN ('owner','administrator','committee_chair','evaluator','submitter','speaker')
     ORDER BY CASE membership.role
       WHEN 'owner' THEN 0
       WHEN 'administrator' THEN 1
       WHEN 'committee_chair' THEN 2
       WHEN 'evaluator' THEN 3
       WHEN 'speaker' THEN 4
       WHEN 'submitter' THEN 5
       ELSE 6
     END
  `,
  )
    .bind(
      eventId,
      person.restrictedOrganisationId,
      person.restrictedOrganisationId,
      person.personId,
    )
    .all<{ role: ViewerRole }>();
  return rows.results.map((row) => row.role);
}

export async function resolveCurrentEventId(
  request: Request,
  env: CloudflareEnvironment,
  allowedRoles: ReadonlyArray<ViewerRole>,
  unauthenticatedBehavior: "redirect" | "response" = "redirect",
) {
  const selected = selectedEventId(request, env);
  if (selected) return selected;

  // Unsafe requests must never gain an implicit event while a mutation is in
  // flight. A page loader establishes the selection before actions can run.
  if (request.method !== "GET" && request.method !== "HEAD") {
    await requireAuthenticatedPerson(request, env, unauthenticatedBehavior);
    throw new Response("Choose a current event before making this change.", {
      status: 428,
      statusText: "Current event required",
    });
  }

  if (String(env.DEMO_MODE) === "true") {
    const demoEventId = env.DEFAULT_EVENT_ID?.trim();
    if (!demoEventId)
      throw new Response("The demo event is not configured.", { status: 503 });
    return demoEventId;
  }

  const events = await listAuthorisedEvents(
    request,
    env,
    allowedRoles,
    unauthenticatedBehavior,
  );
  if (events.length === 0) {
    throw new Response(
      "You do not have access to an event for this workspace.",
      {
        status: 403,
        statusText: "Forbidden",
      },
    );
  }
  const initial = chooseInitialEvent(events, env.DEFAULT_EVENT_ID);
  if (!initial) throw redirect(selectionLocation(request));
  if (events.find((event) => event.eventId === initial)?.invitationPending) {
    throw redirect(selectionLocation(request));
  }
  throw redirect(localDestination(request), {
    headers: {
      "set-cookie": currentEventCookie(initial, env),
      "cache-control": "private, no-store",
    },
  });
}

export async function requireCurrentEventRole(
  request: Request,
  env: CloudflareEnvironment,
  allowedRoles: ReadonlyArray<ViewerRole>,
  unauthenticatedBehavior: "redirect" | "response" = "redirect",
): Promise<Viewer> {
  const eventId = await resolveCurrentEventId(
    request,
    env,
    allowedRoles,
    unauthenticatedBehavior,
  );
  return requireEventRole(
    request,
    env,
    eventId,
    allowedRoles,
    unauthenticatedBehavior,
  );
}

export async function recordEventContextSwitch(
  env: CloudflareEnvironment,
  viewer: Viewer,
  previousEventId: string | null,
) {
  if (previousEventId === viewer.eventId) return false;

  const result = await env.DB.prepare(
    `
    INSERT INTO audit_events (
      id, actor_kind, origin, metadata_version, organisation_id, event_id, actor_person_id, action,
      entity_type, entity_id, metadata_json, created_at
    )
    SELECT ?, 'person', 'admin_ui', 1, event.organisation_id, event.id, ?,
           'event.context.switched', 'event', event.id, ?, unixepoch()
      FROM events event
     WHERE event.id = ? AND event.organisation_id = ?
       AND event.activation_status = 'active'
  `,
  )
    .bind(
      crypto.randomUUID(),
      viewer.personId,
      JSON.stringify({
        hadPreviousSelection: previousEventId !== null,
        role: viewer.role,
      }),
      viewer.eventId,
      viewer.organisationId,
    )
    .run();
  if ((result.meta.changes ?? 0) !== 1) {
    throw new Error(
      "The selected event no longer belongs to the authorised organisation.",
    );
  }
  return true;
}

export type CurrentEventAdminShellContext = {
  eventOptions: AuthorisedEvent[];
  canCreateEvents: boolean;
  notificationCounts: {
    overdueTasks: number;
    scheduleConflicts: number;
    failedOperations: number;
  };
};

/**
 * Loads the authenticated event context used by the persistent admin shell.
 * The explicit organisation predicate protects the boundary if a stale or
 * incorrectly assembled Viewer is ever passed after authorisation.
 */
export async function loadCurrentEventAdminShellContext(
  env: CloudflareEnvironment,
  viewer: Viewer,
  allowedRoles: ReadonlyArray<ViewerRole>,
): Promise<CurrentEventAdminShellContext> {
  const [eventOptions, row] = await Promise.all([
    listAuthorisedEventsForPerson(
      env,
      viewer.personId,
      allowedRoles,
      viewer.evaluation ? viewer.organisationId : null,
    ),
    env.DB.prepare(
      `
      WITH current_event AS (
        SELECT id, organisation_id
          FROM events
         WHERE id = ? AND organisation_id = ?
           AND activation_status = 'active'
      )
      SELECT
        EXISTS(SELECT 1 FROM current_event) AS eventExists,
        EXISTS(
          SELECT 1 FROM memberships membership
           WHERE membership.organisation_id = ?
             AND membership.person_id = ?
             AND membership.event_id IS NULL
             AND membership.role IN ('owner','administrator')
             AND membership.accepted_at IS NOT NULL
             AND membership.revoked_at IS NULL
        ) AS canCreateEvents,
        (SELECT COUNT(*)
           FROM task_instances task
           JOIN current_event event ON event.id = task.event_id
          WHERE task.status NOT IN ('completed','waived')
            AND (task.status = 'overdue'
                 OR (task.due_at IS NOT NULL AND task.due_at < unixepoch()))) AS overdueTasks,
        (SELECT COUNT(*)
           FROM schedule_conflicts conflict
           JOIN current_event event ON event.id = conflict.event_id
          WHERE conflict.resolved_at IS NULL
            AND conflict.severity = 'blocking') AS scheduleConflicts,
        (SELECT COUNT(*)
           FROM operation_jobs operation
           JOIN current_event event ON event.id = operation.event_id
          WHERE operation.organisation_id = event.organisation_id
            AND operation.status IN ('queue_failed','failed','partially_failed')
            AND operation.alert_acknowledged_at IS NULL) AS failedOperations
    `,
    )
      .bind(
        viewer.eventId,
        viewer.organisationId,
        viewer.organisationId,
        viewer.personId,
      )
      .first<{
        eventExists: number | boolean;
        canCreateEvents: number | boolean;
        overdueTasks: number;
        scheduleConflicts: number;
        failedOperations: number;
      }>(),
  ]);

  if (!row?.eventExists)
    throw new Error(
      "The authorised current event no longer belongs to its organisation.",
    );

  return {
    eventOptions,
    canCreateEvents: Boolean(row.canCreateEvents),
    notificationCounts: {
      overdueTasks: Number(row.overdueTasks),
      scheduleConflicts: Number(row.scheduleConflicts),
      failedOperations: Number(row.failedOperations),
    },
  };
}
