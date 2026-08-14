import { describe, expect, it } from "vitest";

import {
  classifyScannerContainerFailure,
  scannerCapacityDelaySeconds,
  scannerCapacityShouldWait,
  scannerContainerInstanceName,
  scannerWorkflowDuplicateStatusIsAcceptable,
  signScannerCallback,
  validateScannerJob,
  verifyScannerDispatch,
  workflowInstanceId,
} from "./contract";

const configuration = {
  callbackUrl: "https://app.programcue.com/api/webhooks/file-scanner",
};

function job() {
  return {
    jobId: "file-scan-dispatch:version-1",
    attempt: 1,
    organisationId: "organisation-1",
    eventId: "event-1",
    versionId: "version-1",
    assetId: "asset-1",
    expiresAt: 1_800_000_300,
    object: {
      key: "private/object",
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
  it("accepts only private object keys and the configured callback boundary", () => {
    expect(validateScannerJob(job(), configuration)).toEqual(job());

    const publicObject = job();
    publicObject.object.key = "public/object";
    expect(() => validateScannerJob(publicObject, configuration)).toThrow(
      /outside private R2 storage/u,
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
      1,
    );
    const repeated = await scannerContainerInstanceName(
      "file-scan-dispatch:version-1",
      1,
    );
    expect(first).toBe(repeated);
    expect(first).toMatch(/^scanner-slot-[0-3]$/u);
    expect(first).not.toContain("version-1");

    const retrySlots = await Promise.all(
      [1, 2, 3, 4].map((attempt) =>
        scannerContainerInstanceName("file-scan-dispatch:version-1", attempt),
      ),
    );
    expect(new Set(retrySlots).size).toBe(4);
    await expect(
      scannerContainerInstanceName("file-scan-dispatch:version-1", 0),
    ).rejects.toThrow(RangeError);
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

  it("authenticates the exact dispatch envelope and rejects tampering or expiry", async () => {
    const timestamp = "1800000000";
    const rawBody = JSON.stringify(job());
    const secret = "dispatch-secret-with-at-least-thirty-two-characters";
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${timestamp}.${rawBody}`),
    );
    const signature = btoa(String.fromCharCode(...new Uint8Array(digest)));
    const headers = new Headers({
      "x-program-cue-dispatch-timestamp": timestamp,
      "x-program-cue-dispatch-signature": `v1,${signature}`,
    });

    await expect(
      verifyScannerDispatch({
        rawBody,
        headers,
        secret,
        configuration,
        nowSeconds: 1_800_000_001,
      }),
    ).resolves.toEqual(job());
    await expect(
      verifyScannerDispatch({
        rawBody: `${rawBody} `,
        headers,
        secret,
        configuration,
        nowSeconds: 1_800_000_001,
      }),
    ).rejects.toThrow(/signature/u);
    await expect(
      verifyScannerDispatch({
        rawBody,
        headers,
        secret,
        configuration,
        nowSeconds: 1_800_000_301,
      }),
    ).rejects.toThrow(/timestamp/u);
  });
});
