import { ZodError } from "zod";
import {
  ContentManagementService,
  ContentManagementStateError,
} from "~/modules/content/content-management-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-content-zip";

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  const form = await request.formData();
  if (form.get("intent") !== "download-zip") {
    throw new Response("Unsupported content-library action.", { status: 400 });
  }
  try {
    return await new ContentManagementService(env).downloadZip(viewer, {
      manifest: form.get("manifest"),
      groupBy: form.get("groupBy"),
      confirmed: form.get("confirmed"),
    });
  } catch (error) {
    if (error instanceof ZodError) {
      throw new Response(
        error.issues[0]?.message ?? "Review the selected file export.",
        { status: 422 },
      );
    }
    if (error instanceof ContentManagementStateError) {
      throw new Response(error.message, { status: error.status });
    }
    throw error;
  }
}
