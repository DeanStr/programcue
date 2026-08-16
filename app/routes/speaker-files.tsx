import { data, useActionData, useNavigation } from "react-router";
import { SpeakerActionNotice } from "~/components/speaker-action-notice";
import { SpeakerFilesPanel } from "~/components/speaker-files-profile-panels";
import { useSpeakerWorkspace } from "~/components/speaker-workspace-context";
import {
  FileAccessError,
  FileErasureConfirmationError,
  FileErasureIncompleteError,
  FileService,
} from "~/modules/files/file-service.server";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import { notifyRouteChange } from "~/platform/realtime/route-realtime.server";
import type { Route } from "./+types/speaker-files";

export const meta = () => [{ title: "Participant Files · Program Cue" }];

export async function action({ request, context }: Route.ActionArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  const form = await request.formData();
  if (form.get("intent") !== "delete-file") {
    return data(
      { ok: false, message: "Unsupported participant file action." },
      { status: 400 },
    );
  }
  try {
    const result = await new FileService(env).eraseAsset(viewer, {
      assetId: String(form.get("assetId") ?? ""),
      confirmed: form.get("confirm") === "erase-all-versions",
      reason: "speaker_requested_file_deletion",
    });
    const realtimeFailure =
      result.changeSequence === null
        ? null
        : await notifyRouteChange(
            env,
            viewer,
            result.changeSequence,
            result.affected.id,
          );
    if (realtimeFailure) return data(realtimeFailure, { status: 207 });
    return data({
      ok: true,
      message: result.duplicate
        ? "This file was already erased."
        : `${result.erasedVersions} stored file version${result.erasedVersions === 1 ? " was" : "s were"} permanently erased.`,
    });
  } catch (error) {
    if (error instanceof FileErasureIncompleteError) {
      console.error(
        JSON.stringify({
          level: "error",
          subsystem: "speaker-file-erasure",
          event: "erasure-incomplete",
          errorName: error.name,
          message: "The private file erasure did not complete.",
        }),
      );
      return data(
        { ok: false, committed: true, message: error.message },
        { status: 503 },
      );
    }
    if (
      error instanceof FileAccessError ||
      error instanceof FileErasureConfirmationError
    ) {
      return data(
        { ok: false, message: error.message },
        { status: error instanceof FileAccessError ? 403 : 422 },
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export default function SpeakerFiles(_props: Route.ComponentProps) {
  const { portal } = useSpeakerWorkspace();
  const actionData = useActionData<typeof action>();
  const navigation = useNavigation();
  return (
    <>
      <div className="page-head">
        <div>
          <span className="pc-page-eyebrow">Private participant workspace</span>
          <h1>Files</h1>
          <p>
            Upload, inspect and manage the files shared with the event team.
          </p>
        </div>
      </div>
      <SpeakerActionNotice notice={actionData} />
      <SpeakerFilesPanel portal={portal} busy={navigation.state !== "idle"} />
    </>
  );
}
