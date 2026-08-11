import { ZodError } from "zod";

import type { Route } from "./+types/file-multipart";
import { FilePolicyError } from "~/modules/files/file-policy";
import {
  FileScanDispatchConfigurationError,
  FileScanDispatchQueueError,
} from "~/modules/files/file-scan-dispatch.server";
import { FileAccessError } from "~/modules/files/file-service.server";
import {
  FileMultipartConflictError,
  FileMultipartIncompleteError,
  FileMultipartStateError,
  MultipartUploadService,
} from "~/modules/files/multipart-upload.server";
import { R2S3ConfigurationError } from "~/modules/files/r2-s3-signing.server";
import { requireCurrentEventRole } from "~/platform/auth/current-event.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  readBoundedText,
  RequestBodyTooLargeError,
} from "~/platform/http/read-body";

const OPERATIONS = new Set([
  "initiate",
  "resume",
  "list-parts",
  "part-url",
  "complete",
  "abort",
]);

function logMultipartFailure(event: string, operation: string, error: unknown) {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(candidate)
    ? candidate
    : "UnknownError";
  console.error(
    JSON.stringify({
      level: "error",
      subsystem: "file-multipart",
      event,
      operation,
      errorName,
      message: "The direct multipart request could not be completed.",
    }),
  );
}

function response(body: unknown, status = 200) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store" },
  });
}

function methodNotAllowed() {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: "POST", "cache-control": "no-store" },
  });
}

export async function action({ request, params, context }: Route.ActionArgs) {
  if (request.method !== "POST") return methodNotAllowed();
  if (!params.operation || !OPERATIONS.has(params.operation))
    return response({ error: "Unsupported multipart operation." }, 404);
  const { env } = getCloudflareContext(context);
  try {
    const viewer = await requireCurrentEventRole(
      request,
      env,
      [
        "owner",
        "administrator",
        "committee_chair",
        "evaluator",
        "submitter",
        "speaker",
      ],
      "response",
    );
    const rawBody = await readBoundedText(request, 128_000);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return response({ error: "Request body must contain valid JSON." }, 400);
    }
    const service = new MultipartUploadService(env);
    if (params.operation === "initiate" || params.operation === "resume") {
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (!idempotencyKey)
        return response(
          { error: "An Idempotency-Key header is required." },
          400,
        );
      const record =
        typeof body === "object" && body !== null
          ? { ...body, idempotencyKey }
          : body;
      if (params.operation === "resume")
        return response({ ok: true, upload: await service.resume(viewer, record) });
      return response(
        { ok: true, upload: await service.initiate(viewer, record) },
        201,
      );
    }
    if (params.operation === "list-parts")
      return response({ ok: true, ...(await service.listParts(viewer, body)) });
    if (params.operation === "part-url")
      return response({ ok: true, part: await service.createPartUrl(viewer, body) });
    if (params.operation === "complete")
      return response({ ok: true, upload: await service.complete(viewer, body) });
    return response({ ok: true, upload: await service.abort(viewer, body) });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return response({ error: "Multipart request exceeds 128 KB." }, 413);
    if (error instanceof ZodError)
      return response(
        {
          error: error.issues[0]?.message ?? "Invalid multipart request.",
          issues: error.issues,
        },
        422,
      );
    if (error instanceof FileAccessError)
      return response({ error: error.message }, 403);
    if (error instanceof FilePolicyError)
      return response({ error: error.message }, 422);
    if (error instanceof R2S3ConfigurationError) {
      logMultipartFailure(
        "upload-configuration-unavailable",
        params.operation,
        error,
      );
      return response({ error: error.message }, 503);
    }
    if (error instanceof FileScanDispatchConfigurationError) {
      logMultipartFailure(
        "scan-configuration-unavailable",
        params.operation,
        error,
      );
      return response({ error: error.message }, 503);
    }
    if (
      error instanceof FileMultipartStateError ||
      error instanceof FileMultipartConflictError
    )
      return response({ error: error.message }, 409);
    if (error instanceof FileMultipartIncompleteError) {
      logMultipartFailure(
        "provider-operation-incomplete",
        params.operation,
        error,
      );
      return response(
        { error: error.message, committed: error.committed },
        503,
      );
    }
    if (error instanceof FileScanDispatchQueueError) {
      logMultipartFailure("scan-queue-unavailable", params.operation, error);
      return response(
        {
          error: error.message,
          committed: true,
          operationId: error.operationId,
        },
        503,
      );
    }
    if (error instanceof Response) throw error;
    throw error;
  }
}

export function loader() {
  return methodNotAllowed();
}
