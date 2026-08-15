import { describe, expect, it } from "vitest";

import {
  applyPrivateWorkspaceCachePolicy,
  applySecurityHeaders,
} from "./security-headers";

describe("Worker security headers", () => {
  it("enforces transport security in production and for invalid environment values", () => {
    const production = new Headers();
    applySecurityHeaders(
      production,
      "production",
      "https://docs.google.com,https://player.vimeo.com",
    );
    expect(production.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    expect(production.get("content-security-policy")).toContain(
      "frame-ancestors 'self'",
    );
    expect(production.get("content-security-policy")).toContain(
      "script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com https://static.cloudflareinsights.com",
    );
    expect(production.get("content-security-policy")).toContain(
      "connect-src 'self' https://challenges.cloudflare.com https://*.r2.cloudflarestorage.com",
    );
    expect(production.get("content-security-policy")).not.toContain(
      "https://cloudflareinsights.com",
    );
    expect(production.get("content-security-policy")).toContain(
      "img-src 'self' data: blob: https:",
    );
    expect(production.get("content-security-policy")).toContain(
      "frame-src 'self' https://challenges.cloudflare.com https://docs.google.com https://player.vimeo.com",
    );
    expect(production.get("content-security-policy")).not.toContain(
      "frame-src https:",
    );
    expect(production.get("x-content-type-options")).toBe("nosniff");

    const development = new Headers();
    applySecurityHeaders(development, "development", "none");
    expect(development.has("strict-transport-security")).toBe(false);

    const missing = new Headers();
    applySecurityHeaders(missing, undefined, "none");
    expect(missing.get("strict-transport-security")).toBe("max-age=31536000");

    const misspelled = new Headers();
    applySecurityHeaders(misspelled, "prodution", "none");
    expect(misspelled.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
  });

  it("fails closed when resource embed origin configuration is invalid", () => {
    const headers = new Headers();
    applySecurityHeaders(headers, "production", "https://example.com/path");
    expect(headers.get("content-security-policy")).toContain(
      "frame-src 'self' https://challenges.cloudflare.com;",
    );
    expect(headers.get("content-security-policy")).not.toContain("example.com");
  });

  it("prevents private workspace documents and route data from being cached", () => {
    for (const pathname of [
      "/admin",
      "/admin.data",
      "/admin/command",
      "/admin/command.data",
      "/review",
      "/review.data",
      "/review/workbench",
      "/review/workbench.data",
      "/ai/context",
      "/ai/context.data",
    ]) {
      const headers = new Headers({ "cache-control": "public, max-age=300" });
      applyPrivateWorkspaceCachePolicy(headers, pathname);
      expect(headers.get("cache-control"), pathname).toBe("private, no-store");
    }

    for (const pathname of ["/administrator", "/reviewer", "/programme"]) {
      const headers = new Headers({ "cache-control": "public, max-age=300" });
      applyPrivateWorkspaceCachePolicy(headers, pathname);
      expect(headers.get("cache-control"), pathname).toBe(
        "public, max-age=300",
      );
    }
  });
});
