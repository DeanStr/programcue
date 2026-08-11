import { z, ZodError } from "zod";

import type { Route } from "./+types/resource-attachment";
import {
  FileDiscardIncompleteError,
  FileService,
} from "~/modules/files/file-service.server";
import {
  ResourceRevisionConflictError,
  ResourceService,
} from "~/modules/resources/resource-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  readBoundedText,
  RequestBodyTooLargeError,
} from "~/platform/http/read-body";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

const attachmentSchema = z.object({
  pageId: z.string().min(1).max(160),
  pageVersionId: z.string().min(1).max(160),
  revision: z.number().int().nonnegative(),
  assetId: z.string().min(1).max(160),
  fileVersionId: z.string().min(1).max(160),
});

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST")
    return new Response("Method not allowed", {
      status: 405,
      headers: { allow: "POST", "cache-control": "no-store" },
    });
  const { env } = getCloudflareContext(context);
  try {
    const viewer = await requireCurrentEventRole(
      request,
      env,
      ["owner", "administrator"],
      "response",
    );
    const raw = await readBoundedText(request, 16_000);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return response({ error: "Request body must contain valid JSON." }, 400);
    }
    const input = attachmentSchema.parse(body);
    try {
      await new ResourceService(env).attachToDraft(
        viewer,
        input.pageId,
        input.pageVersionId,
        input.revision,
        input.assetId,
        input.fileVersionId,
      );
    } catch (error) {
      if (!(error instanceof ResourceRevisionConflictError)) throw error;
      await new FileService(env).discardUnattachedResourceUpload(viewer, {
        assetId: input.assetId,
        versionId: input.fileVersionId,
      });
      return response(
        {
          error: `${error.message} The unattached upload was discarded; reload the latest draft before choosing the file again.`,
        },
        409,
      );
    }
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "resource_page",
      entityId: input.pageId,
      changeType: "updated",
    });
    if (realtimeFailure) return response(realtimeFailure, 207);
    return response({
      ok: true,
      message:
        "Attachment linked to this draft version and retained in quarantine pending scan.",
    });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return response({ error: "Attachment request exceeds 16 KB." }, 413);
    if (error instanceof ZodError)
      return response(
        {
          error: error.issues[0]?.message ?? "Invalid attachment request.",
        },
        422,
      );
    if (error instanceof FileDiscardIncompleteError)
      return response(
        {
          error: error.message,
          committed: true,
          operationId: error.operationId,
        },
        503,
      );
    if (error instanceof Response) return error;
    throw error;
  }
}

export function loader() {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: "POST", "cache-control": "no-store" },
  });
}
