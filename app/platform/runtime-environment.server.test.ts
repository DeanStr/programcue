import { describe, expect, it } from "vitest";

import {
  mayExposeInternalErrors,
  requireRuntimeMode,
  requiresProductionSecurity,
  RuntimeEnvironmentConfigurationError,
} from "./runtime-environment.server";

describe("runtime environment mode", () => {
  it.each([
    ["production", "false", false],
    ["demo", "true", true],
    ["development", "true", true],
    ["test", "true", true],
  ])("accepts the explicit %s/%s combination", (APP_ENV, DEMO_MODE, demo) => {
    expect(requireRuntimeMode({ APP_ENV, DEMO_MODE })).toEqual({
      appEnvironment: APP_ENV,
      demo,
    });
  });

  it.each([
    ["production", "true"],
    ["demo", "false"],
    ["development", "false"],
    ["staging", "false"],
    [undefined, "false"],
    ["production", undefined],
  ])("rejects unsupported or incomplete %s/%s configuration", (APP_ENV, DEMO_MODE) => {
    expect(() => requireRuntimeMode({ APP_ENV, DEMO_MODE }))
      .toThrow(RuntimeEnvironmentConfigurationError);
  });

  it("defaults unknown environments to production-grade security and error redaction", () => {
    for (const environment of [undefined, "", "staging", "prodution", "production"]) {
      expect(requiresProductionSecurity(environment)).toBe(true);
      expect(mayExposeInternalErrors(environment)).toBe(false);
    }
    expect(requiresProductionSecurity("demo")).toBe(false);
    expect(mayExposeInternalErrors("demo")).toBe(true);
  });
});
