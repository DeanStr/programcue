import type { Route } from "./+types/speaker-file-download";
import {
  FileAccessError,
  FileScanPendingError,
  FileService,
} from "~/modules/files/file-service.server";
import {
  ensureDemoSpeakerData,
  requireSpeakerViewer,
} from "~/modules/speakers/demo.server";
import { resolveCurrentEventId } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const eventId = await resolveCurrentEventId(request, env, ["speaker"]);
  const viewer = await requireSpeakerViewer(request, env, eventId);
  try {
    return await new FileService(env).participantDownload(
      viewer,
      params.assetId,
    );
  } catch (error) {
    if (error instanceof FileAccessError)
      throw new Response(error.message, { status: 404 });
    if (error instanceof FileScanPendingError)
      throw new Response(error.message, { status: 423 });
    throw error;
  }
}
