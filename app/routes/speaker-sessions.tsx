import { data, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";
import { SpeakerActionNotice } from "~/components/speaker-action-notice";
import { SpeakerSessionsPanel } from "~/components/speaker-dashboard-overview";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";
import {
  SpeakerAdminStateError,
  SpeakerService,
} from "~/modules/speakers/speaker-service.server";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/speaker-sessions";

export const meta = () => [{ title: "My Sessions · Program Cue" }];

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const form = await request.formData();
  if (form.get("intent") !== "confirm-participation") {
    return data(
      { ok: false, message: "Unsupported session action." },
      { status: 400 },
    );
  }
  try {
    const result = await new SpeakerService(env).confirmOwnParticipation(
      viewer,
      {
        sessionId: form.get("sessionId"),
        confirmation: form.get("confirmation"),
      },
    );
    const realtimeFailure = result.changed
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
        ? `Participation confirmed for “${result.title}”.`
        : `Participation for “${result.title}” was already confirmed.`,
    });
  } catch (error) {
    if (error instanceof ZodError) {
      return data(
        {
          ok: false,
          message:
            error.issues[0]?.message ?? "Confirm the selected session again.",
        },
        { status: 422 },
      );
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

export default function SpeakerSessions(_props: Route.ComponentProps) {
  const { portal } = useSpeakerWorkspace();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <>
      <div className="page-head">
        <div>
          <span className="pc-page-eyebrow">Programme</span>
          <h1>My sessions</h1>
          <p>Published schedule details and your role in each session.</p>
        </div>
      </div>
      <SpeakerActionNotice notice={actionData} />
      <SpeakerSessionsPanel
        portal={portal}
        busy={navigation.state !== "idle"}
      />
    </>
  );
}
