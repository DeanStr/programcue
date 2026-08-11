import { z } from "zod";

import { API_KEY_SCOPES, type ApiKeyScope } from "./api-key-service.server";
import {
  readBoundedText,
  RequestBodyTooLargeError,
} from "~/platform/http/read-body";
import { requestCorrelationId } from "~/platform/observability/request-correlation";
import { mayExposeInternalErrors } from "~/platform/runtime-environment.server";

const encoder = new TextEncoder();

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export type ApiPrincipal = {
  keyId: string;
  organisationId: string;
  eventId: string | null;
  scopes: ReadonlySet<ApiKeyScope>;
};

function json(body: unknown, init: ResponseInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  if (!headers.has("cache-control")) headers.set("cache-control", "no-store");
  return Response.json(body, { ...init, headers });
}

export function correlationId(request: Request) {
  return requestCorrelationId(request);
}

export function apiSuccess(
  body: Record<string, unknown>,
  status = 200,
  headers?: HeadersInit,
) {
  return json(body, { status, headers });
}

export function apiFailure(
  error: unknown,
  request: Request,
  environment: string,
  suppliedCorrelationId?: string,
) {
  const requestId = suppliedCorrelationId ?? correlationId(request);
  if (error instanceof ApiError) {
    return json(
      {
        error: {
          code: error.code,
          message: error.message,
          ...(error.details === undefined ? {} : { details: error.details }),
        },
        correlationId: requestId,
      },
      { status: error.status },
    );
  }

  console.error(
    JSON.stringify({
      level: "error",
      subsystem: "api-request",
      event: "unhandled-error",
      correlationId: requestId,
      method: request.method,
      errorName: error instanceof Error ? error.name : "UnknownError",
      message: "The API request failed unexpectedly.",
    }),
  );
  return json(
    {
      error: {
        code: "INTERNAL_ERROR",
        message: mayExposeInternalErrors(environment)
          ? String(error)
          : "Unexpected server error",
      },
      correlationId: requestId,
    },
    { status: 500 },
  );
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function requireIdempotencyKey(request: Request) {
  const key = request.headers.get("idempotency-key")?.trim() ?? "";
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw new ApiError(
      422,
      "INVALID_IDEMPOTENCY_KEY",
      "Idempotency-Key is required and must contain 8 to 128 letters, digits, periods, underscores, colons or hyphens",
    );
  }
  return key;
}

export function apiRequestHash(value: unknown) {
  return sha256(JSON.stringify(value));
}

const scopesSchema = z.array(z.enum(API_KEY_SCOPES)).max(API_KEY_SCOPES.length);

export function requireApiMethod(request: Request, method: "POST") {
  if (request.method.toUpperCase() !== method) {
    throw new ApiError(
      405,
      "METHOD_NOT_ALLOWED",
      `This endpoint requires ${method}`,
    );
  }
}

export async function requireApiKey(
  request: Request,
  env: CloudflareEnvironment,
  requiredScope: ApiKeyScope,
  requestedEventId?: string,
): Promise<ApiPrincipal> {
  const authorization = request.headers.get("authorization") ?? "";
  if (!authorization.startsWith("Bearer ")) {
    throw new ApiError(
      401,
      "AUTH_REQUIRED",
      "Bearer API key authentication is required",
    );
  }
  const token = authorization.slice("Bearer ".length).trim();
  if (!token)
    throw new ApiError(
      401,
      "AUTH_REQUIRED",
      "Bearer API key authentication is required",
    );

  const keyHash = await sha256(token);
  const key = await env.DB.prepare(
    `
    SELECT id, organisation_id AS organisationId, event_id AS eventId, scopes_json AS scopesJson
      FROM api_keys
     WHERE key_hash = ?
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > unixepoch())
     LIMIT 1
  `,
  )
    .bind(keyHash)
    .first<{
      id: string;
      organisationId: string;
      eventId: string | null;
      scopesJson: string;
    }>();
  if (!key)
    throw new ApiError(
      403,
      "AUTH_FORBIDDEN",
      "The supplied API key is not authorised",
    );

  let scopes: ApiKeyScope[];
  try {
    scopes = scopesSchema.parse(JSON.parse(key.scopesJson));
  } catch {
    throw new ApiError(
      500,
      "INVALID_API_KEY_RECORD",
      "The API key scope record is invalid",
    );
  }
  if (!scopes.includes(requiredScope)) {
    throw new ApiError(
      403,
      "SCOPE_FORBIDDEN",
      `The API key requires the ${requiredScope} scope`,
    );
  }
  if (requestedEventId) {
    if (key.eventId && key.eventId !== requestedEventId) {
      throw new ApiError(
        403,
        "EVENT_FORBIDDEN",
        "The API key is not authorised for this event",
      );
    }
    const event = await env.DB.prepare(
      "SELECT id FROM events WHERE id = ? AND organisation_id = ?",
    )
      .bind(requestedEventId, key.organisationId)
      .first();
    if (!event) throw new ApiError(404, "EVENT_NOT_FOUND", "Event not found");
  }

  await env.DB.prepare(
    "UPDATE api_keys SET last_used_at = unixepoch() WHERE id = ?",
  )
    .bind(key.id)
    .run();
  return {
    keyId: key.id,
    organisationId: key.organisationId,
    eventId: key.eventId,
    scopes: new Set(scopes),
  };
}

export async function readJson(
  request: Request,
  maxBytes = 256_000,
): Promise<unknown> {
  const contentType = request.headers.get("content-type") ?? "";
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    throw new ApiError(
      415,
      "UNSUPPORTED_MEDIA_TYPE",
      "Content-Type must be application/json",
    );
  }
  let text: string;
  try {
    text = await readBoundedText(request, maxBytes);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw new ApiError(413, "PAYLOAD_TOO_LARGE", error.message);
    }
    throw error;
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError(400, "INVALID_JSON", "Request body is not valid JSON");
  }
}
