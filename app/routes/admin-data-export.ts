import type { ActionFunctionArgs } from "react-router";
import { z, ZodError } from "zod";

import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import { rejectCrossOriginBrowserMutation } from "~/platform/http/mutation-origin.server";
import {
  DataExportService,
  DataExportIdempotencyConflictError,
  EventExportTooLargeError,
} from "~/platform/operations/data-export-service.server";

export function loader() {
  return new Response("Event data exports require POST.", {
    status: 405,
    headers: {
      allow: "POST",
      "cache-control": "private, no-store",
    },
  });
}

export async function action({ request, context, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "POST") {
    return loader();
  }
  const rejectedOrigin = rejectCrossOriginBrowserMutation(request);
  if (rejectedOrigin) return rejectedOrigin;

  const { env } = getCloudflareContext(context);
  const viewer = await requireCurrentEventRole(request, env, ["owner"]);
  const form = await request.formData();
  const intentKey = z.uuid().safeParse(form.get("idempotencyKey"));
  if (!intentKey.success) {
    throw new Response("A valid export intent key is required.", {
      status: 422,
      headers: { "cache-control": "private, no-store" },
    });
  }
  try {
    const exported = await new DataExportService(env).export(
      viewer,
      params.resource,
      intentKey.data,
    );
    const headers = new Headers({
      "content-type": "text/csv; charset=utf-8",
      "cache-control": "private, no-store",
      "content-disposition": `attachment; filename="program-cue-${exported.resource}.csv"`,
      "x-program-cue-operation": exported.operationId,
    });
    return new Response(exported.csv, { headers });
  } catch (error) {
    if (error instanceof DataExportIdempotencyConflictError) {
      throw new Response(error.message, { status: 409 });
    }
    if (error instanceof ZodError) {
      throw new Response("Export resource not found", { status: 404 });
    }
    if (error instanceof EventExportTooLargeError) {
      throw new Response(error.message, { status: 413 });
    }
    throw error;
  }
}
