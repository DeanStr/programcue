import { describe, expect, it } from "vitest";

import {
  ApplicationNoticeConfigurationError,
  assertApplicationNoticeConfiguration,
  createApplicationNotice,
  verifyApplicationNotice,
} from "./application-notice.server";

const env = {
  BETTER_AUTH_SECRET: "application-notice-test-secret-at-least-32-characters",
} as CloudflareEnvironment;

describe("application action notices", () => {
  it("accepts only an unexpired, unmodified receipt for the exact form", async () => {
    const token = await createApplicationNotice(
      env,
      {
        slug: "speaker-form",
        kind: "submitted",
        submissionId: "submission-1",
        webhookWarning: false,
      },
      1_000,
    );

    await expect(
      verifyApplicationNotice(env, token, "speaker-form", 1_100),
    ).resolves.toMatchObject({
      kind: "submitted",
      submissionId: "submission-1",
      realtimeWarning: false,
    });
    await expect(
      verifyApplicationNotice(env, token, "another-form", 1_100),
    ).resolves.toBeNull();
    await expect(
      verifyApplicationNotice(env, `${token}x`, "speaker-form", 1_100),
    ).resolves.toBeNull();
    await expect(
      verifyApplicationNotice(env, token, "speaker-form", 1_300),
    ).resolves.toBeNull();
  });

  it("fails configuration before a mutation can rely on an unsigned notice", () => {
    expect(() =>
      assertApplicationNoticeConfiguration({} as CloudflareEnvironment),
    ).toThrow(ApplicationNoticeConfigurationError);
  });
});
