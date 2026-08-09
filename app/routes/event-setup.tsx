import { data } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/event-setup";
import { EventSetupForm } from "~/components/event-setup-form";
import {
  EventRevisionConflictError,
  EventSlugConflictError,
  EventRoomInUseError,
  EventRoomOwnershipError,
  EventPublishedScheduleConflictError,
  EventPublishedProgrammeSlugError,
  EventAdministratorAlreadyActiveError,
} from "~/modules/events/event-repository.server";
import {
  EventInvitationDeliveryError,
  EventService,
} from "~/modules/events/event-service.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta: Route.MetaFunction = () => [
  { title: "Event Setup · Program Cue" },
];

export type ActionResponse = {
  ok: boolean;
  intent: "save" | "invite";
  message: string;
  errors?: Record<string, string[]>;
  committed?: boolean;
};

async function getViewer(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  const eventId = env.DEFAULT_EVENT_ID;
  if (!eventId)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  return requireEventRole(request, env, eventId, ["owner", "administrator"]);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await getViewer(request, context);
  const event = await new EventService(env).getSetup(viewer);
  return { event };
}

function firstZodMessage(error: ZodError) {
  const flattened = error.flatten();
  const errors: Record<string, string[]> = {};
  for (const [field, messages] of Object.entries(flattened.fieldErrors)) {
    if (Array.isArray(messages) && messages.length)
      errors[field] = messages.map(String);
  }
  return {
    message:
      error.issues[0]?.message ?? "Review the highlighted event settings.",
    errors,
  };
}

export async function action({ request, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await getViewer(request, context);
  const service = new EventService(env);
  const formData = await request.formData();
  const intent = formData.get("_intent");

  try {
    if (intent === "invite") {
      const result = await service.inviteAdministrator(viewer, {
        name: formData.get("name"),
        email: formData.get("email"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "membership",
        entityId: result.membershipId,
        changeType: "created",
      });
      if (realtimeFailure) {
        return data<ActionResponse>(
          {
            ...realtimeFailure,
            intent: "invite",
            message: `${result.delivery === "sent" ? "The invitation was saved and its sign-in link was sent." : "The demo invitation was saved without sending email."} ${realtimeFailure.message}`,
          },
          { status: 207 },
        );
      }
      return data<ActionResponse>({
        ok: true,
        intent: "invite",
        message:
          result.delivery === "sent"
            ? "Administrator invitation created and a one-time sign-in link was sent."
            : "Demo invitation created in D1. No email was sent in explicit demo mode.",
      });
    }

    if (intent !== "save") {
      return data<ActionResponse>(
        { ok: false, intent: "save", message: "Unknown Event Setup action." },
        { status: 400 },
      );
    }

    let parsedRooms: unknown;
    try {
      parsedRooms = JSON.parse(String(formData.get("rooms") ?? "[]"));
    } catch {
      return data<ActionResponse>(
        {
          ok: false,
          intent: "save",
          message: "Room data is invalid. Refresh before trying again.",
        },
        { status: 400 },
      );
    }

    await service.saveSetup(viewer, {
      revision: formData.get("revision"),
      name: formData.get("name"),
      timezone: formData.get("timezone"),
      startDate: formData.get("startDate"),
      endDate: formData.get("endDate"),
      venue: formData.get("venue"),
      city: formData.get("city"),
      publicSlug: formData.get("publicSlug"),
      brandAccent: formData.get("brandAccent"),
      description: formData.get("description"),
      repositoryProvider: formData.get("repositoryProvider"),
      retentionMonths: formData.get("retentionMonths"),
      submissionAccessMode: formData.get("submissionAccessMode"),
      allowAnonymousDrafts: formData.has("allowAnonymousDrafts"),
      duplicatePersonWarnings: formData.has("duplicatePersonWarnings"),
      rooms: parsedRooms,
    });

    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "event",
      entityId: viewer.eventId,
      changeType: "updated",
    });
    if (realtimeFailure)
      return data<ActionResponse>(
        { ...realtimeFailure, intent: "save" },
        { status: 207 },
      );
    return data<ActionResponse>({
      ok: true,
      intent: "save",
      message: "Event settings saved to D1.",
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const result = firstZodMessage(error);
      return data<ActionResponse>(
        {
          ok: false,
          intent: intent === "invite" ? "invite" : "save",
          ...result,
        },
        { status: 422 },
      );
    }
    if (error instanceof EventInvitationDeliveryError) {
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "membership",
        entityId: error.membershipId,
        changeType: "created",
      });
      return data<ActionResponse>(
        {
          ok: false,
          intent: "invite",
          message: realtimeFailure
            ? `${error.message} ${realtimeFailure.message}`
            : error.message,
          committed: true,
        },
        { status: 207 },
      );
    }
    if (error instanceof EventAdministratorAlreadyActiveError) {
      return data<ActionResponse>(
        { ok: false, intent: "invite", message: error.message },
        { status: 409 },
      );
    }
    if (
      error instanceof EventRevisionConflictError ||
      error instanceof EventSlugConflictError ||
      error instanceof EventRoomInUseError ||
      error instanceof EventRoomOwnershipError ||
      error instanceof EventPublishedScheduleConflictError ||
      error instanceof EventPublishedProgrammeSlugError
    ) {
      return data<ActionResponse>(
        { ok: false, intent: "save", message: error.message },
        { status: 409 },
      );
    }
    throw error;
  }
}

export default function EventSetupRoute({ loaderData }: Route.ComponentProps) {
  return (
    <EventSetupForm key={loaderData.event.revision} event={loaderData.event} />
  );
}
