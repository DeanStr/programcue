import { requiresProductionSecurity } from "~/platform/runtime-environment.server";
import { parseResourceEmbedOrigins } from "~/modules/resources/resource-embed-policy";

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
} as const;

function contentSecurityPolicy(resourceEmbedOrigins: unknown) {
  let origins: string[] = [];
  try {
    origins = parseResourceEmbedOrigins(resourceEmbedOrigins);
  } catch {
    // Runtime readiness reports invalid production configuration. Security
    // headers still fail closed while that error response is being produced.
  }
  const frameSources = [
    "'self'",
    "https://challenges.cloudflare.com",
    ...origins,
  ].join(" ");
  return `default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://challenges.cloudflare.com https://*.r2.cloudflarestorage.com; font-src 'self'; frame-src ${frameSources}; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'`;
}

export function applySecurityHeaders(
  headers: Headers,
  environment: string | undefined,
  resourceEmbedOrigins: unknown,
) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    headers.set(name, value);
  headers.set(
    "content-security-policy",
    contentSecurityPolicy(resourceEmbedOrigins),
  );
  if (requiresProductionSecurity(environment)) {
    headers.set("strict-transport-security", "max-age=31536000");
  }
}
