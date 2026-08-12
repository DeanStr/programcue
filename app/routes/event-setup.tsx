import { data } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/event-setup";
import { EventSetupForm } from "~/components/event-setup-form";
import { FILE_SIZE_MIB } from "~/modules/files/file-policy";
import {
  AirtableMigrationService,
  AirtableMigrationStateError,
  type AirtableMigrationPreview,
} from "~/modules/airtable/airtable-migration-service.server";
import {
  AirtableRoomRepository,
  isAirtableRepositoryError,
} from "~/modules/airtable/airtable-room-repository.server";
import {
  EventRevisionConflictError,
  EventSlugConflictError,
  EventRoomInUseError,
  EventRoomOwnershipError,
  EventTrackInUseError,
  EventTrackOwnershipError,
  EventSessionFormatInUseError,
  EventResourceConfigurationError,
  EventPublishedScheduleConflictError,
  EventPublishedProgrammeSlugError,
  EventAdministratorAlreadyActiveError,
  EventAdministratorNotFoundError,
} from "~/modules/events/event-repository.server";
import { EventRepositoryRecoveryService } from "~/modules/events/event-repository-recovery.server";
import {
  EventAdministratorPermissionError,
  EventAirtableProjectionCommitError,
  EventInvitationDeliveryError,
  EventRepositoryMigrationRequiredError,
  EventService,
} from "~/modules/events/event-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta: Route.MetaFunction = () => [
  { title: "Event Setup · Program Cue" },
];

export type ActionResponse = {
  ok: boolean;
  intent:
    | "save"
    | "invite"
    | "revoke_administrator"
    | "configure_airtable"
    | "preview_repository_migration"
    | "confirm_repository_migration";
  message: string;
  errors?: Record<string, string[]>;
  committed?: boolean;
  preview?: AirtableMigrationPreview;
};

function responseIntent(
  value: FormDataEntryValue | null,
): ActionResponse["intent"] {
  if (
    value === "invite" ||
    value === "revoke_administrator" ||
    value === "configure_airtable" ||
    value === "preview_repository_migration" ||
    value === "confirm_repository_migration"
  )
    return value;
  return "save";
}

