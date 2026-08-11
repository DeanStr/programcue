import { z } from "zod";

const MAXIMUM_CLOCK_SKEW_SECONDS = 300;

type ScannerEnvironment = CloudflareEnvironment & {
  FILE_SCANNER_WEBHOOK_SECRET?: string;
};

const scannerCallbackBaseShape = {
  jobId: z.string().min(1).max(200),
  eventId: z.string().min(1).max(160),
  versionId: z.string().min(1).max(160),
  assetId: z.string().min(1).max(160),
  object: z
    .object({
      etag: z.string().min(1).max(200),
      sizeBytes: z.number().int().positive().max(1_073_741_824),
    })
    .strict(),
  provider: z
    .string()
    .min(1)
    .max(80)
    .regex(/^[a-zA-Z0-9._-]+$/),
  result: z.unknown().optional(),
};

export const scannerCallbackPayloadSchema = z.discriminatedUnion("verdict", [
  z
    .object({
      ...scannerCallbackBaseShape,
      verdict: z.literal("clean"),
    })
    .strict(),
  z
    .object({
      ...scannerCallbackBaseShape,
      verdict: z.literal("infected"),
    })
    .strict(),
  z
    .object({
      ...scannerCallbackBaseShape,
      verdict: z.literal("error"),
      error: z.string().trim().min(1).max(500),
    })
    .strict(),
]);

export class ScannerCallbackConfigurationError extends Error {
  constructor() {
    super("FILE_SCANNER_WEBHOOK_SECRET must contain at least 32 characters.");
    this.name = "ScannerCallbackConfigurationError";
  }
}

export class ScannerCallbackAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScannerCallbackAuthenticationError";
  }
}

function secret(env: ScannerEnvironment) {
  const value = env.FILE_SCANNER_WEBHOOK_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new ScannerCallbackConfigurationError();
  }
  return value;
}

function base64Bytes(value: string) {
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new ScannerCallbackAuthenticationError(
      "The scanner callback signature is malformed.",
    );
  }
}

export async function verifyScannerCallback(input: {
  env: ScannerEnvironment;
  headers: Headers;
  rawBody: string;
  nowSeconds?: number;
}) {
  const signingSecret = secret(input.env);
  const callbackId = input.headers.get("x-program-cue-scanner-id")?.trim();
  if (
    !callbackId ||
    callbackId.length > 160 ||
    !/^[a-zA-Z0-9._:-]+$/.test(callbackId)
  ) {
    throw new ScannerCallbackAuthenticationError(
      "A valid scanner callback identifier is required.",
    );
  }
  const timestampRaw = input.headers
    .get("x-program-cue-scanner-timestamp")
    ?.trim();
  if (!timestampRaw || !/^\d{10}$/.test(timestampRaw)) {
    throw new ScannerCallbackAuthenticationError(
      "A valid scanner callback timestamp is required.",
    );
  }
  const timestamp = Number(timestampRaw);
  const now = input.nowSeconds ?? Math.floor(Date.now() / 1_000);
  if (Math.abs(now - timestamp) > MAXIMUM_CLOCK_SKEW_SECONDS) {
    throw new ScannerCallbackAuthenticationError(
      "The scanner callback timestamp is outside the accepted window.",
    );
  }
  const signature = input.headers
    .get("x-program-cue-scanner-signature")
    ?.trim();
  if (!signature?.startsWith("v1,")) {
    throw new ScannerCallbackAuthenticationError(
      "A valid scanner callback signature is required.",
    );
  }
  const supplied = base64Bytes(signature.slice(3));
  if (supplied.byteLength !== 32) {
    throw new ScannerCallbackAuthenticationError(
      "The scanner callback signature is malformed.",
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(signingSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    supplied,
    new TextEncoder().encode(`${callbackId}.${timestampRaw}.${input.rawBody}`),
  );
  if (!valid) {
    throw new ScannerCallbackAuthenticationError(
      "The scanner callback signature is invalid.",
    );
  }
  return { callbackId };
}
