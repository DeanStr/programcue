import { z } from "zod";

export const MAX_SCANNED_FILE_BYTES = 1_073_741_824;
export const MAX_SCANNER_REQUEST_BYTES = 24_000;
export const SCANNER_PROVIDER = "program-cue-clamav";

const boundedIdentifier = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const scannerJobSchema = z
  .object({
    jobId: boundedIdentifier,
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
    throw new Error("The object URL is not hosted by the configured R2 account.");
  }
  const bucketPrefix = `/${encodeURIComponent(configuration.r2BucketName)}/`;
  if (!objectUrl.pathname.startsWith(bucketPrefix)) {
    throw new Error("The object URL is not scoped to the private files bucket.");
  }
  if (
    objectUrl.searchParams.get("X-Amz-Algorithm") !== "AWS4-HMAC-SHA256" ||
    !objectUrl.searchParams.has("X-Amz-Signature")
  ) {
    throw new Error("The object URL is not an R2 signed request.");
  }
  const expiry = objectUrl.searchParams.get("X-Amz-Expires") ?? "";
  if (!/^\d{1,4}$/u.test(expiry) || Number(expiry) < 1 || Number(expiry) > 3_600) {
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
