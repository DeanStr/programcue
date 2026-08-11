import { describe, expect, it } from "vitest";

import {
  rejectCrossOriginBrowserMutation,
  rejectUnsupportedRequestMethod,
} from "./mutation-origin.server";

describe("browser mutation origin boundary", () => {
  it("rejects unsupported methods before they can reach a route action", () => {
    for (const method of ["PUT", "DELETE"]) {
      const response = rejectUnsupportedRequestMethod(
        new Request("https://programcue.test/admin/tasks", { method }),
      );
      expect(response?.status).toBe(405);
      expect(response?.headers.get("allow")).toBe(
        "GET, HEAD, POST, PATCH, OPTIONS",
      );
    }

    for (const method of ["GET", "HEAD", "POST", "PATCH", "OPTIONS"])
      expect(
        rejectUnsupportedRequestMethod(
          new Request("https://programcue.test/admin/tasks", { method }),
        ),
      ).toBeNull();
  });

  it("accepts a same-origin browser mutation", () => {
    const request = new Request("https://programcue.example/admin/tasks", {
      method: "POST",
      headers: { origin: "https://programcue.example" },
    });

    expect(rejectCrossOriginBrowserMutation(request)).toBeNull();
  });

  it.each([null, "null", "https://attacker.example"])(
    "rejects an unsafe browser mutation with origin %s",
    (origin) => {
      const headers = origin ? { origin } : undefined;
      const response = rejectCrossOriginBrowserMutation(
        new Request("https://programcue.example/admin/tasks", {
          method: "POST",
          headers,
        }),
      );

      expect(response?.status).toBe(403);
      expect(response?.headers.get("cache-control")).toBe("no-store");
    },
  );

  it("does not apply the cookie-action boundary to API requests", () => {
    const request = new Request(
      "https://programcue.example/api/webhooks/resend",
      { method: "POST" },
    );

    expect(rejectCrossOriginBrowserMutation(request)).toBeNull();
  });

  it("does not require Origin for safe navigation", () => {
    const request = new Request("https://programcue.example/admin/tasks");

    expect(rejectCrossOriginBrowserMutation(request)).toBeNull();
  });
});
