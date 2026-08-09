import type { Route } from "./+types/admin-task-file-download";
import {
  FileAccessError,
  FileService,
} from "~/modules/files/file-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { requireEventRole } from "~/platform/auth/authorize.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  if (!env.DEFAULT_EVENT_ID)
    throw new Response("DEFAULT_EVENT_ID is not configured", { status: 503 });
  await ensureDemoSpeakerData(env);
  const viewer = await requireEventRole(request, env, env.DEFAULT_EVENT_ID, [
    "owner",
    "administrator",
  ]);
  try {
    return await new FileService(env).administratorTaskEvidenceDownload(
      viewer,
      params.assetId,
      params.versionId,
    );
  } catch (error) {
    if (error instanceof FileAccessError)
      throw new Response(error.message, { status: 404 });
    throw error;
  }
}
