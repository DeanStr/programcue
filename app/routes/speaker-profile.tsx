import { data, useActionData, useNavigation } from "react-router";
import { ZodError } from "zod";
import { SpeakerActionNotice } from "~/components/speaker-action-notice";
import { SpeakerProfilePanel } from "~/components/speaker-files-profile-panels";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";
import {
  EventFieldService,
  EventFieldStateError,
} from "~/modules/fields/event-field-service.server";
import {
  SpeakerProfileConflictError,
  SpeakerService,
} from "~/modules/speakers/speaker-service.server";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import type { Route } from "./+types/speaker-profile";

export const meta = () => [{ title: "Participant Profile · Program Cue" }];

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const form = await request.formData();
  const intent = form.get("intent");
  if (intent !== "save-profile" && intent !== "save-custom-fields") {
    return data(
      { ok: false, message: "Unsupported participant profile action." },
      { status: 400 },
    );
  }
  try {
    const fields = new EventFieldService(env);
    if (intent === "save-custom-fields") {
      await fields.saveValues(viewer, "person", viewer.personId, form, true);
      return data({ ok: true, message: "Your event fields were saved." });
    }
    const protectedProfile = await fields.participantProfileInput(viewer, form);
    const result = await new SpeakerService(env).updateProfile(viewer, {
      revision: form.get("revision"),
      ...protectedProfile,
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
        : error instanceof SpeakerProfileConflictError ||
            error instanceof EventFieldStateError
          ? error.message
          : null;
    if (message) {
      return data(
        { ok: false, message },
        {
          status:
            error instanceof SpeakerProfileConflictError
              ? 409
              : error instanceof EventFieldStateError
                ? error.status
                : 422,
        },
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
