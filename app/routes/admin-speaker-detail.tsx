import { data, useLoaderData } from "react-router";
import { ZodError } from "zod";
import { AdminSpeakerDetailPage } from "~/components/admin-speaker-detail-page";
import { statusPresentation } from "~/components/ui/domain-status-badge";
import { adminRecordBreadcrumbHandle } from "~/modules/administration/admin-route-breadcrumb";
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
  return {
    detail: await new SpeakerService(env).getAdminSpeakerDetail(
      viewer,
      params.personId,
    ),
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
    intent !== "confirm_external_participation"
  ) {
    return data(
      { ok: false, message: "Unsupported speaker action." },
      { status: 400 },
    );
  }
  try {
    if (intent === "confirm_external_participation") {
      const result = await new SpeakerService(env).confirmExternalParticipation(
        viewer,
        params.personId,
        {
          sessionId: form.get("sessionId"),
          confirmation: form.get("confirmation"),
          externalConfirmation: form.get("externalConfirmation"),
        },
      );
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
        message: result.changed
          ? `Recorded external participation confirmation for “${result.title}”. Portal invitation acceptance remains separate.`
          : `Participation for “${result.title}” was already confirmed.`,
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

export default function AdminSpeakerDetailRoute() {
  return <AdminSpeakerDetailPage loaderData={useLoaderData<typeof loader>()} />;
}
