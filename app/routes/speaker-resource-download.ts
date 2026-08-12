import type { Route } from "./+types/speaker-resource-download";
import {
  FileAccessError,
  FileService,
} from "~/modules/files/file-service.server";
import { requireSpeakerWorkspace } from "~/modules/speakers/speaker-workspace.server";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env, viewer } = await requireSpeakerWorkspace(request, context);
  try {
    return await new FileService(env).participantResourceDownload(
      viewer,
      params.assetId,
    );
  } catch (error) {
    if (error instanceof FileAccessError)
      throw new Response(error.message, { status: 404 });
    throw error;
  }
}
