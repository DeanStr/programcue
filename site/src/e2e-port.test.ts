import { describe, expect, it } from "vitest";

import { resolveSiteE2ePort } from "./e2e-port";

describe("resolveSiteE2ePort", () => {
  it("uses a stable standalone default", () => {
    expect(resolveSiteE2ePort({})).toBe(8788);
  });

  it("uses an explicit public-site port", () => {
    expect(resolveSiteE2ePort({ PROGRAM_CUE_SITE_E2E_PORT: "9876" })).toBe(
      9876,
    );
  });

  it("isolates the site from an overridden application E2E port", () => {
    expect(resolveSiteE2ePort({ PROGRAM_CUE_E2E_PORT: "6173" })).toBe(7173);
  });

  it("rejects invalid and overflowing ports", () => {
    expect(() =>
      resolveSiteE2ePort({ PROGRAM_CUE_SITE_E2E_PORT: "port" }),
    ).toThrow("PROGRAM_CUE_SITE_E2E_PORT must be an integer");
    expect(() => resolveSiteE2ePort({ PROGRAM_CUE_E2E_PORT: "65000" })).toThrow(
      "too high",
    );
  });
});
