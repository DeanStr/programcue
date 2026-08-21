import { data } from "react-router";
import { ZodError } from "zod";
import { AdminSpeakerDetailPage } from "~/components/admin-speaker-detail-page";
import { statusPresentation } from "~/components/ui/domain-status-badge";
import { adminRecordBreadcrumbHandle } from "~/modules/administration/admin-route-breadcrumb";
import { ScheduleRevisionConflictError } from "~/modules/schedule/schedule-errors";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  SpeakerAdminStateError,
  SpeakerProfileConflictError,
  SpeakerService,
} from "~/modules/speakers/speaker-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  type CommittedRealtimeFailure,
  notifyRouteChange,
  recordRouteChange,
} from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/admin-speaker-detail";

export const handle = adminRecordBreadcrumbHandle([
  "detail",
  "profile",
  "name",
]);

export const meta: Route.MetaFunction = ({ loaderData }) => [
  {
    title: loaderData
      ? `${loaderData.detail.profile.name} · Speakers · Program Cue`
      : "Speaker · Program Cue",
  },
];

export async function loader({ request, params, context }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const service = new SpeakerService(env);
  return {
    detail: await service.getAdminSpeakerDetail(viewer, params.personId),
    availability: await service.listAdminAvailability(viewer, params.personId),
  };
}

export async function action({ request, params, context }: Route.ActionArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const form = await request.formData();
  const intent = form.get("_intent");
  if (
    intent !== "save_speaker_profile" &&
    intent !== "save_speaker_scoped_profile" &&
    intent !== "confirm_external_participation" &&
    intent !== "reset_declined_participation" &&
    intent !== "delete_speaker_blackout"
  ) {
    return data(
      { ok: false, message: "Unsupported speaker action." },
      { status: 400 },
    );
  }
  try {
    if (intent === "delete_speaker_blackout") {
      const result = await new SpeakerService(env).deleteAdminAvailability(
        viewer,
        params.personId,
        {
          eventRevision: form.get("eventRevision"),
          windowId: form.get("windowId"),
          confirmation: form.get("confirmation"),
        },
      );
      const realtimeFailure =
        result.changeSequence != null
          ? await notifyRouteChange(
              env,
              viewer,
              result.changeSequence,
              result.personId,
            )
          : await recordRouteChange(env, viewer, {
              entityType: "person",
              entityId: result.personId,
              changeType: "updated",
            });
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message: `Removed unavailable period ${result.interval}.`,
      });
    }
    if (
      intent === "confirm_external_participation" ||
      intent === "reset_declined_participation"
    ) {
      const service = new SpeakerService(env);
      const result =
        intent === "confirm_external_participation"
          ? await service.confirmExternalParticipation(
              viewer,
              params.personId,
              {
                sessionId: form.get("sessionId"),
                participationRevision: form.get("participationRevision"),
                confirmation: form.get("confirmation"),
                externalConfirmation: form.get("externalConfirmation"),
              },
            )
          : await service.resetDeclinedParticipation(viewer, params.personId, {
              sessionId: form.get("sessionId"),
              participationRevision: form.get("participationRevision"),
              resetConfirmation: form.get("resetConfirmation"),
            });
      const realtimeFailure =
        result.changeSequence != null
          ? await notifyRouteChange(
              env,
              viewer,
              result.changeSequence,
              result.sessionId,
            )
          : result.changed
            ? await recordRouteChange(env, viewer, {
                entityType: "session",
                entityId: result.sessionId,
                changeType: "updated",
              })
            : null;
      if (realtimeFailure) return data(realtimeFailure, { status: 207 });
      return data({
        ok: true,
        message:
          intent === "confirm_external_participation"
            ? `Recorded external participation confirmation for “${result.title}”. Portal invitation acceptance remains separate.`
            : `Reset “${result.title}” to awaiting confirmation. No message was sent.`,
      });
    }
    const speakerService = new SpeakerService(env);
    let result: { webhookWarning: string | null };
    let realtimeFailure: CommittedRealtimeFailure | null;
    let successMessage: string;
    if (intent === "save_speaker_scoped_profile") {
      result = await speakerService.updateAdminScopedSpeakerProfile(
        viewer,
        params.personId,
        {
          profileRevision: form.get("profileRevision"),
          organisationProfileOperationId: form.get(
            "organisationProfileOperationId",
          ),
          travelProfileOperationId: form.get("travelProfileOperationId"),
          name: form.get("name"),
          biography: form.get("biography"),
          organisationName: form.get("organisationName"),
          jobTitle: form.get("jobTitle"),
          travelPreferences: form.get("travelPreferences"),
        },
      );
      realtimeFailure = await recordRouteChange(env, viewer, {
        entityType: "person",
        entityId: params.personId,
        changeType: "updated",
      });
      successMessage =
        "Organisation and event speaker details saved. The participant-owned public identity was unchanged.";
    } else {
      const canonicalResult = await speakerService.updateAdminSpeakerProfile(
        viewer,
        params.personId,
        {
          revision: form.get("revision"),
          name: form.get("name"),
          biography: form.get("biography"),
          pronunciation: form.get("pronunciation"),
          organisationName: form.get("organisationName"),
          jobTitle: form.get("jobTitle"),
          linkedinUrl: form.get("linkedinUrl"),
          xHandle: form.get("xHandle"),
          travelPreferences: form.get("travelPreferences"),
          profileStatus: form.get("profileStatus"),
        },
      );
      result = canonicalResult;
      realtimeFailure = await notifyRouteChange(
        env,
        viewer,
        canonicalResult.changeCursor,
        params.personId,
      );
      successMessage = `Profile saved. It is now ${statusPresentation("content", canonicalResult.profileStatus).label.toLowerCase()}.`;
    }
    const warning = [result.webhookWarning, realtimeFailure?.message]
      .filter(Boolean)
      .join(" ");
    if (warning) {
      return data(
        { ok: false, committed: true, message: warning },
        { status: 207 },
      );
    }
    return data({
      ok: true,
      message: successMessage,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return data(
        {
          ok: false,
          message: error.issues[0]?.message ?? "Review the speaker details.",
        },
        { status: 422 },
      );
    }
    if (error instanceof SpeakerProfileConflictError) {
      return data({ ok: false, message: error.message }, { status: 409 });
    }
    if (error instanceof ScheduleRevisionConflictError) {
      return data({ ok: false, message: error.message }, { status: 409 });
    }
    if (error instanceof SpeakerAdminStateError) {
      return data(
        { ok: false, message: error.message },
        { status: error.status },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function AdminSpeakerDetailRoute({
  loaderData,
}: Route.ComponentProps) {
  return <AdminSpeakerDetailPage loaderData={loaderData} />;
}
