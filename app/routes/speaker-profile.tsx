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

export const meta = () => [{ title: "Participant Profile · Program Cue" }];

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const form = await request.formData();
  if (form.get("intent") !== "save-profile") {
    return data(
      { ok: false, message: "Unsupported participant profile action." },
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
      linkedinUrl: form.get("linkedinUrl"),
      xHandle: form.get("xHandle"),
      travelPreferences: form.get("travelPreferences"),
      publish: form.get("publish") ? "true" : "false",
    });
    const warning = [result.webhookWarning, result.realtimeWarning]
      .filter(Boolean)
      .join(" ");
    if (warning) {
      return data(
        { ok: false, committed: true, message: warning },
        { status: 207 },
      );
    }
    return data({ ok: true, message: "Your profile was saved." });
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
          <h1>Profile</h1>
          <p>
            Manage the identity and biography used for your applications and
            published sessions.
          </p>
        </div>
      </div>
      <SpeakerActionNotice notice={actionData} />
      <SpeakerProfilePanel portal={portal} busy={navigation.state !== "idle"} />
    </>
  );
}
