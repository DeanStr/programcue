const encoder = new TextEncoder();

/**
 * A stable slug naming which part of the upload configuration is wrong.
 *
 * The message names the exact variable, which is useful when this throws at
 * startup but must not reach a log line — `applicant-file-multipart.test.ts`
 * asserts that variable names never appear in one. `reason` is safe to log, and
 * without it every failure here arrives as the same class name, leaving no way
 * to tell a missing account from a malformed bucket name.
 */
export type R2S3ConfigurationReason =
  | "account"
  | "bucket"
  | "credentials"
  | "unknown";

export class R2S3ConfigurationError extends Error {
  constructor(
    message: string,
    readonly reason: R2S3ConfigurationReason = "unknown",
  ) {
    super(message);
    this.name = "R2S3ConfigurationError";
  }
}

type R2S3Configuration = {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function requireValue(
  value: string | undefined,
  name: string,
  reason: R2S3ConfigurationReason,
  minimumLength = 1,
) {
  const normalized = value?.trim() ?? "";
  if (normalized.length < minimumLength)
    throw new R2S3ConfigurationError(
      `${name} is required for direct R2 uploads.`,
      reason,
    );
  return normalized;
}

export function requireR2S3Configuration(
  env: CloudflareEnvironment,
): R2S3Configuration {
  const accountId = requireValue(env.R2_ACCOUNT_ID, "R2_ACCOUNT_ID", "account");
  const bucketName = requireValue(env.R2_BUCKET_NAME, "R2_BUCKET_NAME", "bucket");
  const accessKeyId = requireValue(
    env.R2_ACCESS_KEY_ID,
    "R2_ACCESS_KEY_ID",
    "credentials",
  );
  const secretAccessKey = requireValue(
    env.R2_SECRET_ACCESS_KEY,
    "R2_SECRET_ACCESS_KEY",
    "credentials",
    16,
  );
  if (!/^[a-zA-Z0-9_-]+$/.test(accountId))
    throw new R2S3ConfigurationError(
      "R2_ACCOUNT_ID contains invalid characters.",
      "account",
    );
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucketName))
    throw new R2S3ConfigurationError(
      "R2_BUCKET_NAME is not a valid R2 bucket name.",
      "bucket",
    );
  return { accountId, bucketName, accessKeyId, secretAccessKey };
}

function hex(bytes: ArrayBuffer | Uint8Array) {
  return Array.from(
    bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256(value: string) {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function hmac(key: ArrayBuffer | Uint8Array, value: string) {
  const rawKey = key instanceof ArrayBuffer ? key : new Uint8Array(key).buffer;
  const imported = await crypto.subtle.importKey(
    "raw",
    rawKey,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", imported, encoder.encode(value));
}

function awsEncode(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalPath(bucket: string, objectKey: string) {
  return `/${[bucket, ...objectKey.split("/")].map(awsEncode).join("/")}`;
}

function amzTimestamp(date: Date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

async function signingKey(secret: string, date: string) {
  const dateKey = await hmac(encoder.encode(`AWS4${secret}`), date);
  const regionKey = await hmac(dateKey, "auto");
  const serviceKey = await hmac(regionKey, "s3");
  return hmac(serviceKey, "aws4_request");
}

export async function presignR2S3Request(input: {
  env: CloudflareEnvironment;
  method: "GET" | "PUT";
  objectKey: string;
  query?: Readonly<Record<string, string>>;
  expiresSeconds?: number;
  now?: Date;
}) {
  const configuration = requireR2S3Configuration(input.env);
  const now = input.now ?? new Date();
  const timestamp = amzTimestamp(now);
  const date = timestamp.slice(0, 8);
  const expires = input.expiresSeconds ?? 900;
  if (!Number.isInteger(expires) || expires < 1 || expires > 3_600)
    throw new R2S3ConfigurationError(
      "R2 presigned URL expiry must be between 1 and 3600 seconds.",
    );
  const host = `${configuration.accountId}.r2.cloudflarestorage.com`;
  const scope = `${date}/auto/s3/aws4_request`;
  const parameters: Record<string, string> = {
    ...(input.query ?? {}),
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${configuration.accessKeyId}/${scope}`,
    "X-Amz-Date": timestamp,
    "X-Amz-Expires": String(expires),
    "X-Amz-SignedHeaders": "host",
  };
  const canonicalQuery = Object.entries(parameters)
    .map(([name, value]) => [awsEncode(name), awsEncode(value)] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      const nameOrder =
        leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
      if (nameOrder !== 0) return nameOrder;
      return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
    })
    .map(([name, value]) => `${name}=${value}`)
    .join("&");
  const path = canonicalPath(configuration.bucketName, input.objectKey);
  const canonicalRequest = [
    input.method,
    path,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    timestamp,
    scope,
    await sha256(canonicalRequest),
  ].join("\n");
  const signature = hex(
    await hmac(
      await signingKey(configuration.secretAccessKey, date),
      stringToSign,
    ),
  );
  return `https://${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}
