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
export const SCANNER_DISPATCH_MAXIMUM_AGE_SECONDS = 300;
export const SCANNER_CALLBACK_REQUEST_TIMEOUT_MS = 30_000;

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
    organisationId: z.string().min(1).max(160),
    eventId: z.string().min(1).max(160),
    versionId: z.string().min(1).max(160),
    assetId: z.string().min(1).max(160),
    expiresAt: z.number().int().positive(),
    object: z
      .object({
        key: z.string().min(1).max(1_024),
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
  if (!job.object.key.startsWith("private/"))
    throw new Error("The object key is outside private R2 storage.");
  return job;
}

function base64Bytes(value: string) {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}

export async function verifyScannerDispatch(input: {
  rawBody: string;
  headers: Headers;
  secret: string;
  configuration: ScannerContractConfiguration;
  nowSeconds?: number;
}) {
  const timestampRaw = input.headers
    .get("x-program-cue-dispatch-timestamp")
    ?.trim();
  if (!timestampRaw || !/^\d{10}$/u.test(timestampRaw))
    throw new Error("The scanner dispatch timestamp is invalid.");
  const timestamp = Number(timestampRaw);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (Math.abs(now - timestamp) > SCANNER_DISPATCH_MAXIMUM_AGE_SECONDS)
    throw new Error(
      "The scanner dispatch timestamp is outside the accepted window.",
    );

  const signature = input.headers
    .get("x-program-cue-dispatch-signature")
    ?.trim();
  if (!signature?.startsWith("v1,"))
    throw new Error("The scanner dispatch signature is invalid.");
  const supplied = base64Bytes(signature.slice(3));
  if (supplied?.byteLength !== 32)
    throw new Error("The scanner dispatch signature is invalid.");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    supplied,
    new TextEncoder().encode(`${timestampRaw}.${input.rawBody}`),
  );
  if (!valid) throw new Error("The scanner dispatch signature is invalid.");

  const job = validateScannerJob(
    JSON.parse(input.rawBody),
    input.configuration,
  );
  if (job.expiresAt < now || job.expiresAt < timestamp)
    throw new Error("The scanner dispatch has expired.");
  if (job.expiresAt > timestamp + SCANNER_DISPATCH_MAXIMUM_AGE_SECONDS)
    throw new Error(
      "The scanner dispatch expiry is outside the accepted window.",
    );
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

export async function scannerContainerInstanceName(
  jobId: string,
  attempt: number,
) {
  const validAttempt = requirePositiveAttempt(attempt);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(jobId),
  );
  const baseSlot =
    new DataView(digest).getUint32(0, false) % SCANNER_CONTAINER_POOL_SIZE;
  const slot = (baseSlot + validAttempt - 1) % SCANNER_CONTAINER_POOL_SIZE;
  return `scanner-slot-${slot}`;
}

function requirePositiveAttempt(attempt: number) {
  if (!Number.isInteger(attempt) || attempt < 1) {
    throw new RangeError("Scanner attempt must be a positive integer.");
  }
  return attempt;
}

export function scannerCapacityDelaySeconds(attempt: number) {
  const validAttempt = requirePositiveAttempt(attempt);
  return Math.min(300, 15 * 2 ** Math.min(validAttempt - 1, 5));
}

export function scannerCapacityShouldWait(
  code: "scanner_busy" | "scanner_not_ready",
  attempt: number,
) {
  const validAttempt = requirePositiveAttempt(attempt);
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

export function scannerCallbackRequestInit(input: {
  rawBody: string;
  signed: Awaited<ReturnType<typeof signScannerCallback>>;
}): RequestInit {
  return {
    method: "POST",
    redirect: "manual",
    headers: {
      "content-type": "application/json",
      "x-program-cue-scanner-id": input.signed.callbackId,
      "x-program-cue-scanner-timestamp": input.signed.timestamp,
      "x-program-cue-scanner-signature": input.signed.signature,
    },
    body: input.rawBody,
    signal: AbortSignal.timeout(SCANNER_CALLBACK_REQUEST_TIMEOUT_MS),
  };
}
