import { requiresProductionSecurity } from "~/platform/runtime-environment.server";

export const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), payment=()",
  "cross-origin-opener-policy": "same-origin",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self' https://challenges.cloudflare.com https://*.r2.cloudflarestorage.com; font-src 'self'; frame-src https:; object-src 'none'; base-uri 'self'; frame-ancestors 'self'; form-action 'self'",
} as const;

export function applySecurityHeaders(
  headers: Headers,
  environment: string | undefined,
) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS))
    headers.set(name, value);
  if (requiresProductionSecurity(environment)) {
    headers.set("strict-transport-security", "max-age=31536000");
  }
}
