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
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  await ensureDemoSpeakerData(env);
  const viewer = await requireSpeakerViewer(request, env, env.DEFAULT_EVENT_ID);
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
