import {
  ContentManagementService,
  ContentManagementStateError,
} from "~/modules/content/content-management-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-content-file-version-download";

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  try {
    return await new ContentManagementService(env).downloadFileVersion(
      viewer,
      params.assetId,
      params.versionId,
    );
  } catch (error) {
    if (error instanceof ContentManagementStateError) {
      throw new Response(error.message, { status: error.status });
    }
    throw error;
  }
}
