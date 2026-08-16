import {
  FileAccessError,
  FileService,
} from "~/modules/files/file-service.server";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";
import type { Route } from "./+types/speaker-task-file-download";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  try {
    return await new FileService(env).participantTaskEvidenceDownload(
      viewer,
      params.assetId,
      params.versionId,
    );
  } catch (error) {
    if (error instanceof FileAccessError) {
      throw new Response(error.message, { status: 404 });
    }
    throw error;
  }
}
