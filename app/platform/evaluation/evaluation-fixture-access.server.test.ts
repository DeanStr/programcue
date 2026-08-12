import { describe, expect, it } from "vitest";

import {
  EvaluationFixtureAccessConfigurationError,
  requireEvaluationFixtureAccess,
} from "./evaluation-fixture-access.server";

const request = (token?: string) =>
  new Request(
    "https://app.programcue.test/api/internal/evaluation-fixture/reset",
    {
      method: "POST",
      headers: token ? { authorization: `Bearer ${token}` } : undefined,
    },
  );

describe("production evaluation fixture access", () => {
  it("is absent when no operator secret is installed", async () => {
    await expect(
      requireEvaluationFixtureAccess(request(), undefined),
    ).rejects.toMatchObject({
      status: 404,
    });
  });

  it("fails fast when an installed operator secret is weak", async () => {
    await expect(
      requireEvaluationFixtureAccess(request("short"), "short"),
    ).rejects.toBeInstanceOf(EvaluationFixtureAccessConfigurationError);
  });

  it("rejects missing or incorrect bearer credentials", async () => {
    const secret = "evaluation-fixture-secret-1234567890";
    await expect(
      requireEvaluationFixtureAccess(request(), secret),
    ).rejects.toMatchObject({
      status: 403,
    });
    await expect(
      requireEvaluationFixtureAccess(
        request("incorrect-secret-123456789012345"),
        secret,
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("accepts the exact configured bearer credential", async () => {
    const secret = "evaluation-fixture-secret-1234567890";
    await expect(
      requireEvaluationFixtureAccess(request(secret), secret),
    ).resolves.toBeUndefined();
  });
});
