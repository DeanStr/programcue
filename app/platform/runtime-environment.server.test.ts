import { describe, expect, it } from "vitest";

import {
  mayExposeInternalErrors,
  requireRuntimeMode,
  requiresProductionSecurity,
  RuntimeEnvironmentConfigurationError,
} from "./runtime-environment.server";

describe("runtime environment mode", () => {
  it.each([
    ["production", "false", "false", false, false],
    ["production", "false", "true", false, true],
    ["demo", "true", "false", true, false],
    ["development", "true", "false", true, false],
    ["test", "true", "false", true, false],
  ])(
    "accepts the explicit %s/%s/%s combination",
    (APP_ENV, DEMO_MODE, EVALUATION_MODE, demo, evaluation) => {
      expect(
        requireRuntimeMode({ APP_ENV, DEMO_MODE, EVALUATION_MODE }),
      ).toEqual({
        appEnvironment: APP_ENV,
        demo,
        evaluation,
      });
    },
  );

  it.each([
    ["production", "true", "false"],
    ["demo", "false", "false"],
    ["demo", "true", "true"],
    ["development", "false", "false"],
    ["staging", "false", "false"],
    [undefined, "false", "false"],
    ["production", undefined, "false"],
    ["production", "false", undefined],
  ])(
    "rejects unsupported or incomplete %s/%s/%s configuration",
    (APP_ENV, DEMO_MODE, EVALUATION_MODE) => {
      expect(() =>
        requireRuntimeMode({ APP_ENV, DEMO_MODE, EVALUATION_MODE }),
      ).toThrow(RuntimeEnvironmentConfigurationError);
    },
  );

  it("defaults unknown environments to production-grade security and error redaction", () => {
    for (const environment of [
      undefined,
      "",
      "staging",
      "prodution",
      "production",
    ]) {
      expect(requiresProductionSecurity(environment)).toBe(true);
      expect(mayExposeInternalErrors(environment)).toBe(false);
    }
    expect(requiresProductionSecurity("demo")).toBe(false);
    expect(mayExposeInternalErrors("demo")).toBe(true);
  });
});
