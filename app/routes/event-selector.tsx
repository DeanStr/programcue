import { CalendarDays, CheckCircle2 } from "lucide-react";
import { Form, redirect } from "react-router";
import { z } from "zod";

import type { Route } from "./+types/event-selector";
import {
  acceptEventInvitation,
  requireEventRole,
  type ViewerRole,
} from "~/platform/auth/authorize.server";
import {
  currentEventCookie,
  listAcceptedEventRoles,
  listAuthorisedEvents,
  recordEventContextSwitch,
  selectedEventId,
} from "~/platform/auth/current-event.server";
import { safeReturnTo } from "~/platform/auth/return-to";
import { getCloudflareContext } from "~/platform/cloudflare-context";

const selectionSchema = z.object({
  eventId: z.string().min(1).max(128),
  returnTo: z.string(),
});

const landingPage: Record<ViewerRole, string> = {
  owner: "/admin/event",
  administrator: "/admin/event",
  committee_chair: "/admin/review",
  evaluator: "/review/workbench",
  speaker: "/speaker/dashboard",
  submitter: "/",
};

function selectionReturnTo(value: unknown) {
  const returnTo = safeReturnTo(value);
  return returnTo.startsWith("/events/select") ? "/" : returnTo;
}

function roleCanUseReturnTo(role: ViewerRole, returnTo: string) {
  const pathname = new URL(returnTo, "https://programcue.invalid").pathname;
  if (role === "owner" || role === "administrator")
    return pathname === "/admin" || pathname.startsWith("/admin/");
  if (role === "committee_chair")
    return (
      pathname === "/admin/review" || pathname.startsWith("/admin/review/")
    );
  if (role === "evaluator")
    return pathname === "/review" || pathname.startsWith("/review/");
  if (role === "speaker")
    return pathname === "/speaker" || pathname.startsWith("/speaker/");
  return false;
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const url = new URL(request.url);
  const events = await listAuthorisedEvents(request, env);
  if (events.length === 0)
    throw new Response("You do not have access to any events.", {
      status: 403,
      statusText: "Forbidden",
    });
  let currentEventId: string | null = null;
  try {
    currentEventId = selectedEventId(request, env);
  } catch (error) {
    if (!(error instanceof Response) || error.status !== 400) throw error;
  }
  const requestedEventId = url.searchParams.get("eventId");
  if (requestedEventId && !events.some((event) => event.eventId === requestedEventId))
    throw new Response("You do not have access to the requested event.", {
      status: 403,
      statusText: "Forbidden",
    });
  const preferredEventId = requestedEventId ?? currentEventId;
  const orderedEvents = [
    ...events.filter((event) => event.eventId === preferredEventId),
    ...events.filter(
      (event) =>
        event.eventId !== preferredEventId && event.eventId === currentEventId,
    ),
    ...events.filter(
      (event) =>
        event.eventId !== preferredEventId && event.eventId !== currentEventId,
    ),
  ];
  return {
    events: orderedEvents,
    currentEventId,
    returnTo: selectionReturnTo(url.searchParams.get("returnTo")),
  };
}

export const headers: Route.HeadersFunction = () => ({
  "cache-control": "private, no-store",
});

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST")
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  const { env } = getCloudflareContext(context);
  const form = await request.formData();
  const parsed = selectionSchema.safeParse({
    eventId: form.get("eventId"),
    returnTo: form.get("returnTo"),
  });
  if (!parsed.success)
    throw new Response("Choose a valid event.", {
      status: 422,
      statusText: "Invalid event selection",
    });

  const authorisedEvents = await listAuthorisedEvents(request, env);
  const selectedEvent = authorisedEvents.find(
    (event) => event.eventId === parsed.data.eventId,
  );
  if (!selectedEvent)
    throw new Response("You do not have access to the selected event.", {
      status: 403,
      statusText: "Forbidden",
    });
  const viewer = selectedEvent.pendingInvitationRole
    ? await acceptEventInvitation(request, env, selectedEvent.eventId, [
        selectedEvent.pendingInvitationRole,
      ])
    : await requireEventRole(request, env, selectedEvent.eventId, [
        selectedEvent.role,
      ]);
  let previousEventId: string | null = null;
  try {
    previousEventId = selectedEventId(request, env);
  } catch {
    // A successful explicit selection replaces malformed cookie state.
  }
  await recordEventContextSwitch(env, viewer, previousEventId);

  const requestedDestination = selectionReturnTo(parsed.data.returnTo);
  const acceptedRoles = await listAcceptedEventRoles(
    request,
    env,
    selectedEvent.eventId,
  );
  const destination =
    requestedDestination !== "/" &&
    acceptedRoles.some((role) => roleCanUseReturnTo(role, requestedDestination))
      ? requestedDestination
      : landingPage[viewer.role];
  return redirect(destination, {
    status: 303,
    headers: {
      "set-cookie": currentEventCookie(viewer.eventId, env),
      "cache-control": "private, no-store",
    },
  });
}

export const meta = () => [{ title: "Choose event · Program Cue" }];

export default function EventSelector({ loaderData }: Route.ComponentProps) {
  return (
    <main className="design-board" id="main">
      <section
        className="card pad"
        style={{ maxWidth: 820, margin: "7vh auto" }}
      >
        <div className="page-head">
          <div>
            <span className="pc-page-eyebrow">Authorised workspaces</span>
            <h1>Choose an event</h1>
            <p>
              Select the event that subsequent private pages and changes should
              use.
            </p>
          </div>
          <span className="brand-mark">P</span>
        </div>
        <div className="stack">
          {loaderData.events.map((event) => {
            const current = event.eventId === loaderData.currentEventId;
            return (
              <Form method="post" key={event.eventId} className="card pad">
                <input type="hidden" name="eventId" value={event.eventId} />
                <input
                  type="hidden"
                  name="returnTo"
                  value={loaderData.returnTo}
                />
                <div className="card-title">
                  <div>
                    <strong>{event.eventName}</strong>
                    <p className="subtle">
                      {event.organisationName} ·{" "}
                      {event.invitationPending
                        ? `${event.role.replaceAll("_", " ")} invitation pending`
                        : event.role.replaceAll("_", " ")}
                      {!event.invitationPending && event.pendingInvitationRole
                        ? ` · ${event.pendingInvitationRole.replaceAll("_", " ")} invitation pending`
                        : ""}
                    </p>
                  </div>
                  <CalendarDays aria-hidden size={20} />
                </div>
                <button
                  className={`btn${current ? "" : " primary"}`}
                  type="submit"
                >
                  {current ? <CheckCircle2 aria-hidden size={14} /> : null}
                  {event.pendingInvitationRole
                    ? `Accept ${event.pendingInvitationRole.replaceAll("_", " ")} invitation${current ? "" : " and use event"}`
                    : current
                      ? "Continue with current event"
                      : "Use this event"}
                </button>
              </Form>
            );
          })}
        </div>
      </section>
    </main>
  );
}
