import { env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { describe, expect, it } from "vitest";

import { cloudflareContext } from "~/platform/cloudflare-context";
import { action } from "./api-internal-evaluation-fixture-reset";

function context(environment: CloudflareEnvironment) {
  const routerContext = new RouterContextProvider();
  routerContext.set(cloudflareContext, {
    env: environment,
    ctx: {} as ExecutionContext,
  });
  return routerContext;
}

function invoke(request: Request, environment: CloudflareEnvironment) {
  return action({
    request,
    context: context(environment),
    params: {},
  } as never);
}

describe("production evaluation fixture reset route", () => {
  it("is absent unless the temporary reset secret is installed", async () => {
    await expect(
      invoke(
        new Request(
          "https://app.programcue.test/api/internal/evaluation-fixture/reset",
          { method: "POST" },
        ),
        env as unknown as CloudflareEnvironment,
      ),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects malformed input before invoking fixture mutation", async () => {
    const secret = "evaluation-fixture-secret-1234567890";
    const response = await invoke(
      new Request(
        "https://app.programcue.test/api/internal/evaluation-fixture/reset",
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${secret}`,
            "content-type": "application/json",
          },
          body: "not-json",
        },
      ),
      {
        ...(env as unknown as CloudflareEnvironment),
        EVALUATION_FIXTURE_SECRET: secret,
      } as CloudflareEnvironment,
    );

    if (response instanceof Response) {
      throw new Error("Malformed fixture reset returned a raw response.");
    }
    expect(response.init?.status).toBe(400);
    expect(response.data).toEqual({
      error: "The request body must be valid JSON.",
    });
    expect(new Headers(response.init?.headers).get("cache-control")).toBe(
      "no-store",
    );
  });

  it("accepts only POST with the exact JSON media type", async () => {
    const secret = "evaluation-fixture-secret-1234567890";
    const environment = {
      ...(env as unknown as CloudflareEnvironment),
      EVALUATION_FIXTURE_SECRET: secret,
    } as CloudflareEnvironment;
    const authorizedHeaders = { authorization: `Bearer ${secret}` };

    const methodResponse = await invoke(
      new Request(
        "https://app.programcue.test/api/internal/evaluation-fixture/reset",
        { method: "PATCH", headers: authorizedHeaders },
      ),
      environment,
    );
    expect(methodResponse).toBeInstanceOf(Response);
    expect((methodResponse as Response).status).toBe(405);
    expect((methodResponse as Response).headers.get("allow")).toBe("POST");

    const contentTypeResponse = await invoke(
      new Request(
        "https://app.programcue.test/api/internal/evaluation-fixture/reset",
        {
          method: "POST",
          headers: {
            ...authorizedHeaders,
            "content-type": "application/json-patch+json",
          },
          body: JSON.stringify({ confirmation: "Future of Events 2027" }),
        },
      ),
      environment,
    );
    if (contentTypeResponse instanceof Response) {
      throw new Error("Invalid media type returned a raw response.");
    }
    expect(contentTypeResponse.init?.status).toBe(415);
  });
});
