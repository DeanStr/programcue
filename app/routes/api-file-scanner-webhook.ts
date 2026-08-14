import { ZodError } from "zod";

import type { Route } from "./+types/api-file-scanner-webhook";
import {
  FileScanConflictError,
  FileScanStateError,
  FileService,
  FileVersionNotFoundError,
} from "~/modules/files/file-service.server";
import {
  scannerCallbackPayloadSchema,
  ScannerCallbackAuthenticationError,
  ScannerCallbackConfigurationError,
  verifyScannerCallback,
} from "~/modules/files/scanner-callback.server";
import { getCloudflareContext } from "~/platform/cloudflare-context";
import {
  readBoundedText,
  RequestBodyTooLargeError,
} from "~/platform/http/read-body";

function logScannerCallbackFailure(error: unknown) {
  const candidate = error instanceof Error ? error.name : "UnknownError";
  const errorName = /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(candidate)
    ? candidate
    : "UnknownError";
  console.error(
    JSON.stringify({
      level: "error",
      subsystem: "file-scanner-callback",
      event: "configuration-unavailable",
      errorName,
      message: "The scanner callback configuration is unavailable.",
    }),
  );
}

function methodNotAllowed() {
  return new Response("Method not allowed", {
    status: 405,
    headers: { allow: "POST" },
  });
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") return methodNotAllowed();
  const { env } = getCloudflareContext(context);
  let rawBody: string;
  try {
    rawBody = await readBoundedText(request, 128_000);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return Response.json(
        { error: "Scanner callback payload exceeds 128 KB." },
        { status: 413 },
      );
    }
    throw error;
  }

  let callbackId: string;
  try {
    ({ callbackId } = await verifyScannerCallback({
      env,
      headers: request.headers,
      rawBody,
    }));
  } catch (error) {
    if (error instanceof ScannerCallbackConfigurationError) {
      logScannerCallbackFailure(error);
      return Response.json(
        { error: "File scanner callback configuration is unavailable." },
        { status: 503 },
      );
    }
    if (error instanceof ScannerCallbackAuthenticationError) {
      return Response.json({ error: error.message }, { status: 401 });
    }
    throw error;
  }

  const mediaType =
    request.headers
      .get("content-type")
      ?.split(";", 1)[0]
      ?.trim()
      .toLowerCase() ?? "";
  if (mediaType !== "application/json") {
    return Response.json(
      { error: "Scanner callback Content-Type must be application/json." },
      { status: 415 },
    );
  }

  try {
    const payload = scannerCallbackPayloadSchema.parse(JSON.parse(rawBody));
    const result = await new FileService(env).recordScanResult({
      jobId: payload.jobId,
      attempt: payload.attempt,
      organisationId: payload.organisationId,
      eventId: payload.eventId,
      versionId: payload.versionId,
      assetId: payload.assetId,
      objectKey: payload.object.key,
      objectEtag: payload.object.etag,
      sizeBytes: payload.object.sizeBytes,
      provider: payload.provider,
      callbackId,
      status: payload.verdict === "error" ? "failed" : payload.verdict,
      result: payload.result ?? null,
      error: payload.verdict === "error" ? payload.error : undefined,
    });
    return Response.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof ZodError) {
      return Response.json(
        { error: "Scanner callback body is not a supported JSON payload." },
        { status: 400 },
      );
    }
    if (error instanceof FileVersionNotFoundError) {
      return Response.json({ error: error.message }, { status: 404 });
    }
    if (
      error instanceof FileScanConflictError ||
      error instanceof FileScanStateError
    ) {
      return Response.json({ error: error.message }, { status: 409 });
    }
    throw error;
  }
}

export function loader() {
  throw methodNotAllowed();
}
