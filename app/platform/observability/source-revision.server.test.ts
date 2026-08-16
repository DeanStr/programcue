import { describe, expect, it } from "vitest";

import {
  requireSourceRevision,
  sourceRevisionForLog,
  SourceRevisionConfigurationError,
} from "./source-revision.server";

describe("source revision", () => {
  it("accepts local labels and production Git revisions", () => {
    expect(
      requireSourceRevision({
        APP_ENV: "test",
        SOURCE_REVISION: "test-revision",
      }),
    ).toBe("test-revision");
    expect(
      requireSourceRevision({
        APP_ENV: "production",
        SOURCE_REVISION: "3f6a2c1",
      }),
    ).toBe("3f6a2c1");
  });

  it.each([
    undefined,
    "REPLACE_WITH_SOURCE_REVISION",
    "contains personal@example.test",
  ])(
    "rejects missing, placeholder or unsafe revision %s",
    (SOURCE_REVISION) => {
      expect(() =>
        requireSourceRevision({ APP_ENV: "test", SOURCE_REVISION }),
      ).toThrow(SourceRevisionConfigurationError);
    },
  );

  it("requires a Git revision in production without logging the raw value", () => {
    const environment = {
      APP_ENV: "production",
      SOURCE_REVISION: "not-a-production-commit",
    };
    expect(() => requireSourceRevision(environment)).toThrow(
      SourceRevisionConfigurationError,
    );
    expect(sourceRevisionForLog(environment)).toBe("invalid");
  });
});
