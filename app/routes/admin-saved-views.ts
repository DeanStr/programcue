import { type ActionFunctionArgs, redirect } from "react-router";
import { ZodError } from "zod";

import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  SavedViewNameConflictError,
  SavedViewService,
} from "~/platform/operations/saved-view-service.server";

function returnLocation(value: FormDataEntryValue | null) {
  const path = typeof value === "string" ? value.trim() : "";
  return path.startsWith("/admin/") && !path.startsWith("//")
    ? path
    : "/admin/command";
}

export async function action({ request, context }: ActionFunctionArgs) {
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
  const service = new SavedViewService(env);
  try {
    if (form.get("intent") === "create") {
      await service.create(viewer, {
        area: form.get("area"),
        name: form.get("name"),
        href: form.get("href"),
        visibility: form.get("visibility"),
      });
    } else if (form.get("intent") === "delete") {
      await service.remove(viewer, String(form.get("viewId") ?? ""));
    } else {
      throw new Response("Unsupported saved-view action", { status: 400 });
    }
    const destination = new URL(
      returnLocation(form.get("returnTo")),
      request.url,
    );
    destination.searchParams.set("savedView", "updated");
    throw redirect(`${destination.pathname}${destination.search}`);
  } catch (error) {
    if (error instanceof Response) throw error;
    if (error instanceof SavedViewNameConflictError) {
      throw new Response(error.message, { status: 409 });
    }
    if (error instanceof ZodError) {
      throw new Response(
        error.issues[0]?.message ?? "The saved view is invalid.",
        { status: 422 },
      );
    }
    throw error;
  }
}
