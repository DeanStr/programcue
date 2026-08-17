import { data } from "react-router";
import { ZodError } from "zod";
import {
  ContentManagementService,
  ContentManagementStateError,
} from "~/modules/content/content-management-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import type { Route } from "./+types/admin-content-zip";

async function administrator(
  request: Request,
  context: Route.LoaderArgs["context"],
) {
  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, [
    "owner",
    "administrator",
  ]);
  return { env, viewer };
}

export async function loader({ request, context }: Route.LoaderArgs) {
  const { env, viewer } = await administrator(request, context);
  const search = new URL(request.url).searchParams;
  const operationId = search.get("operation");
  if (!operationId) {
    throw new Response("ZIP operation is required.", { status: 400 });
  }
  const service = new ContentManagementService(env);
  try {
    if (search.get("download") === "1") {
      return await service.downloadStoredZip(viewer, operationId);
    }
    return data(await service.zipOperationStatus(viewer, operationId));
  } catch (error) {
    if (error instanceof ContentManagementStateError) {
      throw new Response(error.message, { status: error.status });
    }
    throw error;
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    throw new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST" },
    });
  }
  const { env, viewer } = await administrator(request, context);
  const form = await request.formData();
  if (form.get("intent") !== "queue-zip") {
    throw new Response("Unsupported content-library action.", { status: 400 });
  }
  try {
    const result = await new ContentManagementService(env).queueZip(viewer, {
      manifest: form.get("manifest"),
      groupBy: form.get("groupBy"),
      confirmed: form.get("confirmed"),
    });
    return data(
      {
        ok: result.status !== "failed",
        ...result,
        message:
          result.status === "failed"
            ? (result.error ??
              "The ZIP export failed before it could be queued.")
            : "ZIP export queued. The download link will appear when the archive is ready.",
      },
      result.status === "failed" ? { status: 207 } : undefined,
    );
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