async function getViewer(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  return requireCurrentEventRole(request, env, ["owner", "administrator"]);
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await getViewer(request, context);
  const [event, incompleteEvents] = await Promise.all([
    new EventService(env).getSetup(viewer),
    new EventRepositoryRecoveryService(env).listIncomplete(viewer),
  ]);
  const search = new URL(request.url).searchParams;
  const roomId = search.get("room");
  const trackId = search.get("track");
  if (roomId && trackId)
    throw new Response("Choose one Event Setup record.", { status: 400 });
  if (roomId && !event.rooms.some((room) => room.id === roomId))
    throw new Response("Room not found.", { status: 404 });
  if (trackId && !event.tracks.some((track) => track.id === trackId))
    throw new Response("Track not found.", { status: 404 });
  return {
    event,
    incompleteEvents,
    focusedRecord: roomId
      ? ({ kind: "room", id: roomId } as const)
      : trackId
        ? ({ kind: "track", id: trackId } as const)
        : null,
    canManageFileRetention: viewer.role === "owner",
    canManageOrganisationAdministrators: viewer.role === "owner",
  };
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
  if (request.method !== "POST")
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  const { env } = getCloudflareContext(context);
  const viewer = await getViewer(request, context);
  const service = new EventService(env);
  const formData = await request.formData();
  const intent = formData.get("_intent");

  try {
    if (intent === "configure_airtable") {
      const result = await new AirtableRoomRepository(env).configure(viewer, {
        personalAccessToken: formData.get("personalAccessToken"),
        baseId: formData.get("baseId"),
        tableName: formData.get("tableName"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "integration_connection",
        entityId: result.connectionId,
        changeType: "updated",
      });
      return data<ActionResponse>(
        {
          ok: !realtimeFailure,
          intent: "configure_airtable",
          message: realtimeFailure
            ? `Airtable credentials and schema were validated and saved. ${realtimeFailure.message}`
            : "Airtable credentials were verified, encrypted, and saved after every managed repository table was validated.",
          committed: Boolean(realtimeFailure),
        },
        realtimeFailure ? { status: 207 } : undefined,
      );
    }

    if (intent === "preview_repository_migration") {
      const preview = await new AirtableMigrationService(env).preview(
        viewer,
        formData.get("targetProvider"),
      );
      return data<ActionResponse>({
        ok: true,
        intent: "preview_repository_migration",
        message:
          "Migration preview recorded. Review every managed event-data change before confirming the authority switch.",
        preview,
      });
    }

    if (intent === "confirm_repository_migration") {
      const result = await new AirtableMigrationService(env).confirm(
        viewer,
        formData.get("previewId"),
      );
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "event",
        entityId: viewer.eventId,
        changeType: "updated",
      });
      return data<ActionResponse>(
        {
          ok: !realtimeFailure,
          intent: "confirm_repository_migration",
          message: realtimeFailure
            ? `Repository authority changed to ${result.provider === "airtable" ? "Airtable" : "D1"}. ${realtimeFailure.message}`
            : `Repository authority changed to ${result.provider === "airtable" ? "Airtable" : "D1"} after reconciliation.`,
          committed: true,
        },
        realtimeFailure ? { status: 207 } : undefined,
      );
    }

    if (intent === "revoke_administrator") {
      const result = await service.revokeAdministrator(viewer, {
        membershipId: formData.get("membershipId"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "membership",
        entityId: result.membershipId,
        changeType: "updated",
      });
      const scopeLabel =
        result.scope === "organisation" ? "Organisation" : "Event";
      if (realtimeFailure)
        return data<ActionResponse>(
          {
            ...realtimeFailure,
            intent: "revoke_administrator",
            message: `${scopeLabel} administrator access was revoked. ${realtimeFailure.message}`,
          },
          { status: 207 },
        );
      return data<ActionResponse>({
        ok: true,
        intent: "revoke_administrator",
        message: `${scopeLabel} administrator access was revoked.`,
      });
    }

    if (intent === "invite") {
      const result = await service.inviteAdministrator(viewer, {
        name: formData.get("name"),
        email: formData.get("email"),
        scope: formData.get("scope"),
      });
      const realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "membership",
        entityId: result.membershipId,
        changeType: "created",
      });
      if (realtimeFailure) {
        const scopeLabel =
          result.scope === "organisation" ? "organisation" : "event";
        return data<ActionResponse>(
          {
            ...realtimeFailure,
            intent: "invite",
            message: `${result.delivery === "sent" ? `The ${scopeLabel} administrator invitation was saved and its sign-in link was sent.` : `The demo ${scopeLabel} administrator invitation was saved without sending email.`} ${realtimeFailure.message}`,
          },
          { status: 207 },
        );
      }
      return data<ActionResponse>({
        ok: true,
        intent: "invite",
        message:
          result.delivery === "sent"
            ? `${result.scope === "organisation" ? "Organisation" : "Event"} administrator invitation created and a one-time sign-in link was sent.`
            : `Demo ${result.scope === "organisation" ? "organisation" : "event"} administrator invitation created in D1. No email was sent in explicit demo mode.`,
      });
    }

    if (intent !== "save") {
      return data<ActionResponse>(
        { ok: false, intent: "save", message: "Unknown Event Setup action." },
        { status: 400 },
      );
    }

    let parsedRooms: unknown;
    let parsedTracks: unknown;
    let parsedSessionFormats: unknown;
    try {
      parsedRooms = JSON.parse(String(formData.get("rooms") ?? "[]"));
      parsedTracks = JSON.parse(String(formData.get("tracks") ?? "[]"));
      parsedSessionFormats = JSON.parse(
        String(formData.get("sessionFormats") ?? "[]"),
      );
    } catch {
      return data<ActionResponse>(
        {
          ok: false,
          intent: "save",
          message:
            "Programme configuration data is invalid. Refresh before trying again.",
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
      participantLogoUrl: formData.get("participantLogoUrl"),
      participantWelcomeText: formData.get("participantWelcomeText"),
      participantSupportUrl: formData.get("participantSupportUrl"),
      description: formData.get("description"),
      repositoryProvider: formData.get("repositoryProvider"),
      retentionMonths: formData.get("retentionMonths"),
      submissionAccessMode: formData.get("submissionAccessMode"),
      allowAnonymousDrafts: formData.has("allowAnonymousDrafts"),
      duplicatePersonWarnings: formData.has("duplicatePersonWarnings"),
      filePolicy: {
        headshotMaximumBytes:
          Number(formData.get("headshotMaximumMegabytes")) * FILE_SIZE_MIB,
        slidesMaximumBytes:
          Number(formData.get("slidesMaximumMegabytes")) * FILE_SIZE_MIB,
        supportingDocumentMaximumBytes:
          Number(formData.get("supportingDocumentMaximumMegabytes")) *
          FILE_SIZE_MIB,
        videoMaximumBytes:
          Number(formData.get("videoMaximumMegabytes")) * FILE_SIZE_MIB,
      },
      rooms: parsedRooms,
      tracks: parsedTracks,
      sessionFormats: parsedSessionFormats,
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
      message:
        formData.get("repositoryProvider") === "airtable"
          ? "Event settings saved. Airtable event-data authority and the D1 control projection reconciled."
          : "Event settings saved to D1.",
    });
  } catch (error) {
    if (error instanceof ZodError) {
      const result = firstZodMessage(error);
      return data<ActionResponse>(
        {
          ok: false,
          intent: responseIntent(intent),
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
    if (error instanceof EventAirtableProjectionCommitError) {
      return data<ActionResponse>(
        {
          ok: false,
          intent: "save",
          message: error.message,
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
    if (error instanceof EventAdministratorPermissionError) {
      return data<ActionResponse>(
        { ok: false, intent: responseIntent(intent), message: error.message },
        { status: 403 },
      );
    }
    if (error instanceof EventAdministratorNotFoundError) {
      return data<ActionResponse>(
        {
          ok: false,
          intent: "revoke_administrator",
          message: error.message,
        },
        { status: 409 },
      );
    }
    if (
      error instanceof EventRevisionConflictError ||
      error instanceof EventSlugConflictError ||
      error instanceof EventRoomInUseError ||
      error instanceof EventRoomOwnershipError ||
      error instanceof EventTrackInUseError ||
      error instanceof EventTrackOwnershipError ||
      error instanceof EventSessionFormatInUseError ||
      error instanceof EventResourceConfigurationError ||
      error instanceof EventPublishedScheduleConflictError ||
      error instanceof EventPublishedProgrammeSlugError ||
      error instanceof EventRepositoryMigrationRequiredError ||
      error instanceof AirtableMigrationStateError
    ) {
      return data<ActionResponse>(
        {
          ok: false,
          intent: responseIntent(intent),
          message: error.message,
        },
        { status: 409 },
      );
    }
    if (isAirtableRepositoryError(error)) {
      return data<ActionResponse>(
        {
          ok: false,
          intent: responseIntent(intent),
          message: error.message,
        },
        { status: 422 },
      );
    }
    throw error;
  }
}

export default function EventSetupRoute({ loaderData }: Route.ComponentProps) {
  return (
    <EventSetupForm
      key={loaderData.event.revision}
      event={loaderData.event}
      incompleteEvents={loaderData.incompleteEvents}
      focusedRecord={loaderData.focusedRecord}
      canManageFileRetention={loaderData.canManageFileRetention}
      canManageOrganisationAdministrators={
        loaderData.canManageOrganisationAdministrators
      }
    />
  );
}
