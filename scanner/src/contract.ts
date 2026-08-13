import { z } from "zod";

export const MAX_SCANNED_FILE_BYTES = 1_073_741_824;
export const MAX_SCANNER_REQUEST_BYTES = 24_000;
export const SCANNER_PROVIDER = "program-cue-clamav";
export const SCANNER_CONTAINER_POOL_SIZE = 4;
// Thirty-nine capped sleeps keep genuine slot contention waiting for just
// under three hours without occupying a Worker request.
export const SCANNER_BUSY_ATTEMPT_LIMIT = 40;
// Five sleeps allow the container's five-minute cold-start window plus margin,
// but persistent readiness failure surfaces in under eight minutes.
export const SCANNER_NOT_READY_ATTEMPT_LIMIT = 6;

const scannerContainerErrorSchema = z
  .object({
    code: z.enum([
      "invalid_request",
      "scanner_busy",
      "scanner_not_ready",
      "object_verification_failed",
      "clamav_unavailable",
      "scan_failed",
    ]),
    error: z.string().min(1).max(500),
  })
  .strict();

export type ScannerContainerFailure =
  | {
      kind: "capacity_wait";
      code: "scanner_busy" | "scanner_not_ready";
    }
  | {
      kind: "terminal_error";
      error: string;
      reason: "invalid_request" | "object_verification_failed";
    };

const boundedIdentifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const scannerJobSchema = z
  .object({
    jobId: boundedIdentifier,
    attempt: z.number().int().positive(),
    eventId: z.string().min(1).max(160),
    versionId: z.string().min(1).max(160),
    assetId: z.string().min(1).max(160),
    object: z
      .object({
        url: z.string().url().max(8_192),
        sizeBytes: z.number().int().positive().max(MAX_SCANNED_FILE_BYTES),
        etag: z.string().min(1).max(200),
      })
      .strict(),
    callback: z
      .object({
        url: z.string().url().max(2_048),
        authentication: z.literal("program-cue-hmac-sha256-v1"),
      })
      .strict(),
  })
  .strict();

export type ScannerJob = z.infer<typeof scannerJobSchema>;

export interface ScannerContractConfiguration {
  callbackUrl: string;
  r2BucketName: string;
  r2ObjectHost: string;
}

function requireExactHttpsUrl(rawValue: string, name: string) {
  let value: URL;
  try {
    value = new URL(rawValue);
  } catch {
    throw new Error(`${name} must be an absolute HTTPS URL.`);
  }
  if (
    value.protocol !== "https:" ||
    value.username ||
    value.password ||
    value.hash
  ) {
    throw new Error(`${name} must be an absolute HTTPS URL.`);
  }
  return value;
}

export function validateScannerJob(
  input: unknown,
  configuration: ScannerContractConfiguration,
) {
  const job = scannerJobSchema.parse(input);
  const callback = requireExactHttpsUrl(job.callback.url, "Callback URL");
  const expectedCallback = requireExactHttpsUrl(
    configuration.callbackUrl,
    "EXPECTED_CALLBACK_URL",
  );
  if (callback.toString() !== expectedCallback.toString()) {
    throw new Error("The callback URL is not the configured Program Cue URL.");
  }

  const objectUrl = requireExactHttpsUrl(job.object.url, "Object URL");
  if (objectUrl.hostname !== configuration.r2ObjectHost) {
    throw new Error(
      "The object URL is not hosted by the configured R2 account.",
    );
  }
  const bucketPrefix = `/${encodeURIComponent(configuration.r2BucketName)}/`;
  if (!objectUrl.pathname.startsWith(bucketPrefix)) {
    throw new Error(
      "The object URL is not scoped to the private files bucket.",
    );
  }
  if (
    objectUrl.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
    !objectUrl.searchParams.has("X-Amz-Signature")
  ) {
    throw new Error("The object URL is not an R2 signed request.");
  }
  const expiry = objectUrl.searchParams.get("X-Amz-Expires") ?? "";
  if (
    !/^\d{1,4}$/u.test(expiry) ||
    Number(expiry) < 1 ||
    Number(expiry) > 3_600
  ) {
    throw new Error("The R2 signed request has an invalid expiry.");
  }
  return job;
}

export async function workflowInstanceId(jobId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jobId),
  );
  const hexadecimal = Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `scan-${hexadecimal}`;
}

export async function scannerContainerInstanceName(jobId: string) {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jobId),
  );
  const slot =
    new DataView(digest).getUint32(0, false) % SCANNER_CONTAINER_POOL_SIZE;
  return `scanner-slot-${slot}`;
}

function requireCapacityAttempt(attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("Scanner capacity attempt must be a positive integer.");
  }
  return attempt;
}

export function scannerCapacityDelaySeconds(attempt: number) {
  const validAttempt = requireCapacityAttempt(attempt);
  return Math.min(300, 15 * 2 ** Math.min(validAttempt - 1, 5));
}

export function scannerCapacityShouldWait(
  code: "scanner_busy" | "scanner_not_ready",
  attempt: number,
) {
  const validAttempt = requireCapacityAttempt(attempt);
  const limit =
    code === "scanner_busy"
      ? SCANNER_BUSY_ATTEMPT_LIMIT
      : SCANNER_NOT_READY_ATTEMPT_LIMIT;
  return validAttempt < limit;
}

export function scannerWorkflowDuplicateStatusIsAcceptable(status: string) {
  return ["queued", "running", "waiting", "complete"].includes(status);
}

export function classifyScannerContainerFailure(
  status: number,
  rawBody: string,
): ScannerContainerFailure | null {
  let error: z.infer<typeof scannerContainerErrorSchema>;
  try {
    error = scannerContainerErrorSchema.parse(JSON.parse(rawBody));
  } catch {
    return null;
  }
  if (
    status === 503 &&
    (error.code === "scanner_busy" || error.code === "scanner_not_ready")
  ) {
    return { kind: "capacity_wait", code: error.code };
  }
  if (
    [400, 413, 415, 422].includes(status) &&
    (error.code === "invalid_request" ||
      error.code === "object_verification_failed")
  ) {
    return {
      kind: "terminal_error",
      error: error.error,
      reason: error.code,
    };
  }
  return null;
}

function base64(bytes: ArrayBuffer) {
  const view = new Uint8Array(bytes);
  let binary = "";
  for (let offset = 0; offset < view.length; offset += 8_192) {
    binary += String.fromCharCode(...view.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

export async function signScannerCallback(input: {
  callbackId: string;
  rawBody: string;
  secret: string;
  timestampSeconds?: number;
}) {
  const timestamp = String(
    input.timestampSeconds ?? Math.floor(Date.now() / 1_000),
  );
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(
      `${input.callbackId}.${timestamp}.${input.rawBody}`,
    ),
  );
  return {
    callbackId: input.callbackId,
    timestamp,
    signature: `v1,${base64(signature)}`,
  };
}

export async function constantTimeTokenMatch(
  supplied: string,
  expected: string,
) {
  const encoder = new TextEncoder();
  const [suppliedDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(supplied)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(suppliedDigest);
  const right = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index] ^ right[index];
  }
  return difference === 0;
}
