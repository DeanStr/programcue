import { z, ZodError } from "zod";

import type { Route } from "./+types/task-evidence-attachment";
import { ensureDemoSpeakerData } from "~/modules/speakers/demo.server";
import {
  TaskEvidenceAttachmentConflictError,
  TaskService,
  TaskStateError,
} from "~/modules/tasks/task-service.server";
import {
  FileDiscardIncompleteError,
  FileService,
} from "~/modules/files/file-service.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  readBoundedText,
  RequestBodyTooLargeError,
} from "~/platform/http/read-body";
import { recordRouteChange } from "~/platform/realtime/route-realtime.server";

const attachmentSchema = z.object({
  taskId: z.string().min(1).max(160),
  assetId: z.string().min(1).max(160),
  versionId: z.string().min(1).max(160),
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
    await ensureDemoSpeakerData(env);
    const viewer = await requireCurrentEventRole(
      request,
      env,
      ["speaker", "submitter"],
      "response",
    );
    const raw = await readBoundedText(request, 16_000);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return response(
        {
          error:
            "That request could not be read. Reload the page and try again.",
        },
        400,
      );
    }
    const input = attachmentSchema.parse(body);
    let result: Awaited<ReturnType<TaskService["attachCompletedFileEvidence"]>>;
    try {
      result = await new TaskService(env).attachCompletedFileEvidence(
        viewer,
        input,
      );
    } catch (error) {
      if (!(error instanceof TaskEvidenceAttachmentConflictError)) throw error;
      await new FileService(env).discardUnattachedTaskUpload(
        viewer,
        { assetId: input.assetId, versionId: input.versionId },
        input.taskId,
      );
      return response(
        {
          error: `${error.message} The unattached upload was discarded; reload the latest task before choosing the file again.`,
          discarded: true,
        },
        409,
      );
    }
    const realtimeFailure = await recordRouteChange(env, viewer, {
      entityType: "task_instance",
      entityId: input.taskId,
      changeType: "progress",
    });
    const warning = [result.webhookWarning, realtimeFailure?.message]
      .filter(Boolean)
      .join(" ");
    if (warning)
      return response(
        {
          ok: false,
          committed: true,
          message: warning,
        },
        207,
      );
    return response({
      ok: true,
      message: result.duplicate
        ? "This exact file version was already attached to the task."
        : "File evidence attached and awaiting administrator review. It remains quarantined until its malware scan passes.",
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
    if (error instanceof TaskStateError)
      return response({ error: error.message }, 409);
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
