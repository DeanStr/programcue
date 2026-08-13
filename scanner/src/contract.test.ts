import { describe, expect, it } from "vitest";

import {
  classifyScannerContainerFailure,
  constantTimeTokenMatch,
  scannerCapacityDelaySeconds,
  scannerCapacityShouldWait,
  scannerContainerInstanceName,
  scannerWorkflowDuplicateStatusIsAcceptable,
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
    attempt: 1,
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

  it("routes jobs deterministically across the fixed scanner pool", async () => {
    const first = await scannerContainerInstanceName(
      "file-scan-dispatch:version-1",
    );
    const repeated = await scannerContainerInstanceName(
      "file-scan-dispatch:version-1",
    );
    expect(first).toBe(repeated);
    expect(first).toMatch(/^scanner-slot-[0-3]$/u);
    expect(first).not.toContain("version-1");
  });

  it("caps scanner-capacity retry delays at five minutes", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(scannerCapacityDelaySeconds)).toEqual([
      15, 30, 60, 120, 240, 300, 300,
    ]);
    for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => scannerCapacityDelaySeconds(invalid)).toThrow(RangeError);
    }
  });

  it("uses separate bounded wait budgets for busy and unready scanners", () => {
    expect(scannerCapacityShouldWait("scanner_busy", 39)).toBe(true);
    expect(scannerCapacityShouldWait("scanner_busy", 40)).toBe(false);
    expect(scannerCapacityShouldWait("scanner_not_ready", 5)).toBe(true);
    expect(scannerCapacityShouldWait("scanner_not_ready", 6)).toBe(false);
    expect(() => scannerCapacityShouldWait("scanner_busy", 0)).toThrow(
      RangeError,
    );
  });

  it("accepts duplicates only while the existing Workflow can still satisfy them", () => {
    for (const status of ["queued", "running", "waiting", "complete"]) {
      expect(scannerWorkflowDuplicateStatusIsAcceptable(status)).toBe(true);
    }
    for (const status of [
      "paused",
      "waitingForPause",
      "errored",
      "terminated",
      "unknown",
      "unexpected",
    ]) {
      expect(scannerWorkflowDuplicateStatusIsAcceptable(status)).toBe(false);
    }
  });

  it("waits only for explicit capacity responses and fails permanent input errors immediately", () => {
    expect(
      classifyScannerContainerFailure(
        503,
        JSON.stringify({
          code: "scanner_busy",
          error: "The scanner is busy; retry this job.",
        }),
      ),
    ).toEqual({ kind: "capacity_wait", code: "scanner_busy" });
    expect(
      classifyScannerContainerFailure(
        422,
        JSON.stringify({
          code: "object_verification_failed",
          error: "The private object could not be verified.",
        }),
      ),
    ).toEqual({
      kind: "terminal_error",
      error: "The private object could not be verified.",
      reason: "object_verification_failed",
    });
    expect(
      classifyScannerContainerFailure(
        503,
        JSON.stringify({
          code: "clamav_unavailable",
          error: "ClamAV could not produce a verdict.",
        }),
      ),
    ).toBeNull();
    expect(classifyScannerContainerFailure(503, "not-json")).toBeNull();
  });

  it("gives each dispatch attempt a distinct Workflow identity", async () => {
    const jobId = "file-scan-dispatch:version-1";
    const first = await workflowInstanceId(`${jobId}:attempt:1`);
    const retry = await workflowInstanceId(`${jobId}:attempt:2`);
    expect(first).not.toBe(retry);
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
    await expect(
      constantTimeTokenMatch("same-token", "same-token"),
    ).resolves.toBe(true);
    await expect(constantTimeTokenMatch("wrong", "same-token")).resolves.toBe(
      false,
    );
  });
});
