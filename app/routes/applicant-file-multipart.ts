import { ZodError, z } from "zod";
import { FilePolicyError } from "~/modules/files/file-policy";
import {
  FileScanDispatchConfigurationError,
  FileScanDispatchQueueError,
} from "~/modules/files/file-scan-dispatch.server";
import { FileAccessError } from "~/modules/files/file-service.server";
import {
  type ApplicantMultipartActor,
  FileMultipartConflictError,
  FileMultipartIncompleteError,
  FileMultipartStateError,
  MultipartUploadService,
} from "~/modules/files/multipart-upload.server";
import { R2S3ConfigurationError } from "~/modules/files/r2-s3-signing.server";
import { ensureDemoSubmissionForm } from "~/modules/submissions/demo-submissions.server";
import { SubmissionService } from "~/modules/submissions/submission-service.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  AbuseProtectionConfigurationError,
  AbuseRateLimitError,
  enforcePublicAbuseProtection,
  TurnstileRejectedError,
  TurnstileUnavailableError,
} from "~/platform/http/public-abuse-protection.server";
import {
  RequestBodyTooLargeError,
  readBoundedText,
} from "~/platform/http/read-body";
import type { Route } from "./+types/applicant-file-multipart";

const scopeSchema = z.object({
  submissionId: z.string().min(1).max(100),
  fieldId: z.string().regex(/^[a-z][a-z0-9_]{1,39}$/),
});
const OPERATIONS = new Set([
  "initiate",
  "resume",
  "list-parts",
  "part-url",
  "complete",
  "abort",
]);

function logApplicantUploadFailure(
  event: string,
  operation: string,
  error: unknown,
) {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(candidate)
    ? candidate
    : "UnknownError";
  console.error(
    JSON.stringify({
      level: "error",
      subsystem: "applicant-file-multipart",
      event,
      operation,
      errorName,
      // A slug, never the message: several distinct configuration faults share
      // one error class, and the class alone cannot tell them apart. The
      // message names the variable, which must stay out of logs.
      ...(typeof (error as { reason?: unknown })?.reason === "string"
        ? { reason: (error as { reason: string }).reason }
        : {}),
      message: "An applicant file upload request could not be completed.",
    }),
  );
}

function response(body: unknown, status = 200, headers?: HeadersInit) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "private, no-store", ...headers },
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
  if (!params.slug || !params.operation || !OPERATIONS.has(params.operation))
    return response({ error: "That upload step is not supported." }, 404);
  const { env } = getCloudflareContext(context);
  try {
    await ensureDemoSubmissionForm(env);
    const rawBody = await readBoundedText(request, 128_000);
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return response(
        {
          error:
            "That request could not be read. Reload the page and try again.",
        },
        400,
      );
    }
    const scopeInput = scopeSchema.parse(body);
    const authorized = await new SubmissionService(
      env,
    ).authorizeApplicantMultipartUpload(
      request,
      params.slug,
      scopeInput.submissionId,
      scopeInput.fieldId,
    );
    const actor: ApplicantMultipartActor = { kind: "applicant", ...authorized };
    const service = new MultipartUploadService(env);
    if (params.operation === "initiate" || params.operation === "resume") {
      const idempotencyKey = request.headers.get("idempotency-key")?.trim();
      if (!idempotencyKey)
        return response(
          {
            error:
              "That request was missing information needed to avoid duplicates. Reload the page and try again.",
          },
          400,
        );
      const record = z
        .object({
          filename: z.string(),
          contentType: z.string(),
          sizeBytes: z.number(),
          turnstileToken: z.string().max(2_048).optional(),
        })
        .parse(body);
      if (params.operation === "initiate")
        await enforcePublicAbuseProtection({
          env,
          request,
          action: "application_file_upload",
          tenantId: actor.eventId,
          email: actor.personId ?? actor.submissionId,
          turnstileToken: record.turnstileToken ?? "",
        });
      const uploadInput = {
        target: {
          targetType: "submission" as const,
          targetId: actor.submissionId,
          assetKind: "video" as const,
        },
        filename: record.filename,
        contentType: record.contentType,
        sizeBytes: record.sizeBytes,
        idempotencyKey,
      };
      if (params.operation === "resume")
        return response({
          ok: true,
          upload: await service.resume(actor, uploadInput),
        });
      return response(
        {
          ok: true,
          upload: await service.initiate(actor, uploadInput),
        },
        201,
      );
    }
    if (params.operation === "list-parts")
      return response({ ok: true, ...(await service.listParts(actor, body)) });
    if (params.operation === "part-url")
      return response({
        ok: true,
        part: await service.createPartUrl(actor, body),
      });
    if (params.operation === "complete")
      return response({
        ok: true,
        upload: await service.complete(actor, body),
      });
    return response({ ok: true, upload: await service.abort(actor, body) });
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError)
      return response({ error: "That request was too large to process." }, 413);
    if (error instanceof Response) return error;
    if (error instanceof ZodError)
      return response(
        {
          error:
            error.issues[0]?.message ??
            "That upload request could not be read.",
          issues: error.issues,
        },
        422,
      );
    if (error instanceof FileAccessError)
      return response({ error: error.message }, 403);
    if (error instanceof FilePolicyError)
      return response({ error: error.message }, 422);
    if (error instanceof AbuseRateLimitError)
      return response({ error: error.message }, 429, {
        "retry-after": String(error.retryAfterSeconds),
      });
    if (error instanceof TurnstileRejectedError)
      return response({ error: error.message }, 422);
    if (error instanceof R2S3ConfigurationError) {
      logApplicantUploadFailure(
        "upload-configuration-unavailable",
        params.operation,
        error,
      );
      return response(
        { error: "Uploads are unavailable right now. Try again later." },
        503,
      );
    }
    if (
      error instanceof AbuseProtectionConfigurationError ||
      error instanceof TurnstileUnavailableError ||
      error instanceof FileScanDispatchConfigurationError
    ) {
      logApplicantUploadFailure(
        "dependency-unavailable",
        params.operation,
        error,
      );
      return response(
        { error: "Uploads are unavailable right now. Try again later." },
        503,
      );
    }
    if (
      error instanceof FileMultipartStateError ||
      error instanceof FileMultipartConflictError
    )
      return response({ error: error.message }, 409);
    if (error instanceof FileMultipartIncompleteError)
      return response(
        { error: error.message, committed: error.committed },
        503,
      );
    if (error instanceof FileScanDispatchQueueError)
      return response(
        {
          error: error.message,
          committed: true,
          operationId: error.operationId,
        },
        503,
      );
    throw error;
  }
}

export function loader() {
  return methodNotAllowed();
}
