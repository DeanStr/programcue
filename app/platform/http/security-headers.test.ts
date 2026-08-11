import { describe, expect, it } from "vitest";

import { applySecurityHeaders } from "./security-headers";

describe("Worker security headers", () => {
  it("enforces transport security in production and for invalid environment values", () => {
    const production = new Headers();
    applySecurityHeaders(production, "production");
    expect(production.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    expect(production.get("content-security-policy")).toContain(
      "frame-ancestors 'self'",
    );
    expect(production.get("content-security-policy")).toContain(
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com",
    );
    expect(production.get("content-security-policy")).toContain(
      "connect-src 'self' https://challenges.cloudflare.com https://*.r2.cloudflarestorage.com",
    );
    expect(production.get("content-security-policy")).toContain(
      "frame-src https:",
    );
    expect(production.get("x-content-type-options")).toBe("nosniff");

    const development = new Headers();
    applySecurityHeaders(development, "development");
    expect(development.has("strict-transport-security")).toBe(false);

    const missing = new Headers();
    applySecurityHeaders(missing, undefined);
    expect(missing.get("strict-transport-security")).toBe("max-age=31536000");

    const misspelled = new Headers();
    applySecurityHeaders(misspelled, "prodution");
    expect(misspelled.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
  });
});
