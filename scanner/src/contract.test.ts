import { describe, expect, it } from "vitest";

import {
  constantTimeTokenMatch,
  signScannerCallback,
  validateScannerJob,
  workflowInstanceId,
} from "./contract";

const configuration = {
  callbackUrl: "https://app.programcue.com/api/webhooks/file-scanner",
  r2BucketName: "program-cue-files",
  r2ObjectHost: "327c60945460c16be8ecdbbc7fa35447.r2.cloudflarestorage.com",
};

function job() {
  return {
    jobId: "file-scan-dispatch:version-1",
    eventId: "event-1",
    versionId: "version-1",
    assetId: "asset-1",
    object: {
      url: `https://${configuration.r2ObjectHost}/program-cue-files/private%2Fobject?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=900&X-Amz-Signature=abc123`,
      sizeBytes: 1_073_741_824,
      etag: '"object-etag"',
    },
    callback: {
      url: configuration.callbackUrl,
      authentication: "program-cue-hmac-sha256-v1",
    },
  };
}

describe("file scanner provider contract", () => {
  it("accepts only the configured private R2 and callback boundaries", () => {
    expect(validateScannerJob(job(), configuration)).toEqual(job());

    const wrongHost = job();
    wrongHost.object.url = wrongHost.object.url.replace(
      configuration.r2ObjectHost,
      "attacker.example",
    );
    expect(() => validateScannerJob(wrongHost, configuration)).toThrow(
      /configured R2 account/u,
    );

    const wrongCallback = job();
    wrongCallback.callback.url = "https://attacker.example/collect";
    expect(() => validateScannerJob(wrongCallback, configuration)).toThrow(
      /configured Program Cue URL/u,
    );
  });

  it("derives a valid, deterministic Workflow id without leaking the job id", async () => {
    const first = await workflowInstanceId("file-scan-dispatch:version-1");
    const second = await workflowInstanceId("file-scan-dispatch:version-1");
    expect(first).toBe(second);
    expect(first).toMatch(/^scan-[a-f0-9]{64}$/u);
    expect(first).not.toContain("version-1");
  });

  it("signs the exact callback body using the application contract", async () => {
    const rawBody = JSON.stringify({ verdict: "clean" });
    const signed = await signScannerCallback({
      callbackId: "scanner-callback-1",
      rawBody,
      secret: "scanner-callback-secret-with-at-least-32-characters",
      timestampSeconds: 1_800_000_000,
    });
    expect(signed).toEqual({
      callbackId: "scanner-callback-1",
      timestamp: "1800000000",
      signature: "v1,9+liCDx+WGmwKwjFMsR3+gl6VlLyvDG0TFEdAkca5Ik=",
    });
  });

  it("compares bearer credentials without depending on their length", async () => {
    await expect(constantTimeTokenMatch("same-token", "same-token")).resolves.toBe(
      true,
    );
    await expect(
      constantTimeTokenMatch("wrong", "same-token"),
    ).resolves.toBe(false);
  });
});
