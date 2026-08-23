import { describe, expect, it } from "vitest";

import {
  applyPrivateWorkspaceCachePolicy,
  applyScheduleReviewPreviewHeaders,
  applySecurityHeaders,
} from "./security-headers";

describe("Worker security headers", () => {
  const cspNonce = "test-response-nonce-1234567890";

  it("enforces transport security in production and for invalid environment values", () => {
    const production = new Headers();
    applySecurityHeaders(
      production,
      "production",
      "youtube,vimeo,google_maps",
      cspNonce,
    );
    expect(production.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    expect(production.get("content-security-policy")).toContain(
      "frame-ancestors 'self'",
    );
    expect(production.get("content-security-policy")).toContain(
      `script-src 'self' 'nonce-${cspNonce}' https://challenges.cloudflare.com https://static.cloudflareinsights.com`,
    );
    expect(production.get("content-security-policy")).toContain(
      "script-src-attr 'none'",
    );
    expect(production.get("content-security-policy")).toContain(
      "style-src 'self' 'unsafe-inline'",
    );
    expect(production.get("content-security-policy")).not.toContain(
      "require-trusted-types-for 'script'",
    );
    expect(production.get("content-security-policy")).not.toContain(
      "script-src 'self' 'unsafe-inline'",
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
      "frame-src 'self' https://challenges.cloudflare.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.google.com",
    );
    expect(production.get("content-security-policy")).not.toContain(
      "frame-src https:",
    );
    expect(production.get("x-content-type-options")).toBe("nosniff");

    const development = new Headers();
    applySecurityHeaders(development, "development", "none", cspNonce);
    expect(development.has("strict-transport-security")).toBe(false);

    const missing = new Headers();
    applySecurityHeaders(missing, undefined, "none", cspNonce);
    expect(missing.get("strict-transport-security")).toBe("max-age=31536000");

    const misspelled = new Headers();
    applySecurityHeaders(misspelled, "prodution", "none", cspNonce);
    expect(misspelled.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
  });

  it("fails closed when resource embed provider configuration is invalid", () => {
    const headers = new Headers();
    applySecurityHeaders(headers, "production", "unknown", cspNonce);
    expect(headers.get("content-security-policy")).toContain(
      "frame-src 'self' https://challenges.cloudflare.com;",
    );
    expect(headers.get("content-security-policy")).not.toContain("example.com");
  });

  it("rejects a missing or unsafe CSP nonce", () => {
    expect(() =>
      applySecurityHeaders(new Headers(), "production", "none", "short"),
    ).toThrow("valid per-response CSP nonce");
    expect(() =>
      applySecurityHeaders(
        new Headers(),
        "production",
        "none",
        "unsafe-nonce; script-src *",
      ),
    ).toThrow("valid per-response CSP nonce");
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
      "/participant",
      "/participant.data",
      "/participant/dashboard",
      "/participant/files/asset-1",
      "/apply",
      "/apply.data",
      "/apply/future-of-events-2027",
      "/apply/future-of-events-2027.data",
      "/apply/future-of-events-2027/files/multipart/initiate",
      "/events/select",
      "/events/select.data",
      "/ai/context",
      "/ai/context.data",
    ]) {
      const headers = new Headers({ "cache-control": "public, max-age=300" });
      applyPrivateWorkspaceCachePolicy(headers, pathname);
      expect(headers.get("cache-control"), pathname).toBe("private, no-store");
    }

    for (const pathname of [
      "/programme-preview",
      "/programme-preview.data",
      "/programme-preview/token-value",
      "/programme-preview/token-value.data",
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

  it("marks confidential programme previews private, unindexed and unframeable", () => {
    const headers = new Headers();
    applySecurityHeaders(headers, "production", "none", cspNonce);
    applyScheduleReviewPreviewHeaders(
      headers,
      "/programme-preview/secret-token",
    );
    expect(headers.get("cache-control")).toBe("private, no-store");
    expect(headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(headers.get("referrer-policy")).toBe("no-referrer");
    expect(headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(headers.get("content-security-policy")).not.toContain(
      "frame-ancestors 'self'",
    );
  });
});
