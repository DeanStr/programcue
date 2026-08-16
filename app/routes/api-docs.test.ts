import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import { apiReferenceBackLink } from "./api-docs-navigation.server";

function environment(
  overrides: Partial<
    Record<
      "APP_ENV" | "DEFAULT_EVENT_ID" | "DEMO_MODE" | "EVALUATION_MODE",
      string
    >
  >,
): CloudflareEnvironment {
  return {
    ...(env as unknown as CloudflareEnvironment),
    ...overrides,
  } as unknown as CloudflareEnvironment;
}

describe("API reference navigation", () => {
  it("returns to the production evaluation gate in evaluation mode", () => {
    expect(
      apiReferenceBackLink(
        environment({
          APP_ENV: "production",
          DEMO_MODE: "false",
          EVALUATION_MODE: "true",
        }),
      ),
    ).toEqual({ label: "Evaluation access", to: "/evaluate" });
  });

  it("returns to the demo guide only when its canonical fixture is available", () => {
    expect(apiReferenceBackLink(environment({}))).toEqual({
      label: "Demo guide",
      to: "/demo",
    });
    expect(
      apiReferenceBackLink(
        environment({ DEFAULT_EVENT_ID: "evt-not-the-canonical-demo" }),
      ),
    ).toEqual({ label: "API settings", to: "/admin/settings" });
  });

  it("returns to API settings in ordinary production", () => {
    expect(
      apiReferenceBackLink(
        environment({
          APP_ENV: "production",
          DEMO_MODE: "false",
          EVALUATION_MODE: "false",
        }),
      ),
    ).toEqual({ label: "API settings", to: "/admin/settings" });
  });
});
