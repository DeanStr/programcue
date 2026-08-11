import { data, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";

import type { Route } from "./+types/speaker-profile";
import { SpeakerActionNotice } from "~/components/speaker-action-notice";
import { SpeakerProfilePanel } from "~/components/speaker-files-profile-panels";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";
import {
  SpeakerProfileConflictError,
  SpeakerService,
} from "~/modules/speakers/speaker-service.server";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

export const meta = () => [{ title: "Speaker Profile · Program Cue" }];

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const form = await request.formData();
  if (form.get("intent") !== "save-profile") {
    return data(
      { ok: false, message: "Unsupported speaker profile action." },
      { status: 400 },
    );
  }
  try {
    const result = await new SpeakerService(env).updateProfile(viewer, {
      revision: form.get("revision"),
      name: form.get("name"),
      biography: form.get("biography"),
      pronunciation: form.get("pronunciation"),
      organisationName: form.get("organisationName"),
      jobTitle: form.get("jobTitle"),
      publish: form.get("publish") ? "true" : "false",
    });
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "person",
      entityId: viewer.personId,
      changeType: "updated",
    });
    const warning = [result.webhookWarning, realtimeFailure?.message]
      .filter(Boolean)
      .join(" ");
    if (warning) {
      return data(
        { ok: false, committed: true, message: warning },
        { status: 207 },
      );
    }
    return data({ ok: true, message: "Profile saved to D1." });
  } catch (error) {
    const message =
      error instanceof ZodError
        ? (error.issues[0]?.message ?? "Review the highlighted information.")
        : error instanceof SpeakerProfileConflictError
          ? error.message
          : null;
    if (message) {
      return data(
        { ok: false, message },
        { status: error instanceof SpeakerProfileConflictError ? 409 : 422 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function SpeakerProfile(_props: Route.ComponentProps) {
  const { portal } = useSpeakerWorkspace();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <>
      <div className="page-head">
        <div>
          <span className="pc-page-eyebrow">Public identity</span>
          <h1>Speaker profile</h1>
          <p>Review the identity and biography used across the programme.</p>
        </div>
      </div>
      <SpeakerActionNotice notice={actionData} />
      <SpeakerProfilePanel portal={portal} busy={navigation.state !== "idle"} />
    </>
  );
}
