import {
  FileAccessError,
  FileService,
} from "~/modules/files/file-service.server";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-speaker-file-download";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  await ensureDemoSpeakerData(env);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  try {
    return await new FileService(env).administratorSpeakerFileDownload(
      viewer,
      params.personId,
      params.assetId,
      {
        inlineHeadshot:
          new URL(request.url).searchParams.get("view") === "headshot",
      },
    );
  } catch (error) {
    if (error instanceof FileAccessError) {
      throw new Response(error.message, { status: 404 });
    }
    throw error;
  }
}
