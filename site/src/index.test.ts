import { describe, expect, it } from "vitest";

import worker, { canonicalRedirectTarget } from "./index";

/* Stands in for the Cloudflare asset router: the Worker's only dependency. */
function assets(response: () => Response) {
  return { ASSETS: { fetch: async () => response() } };
}

const html = () =>
  new Response("<!doctype html><title>Program Cue</title>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });

function get(url: string, served: () => Response = html) {
  return worker.fetch(
    new Request(url),
    assets(served) as unknown as Parameters<typeof worker.fetch>[1],
  );
}

describe("canonicalRedirectTarget", () => {
  it("moves www to the secure apex host and keeps the rest of the URL", () => {
    expect(
      canonicalRedirectTarget(
        new URL("http://www.programcue.com:8080/privacy?a=1"),
      ),
    ).toBe("https://programcue.com/privacy?a=1");
  });

  it("upgrades plain HTTP on the apex host", () => {
    expect(
      canonicalRedirectTarget(new URL("http://programcue.com/terms")),
    ).toBe("https://programcue.com/terms");
  });

  it("leaves the secure apex host and development origins alone", () => {
    expect(
      canonicalRedirectTarget(new URL("https://programcue.com/terms")),
    ).toBeUndefined();
    expect(
      canonicalRedirectTarget(new URL("http://localhost:8787/terms")),
    ).toBeUndefined();
  });
});

describe("public site Worker", () => {
  it("serves the published pages with a 200 and no redirect", async () => {
    for (const path of ["/", "/guide", "/privacy", "/terms"]) {
      const response = await get(`https://programcue.com${path}`);
      expect(response.status).toBe(200);
    }
  });

  it("redirects www to the apex host permanently", async () => {
    const response = await get("https://www.programcue.com/terms");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://programcue.com/terms",
    );
  });

  it("redirects plain HTTP requests to HTTPS", async () => {
    const response = await get("http://programcue.com/privacy");
    expect(response.status).toBe(301);
    expect(response.headers.get("location")).toBe(
      "https://programcue.com/privacy",
    );
  });

  it("applies the security headers to served HTML", async () => {
    const response = await get("https://programcue.com/privacy");
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("script-src 'none'");
    expect(policy).toContain("media-src 'self' https://media.programcue.com");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
  });

  it("never sends a noindex directive that would hide the site from Google", async () => {
    const response = await get("https://programcue.com/");
    expect(response.headers.get("x-robots-tag")).toBeNull();
  });

  it("leaves HSTS off a plain-HTTP development origin", async () => {
    const response = await get("http://localhost:8787/");
    expect(response.headers.get("strict-transport-security")).toBeNull();
  });

  it("does not redirect Wrangler's local Custom Domain proxy", async () => {
    const response = await worker.fetch(
      new Request("http://programcue.com/privacy", {
        headers: {
          "cf-connecting-ip": "127.0.0.1",
          "mf-original-hostname": "programcue.com",
        },
      }),
      assets(html) as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("passes the asset router's status and body through unchanged", async () => {
    const response = await get(
      "https://programcue.com/missing",
      () => new Response("not found", { status: 404 }),
    );
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("not found");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("refuses write methods, which a static site has no use for", async () => {
    const response = await worker.fetch(
      new Request("https://programcue.com/", { method: "POST" }),
      assets(html) as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });

  it("refuses write methods before applying canonical redirects", async () => {
    const response = await worker.fetch(
      new Request("http://www.programcue.com/", { method: "POST" }),
      assets(html) as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(response.status).toBe(405);
    expect(response.headers.get("location")).toBeNull();
  });
});
