import { describe, expect, it } from "vitest";

import { apiCorsHeaders, apiPreflightResponse } from "./api-cors";

const env = {
  CORS_ALLOWED_ORIGINS: "https://admin.example,https://ops.example",
};

describe("versioned API CORS", () => {
  it("allows every origin only for published public resources", () => {
    const request = new Request(
      "https://programcue.test/api/v1/public/events/demo/programme",
      {
        headers: { origin: "https://untrusted.example" },
      },
    );
    expect(
      apiCorsHeaders(request, env).get("access-control-allow-origin"),
    ).toBe("*");
  });

  it("echoes only explicitly configured private origins", () => {
    const allowed = new Request(
      "https://programcue.test/api/v1/events/event-1/tasks",
      {
        headers: { origin: "https://ops.example" },
      },
    );
    const denied = new Request(
      "https://programcue.test/api/v1/events/event-1/tasks",
      {
        headers: { origin: "https://untrusted.example" },
      },
    );
    expect(
      apiCorsHeaders(allowed, env).get("access-control-allow-origin"),
    ).toBe("https://ops.example");
    expect(apiCorsHeaders(allowed, env).get("vary")).toBe("Origin");
    expect(apiCorsHeaders(denied, env).has("access-control-allow-origin")).toBe(
      false,
    );
  });

  it("rejects an unconfigured private preflight and accepts a public one", async () => {
    const denied = apiPreflightResponse(
      new Request("https://programcue.test/api/v1/events/event-1/tasks", {
        method: "OPTIONS",
        headers: { origin: "https://untrusted.example" },
      }),
      env,
      "request-1",
    );
    expect(denied?.status).toBe(403);
    await expect(denied?.json()).resolves.toMatchObject({
      error: { code: "CORS_FORBIDDEN" },
    });

    const allowed = apiPreflightResponse(
      new Request(
        "https://programcue.test/api/v1/public/events/demo/programme",
        { method: "OPTIONS", headers: { origin: "https://untrusted.example" } },
      ),
      env,
      "request-2",
    );
    expect(allowed?.status).toBe(204);
    expect(allowed?.headers.get("access-control-allow-origin")).toBe("*");
  });

  it("allows the idempotency header required by private mutations", () => {
    const response = apiPreflightResponse(
      new Request("https://programcue.test/api/v1/events/event-1/tasks", {
        method: "OPTIONS",
        headers: {
          origin: "https://ops.example",
          "access-control-request-method": "POST",
          "access-control-request-headers":
            "authorization,content-type,idempotency-key",
        },
      }),
      env,
      "request-idempotent",
    );

    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-headers")).toContain(
      "idempotency-key",
    );
  });
});
