const API_PREFIX = "/api/v1/";
type CorsEnvironment = { CORS_ALLOWED_ORIGINS?: string };

function configuredOrigins(env: CorsEnvironment) {
  return String(env.CORS_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function allowedPrivateOrigin(request: Request, env: CorsEnvironment) {
  const origin = request.headers.get("origin");
  return origin && configuredOrigins(env).includes(origin) ? origin : null;
}

export function isVersionedApiPath(pathname: string) {
  return pathname.startsWith(API_PREFIX);
}

export function isPublicApiPath(pathname: string) {
  return (
    pathname === "/api/v1/health" || pathname.startsWith("/api/v1/public/")
  );
}

export function apiCorsHeaders(
  request: Request,
  env: CorsEnvironment,
  pathname = new URL(request.url).pathname,
) {
  const headers = new Headers();
  if (!isVersionedApiPath(pathname)) return headers;
  if (isPublicApiPath(pathname)) {
    headers.set("access-control-allow-origin", "*");
    return headers;
  }
  const origin = allowedPrivateOrigin(request, env);
  if (origin) {
    headers.set("access-control-allow-origin", origin);
    headers.set("vary", "Origin");
  }
  return headers;
}

export function apiPreflightResponse(
  request: Request,
  env: CorsEnvironment,
  correlationId: string,
) {
  const pathname = new URL(request.url).pathname;
  if (request.method !== "OPTIONS" || !isVersionedApiPath(pathname))
    return null;

  const origin = isPublicApiPath(pathname)
    ? "*"
    : allowedPrivateOrigin(request, env);
  if (!origin) {
    return Response.json(
      {
        error: {
          code: "CORS_FORBIDDEN",
          message: "Origin is not allowed for private API routes",
        },
        correlationId,
      },
      {
        status: 403,
        headers: { "cache-control": "no-store" },
      },
    );
  }

  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
      "access-control-allow-headers":
        "authorization,content-type,idempotency-key,x-correlation-id",
      "access-control-max-age": "600",
      ...(origin === "*" ? {} : { vary: "Origin" }),
    },
  });
}
