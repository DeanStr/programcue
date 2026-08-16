import { data } from "react-router";
import {
  ContentManagementService,
  ContentManagementStateError,
} from "~/modules/content/content-management-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-content-file-versions";

function requestedPage(request: Request) {
  const raw = new URL(request.url).searchParams.get("page");
  if (raw === null) return 1;
  if (!/^[1-9]\d*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new Response("page must be a positive integer", { status: 400 });
  }
  return Number(raw);
}

export async function loader({ request, context, params }: Route.LoaderArgs) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  try {
    return {
      ok: true as const,
      ...(await new ContentManagementService(env).getFileVersions(
        viewer,
        params.assetId,
        requestedPage(request),
      )),
    };
  } catch (error) {
    if (error instanceof ContentManagementStateError) {
      return data(
        { ok: false as const, message: error.message },
        { status: error.status },
      );
    }
    throw error;
  }
}
