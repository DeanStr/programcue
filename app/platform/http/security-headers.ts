import { resourceEmbedFrameOrigins } from "~/modules/resources/resource-embed-policy";
import { requiresProductionSecurity } from "~/platform/runtime-environment.server";

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
} as const;

function isPrivateWorkspacePath(pathname: string) {
  return (
    pathname === "/admin" ||
    pathname === "/admin.data" ||
    pathname.startsWith("/admin/") ||
    pathname === "/review" ||
    pathname === "/review.data" ||
    pathname.startsWith("/review/") ||
    pathname === "/participant" ||
    pathname === "/participant.data" ||
    pathname.startsWith("/participant/") ||
    pathname === "/events/select" ||
    pathname === "/events/select.data" ||
    pathname === "/ai/context" ||
    pathname === "/ai/context.data"
  );
}

export function applyPrivateWorkspaceCachePolicy(
  headers: Headers,
  pathname: string,
) {
  if (isPrivateWorkspacePath(pathname)) {
    headers.set("cache-control", "private, no-store");
  }
}

function contentSecurityPolicy(
  resourceEmbedProviders: unknown,
  cspNonce: string,
) {
  if (!/^[A-Za-z0-9_-]{16,128}$/u.test(cspNonce)) {
    throw new Error("A valid per-response CSP nonce is required.");
  }
  let origins: string[] = [];
  try {
    origins = resourceEmbedFrameOrigins(resourceEmbedProviders);
  } catch {
    // Runtime readiness reports invalid production configuration. Security
    // headers still fail closed while that error response is being produced.
  }
  const frameSources = [
    "'self'",
    "https://challenges.cloudflare.com",
    ...origins,
  ].join(" ");
  return `default-src 'self'; script-src 'self' 'nonce-${cspNonce}' https://challenges.cloudflare.com https://static.cloudflareinsights.com; script-src-attr 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https:; connect-src 'self' https://challenges.cloudflare.com https://*.r2.cloudflarestorage.com; font-src 'self'; frame-src ${frameSources}; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'`;
}

export function applySecurityHeaders(
  headers: Headers,
  environment: string | undefined,
  resourceEmbedProviders: unknown,
  cspNonce: string,
) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    headers.set(name, value);
  headers.set(
    "content-security-policy",
    contentSecurityPolicy(resourceEmbedProviders, cspNonce),
  );
  if (requiresProductionSecurity(environment)) {
    headers.set("strict-transport-security", "max-age=31536000");
  }
}
